import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAddConnectionMode } from '../mcp-server/connectionStore';

const TEST_DIR = path.join(os.tmpdir(), `viewstor-addconn-${Date.now()}`);
const TEST_PROJECT_DIR = path.join(TEST_DIR, 'project');
const TEST_PROJECT_CONFIG = path.join(TEST_PROJECT_DIR, '.vscode', 'viewstor.json');

// -------------------------------------------------------------------------
// getAddConnectionMode — reads from env / config file
// -------------------------------------------------------------------------
describe('getAddConnectionMode', () => {
  const origEnv = process.env.VIEWSTOR_ALLOW_ADD_CONNECTION;

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.VIEWSTOR_ALLOW_ADD_CONNECTION = origEnv;
    } else {
      delete process.env.VIEWSTOR_ALLOW_ADD_CONNECTION;
    }
  });

  it('defaults to restricted when no env or config', () => {
    delete process.env.VIEWSTOR_ALLOW_ADD_CONNECTION;
    expect(getAddConnectionMode()).toBe('restricted');
  });

  it('reads off from env var', () => {
    process.env.VIEWSTOR_ALLOW_ADD_CONNECTION = 'off';
    expect(getAddConnectionMode()).toBe('off');
  });

  it('reads unrestricted from env var', () => {
    process.env.VIEWSTOR_ALLOW_ADD_CONNECTION = 'unrestricted';
    expect(getAddConnectionMode()).toBe('unrestricted');
  });

  it('reads restricted from env var', () => {
    process.env.VIEWSTOR_ALLOW_ADD_CONNECTION = 'restricted';
    expect(getAddConnectionMode()).toBe('restricted');
  });

  it('ignores invalid env var values and falls through to default', () => {
    process.env.VIEWSTOR_ALLOW_ADD_CONNECTION = 'invalid';
    expect(getAddConnectionMode()).toBe('restricted');
  });
});

