import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ADD_CONNECTION_TOOL,
  handleAddConnection,
  resolveAddConnectionMode,
  toolDefinitionsForMode,
  type ToolDef,
} from '../mcp-server/addConnection';
import { handleBuildChart, handleExecuteQuery } from '../mcp-server/queryExecutor';

const TEST_DIR = path.join(os.tmpdir(), `viewstor-add-conn-test-${process.pid}-${Date.now()}`);
const USER_CONFIG_DIR = path.join(TEST_DIR, '.viewstor');
const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, 'connections.json');
const AUDIT_FILE = path.join(USER_CONFIG_DIR, 'audit.jsonl');
const PROJECT_DIR = path.join(TEST_DIR, 'project');
const PROJECT_CONFIG_FILE = path.join(PROJECT_DIR, '.vscode', 'viewstor.json');

vi.mock('../drivers', () => ({
  createDriver: vi.fn(() => ({
    connect: vi.fn(async () => {}),
    ping: vi.fn(async () => true),
    disconnect: vi.fn(async () => {}),
    execute: vi.fn(async () => ({ columns: [], rows: [] })),
    getSchema: vi.fn(async () => []),
    getTableData: vi.fn(async () => ({ columns: [], rows: [] })),
    getTableInfo: vi.fn(async () => ({ columns: [] })),
  })),
}));

