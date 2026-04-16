import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `viewstor-test-${Date.now()}`);
const TEST_CONFIG_FILE = path.join(TEST_DIR, 'connections.json');

describe('ConnectionStore file operations', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should write and read connections from JSON file', () => {
    const connections = [
      { id: 'test-1', name: 'Test PG', type: 'postgresql', host: 'localhost', port: 5432, database: 'testdb' },
      { id: 'test-2', name: 'Test Redis', type: 'redis', host: 'localhost', port: 6379 },
    ];
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ connections }, null, 2), 'utf8');

    const data = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf8'));
    expect(data.connections).toHaveLength(2);
    expect(data.connections[0].type).toBe('postgresql');
    expect(data.connections[1].type).toBe('redis');
  });

  it.each([
    ['missing file', () => path.join(TEST_DIR, 'nonexistent.json'), undefined],
    ['invalid JSON', () => { fs.writeFileSync(TEST_CONFIG_FILE, 'not json', 'utf8'); return TEST_CONFIG_FILE; }, undefined],
  ])('should handle %s gracefully', (_desc, getPath) => {
    const filePath = getPath();
    let connections: unknown[] = [];
    try {
      if (fs.existsSync(filePath)) {
        connections = JSON.parse(fs.readFileSync(filePath, 'utf8')).connections;
      }
    } catch {
      connections = [];
    }
    expect(connections).toEqual([]);
  });

  it('should preserve existing connections when adding new ones', () => {
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({
      connections: [{ id: 'pg-1', name: 'PG One', type: 'postgresql', host: 'db1.local', port: 5432 }],
    }, null, 2), 'utf8');

    const data = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf8'));
    const connMap = new Map(data.connections.map((c: { id: string }) => [c.id, c]));
    if (!connMap.has('pg-2')) {
      connMap.set('pg-2', { id: 'pg-2', name: 'PG Two', type: 'postgresql', host: 'db2.local', port: 5432 });
    }
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ connections: Array.from(connMap.values()) }, null, 2), 'utf8');

    const reloaded = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf8'));
    expect(reloaded.connections).toHaveLength(2);
    expect(reloaded.connections.map((c: { name: string }) => c.name).sort()).toEqual(['PG One', 'PG Two']);
  });

  it('should create nested directory for config file', () => {
    const nestedDir = path.join(TEST_DIR, 'nested', '.viewstor');
    const nestedFile = path.join(nestedDir, 'connections.json');

    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(nestedFile, JSON.stringify({ connections: [{ id: 'x', name: 'X' }] }), 'utf8');

    expect(fs.existsSync(nestedFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(nestedFile, 'utf8')).connections[0].id).toBe('x');
  });
});

// -------------------------------------------------------------------------
// ensureDriverForDatabase — driver caching per (connectionId, database)
// -------------------------------------------------------------------------
const { mockDrivers, createDriverMock } = vi.hoisted(() => {
  const mockDrivers: { connect: ReturnType<typeof vi.fn>; ping: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const createDriverMock = vi.fn(() => {
    const driver = {
      connect: vi.fn(async () => {}),
      ping: vi.fn(async () => true),
      disconnect: vi.fn(async () => {}),
      execute: vi.fn(async () => ({ columns: [], rows: [] })),
      getSchema: vi.fn(async () => []),
      getTableData: vi.fn(async () => ({ columns: [], rows: [] })),
      getTableInfo: vi.fn(async () => ({ columns: [] })),
    };
    mockDrivers.push(driver);
    return driver;
  });
  return { mockDrivers, createDriverMock };
});

vi.mock('../drivers', () => ({ createDriver: createDriverMock }));

describe('ConnectionStore.ensureDriverForDatabase', () => {
  beforeEach(() => {
    mockDrivers.length = 0;
    createDriverMock.mockClear();
  });

  async function makeStore() {
    const { ConnectionStore } = await import('../mcp-server/connectionStore');
    const store = new ConnectionStore();
    const config = {
      id: 'pg-main',
      name: 'PG',
      type: 'postgresql' as const,
      host: 'localhost',
      port: 5432,
      username: 'u',
      password: 'p',
      database: 'maindb',
      databases: ['maindb', 'analytics'],
      scope: 'user' as const,
    };
    await store.add(config);
    return store;
  }

  it('returns primary driver when database matches the main database', async () => {
    const store = await makeStore();
    const primary = await store.ensureDriver('pg-main');
    const sameDb = await store.ensureDriverForDatabase('pg-main', 'maindb');
    expect(sameDb).toBe(primary);
  });

  it('creates a new driver for a different database with same credentials', async () => {
    const store = await makeStore();
    await store.ensureDriver('pg-main');
    const analyticsDriver = await store.ensureDriverForDatabase('pg-main', 'analytics');
    expect(analyticsDriver.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: 'localhost', username: 'u', password: 'p', database: 'analytics',
    }));
  });

  it('caches driver per (connectionId, database) — no duplicate creation', async () => {
    const store = await makeStore();
    const first = await store.ensureDriverForDatabase('pg-main', 'analytics');
    const createCount = createDriverMock.mock.calls.length;
    const second = await store.ensureDriverForDatabase('pg-main', 'analytics');
    expect(second).toBe(first);
    expect(createDriverMock.mock.calls.length).toBe(createCount);
  });

  it('concurrent calls for same db share the in-flight driver', async () => {
    const store = await makeStore();
    const [a, b] = await Promise.all([
      store.ensureDriverForDatabase('pg-main', 'analytics'),
      store.ensureDriverForDatabase('pg-main', 'analytics'),
    ]);
    expect(a).toBe(b);
    const connects = mockDrivers.filter(d => d.connect.mock.calls.length > 0);
    const analyticsDrivers = connects.filter(d =>
      (d.connect.mock.calls[0]?.[0] as { database?: string })?.database === 'analytics');
    expect(analyticsDrivers).toHaveLength(1);
  });

  it('recreates driver when cached driver ping fails', async () => {
    const store = await makeStore();
    const first = await store.ensureDriverForDatabase('pg-main', 'analytics');
    first.ping.mockRejectedValueOnce(new Error('lost'));
    const second = await store.ensureDriverForDatabase('pg-main', 'analytics');
    expect(second).not.toBe(first);
    expect(second.connect).toHaveBeenCalled();
  });

  it('throws for unknown connection', async () => {
    const store = await makeStore();
    await expect(store.ensureDriverForDatabase('ghost', 'db')).rejects.toThrow('not found');
  });
});