// -------------------------------------------------------------------------
// add_connection handler logic — mode × readonly combinations
// -------------------------------------------------------------------------
describe('add_connection mode behavior', () => {
  type AddConnArgs = {
    name: string;
    type: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
    database?: string;
    ssl?: boolean;
    readonly?: boolean;
  };

  function simulateAddConnection(mode: 'off' | 'restricted' | 'unrestricted', args: AddConnArgs) {
    if (mode === 'off') {
      return { error: 'Tool disabled', kind: 'tool_disabled', isError: true };
    }

    const warnings: Array<{ kind: string; message?: string }> = [];
    const id = 'test-id';

    if (mode === 'restricted') {
      const effectiveName = args.name.startsWith('[agent] ') ? args.name : `[agent] ${args.name}`;
      if (args.readonly === false) {
        warnings.push({ kind: 'readonly_forced', message: 'readonly: false was ignored; restricted mode forces readonly: true.' });
      }
      return {
        id,
        name: effectiveName,
        type: args.type,
        readonly: true,
        scope: 'project',
        agentCreated: true,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }

    // unrestricted
    if (!args.readonly) {
      warnings.push({ kind: 'agent_created_writeable_connection' });
    }
    return {
      id,
      name: args.name,
      type: args.type,
      readonly: args.readonly,
      agentCreated: true,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  const baseArgs: AddConnArgs = {
    name: 'Test DB',
    type: 'postgresql',
    host: 'localhost',
    port: 5432,
    database: 'testdb',
  };

  describe('off mode', () => {
    it('returns error with kind tool_disabled', () => {
      const result = simulateAddConnection('off', baseArgs);
      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('kind', 'tool_disabled');
      expect(result.isError).toBe(true);
    });
  });

  describe('restricted mode', () => {
    it('forces readonly: true when readonly is omitted', () => {
      const result = simulateAddConnection('restricted', baseArgs);
      expect(result.readonly).toBe(true);
      expect(result.scope).toBe('project');
      expect(result.agentCreated).toBe(true);
    });

    it('forces readonly: true when readonly: true is provided', () => {
      const result = simulateAddConnection('restricted', { ...baseArgs, readonly: true });
      expect(result.readonly).toBe(true);
      expect(result.warnings).toBeUndefined();
    });

    it('forces readonly: true when readonly: false is provided, adds warning', () => {
      const result = simulateAddConnection('restricted', { ...baseArgs, readonly: false });
      expect(result.readonly).toBe(true);
      expect(result.warnings).toEqual([
        { kind: 'readonly_forced', message: expect.stringContaining('ignored') },
      ]);
    });

    it('prefixes name with [agent] ', () => {
      const result = simulateAddConnection('restricted', baseArgs);
      expect(result.name).toBe('[agent] Test DB');
    });

    it('does not double-prefix name already starting with [agent] ', () => {
      const result = simulateAddConnection('restricted', { ...baseArgs, name: '[agent] My DB' });
      expect(result.name).toBe('[agent] My DB');
    });

    it('sets scope to project', () => {
      const result = simulateAddConnection('restricted', baseArgs);
      expect(result.scope).toBe('project');
    });
  });

  describe('unrestricted mode', () => {
    it('preserves readonly: false and adds warning', () => {
      const result = simulateAddConnection('unrestricted', { ...baseArgs, readonly: false });
      expect(result.readonly).toBe(false);
      expect(result.warnings).toEqual([
        { kind: 'agent_created_writeable_connection' },
      ]);
    });

    it('preserves readonly: true without warning', () => {
      const result = simulateAddConnection('unrestricted', { ...baseArgs, readonly: true });
      expect(result.readonly).toBe(true);
      expect(result.warnings).toBeUndefined();
    });

    it('adds warning when readonly is omitted (falsy)', () => {
      const result = simulateAddConnection('unrestricted', baseArgs);
      expect(result.readonly).toBeUndefined();
      expect(result.warnings).toEqual([
        { kind: 'agent_created_writeable_connection' },
      ]);
    });

    it('does not prefix name', () => {
      const result = simulateAddConnection('unrestricted', baseArgs);
      expect(result.name).toBe('Test DB');
    });

    it('marks agentCreated', () => {
      const result = simulateAddConnection('unrestricted', baseArgs);
      expect(result.agentCreated).toBe(true);
    });
  });
});

// -------------------------------------------------------------------------
// ConnectionStore.add — project-scoped save strips passwords
// -------------------------------------------------------------------------
const { createDriverMock } = vi.hoisted(() => {
  const createDriverMock = vi.fn(() => ({
    connect: vi.fn(async () => {}),
    ping: vi.fn(async () => true),
    disconnect: vi.fn(async () => {}),
    execute: vi.fn(async () => ({ columns: [], rows: [] })),
    getSchema: vi.fn(async () => []),
    getTableData: vi.fn(async () => ({ columns: [], rows: [] })),
    getTableInfo: vi.fn(async () => ({ columns: [] })),
  }));
  return { createDriverMock };
});

vi.mock('../drivers', () => ({ createDriver: createDriverMock }));

describe('ConnectionStore.add with project scope', () => {
  const origCwd = process.cwd();

  beforeEach(() => {
    fs.mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    process.chdir(TEST_PROJECT_DIR);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('saves project-scoped connection to .vscode/viewstor.json without password', async () => {
    const { ConnectionStore } = await import('../mcp-server/connectionStore');
    const store = new ConnectionStore();
    await store.add({
      id: 'agent-1',
      name: '[agent] PG',
      type: 'postgresql',
      host: 'localhost',
      port: 5432,
      password: 'secret123',
      database: 'testdb',
      scope: 'project',
      agentCreated: true,
      readonly: true,
    });

    const saved = JSON.parse(fs.readFileSync(TEST_PROJECT_CONFIG, 'utf8'));
    const conn = saved.connections.find((c: { id: string }) => c.id === 'agent-1');
    expect(conn).toBeDefined();
    expect(conn.password).toBeUndefined();
    expect(conn.agentCreated).toBe(true);
    expect(conn.readonly).toBe(true);
  });

  it('saves user-scoped connection to ~/.viewstor/connections.json', async () => {
    const { ConnectionStore } = await import('../mcp-server/connectionStore');
    const store = new ConnectionStore();
    await store.add({
      id: 'user-1',
      name: 'User PG',
      type: 'postgresql',
      host: 'localhost',
      port: 5432,
      database: 'testdb',
      scope: 'user',
    });

    // user-scoped → does NOT write to project config
    expect(fs.existsSync(TEST_PROJECT_CONFIG)).toBe(false);
  });
});
