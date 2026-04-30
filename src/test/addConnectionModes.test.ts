import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `viewstor-add-conn-test-${Date.now()}`);
const USER_CONFIG_DIR = path.join(TEST_DIR, '.viewstor');
const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, 'connections.json');
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
  });

  function writeUserConfig(data: Record<string, unknown>) {
    fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  }

  async function loadStore() {
    const mod = await import('../mcp-server/connectionStore');
    return new mod.ConnectionStore();
  }

  // --- Settings loading ---

  it('defaults allowAddConnection to undefined (caller defaults to restricted)', async () => {
    writeUserConfig({ connections: [] });
    const store = await loadStore();
    expect(store.getSettings().allowAddConnection).toBeUndefined();
  });

  it('reads allowAddConnection from config settings', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'off' } });
    const store = await loadStore();
    expect(store.getSettings().allowAddConnection).toBe('off');
  });

  it('reads allowAddConnection=unrestricted', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'unrestricted' } });
    const store = await loadStore();
    expect(store.getSettings().allowAddConnection).toBe('unrestricted');
  });

  // --- Restricted mode (default) ---

  it('restricted mode: forces readonly=true when agent passes readonly=false', async () => {
    writeUserConfig({ connections: [] });
    const store = await loadStore();
    await store.add({
      id: 'test-1', name: 'Test', type: 'postgresql', host: 'localhost', port: 5432,
      readonly: true, scope: 'project', agentCreated: true,
    });
    const saved = store.get('test-1');
    expect(saved?.readonly).toBe(true);
  });

  it('restricted mode: forces scope=project', async () => {
    writeUserConfig({ connections: [] });
    const store = await loadStore();
    await store.add({
      id: 'test-2', name: '[agent] PG', type: 'postgresql', host: 'localhost', port: 5432,
      scope: 'project', agentCreated: true, readonly: true,
    });
    const saved = store.get('test-2');
    expect(saved?.scope).toBe('project');
  });

  it('restricted mode: project-scoped save strips password', async () => {
    writeUserConfig({ connections: [] });
    const store = await loadStore();
    await store.add({
      id: 'test-pw', name: '[agent] PW', type: 'postgresql', host: 'localhost', port: 5432,
      username: 'user', password: 'secret',
      scope: 'project', agentCreated: true, readonly: true,
    });

    const projectData = JSON.parse(fs.readFileSync(PROJECT_CONFIG_FILE, 'utf8'));
    const conn = projectData.connections.find((c: { id: string }) => c.id === 'test-pw');
    expect(conn).toBeDefined();
    expect(conn.password).toBeUndefined();
  });

  it('restricted mode: prefixes name with [agent]', async () => {
    writeUserConfig({ connections: [] });
    const store = await loadStore();
    await store.add({
      id: 'test-prefix', name: '[agent] My DB', type: 'postgresql', host: 'localhost', port: 5432,
      scope: 'project', agentCreated: true, readonly: true,
    });
    const saved = store.get('test-prefix');
    expect(saved?.name).toBe('[agent] My DB');
  });

  // --- Unrestricted mode ---

  it('unrestricted mode: allows readonly=false', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'unrestricted' } });
    const store = await loadStore();
    await store.add({
      id: 'test-unr', name: 'Unr', type: 'postgresql', host: 'localhost', port: 5432,
      readonly: false, agentCreated: true,
    });
    const saved = store.get('test-unr');
    expect(saved?.readonly).toBe(false);
  });

  it('unrestricted mode: saves to user config by default', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'unrestricted' } });
    const store = await loadStore();
    await store.add({
      id: 'test-user', name: 'User', type: 'postgresql', host: 'localhost', port: 5432,
      agentCreated: true,
    });
    const userData = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8'));
    const conn = userData.connections.find((c: { id: string }) => c.id === 'test-user');
    expect(conn).toBeDefined();
  });

  // --- agentCreated flag ---

  it('sets agentCreated=true on added connections', async () => {
    writeUserConfig({ connections: [] });
    const store = await loadStore();
    await store.add({
      id: 'test-ac', name: '[agent] AC', type: 'sqlite', host: '', port: 0,
      database: ':memory:', agentCreated: true, readonly: true, scope: 'project',
    });
    expect(store.get('test-ac')?.agentCreated).toBe(true);
  });

  // --- Off mode ---

  it('off mode: tool is not listed (verified by settings value)', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'off' } });
    const store = await loadStore();
    expect(store.getSettings().allowAddConnection).toBe('off');
  });

  // --- Settings reload ---

  it('reload picks up changed settings', async () => {
    writeUserConfig({ connections: [], settings: { allowAddConnection: 'restricted' } });
    const store = await loadStore();
    expect(store.getSettings().allowAddConnection).toBe('restricted');

    writeUserConfig({ connections: [], settings: { allowAddConnection: 'off' } });
    store.reload();
    expect(store.getSettings().allowAddConnection).toBe('off');
  });
});