describe('add_connection modes', () => {
  const origHome = process.env.HOME;
  const origCwd = process.cwd();

  beforeEach(() => {
    fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
    fs.mkdirSync(PROJECT_DIR, { recursive: true });
    process.env.HOME = TEST_DIR;
    process.chdir(PROJECT_DIR);
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.chdir(origCwd);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function writeUserConfig(data: Record<string, unknown>) {
    fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  }

  function writeProjectConfig(data: Record<string, unknown>) {
    fs.mkdirSync(path.dirname(PROJECT_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(PROJECT_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  }

  async function loadStore() {
    const mod = await import('../mcp-server/connectionStore');
    return new mod.ConnectionStore();
  }

  function input(readonly?: boolean) {
    return {
      name: 'Sandbox',
      type: 'sqlite' as const,
      host: '',
      port: 0,
      database: ':memory:',
      username: 'agent-user',
      password: 'super-secret',
      ...(readonly === undefined ? {} : { readonly }),
    };
  }

  function payload(response: { content: { text: string }[] }) {
    return JSON.parse(response.content[0].text);
  }

  function auditEntries() {
    return fs.readFileSync(AUDIT_FILE, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
  }

  it('defaults a missing or invalid mode to restricted', async () => {
    writeUserConfig({ connections: [] });
    const store = await loadStore();
    expect(resolveAddConnectionMode(store.getSettings().allowAddConnection)).toBe('restricted');
    expect(resolveAddConnectionMode('unexpected')).toBe('restricted');
  });

  it('does not let project settings override the user-owned mode', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'off' } });
    writeProjectConfig({ connections: [], settings: { allowAddConnection: 'unrestricted' } });
    const store = await loadStore();
    expect(store.getSettings().allowAddConnection).toBe('off');
  });

  it('reloads changed user settings', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'restricted' } });
    const store = await loadStore();
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'off' } });
    store.reload();
    expect(store.getSettings().allowAddConnection).toBe('off');
  });

  it.each([true, false, undefined])('restricted mode enforces the final config for readonly=%s', async readonly => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'restricted' } });
    const store = await loadStore();
    const response = await handleAddConnection(store, input(readonly));
    const body = payload(response);
    const saved = store.get(body.id);

    expect(saved).toMatchObject({
      name: '[agent] Sandbox',
      readonly: true,
      scope: 'project',
      agentCreated: true,
    });
    expect((body.warnings ?? []).some((warning: { kind: string }) => warning.kind === 'readonly_forced')).toBe(readonly === false);

    const projectData = JSON.parse(fs.readFileSync(PROJECT_CONFIG_FILE, 'utf8'));
    expect(projectData.connections).toHaveLength(1);
    expect(projectData.connections[0].password).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8')).connections).toEqual([]);
  });

  it.each([true, false, undefined])('unrestricted mode preserves readonly=%s and returns a warning', async readonly => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'unrestricted' } });
    const store = await loadStore();
    const response = await handleAddConnection(store, input(readonly));
    const body = payload(response);
    const saved = store.get(body.id);

    expect(saved?.readonly).toBe(readonly);
    expect(saved?.scope).toBeUndefined();
    expect(saved?.agentCreated).toBe(true);
    expect(body.warnings).toEqual([
      expect.objectContaining({ kind: 'agent_created_writeable_connection' }),
    ]);
    expect(JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8')).connections).toHaveLength(1);
  });

  it.each([true, false, undefined])('off mode rejects readonly=%s, creates nothing, and audits the call', async readonly => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'off' } });
    const store = await loadStore();
    const response = await handleAddConnection(store, input(readonly));

    expect(response.isError).toBe(true);
    expect(payload(response)).toEqual({
      error: 'Tool disabled',
      kind: 'tool_disabled',
      message: 'Configure allowAddConnection in ~/.viewstor/connections.json settings.',
    });
    expect(store.getAll()).toEqual([]);
    expect(auditEntries()).toEqual([
      expect.objectContaining({ tool: 'add_connection', mode: 'off', outcome: 'disabled' }),
    ]);
  });

  it('lists add_connection only in modes where it is enabled', () => {
    const baseTool: ToolDef = {
      name: 'execute_query',
      description: 'query',
      inputSchema: { type: 'object', properties: {} },
    };
    expect(toolDefinitionsForMode([baseTool], 'off')).toEqual([baseTool]);
    for (const mode of ['restricted', 'unrestricted'] as const) {
      expect(toolDefinitionsForMode([baseTool], mode)).toEqual([baseTool, ADD_CONNECTION_TOOL]);
    }
  });

  it.each([
    ['postgresql', 'localhost', 5432],
    ['redis', 'localhost', 6379],
    ['clickhouse', 'localhost', 8123],
    ['sqlite', '', 0],
  ] as const)('applies driver defaults for a minimal %s call', async (type, host, port) => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'restricted' } });
    const store = await loadStore();

    const response = await handleAddConnection(store, { name: `Minimal ${type}`, type });
    const saved = store.get(payload(response).id);

    expect(saved).toMatchObject({ type, host, port });
  });

  it('preserves explicitly supplied host and port', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'restricted' } });
    const store = await loadStore();

    const response = await handleAddConnection(store, {
      name: 'Explicit Redis', type: 'redis', host: 'cache.internal', port: 6380,
    });
    const saved = store.get(payload(response).id);

    expect(saved).toMatchObject({ host: 'cache.internal', port: 6380 });
  });

  it('audits the resolved config without persisting the password', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'restricted' } });
    const store = await loadStore();
    const response = await handleAddConnection(store, input(false));
    const body = payload(response);
    const [entry] = auditEntries();

    expect(entry).toMatchObject({
      tool: 'add_connection',
      mode: 'restricted',
      outcome: 'resolved',
      config: {
        id: body.id,
        name: '[agent] Sandbox',
        readonly: true,
        scope: 'project',
        agentCreated: true,
      },
    });
    expect(JSON.stringify(entry)).not.toContain('super-secret');
    expect(entry.config).not.toHaveProperty('password');
  });

  it('ignores undeclared config fields supplied at runtime', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'restricted' } });
    const store = await loadStore();
    const response = await handleAddConnection(store, {
      ...input(false),
      scope: 'user',
      agentCreated: false,
      proxy: { type: 'ssh', sshPassword: 'proxy-secret' },
      options: { token: 'option-secret' },
    });
    const body = payload(response);
    const saved = store.get(body.id);

    expect(saved).toMatchObject({ readonly: true, scope: 'project', agentCreated: true });
    expect(saved).not.toHaveProperty('proxy');
    expect(saved).not.toHaveProperty('options');
    expect(fs.readFileSync(PROJECT_CONFIG_FILE, 'utf8')).not.toContain('proxy-secret');
    expect(fs.readFileSync(AUDIT_FILE, 'utf8')).not.toContain('option-secret');
  });

  it('preserves existing user settings and folders on unrestricted saves', async () => {
    writeUserConfig({
      connections: [],
      settings: { allowAddConnection: 'unrestricted' },
      folders: [{ id: 'f1', name: 'Folder' }],
    });
    const store = await loadStore();
    await handleAddConnection(store, input());

    const userData = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8'));
    expect(userData.settings).toEqual({ allowAddConnection: 'unrestricted' });
    expect(userData.folders).toEqual([{ id: 'f1', name: 'Folder' }]);
  });

  it('blocks UPDATE through execute_query after restricted connection creation', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'restricted' } });
    const store = await loadStore();
    const added = payload(await handleAddConnection(store, input(false)));
    const driver = await store.ensureDriver(added.id);
    const execute = vi.spyOn(driver, 'execute');

    const response = await handleExecuteQuery(store, {
      connectionId: added.id,
      query: 'UPDATE items SET value = 1',
    });

    expect(response.isError).toBe(true);
    expect(payload(response).error).toContain('Connection is read-only');
    expect(execute).not.toHaveBeenCalled();
  });

  it('blocks raw UPDATE through build_chart before it reaches the driver', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'restricted' } });
    const store = await loadStore();
    const added = payload(await handleAddConnection(store, input(false)));
    const driver = await store.ensureDriver(added.id);
    const execute = vi.spyOn(driver, 'execute');

    const response = await handleBuildChart(store, {
      connectionId: added.id,
      query: 'UPDATE items SET value = 1',
    });

    expect(response.isError).toBe(true);
    expect(payload(response).error).toContain('Connection is read-only');
    expect(execute).not.toHaveBeenCalled();
  });

  it('audits malformed calls without creating a connection', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'restricted' } });
    const store = await loadStore();

    const response = await handleAddConnection(store, { name: '', type: 'sqlite' });

    expect(response.isError).toBe(true);
    expect(payload(response)).toMatchObject({ kind: 'invalid_config' });
    expect(store.getAll()).toEqual([]);
    expect(auditEntries()).toEqual([
      expect.objectContaining({ tool: 'add_connection', mode: 'restricted', outcome: 'rejected' }),
    ]);
  });

  it.each(['restricted', 'unrestricted'] as const)('%s saves merge with fresh external edits', async mode => {
    const project = mode === 'restricted';
    const writeTarget = project ? writeProjectConfig : writeUserConfig;
    const targetFile = project ? PROJECT_CONFIG_FILE : USER_CONFIG_FILE;
    const config = (id: string, name: string) => ({
      id, name, type: 'sqlite', host: '', port: 0, database: ':memory:',
    });
    writeUserConfig({ connections: [], settings: { allowAddConnection: mode } });
    writeTarget({
      connections: [config('edited', 'Before'), config('deleted', 'Delete me'), config('kept', 'Keep me')],
      settings: { allowAddConnection: mode },
      folders: [{ id: 'folder', name: 'Keep folder' }],
      futureTopLevel: 'preserve',
    });
    const store = await loadStore();

    // Simulate VS Code or another process editing the file after this store loaded it.
    writeTarget({
      connections: [config('edited', 'External edit'), config('kept', 'Keep me'), config('external-new', 'Added outside')],
      settings: { allowAddConnection: mode },
      folders: [{ id: 'folder', name: 'Keep folder' }],
      futureTopLevel: 'preserve',
    });
    const added = payload(await handleAddConnection(store, input()));

    const data = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    const byId = new Map(data.connections.map((item: { id: string }) => [item.id, item]));
    expect(byId.get('edited')).toMatchObject({ name: 'External edit' });
    expect(byId.has('deleted')).toBe(false);
    expect(byId.get('external-new')).toMatchObject({ name: 'Added outside' });
    expect(byId.has(added.id)).toBe(true);
    expect(data.futureTopLevel).toBe('preserve');
    expect(data.folders).toEqual([{ id: 'folder', name: 'Keep folder' }]);
    if (project) expect(byId.get(added.id).password).toBeUndefined();
  });

  it('does not update in-memory state when persistence fails and audits the failure', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'restricted' } });
    const store = await loadStore();
    // Make the target's parent path a regular file so the real persistence path fails.
    fs.writeFileSync(path.join(PROJECT_DIR, '.vscode'), 'not a directory', 'utf8');

    await expect(handleAddConnection(store, input())).rejects.toThrow();

    expect(store.getAll()).toEqual([]);
    expect(auditEntries().map((entry: { outcome: string }) => entry.outcome)).toEqual(['resolved', 'persist_failed']);
  });
});
