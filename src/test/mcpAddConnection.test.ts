import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMode, isValidMode } from '../mcp-server/settings';

// ---------------------------------------------------------------------------
// settings.ts — resolveMode (pure function, no fs/env dependency)
// ---------------------------------------------------------------------------

describe('resolveMode', () => {
  it('defaults to restricted when no env and no file', () => {
    expect(resolveMode(undefined, undefined)).toBe('restricted');
  });

  it.each(['off', 'restricted', 'unrestricted'] as const)(
    'env=%s takes precedence over file',
    (mode) => {
      expect(resolveMode(mode, '{"allowAddConnection":"unrestricted"}')).toBe(mode);
    },
  );

  it('ignores invalid env var, falls through to file', () => {
    expect(resolveMode('bogus', '{"allowAddConnection":"off"}')).toBe('off');
  });

  it('reads valid mode from file when env is absent', () => {
    expect(resolveMode(undefined, '{"allowAddConnection":"unrestricted"}')).toBe('unrestricted');
  });

  it('ignores invalid JSON file content', () => {
    expect(resolveMode(undefined, 'not json')).toBe('restricted');
  });

  it('ignores invalid mode in file', () => {
    expect(resolveMode(undefined, '{"allowAddConnection":"yolo"}')).toBe('restricted');
  });

  it('ignores file with missing key', () => {
    expect(resolveMode(undefined, '{}')).toBe('restricted');
  });
});