// -------------------------------------------------------------------------
// MCP tool handler routing: database arg → ensureDriverForDatabase
// -------------------------------------------------------------------------
describe('MCP handler routing for database parameter', () => {
  // Mirrors `resolveDriver(connectionId, database?)` in src/mcp-server/index.ts —
  // verifies the handler picks the right store method based on presence of `database`.
  async function resolveDriver(
    store: { ensureDriver: (id: string) => Promise<unknown>; ensureDriverForDatabase: (id: string, db: string) => Promise<unknown> },
    connectionId: string,
    database?: string,
  ) {
    if (database) return store.ensureDriverForDatabase(connectionId, database);
    return store.ensureDriver(connectionId);
  }

  it('routes to ensureDriver when no database arg', async () => {
    const ensureDriver = vi.fn(async () => 'primary');
    const ensureDriverForDatabase = vi.fn(async () => 'secondary');
    const result = await resolveDriver({ ensureDriver, ensureDriverForDatabase }, 'c1');
    expect(result).toBe('primary');
    expect(ensureDriver).toHaveBeenCalledWith('c1');
    expect(ensureDriverForDatabase).not.toHaveBeenCalled();
  });

  it('routes to ensureDriverForDatabase when database arg present', async () => {
    const ensureDriver = vi.fn(async () => 'primary');
    const ensureDriverForDatabase = vi.fn(async () => 'secondary');
    const result = await resolveDriver({ ensureDriver, ensureDriverForDatabase }, 'c1', 'analytics');
    expect(result).toBe('secondary');
    expect(ensureDriverForDatabase).toHaveBeenCalledWith('c1', 'analytics');
    expect(ensureDriver).not.toHaveBeenCalled();
  });

  it('treats empty-string database as absent (falsy)', async () => {
    const ensureDriver = vi.fn(async () => 'primary');
    const ensureDriverForDatabase = vi.fn(async () => 'secondary');
    await resolveDriver({ ensureDriver, ensureDriverForDatabase }, 'c1', '');
    expect(ensureDriver).toHaveBeenCalled();
    expect(ensureDriverForDatabase).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------
// ConnectionStore.getAgentAccess — inheritance for the standalone MCP server
// -------------------------------------------------------------------------
describe('ConnectionStore.getAgentAccess', () => {
  const HOME_DIR = path.join(os.tmpdir(), `viewstor-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const USER_CONFIG = path.join(HOME_DIR, '.viewstor', 'connections.json');

  beforeEach(() => {
    fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
    vi.stubEnv('HOME', HOME_DIR);
    // os.homedir() is cached at module import time in connectionStore.ts,
    // so we reload the module each test with a fresh env.
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(HOME_DIR, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function makeStoreWith(data: unknown) {
    fs.writeFileSync(USER_CONFIG, JSON.stringify(data, null, 2), 'utf8');
    const { ConnectionStore } = await import('../mcp-server/connectionStore');
    return new ConnectionStore();
  }

  it('returns "full" by default when no override or folder applies', async () => {
    const store = await makeStoreWith({
      connections: [{ id: 'c1', name: 'C1', type: 'postgresql', host: 'h', port: 5432 }],
      folders: [],
    });
    expect(store.getAgentAccess('c1')).toBe('full');
  });

  it('returns the connection\'s own agentAccess when set', async () => {
    const store = await makeStoreWith({
      connections: [{ id: 'c1', name: 'C1', type: 'postgresql', host: 'h', port: 5432, agentAccess: 'none' }],
      folders: [],
    });
    expect(store.getAgentAccess('c1')).toBe('none');
  });

  it('inherits schema-only from folder', async () => {
    const store = await makeStoreWith({
      connections: [{ id: 'c1', name: 'C1', type: 'postgresql', host: 'h', port: 5432, folderId: 'f1' }],
      folders: [{ id: 'f1', name: 'F', sortOrder: 0, agentAccess: 'schema-only' }],
    });
    expect(store.getAgentAccess('c1')).toBe('schema-only');
  });

  it('walks up the folder chain', async () => {
    const store = await makeStoreWith({
      connections: [{ id: 'c1', name: 'C1', type: 'postgresql', host: 'h', port: 5432, folderId: 'child' }],
      folders: [
        { id: 'grand', name: 'Grand', sortOrder: 0, agentAccess: 'none' },
        { id: 'child', name: 'Child', sortOrder: 1, parentFolderId: 'grand' },
      ],
    });
    expect(store.getAgentAccess('c1')).toBe('none');
  });

  it('returns "none" for unknown connection (so MCP treats it as missing)', async () => {
    const store = await makeStoreWith({
      connections: [{ id: 'c1', name: 'C1', type: 'postgresql', host: 'h', port: 5432 }],
      folders: [],
    });
    expect(store.getAgentAccess('ghost')).toBe('none');
  });
});
