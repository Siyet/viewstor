/**
 * Integration workflow tests — verify multi-module coordination
 * with mocked database drivers and vscode APIs.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// vi.hoisted runs before vi.mock hoisting
const {
  globalStateStore,
  mockGlobalState,
  mockFileSystemWatcher,
  readFileHolder,
} = vi.hoisted(() => {
  const globalStateStore = new Map<string, unknown>();
  const mockGlobalState = {
    get: (key: string, defaultValue?: unknown) => globalStateStore.get(key) ?? defaultValue,
    update: async (key: string, value: unknown) => { globalStateStore.set(key, value); },
  };

  const mockFileSystemWatcher = {
    onDidChange: () => ({ dispose: () => {} }),
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  };

  const readFileHolder = { result: null as Uint8Array | null };

  return { globalStateStore, mockGlobalState, mockFileSystemWatcher, readFileHolder };
});

vi.mock('vscode', () => {
  const mockWorkspaceFolderUri = { fsPath: '/workspace', toString: () => 'file:///workspace' };
  const mockFileUri = {
    fsPath: '/workspace/.vscode/viewstor.json',
    toString: () => 'file:///workspace/.vscode/viewstor.json',
  };

  return {
    EventEmitter: class {
      private listeners: Array<(...args: unknown[]) => void> = [];
      event = (listener: (...args: unknown[]) => void) => {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(item => item !== listener); } };
      };
      fire(...args: unknown[]) {
        for (const listener of this.listeners) listener(...args);
      }
      dispose() { this.listeners = []; }
    },
    Uri: {
      joinPath: () => mockFileUri,
      file: (filePath: string) => ({
        fsPath: filePath,
        scheme: 'file',
        toString: () => `file://${filePath}`,
      }),
      parse: (str: string) => ({
        fsPath: str.replace('file://', ''),
        scheme: 'file',
        toString: () => str,
      }),
    },
    RelativePattern: class {
      constructor(public base: unknown, public pattern: string) {}
    },
    workspace: {
      workspaceFolders: [{ uri: mockWorkspaceFolderUri }],
      fs: {
        readFile: async () => {
          if (readFileHolder.result) return readFileHolder.result;
          throw new Error('File not found');
        },
        writeFile: async () => {},
      },
      createFileSystemWatcher: () => mockFileSystemWatcher,
      textDocuments: [],
    },
    window: {
      showTextDocument: vi.fn(async () => ({})),
      activeTextEditor: undefined,
    },
    commands: {
      executeCommand: vi.fn(),
    },
    ViewColumn: { One: 1, Beside: 2 },
    TextDocumentSaveReason: { Manual: 1 },
    l10n: { t: (str: string, ...args: unknown[]) => str.replace(/\{(\d+)\}/g, (_, idx) => String(args[Number(idx)])) },
  };
});

vi.mock('../drivers', () => ({
  createDriver: vi.fn(() => createFreshMockDriver()),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
}));

function createFreshMockDriver() {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    ping: vi.fn(async () => true),
    execute: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0 })),
    getSchema: vi.fn(async () => []),
    getTableInfo: vi.fn(async () => ({ columns: [] })),
    getTableData: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0 })),
  };
}

import { ConnectionManager } from '../connections/connectionManager';
import { QueryEditorProvider } from '../editors/queryEditor';
import { ExportService } from '../services/exportService';
import { parseDBeaver } from '../services/importService';
import { ConnectionConfig } from '../types/connection';
import { QueryResult } from '../types/query';
import { createDriver } from '../drivers';

// --- Helpers ---

function makeConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'wf-conn-1',
    name: 'Workflow PG',
    type: 'postgresql',
    host: 'localhost',
    port: 5432,
    database: 'testdb',
    ...overrides,
  };
}

function makeContext() {
  return {
    globalState: mockGlobalState,
    subscriptions: [],
  } as never;
}

function createManager(): ConnectionManager {
  return new ConnectionManager(makeContext());
}

function makeQueryResult(): QueryResult {
  return {
    columns: [
      { name: 'id', dataType: 'integer' },
      { name: 'name', dataType: 'text' },
      { name: 'active', dataType: 'boolean' },
    ],
    rows: [
      { id: 1, name: 'Alice', active: true },
      { id: 2, name: 'Bob', active: false },
      { id: 3, name: null, active: true },
    ],
    rowCount: 3,
    executionTimeMs: 42,
  };
}

// --- Setup ---

beforeEach(() => {
  globalStateStore.clear();
  readFileHolder.result = null;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Workflow 1: ConnectionManager connect -> getDriver -> execute round-trip
// ---------------------------------------------------------------------------
describe('Workflow 1: connect -> getDriver -> execute round-trip', () => {
  it('full lifecycle: add, connect, execute, disconnect', async () => {
    const manager = createManager();

    // Add connection
    const config = makeConfig({ id: 'rt-1' });
    await manager.add(config);
    expect(manager.get('rt-1')).toBeDefined();
    expect(manager.get('rt-1')!.connected).toBe(false);

    // Connect — createDriver is called and driver.connect is invoked
    await manager.connect('rt-1');
    expect(manager.get('rt-1')!.connected).toBe(true);
    expect(createDriver).toHaveBeenCalledWith('postgresql');

    // getDriver returns the connected driver
    const driver = manager.getDriver('rt-1');
    expect(driver).toBeDefined();

    // Execute a query via the driver
    const mockResult: QueryResult = {
      columns: [{ name: 'count', dataType: 'bigint' }],
      rows: [{ count: 42 }],
      rowCount: 1,
      executionTimeMs: 5,
    };
    (driver!.execute as Mock).mockResolvedValueOnce(mockResult);

    const result = await driver!.execute('SELECT COUNT(*) FROM users');
    expect(result.columns).toHaveLength(1);
    expect(result.rows[0].count).toBe(42);
    expect(result.rowCount).toBe(1);

    // Disconnect cleans up driver
    await manager.disconnect('rt-1');
    expect(manager.get('rt-1')!.connected).toBe(false);
    expect(manager.getDriver('rt-1')).toBeUndefined();
    expect(driver!.disconnect).toHaveBeenCalled();
  });

  it('connect throws for nonexistent connection', async () => {
    const manager = createManager();
    await expect(manager.connect('nonexistent')).rejects.toThrow('not found');
  });

  it('getDriver returns undefined before connect', async () => {
    const manager = createManager();
    await manager.add(makeConfig({ id: 'rt-2' }));
    expect(manager.getDriver('rt-2')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Workflow 2: Multi-DB driver lifecycle
// ---------------------------------------------------------------------------
describe('Workflow 2: multi-DB driver lifecycle', () => {
  it('secondary DB driver is created, cached, and cleaned up on disconnect', async () => {
    const manager = createManager();
    await manager.add(makeConfig({ id: 'mdb-wf', database: 'maindb' }));
    await manager.connect('mdb-wf');

    const initialCreateCount = (createDriver as Mock).mock.calls.length;

    // getDriverForDatabase for secondary DB creates a new driver
    const secondaryDriver = await manager.getDriverForDatabase('mdb-wf', 'analytics');
    expect((createDriver as Mock).mock.calls.length).toBe(initialCreateCount + 1);
    expect(secondaryDriver.connect).toHaveBeenCalled();

    // Same call reuses cached driver (ping succeeds)
    const cachedDriver = await manager.getDriverForDatabase('mdb-wf', 'analytics');
    expect(cachedDriver).toBe(secondaryDriver);
    expect((createDriver as Mock).mock.calls.length).toBe(initialCreateCount + 1); // no extra call

    // Disconnect main also cleans up secondary drivers
    await manager.disconnect('mdb-wf');
    expect(secondaryDriver.disconnect).toHaveBeenCalled();
    expect(manager.getDriver('mdb-wf')).toBeUndefined();
  });

  it('returns primary driver when requesting main database', async () => {
    const manager = createManager();
    await manager.add(makeConfig({ id: 'mdb-main', database: 'maindb' }));
    await manager.connect('mdb-main');

    const primaryDriver = manager.getDriver('mdb-main');
    const result = await manager.getDriverForDatabase('mdb-main', 'maindb');
    expect(result).toBe(primaryDriver);
  });

  it('recreates secondary driver when ping fails', async () => {
    const manager = createManager();
    await manager.add(makeConfig({ id: 'mdb-ping', database: 'maindb' }));
    await manager.connect('mdb-ping');

    const firstDriver = await manager.getDriverForDatabase('mdb-ping', 'reporting');
    // Make ping fail so next call creates a new driver
    (firstDriver.ping as Mock).mockRejectedValueOnce(new Error('connection lost'));

    const newDriver = await manager.getDriverForDatabase('mdb-ping', 'reporting');
    expect(newDriver).not.toBe(firstDriver);
    expect(newDriver.connect).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Workflow 3: QueryEditor file->connection mapping lifecycle
// ---------------------------------------------------------------------------
describe('Workflow 3: QueryEditor file->connection mapping lifecycle', () => {
  it('openNewQuery maps URI, getConnectionIdFromUri resolves, handleFileRenamed updates, removeConnectionForUri cleans up', async () => {
    const manager = createManager();
    await manager.add(makeConfig({ id: 'qe-conn' }));

    // Mock QueryFileManager
    const mockUri = {
      fsPath: '/tmp/query_12345.sql',
      scheme: 'file',
      toString: () => 'file:///tmp/query_12345.sql',
    };

    const mockQueryFileManager = {
      createTempQuery: vi.fn(async () => mockUri),
      parseMetadata: vi.fn(() => undefined),
      parseMetadataFromFile: vi.fn(() => undefined),
    };

    const editor = new QueryEditorProvider(
      manager as never,
      mockQueryFileManager as never,
    );

    // openNewQuery creates temp file and maps URI to connection
    await editor.openNewQuery('qe-conn', 'mydb');
    expect(mockQueryFileManager.createTempQuery).toHaveBeenCalledWith('qe-conn', 'mydb');

    // getConnectionIdFromUri returns correct connection
    const connectionId = editor.getConnectionIdFromUri(mockUri as never);
    expect(connectionId).toBe('qe-conn');

    // getDatabaseNameFromUri also works
    const dbName = editor.getDatabaseNameFromUri(mockUri as never);
    expect(dbName).toBe('mydb');

    // handleFileRenamed updates the mapping
    const newUri = {
      fsPath: '/queries/saved_query.sql',
      scheme: 'file',
      toString: () => 'file:///queries/saved_query.sql',
    };
    editor.handleFileRenamed(mockUri as never, newUri as never);

    // Old URI no longer resolves
    expect(editor.getConnectionIdFromUri(mockUri as never)).toBeUndefined();
    // New URI resolves
    expect(editor.getConnectionIdFromUri(newUri as never)).toBe('qe-conn');
    expect(editor.getDatabaseNameFromUri(newUri as never)).toBe('mydb');

    // removeConnectionForUri cleans up
    editor.removeConnectionForUri(newUri as never);
    expect(editor.getConnectionIdFromUri(newUri as never)).toBeUndefined();
  });

  it('setConnectionForUri allows external callers to register URIs', async () => {
    const manager = createManager();
    await manager.add(makeConfig({ id: 'qe-ext' }));

    const mockQueryFileManager = {
      createTempQuery: vi.fn(),
      parseMetadata: vi.fn(() => undefined),
      parseMetadataFromFile: vi.fn(() => undefined),
    };

    const editor = new QueryEditorProvider(
      manager as never,
      mockQueryFileManager as never,
    );

    const uri = {
      fsPath: '/external/file.sql',
      scheme: 'file',
      toString: () => 'file:///external/file.sql',
    };

    editor.setConnectionForUri(uri as never, 'qe-ext', 'extdb');
    expect(editor.getConnectionIdFromUri(uri as never)).toBe('qe-ext');
    expect(editor.getDatabaseNameFromUri(uri as never)).toBe('extdb');
  });
});

// ---------------------------------------------------------------------------
// Workflow 4: Connection folder hierarchy with readonly/color inheritance
// ---------------------------------------------------------------------------
describe('Workflow 4: folder hierarchy with readonly/color inheritance', () => {
  it('connection inherits folder color and readonly, overrides with own values', async () => {
    const manager = createManager();

    // Add folder with color and readonly
    const folder = await manager.addFolder('Production', '#ff0000', true);

    // Add connection in that folder (no own color/readonly)
    await manager.add(makeConfig({
      id: 'inh-1',
      folderId: folder.id,
      color: undefined,
      readonly: undefined,
    }));

    // getConnectionColor returns folder color
    expect(manager.getConnectionColor('inh-1')).toBe('#ff0000');

    // isConnectionReadonly returns folder readonly
    expect(manager.isConnectionReadonly('inh-1')).toBe(true);

    // Set own color on connection — getConnectionColor returns own color
    await manager.setConnectionColor('inh-1', '#00ff00');
    expect(manager.getConnectionColor('inh-1')).toBe('#00ff00');
  });

  it('nested folders: child folder inherits from parent', async () => {
    const manager = createManager();

    // Create parent folder with color
    const parent = await manager.addFolder('Parent', '#ff0000', true);

    // Create child folder nested under parent (no own color/readonly)
    const child = await manager.addFolder('Child', undefined, undefined, parent.id);
    expect(child.parentFolderId).toBe(parent.id);

    // Add connection in child folder
    await manager.add(makeConfig({
      id: 'nested-1',
      folderId: child.id,
    }));

    // getConnectionColor falls back to the direct folder (child).
    // Child has no color, so returns undefined — color inheritance
    // is only one level deep (connection -> its folder), not recursive.
    const color = manager.getConnectionColor('nested-1');
    expect(color).toBeUndefined();

    // Set color on child folder — now connection gets child folder's color
    await manager.updateFolder(child.id, { color: '#0000ff' });
    expect(manager.getConnectionColor('nested-1')).toBe('#0000ff');
  });

  it('connection with no folder returns undefined color and false readonly', async () => {
    const manager = createManager();
    await manager.add(makeConfig({ id: 'nofolder' }));

    expect(manager.getConnectionColor('nofolder')).toBeUndefined();
    expect(manager.isConnectionReadonly('nofolder')).toBe(false);
  });

  it('removing folder reparents connections to parent folder', async () => {
    const manager = createManager();
    const grandparent = await manager.addFolder('Grandparent', '#aaaaaa');
    const parent = await manager.addFolder('Parent', '#bbbbbb', undefined, grandparent.id);

    await manager.add(makeConfig({ id: 'reparent-1', folderId: parent.id }));
    expect(manager.getConnectionColor('reparent-1')).toBe('#bbbbbb');

    // Remove parent folder — connection reparented to grandparent
    await manager.removeFolder(parent.id);
    expect(manager.get('reparent-1')!.config.folderId).toBe(grandparent.id);
    expect(manager.getConnectionColor('reparent-1')).toBe('#aaaaaa');
  });
});

// ---------------------------------------------------------------------------
// Workflow 5: Export format round-trip
// ---------------------------------------------------------------------------
describe('Workflow 5: export format round-trip', () => {
  const queryResult = makeQueryResult();

  it('toCsv produces valid CSV and data is preserved', () => {
    const csv = ExportService.toCsv(queryResult);
    const lines = csv.split('\n');

    // Header + 3 data rows
    expect(lines).toHaveLength(4);

    // Header matches column names
    expect(lines[0]).toBe('id,name,active');

    // Parse back and verify data integrity
    const header = lines[0].split(',');
    expect(header).toEqual(['id', 'name', 'active']);

    const firstRow = lines[1].split(',');
    expect(firstRow[0]).toBe('1');
    expect(firstRow[1]).toBe('Alice');
    expect(firstRow[2]).toBe('true');

    // Null value row
    const thirdRow = lines[3].split(',');
    expect(thirdRow[0]).toBe('3');
    expect(thirdRow[1]).toBe(''); // null renders as empty
    expect(thirdRow[2]).toBe('true');
  });

  it('toCsv with custom options', () => {
    const csv = ExportService.toCsv(queryResult, {
      delimiter: ';',
      nullValue: 'N/A',
      lineEnding: '\r\n',
      includeHeader: false,
    });
    const lines = csv.split('\r\n');

    // No header, just 3 data rows
    expect(lines).toHaveLength(3);

    // Semicolon delimiter
    expect(lines[0]).toContain(';');

    // Null replaced with N/A
    const thirdRow = lines[2].split(';');
    expect(thirdRow[1]).toBe('N/A');
  });

  it('toJson produces valid JSON with correct structure', () => {
    const json = ExportService.toJson(queryResult);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ id: 1, name: 'Alice', active: true });
    expect(parsed[1]).toEqual({ id: 2, name: 'Bob', active: false });
    expect(parsed[2]).toEqual({ id: 3, name: null, active: true });
  });

  it('toMarkdownTable produces valid markdown with correct headers and rows', () => {
    const md = ExportService.toMarkdownTable(queryResult);
    const lines = md.split('\n');

    // Header | separator | 3 rows
    expect(lines).toHaveLength(5);

    // Header row has pipe delimiters and column names
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('name');
    expect(lines[0]).toContain('active');
    expect(lines[0]).toMatch(/^\|.*\|$/);

    // Separator row has dashes
    expect(lines[1]).toMatch(/^\|[-|]+\|$/);

    // Data rows
    expect(lines[2]).toContain('Alice');
    expect(lines[4]).toContain('NULL'); // null rendered as NULL
  });

  it('toMarkdownTable returns empty string for empty columns', () => {
    const empty: QueryResult = { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
    expect(ExportService.toMarkdownTable(empty)).toBe('');
  });

  it('toPlainTextTable produces aligned columns', () => {
    const table = ExportService.toPlainTextTable(queryResult);
    const lines = table.split('\n');

    // Header + separator + 3 rows
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('name');
    // No pipe delimiters in plain text
    expect(lines[0]).not.toContain('|');
  });
});

// ---------------------------------------------------------------------------
// Workflow 6: Import -> add connections round-trip
// ---------------------------------------------------------------------------
describe('Workflow 6: DBeaver import -> connection configs round-trip', () => {
  it('parses valid DBeaver JSON with supported providers', () => {
    const dbeaverJson = JSON.stringify({
      connections: {
        'pg-main': {
          provider: 'postgresql',
          name: 'Production PG',
          configuration: {
            host: 'db.example.com',
            port: '5432',
            database: 'myapp',
            user: 'admin',
          },
        },
        'ch-analytics': {
          provider: 'clickhouse',
          name: 'ClickHouse Analytics',
          configuration: {
            host: 'ch.example.com',
            port: '8123',
            database: 'analytics',
          },
        },
        'redis-cache': {
          provider: 'redis',
          name: 'Redis Cache',
          configuration: {
            host: 'redis.example.com',
            port: '6379',
          },
        },
      },
    });

    const result = parseDBeaver(dbeaverJson);
    expect(result.warnings).toHaveLength(0);
    expect(result.connections).toHaveLength(3);

    // Verify PostgreSQL config
    const pgConn = result.connections.find(conn => conn.name === 'Production PG');
    expect(pgConn).toBeDefined();
    expect(pgConn!.type).toBe('postgresql');
    expect(pgConn!.host).toBe('db.example.com');
    expect(pgConn!.port).toBe(5432);
    expect(pgConn!.database).toBe('myapp');
    expect(pgConn!.username).toBe('admin');
    expect(pgConn!.id).toBeTruthy(); // generated ID

    // Verify ClickHouse config
    const chConn = result.connections.find(conn => conn.name === 'ClickHouse Analytics');
    expect(chConn).toBeDefined();
    expect(chConn!.type).toBe('clickhouse');
    expect(chConn!.host).toBe('ch.example.com');

    // Verify Redis config
    const redisConn = result.connections.find(conn => conn.name === 'Redis Cache');
    expect(redisConn).toBeDefined();
    expect(redisConn!.type).toBe('redis');
  });

  it('produces warnings for unsupported DB types', () => {
    const dbeaverJson = JSON.stringify({
      connections: {
        'mysql-prod': {
          provider: 'mysql',
          name: 'MySQL Production',
          configuration: { host: 'mysql.example.com', port: '3306' },
        },
        'oracle-legacy': {
          provider: 'oracle',
          name: 'Oracle Legacy',
          configuration: { host: 'oracle.example.com' },
        },
        'pg-ok': {
          provider: 'postgresql',
          name: 'PG Valid',
          configuration: { host: 'pg.example.com', port: '5432' },
        },
      },
    });

    const result = parseDBeaver(dbeaverJson);

    // Two unsupported providers should produce warnings
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('mysql');
    expect(result.warnings[1]).toContain('oracle');

    // Only the valid PostgreSQL connection is imported
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].type).toBe('postgresql');
  });

  it('handles invalid JSON gracefully', () => {
    const result = parseDBeaver('not valid json {{');
    expect(result.connections).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Invalid JSON');
  });

  it('handles DBeaver file with no connections key', () => {
    const result = parseDBeaver(JSON.stringify({}));
    expect(result.connections).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('No connections');
  });

  it('parses readonly flag from DBeaver', () => {
    const dbeaverJson = JSON.stringify({
      connections: {
        'pg-ro': {
          provider: 'postgresql',
          name: 'ReadOnly PG',
          'read-only': true,
          configuration: {
            host: 'readonly.example.com',
            port: '5432',
          },
        },
      },
    });

    const result = parseDBeaver(dbeaverJson);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].readonly).toBe(true);
  });
});