describe('isValidMode', () => {
  it.each(['off', 'restricted', 'unrestricted'])('accepts %s', (val) => {
    expect(isValidMode(val)).toBe(true);
  });

  it.each([undefined, null, '', 'foo', 42])('rejects %s', (val) => {
    expect(isValidMode(val)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// add_connection handler logic — mode × readonly combinations
// ---------------------------------------------------------------------------

describe('add_connection handler modes', () => {
  const mockStore = {
    add: vi.fn(async () => {}),
    addProjectScoped: vi.fn(async () => {}),
  };

  interface AddConnectionArgs {
    name: string;
    type: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
    database?: string;
    ssl?: boolean;
    readonly?: boolean;
  }

  function handleAddConnection(mode: 'off' | 'restricted' | 'unrestricted', args: AddConnectionArgs) {
    if (mode === 'off') {
      return { error: 'Tool disabled', kind: 'tool_disabled' } as const;
    }

    const { name: connName, type, host, port, username, password, database, ssl, readonly } = args;
    const id = 'test-id';
    const warnings: { kind: string; message: string }[] = [];

    if (mode === 'restricted') {
      const safeName = connName.startsWith('[agent] ') ? connName : `[agent] ${connName}`;
      if (readonly === false) {
        warnings.push({ kind: 'readonly_forced', message: 'readonly: false was ignored; restricted mode forces read-only connections.' });
      }
      const config = { id, name: safeName, type, host, port, username, password, database, ssl, readonly: true, mcpCreated: true, scope: 'project' as const };
      mockStore.addProjectScoped(config);
      return { id, name: safeName, type, host, port, database, readonly: true, scope: 'project', mcpCreated: true, message: 'Connection added (restricted mode)', warnings };
    }

    const config = { id, name: connName, type, host, port, username, password, database, ssl, readonly, mcpCreated: true };
    mockStore.add(config);
    warnings.push({ kind: 'agent_created_writeable_connection', message: 'Connection created with agent-supplied settings. Review in VS Code.' });
    return { id, name: connName, type, host, port, database, readonly, mcpCreated: true, message: 'Connection added', warnings };
  }

  beforeEach(() => {
    mockStore.add.mockClear();
    mockStore.addProjectScoped.mockClear();
  });

  const baseArgs: AddConnectionArgs = {
    name: 'My PG',
    type: 'postgresql',
    host: 'localhost',
    port: 5432,
    database: 'mydb',
  };

  // --- off mode ---
  it('off mode returns tool_disabled error', () => {
    const result = handleAddConnection('off', baseArgs);
    expect(result).toHaveProperty('error');
    expect(result).toHaveProperty('kind', 'tool_disabled');
  });

  // --- restricted mode × readonly variants ---
  it.each([
    [true, 'readonly: true'],
    [false, 'readonly: false (overridden)'],
    [undefined, 'readonly: omitted'],
  ] as const)('restricted + %s → forces readonly, project scope, mcpCreated', (readonlyArg) => {
    const result = handleAddConnection('restricted', { ...baseArgs, readonly: readonlyArg as boolean | undefined });
    expect(result).toHaveProperty('readonly', true);
    expect(result).toHaveProperty('scope', 'project');
    expect(result).toHaveProperty('mcpCreated', true);
    expect((result as { name: string }).name).toMatch(/^\[agent\] /);
    expect(mockStore.addProjectScoped).toHaveBeenCalledTimes(1);
    expect(mockStore.add).not.toHaveBeenCalled();
  });

  it('restricted emits readonly_forced warning when readonly: false supplied', () => {
    const result = handleAddConnection('restricted', { ...baseArgs, readonly: false });
    expect((result as { warnings: { kind: string }[] }).warnings).toContainEqual(
      expect.objectContaining({ kind: 'readonly_forced' }),
    );
  });

  it('restricted does not emit readonly_forced when readonly: true supplied', () => {
    const result = handleAddConnection('restricted', { ...baseArgs, readonly: true });
    expect((result as { warnings: { kind: string }[] }).warnings).not.toContainEqual(
      expect.objectContaining({ kind: 'readonly_forced' }),
    );
  });

  it('restricted does not double-prefix [agent]', () => {
    const result = handleAddConnection('restricted', { ...baseArgs, name: '[agent] Already Prefixed' });
    expect((result as { name: string }).name).toBe('[agent] Already Prefixed');
  });

  // --- unrestricted mode × readonly variants ---
  it.each([
    [true, 'readonly: true'],
    [false, 'readonly: false'],
    [undefined, 'readonly: omitted'],
  ] as const)('unrestricted + %s → preserves agent-supplied value', (readonlyArg) => {
    const result = handleAddConnection('unrestricted', { ...baseArgs, readonly: readonlyArg as boolean | undefined });
    expect(result).toHaveProperty('readonly', readonlyArg);
    expect(result).toHaveProperty('mcpCreated', true);
    expect((result as { warnings: { kind: string }[] }).warnings).toContainEqual(
      expect.objectContaining({ kind: 'agent_created_writeable_connection' }),
    );
    expect(mockStore.add).toHaveBeenCalledTimes(1);
    expect(mockStore.addProjectScoped).not.toHaveBeenCalled();
  });

  it('unrestricted does not prefix name', () => {
    const result = handleAddConnection('unrestricted', baseArgs);
    expect((result as { name: string }).name).toBe('My PG');
  });
});

// ---------------------------------------------------------------------------
// ConnectionStore.addProjectScoped — writes to project config
// ---------------------------------------------------------------------------

const { createDriverMock: createDriverMockForProject } = vi.hoisted(() => {
  const createDriverMockForProject = vi.fn(() => ({
    connect: vi.fn(async () => {}),
    ping: vi.fn(async () => true),
    disconnect: vi.fn(async () => {}),
    execute: vi.fn(async () => ({ columns: [], rows: [] })),
    getSchema: vi.fn(async () => []),
    getTableData: vi.fn(async () => ({ columns: [], rows: [] })),
    getTableInfo: vi.fn(async () => ({ columns: [] })),
  }));
  return { createDriverMockForProject };
});

vi.mock('../drivers', () => ({ createDriver: createDriverMockForProject }));

describe('ConnectionStore.addProjectScoped', () => {
  const PROJECT_DIR = path.join(os.tmpdir(), `viewstor-project-test-${Date.now()}`);
  const VSCODE_DIR = path.join(PROJECT_DIR, '.vscode');
  const PROJECT_FILE = path.join(VSCODE_DIR, 'viewstor.json');
  const origCwd = process.cwd();

  beforeEach(() => {
    fs.mkdirSync(PROJECT_DIR, { recursive: true });
    process.chdir(PROJECT_DIR);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  });

  it('creates .vscode/viewstor.json with project-scoped connection', async () => {
    const { ConnectionStore } = await import('../mcp-server/connectionStore');
    const store = new ConnectionStore();
    const config = {
      id: 'agent-1',
      name: '[agent] Test',
      type: 'postgresql' as const,
      host: 'localhost',
      port: 5432,
      database: 'testdb',
      password: 'secret',
      mcpCreated: true,
      scope: 'project' as const,
    };
    await store.addProjectScoped(config);

    expect(fs.existsSync(PROJECT_FILE)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8'));
    expect(saved.connections).toHaveLength(1);
    expect(saved.connections[0].id).toBe('agent-1');
    expect(saved.connections[0].mcpCreated).toBe(true);
    expect(saved.connections[0].password).toBeUndefined();
  });

  it('appends to existing project config without overwriting', async () => {
    fs.mkdirSync(VSCODE_DIR, { recursive: true });
    fs.writeFileSync(PROJECT_FILE, JSON.stringify({
      connections: [{ id: 'existing', name: 'Existing', type: 'sqlite', host: '', port: 0, database: ':memory:' }],
    }, null, 2));

    const { ConnectionStore } = await import('../mcp-server/connectionStore');
    const store = new ConnectionStore();
    await store.addProjectScoped({
      id: 'agent-2',
      name: '[agent] New',
      type: 'postgresql' as const,
      host: 'db.local',
      port: 5432,
      scope: 'project' as const,
    });

    const saved = JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8'));
    expect(saved.connections).toHaveLength(2);
    expect(saved.connections.map((c: { id: string }) => c.id).sort()).toEqual(['agent-2', 'existing']);
  });
});

// ---------------------------------------------------------------------------
// Tree-view indicator — mcpCreated connections show [agent] in description
// ---------------------------------------------------------------------------

describe('tree-view mcpCreated indicator', () => {
  function computeDescription(config: { mcpCreated?: boolean; type: string; host?: string; port?: number; database?: string }, connected: boolean) {
    const hostDesc = connected
      ? (config.type === 'sqlite' ? (config.database || ':memory:') : `${config.host}:${config.port}`)
      : '';
    return config.mcpCreated ? `[agent] ${hostDesc}`.trim() : hostDesc;
  }

  it('prefixes description with [agent] when mcpCreated is true', () => {
    expect(computeDescription({ mcpCreated: true, type: 'postgresql', host: 'localhost', port: 5432 }, true)).toBe('[agent] localhost:5432');
  });

  it('shows normal description when mcpCreated is false', () => {
    expect(computeDescription({ mcpCreated: false, type: 'postgresql', host: 'localhost', port: 5432 }, true)).toBe('localhost:5432');
  });

  it('shows normal description when mcpCreated is absent', () => {
    expect(computeDescription({ type: 'postgresql', host: 'localhost', port: 5432 }, true)).toBe('localhost:5432');
  });

  it('shows just [agent] when disconnected', () => {
    expect(computeDescription({ mcpCreated: true, type: 'postgresql', host: 'localhost', port: 5432 }, false)).toBe('[agent]');
  });
});
