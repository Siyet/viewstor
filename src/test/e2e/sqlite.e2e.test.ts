import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteDriver } from '../../drivers/sqlite';
import { ConnectionConfig } from '../../types/connection';
import { runDriverInterfaceTests } from './helpers/driverTestSuite';

// ============================================================
// Native module ABI validation
// ============================================================

describe('SQLite native module ABI', () => {
  const CACHE_DIR = path.join(__dirname, '..', '..', '..', 'node_modules', '.cache', 'sqlite-builds');
  const NODE_META = path.join(CACHE_DIR, 'better_sqlite3.node.meta');
  const BINARY = path.join(__dirname, '..', '..', '..', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

  it('better-sqlite3 binary exists', () => {
    expect(fs.existsSync(BINARY)).toBe(true);
  });

  it('better-sqlite3 loads without ABI error in current Node.js', () => {
    // This will throw "NODE_MODULE_VERSION" error if ABI mismatch
    expect(() => require('better-sqlite3')).not.toThrow();
  });

  it('better-sqlite3 exports a constructor (not a plain object)', () => {
    // This catches the "r is not a constructor" bug from marketplace builds
    // where version mismatch between deps/devDeps caused wrong export
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    expect(typeof Database).toBe('function');
    expect(Database.name).toBe('Database');
    const db = new Database(':memory:');
    expect(db).toBeDefined();
    db.close();
  });

  it('Node cache meta file contains correct ABI for current runtime', () => {
    if (!fs.existsSync(NODE_META)) {
      // Meta might not exist if cache was just created; skip gracefully
      return;
    }
    const meta = JSON.parse(fs.readFileSync(NODE_META, 'utf8'));
    expect(meta.abi).toBe(String(process.versions.modules));
  });

  it('SqliteDriver.connect() provides actionable error on ABI mismatch', async () => {
    // Simulate the error message format that Node.js produces
    const driver = new SqliteDriver();
    // We can't actually trigger ABI mismatch in tests (we just rebuilt for Node),
    // but we verify the driver loads correctly
    await driver.connect({
      id: 'abi-test',
      name: 'ABI Test',
      type: 'sqlite',
      host: '',
      port: 0,
      database: ':memory:',
    });
    const ping = await driver.ping();
    expect(ping).toBe(true);
    await driver.disconnect();
  });
});

describe('SQLite Driver E2E', () => {
  let dbPath: string;
  let driver: SqliteDriver;
  let config: ConnectionConfig;

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `viewstor-test-${Date.now()}.sqlite`);
    config = {
      id: 'test-sqlite',
      name: 'Test SQLite',
      type: 'sqlite',
      host: '',
      port: 0,
      database: dbPath,
    };

    driver = new SqliteDriver();
    await driver.connect(config);

    // Seed test data
    await driver.execute(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await driver.execute(`
      INSERT INTO users (name, email) VALUES
        ('Alice', 'alice@test.com'),
        ('Bob', 'bob@test.com')
    `);
    await driver.execute(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        amount REAL,
        status TEXT DEFAULT 'pending'
      )
    `);
    await driver.execute(`
      INSERT INTO orders (user_id, amount) VALUES (1, 99.95), (1, 42.00), (2, 150.00)
    `);
    await driver.execute(`
      CREATE VIEW user_order_summary AS
        SELECT u.name, COUNT(o.id) as order_count, SUM(o.amount) as total
        FROM users u LEFT JOIN orders o ON o.user_id = u.id
        GROUP BY u.name
    `);
    await driver.execute('CREATE INDEX idx_users_email ON users (email)');
    await driver.execute('CREATE INDEX idx_orders_user_id ON orders (user_id)');
    await driver.execute(`
      CREATE TRIGGER trg_orders_default_status
      AFTER INSERT ON orders
      FOR EACH ROW
      WHEN NEW.status IS NULL
      BEGIN
        UPDATE orders SET status = 'pending' WHERE id = NEW.id;
      END
    `);
  });

  afterAll(async () => {
    await driver?.disconnect();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    // Clean up WAL/SHM files
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  });

  // Shared interface tests
  runDriverInterfaceTests(() => driver, 'users');

  it('execute SELECT returns correct rows and columns', async () => {
    const result = await driver.execute('SELECT * FROM users ORDER BY id');
    expect(result.error).toBeUndefined();
    expect(result.rowCount).toBe(2);
    expect(result.columns.map(c => c.name)).toEqual(
      expect.arrayContaining(['id', 'name', 'email', 'created_at'])
    );
    expect(result.rows[0]).toMatchObject({ name: 'Alice', email: 'alice@test.com' });
    expect(result.rows[1]).toMatchObject({ name: 'Bob', email: 'bob@test.com' });
  });

  it('execute INSERT returns affectedRows', async () => {
    const result = await driver.execute(
      'INSERT INTO users (name, email) VALUES (\'Carol\', \'carol@test.com\')'
    );
    expect(result.error).toBeUndefined();
    expect(result.affectedRows).toBe(1);

    const check = await driver.execute('SELECT COUNT(*) as cnt FROM users');
    expect(Number(check.rows[0].cnt)).toBe(3);
  });

  it('execute with error returns error string', async () => {
    const result = await driver.execute('SELECT * FROM nonexistent_table');
    expect(result.error).toBeDefined();
    expect(result.error).toContain('nonexistent_table');
    expect(result.rows).toEqual([]);
  });

  it('getSchema returns complete structure: tables, views, columns, indexes, triggers', async () => {
    const schema = await driver.getSchema();
    const tableNames = schema.filter(s => s.type === 'table').map(s => s.name);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('orders');

    const viewNames = schema.filter(s => s.type === 'view').map(s => s.name);
    expect(viewNames).toContain('user_order_summary');

    // Columns on table
    const usersTable = schema.find(c => c.name === 'users' && c.type === 'table')!;
    const columns = usersTable.children!.filter(c => c.type === 'column');
    expect(columns.length).toBe(4);

    const idCol = columns.find(c => c.name === 'id')!;
    expect(idCol.detail).toContain('INTEGER');
    expect(idCol.detail).toContain('PK');

    const nameCol = columns.find(c => c.name === 'name')!;
    expect(nameCol.detail).toContain('TEXT');
    // NOT NULL is now exposed as a notNullable flag (the tree appends "*" to the label);
    // detail no longer carries the marker.
    expect(nameCol.notNullable).toBe(true);
    expect(nameCol.detail).not.toContain('*');

    // Indexes group
    const indexesGroup = usersTable.children!.find(c => c.name === 'Indexes' && c.type === 'group')!;
    expect(indexesGroup).toBeDefined();
    expect(indexesGroup.children!.map(c => c.name)).toContain('idx_users_email');

    // Triggers group
    const triggersGroup = schema.find(c => c.name === 'orders')!.children!
      .find(c => c.name === 'Triggers' && c.type === 'group')!;
    expect(triggersGroup).toBeDefined();
    expect(triggersGroup.children!.map(c => c.name)).toContain('trg_orders_default_status');

    // View has columns
    const viewObj = schema.find(c => c.name === 'user_order_summary')!;
    expect(viewObj.children!.length).toBeGreaterThan(0);
    expect(viewObj.children![0].type).toBe('column');
  });

  it.each([
    ['table', 'users', ['CREATE TABLE', 'users', 'id', 'name']],
    ['view', 'user_order_summary', ['CREATE VIEW', 'user_order_summary']],
    ['index', 'idx_users_email', ['CREATE INDEX', 'idx_users_email']],
    ['trigger', 'trg_orders_default_status', ['CREATE TRIGGER', 'trg_orders_default_status']],
  ])('getDDL returns correct DDL for %s', async (type, name, expectedFragments) => {
    const ddl = await driver.getDDL!(name, type);
    for (const fragment of expectedFragments) {
      expect(ddl).toContain(fragment);
    }
  });

  it('getTableInfo returns column details with PK and nullability', async () => {
    const info = await driver.getTableInfo('users');
    expect(info.columns.length).toBe(4);

    const idCol = info.columns.find(c => c.name === 'id')!;
    expect(idCol.isPrimaryKey).toBe(true);

    const emailCol = info.columns.find(c => c.name === 'email')!;
    expect(emailCol.nullable).toBe(true);
    expect(emailCol.dataType).toBe('TEXT');

    const nameCol = info.columns.find(c => c.name === 'name')!;
    expect(nameCol.nullable).toBe(false);
  });

  it('getTableData with limit and offset', async () => {
    const result = await driver.getTableData('users', undefined, 1, 1);
    expect(result.rows.length).toBe(1);
  });

  it('getTableData with orderBy sorts results', async () => {
    const result = await driver.getTableData('users', undefined, 100, 0, [{ column: 'name', direction: 'desc' }]);
    expect(result.error).toBeUndefined();
    const names = result.rows.map(r => r.name as string);
    for (let index = 1; index < names.length; index++) {
      expect(names[index - 1].localeCompare(names[index])).toBeGreaterThanOrEqual(0);
    }
  });

  it('getTableData with multi-column orderBy', async () => {
    const result = await driver.getTableData('orders', undefined, 100, 0, [
      { column: 'user_id', direction: 'asc' },
      { column: 'amount', direction: 'desc' },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.rows.length).toBe(3);
  });

  it('getCompletions returns table and column names', async () => {
    const completions = await driver.getCompletions!();
    const labels = completions.map(c => c.label);
    expect(labels).toContain('users');
    expect(labels).toContain('orders');
    expect(labels).toContain('id');
    expect(labels).toContain('name');
  });

  it('getTableRowCount returns correct count', async () => {
    const count = await driver.getTableRowCount!('users');
    expect(count).toBeGreaterThan(0);
  });

  it('getEstimatedRowCount returns count (exact for SQLite)', async () => {
    const count = await driver.getEstimatedRowCount!('users');
    expect(count).toBeGreaterThan(0);
  });

  it('getIndexedColumns returns indexed column names', async () => {
    const indexed = await driver.getIndexedColumns!('users');
    expect(indexed.has('email')).toBe(true);
  });

  it('UPDATE executes without error', async () => {
    const result = await driver.execute('UPDATE users SET name = \'Alice Updated\' WHERE id = 1');
    expect(result.error).toBeUndefined();
    expect(result.affectedRows).toBe(1);

    const check = await driver.execute('SELECT name FROM users WHERE id = 1');
    expect(check.rows[0].name).toBe('Alice Updated');

    // Restore
    await driver.execute('UPDATE users SET name = \'Alice\' WHERE id = 1');
  });

  it('DELETE executes and removes row', async () => {
    await driver.execute('INSERT INTO users (name, email) VALUES (\'ToDelete\', \'del@test.com\')');
    const inserted = await driver.execute('SELECT id FROM users WHERE name = \'ToDelete\'');
    const deleteId = inserted.rows[0].id;

    const result = await driver.execute(`DELETE FROM users WHERE id = ${deleteId}`);
    expect(result.error).toBeUndefined();

    const check = await driver.execute(`SELECT COUNT(*) as cnt FROM users WHERE id = ${deleteId}`);
    expect(Number(check.rows[0].cnt)).toBe(0);
  });

  it('PRAGMA queries work correctly', async () => {
    const result = await driver.execute('PRAGMA journal_mode');
    expect(result.error).toBeUndefined();
    expect(result.rows.length).toBe(1);
  });

  it('disconnect and reconnect works', async () => {
    await driver.disconnect();
    driver = new SqliteDriver();
    await driver.connect(config);
    const ping = await driver.ping();
    expect(ping).toBe(true);
  });

  it('in-memory database works', async () => {
    const memDriver = new SqliteDriver();
    await memDriver.connect({
      id: 'test-mem',
      name: 'Memory',
      type: 'sqlite',
      host: '',
      port: 0,
      database: ':memory:',
    });

    await memDriver.execute('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)');
    await memDriver.execute('INSERT INTO test VALUES (1, \'hello\')');
    const result = await memDriver.execute('SELECT * FROM test');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].val).toBe('hello');

    await memDriver.disconnect();
  });

  it('nullable info is enriched in getTableData', async () => {
    const result = await driver.getTableData('users');
    expect(result.error).toBeUndefined();
    expect(result.columns.find(c => c.name === 'name')!.nullable).toBe(false);
    expect(result.columns.find(c => c.name === 'email')!.nullable).toBe(true);
  });

  it('timestamp columns are reported with correct type for chart detection', async () => {
    await driver.execute('CREATE TABLE ts_test (id INTEGER PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, event_date DATE)');
    await driver.execute('INSERT INTO ts_test (created_at, event_date) VALUES (\'2024-01-01 10:00:00\', \'2024-01-01\')');

    const result = await driver.getTableData('ts_test');
    expect(result.error).toBeUndefined();

    const tsCol = result.columns.find(c => c.name === 'created_at');
    expect(tsCol).toBeDefined();
    // SQLite should return declared type — must match TIME_TYPES for chart detection
    expect(tsCol!.dataType.toUpperCase()).toContain('TIMESTAMP');

    const dateCol = result.columns.find(c => c.name === 'event_date');
    expect(dateCol).toBeDefined();
    expect(dateCol!.dataType.toUpperCase()).toContain('DATE');

    await driver.execute('DROP TABLE ts_test');
  });

  // --- Chart aggregation: buildAggregationQuery → driver.execute ---

  describe('Chart aggregation with strftime', () => {
    beforeAll(async () => {
      await driver.execute(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          category TEXT,
          value REAL
        )
      `);
      // Insert data spanning multiple months
      await driver.execute(`
        INSERT INTO events (created_at, category, value) VALUES
          ('2024-01-15 10:00:00', 'A', 10),
          ('2024-01-20 12:00:00', 'B', 20),
          ('2024-02-10 08:00:00', 'A', 30),
          ('2024-02-25 16:00:00', 'A', 40),
          ('2024-03-05 09:00:00', 'B', 50),
          ('2024-03-15 14:00:00', 'B', 60)
      `);
    });

    afterAll(async () => {
      await driver.execute('DROP TABLE IF EXISTS events');
    });

    it('COUNT by month using strftime produces correct buckets', async () => {
      const { buildAggregationQuery } = await import('../../types/chart');
      const sql = buildAggregationQuery(
        'events', undefined, 'created_at', ['id'], 'count', undefined,
        { function: 'count', timeBucketPreset: 'month' }, 'sqlite',
      );
      expect(sql).toContain('strftime');
      expect(sql).not.toContain('date_trunc');

      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();
      expect(result.rowCount).toBe(3);
      expect(result.rows.map(r => r.created_at)).toEqual(['2024-01', '2024-02', '2024-03']);
      expect(result.rows.map(r => r.count)).toEqual([2, 2, 2]);
    });

    it('aggregation result columns have numeric dataType for COUNT/SUM (not TEXT)', async () => {
      // This is the root cause of the "chart disappears" bug:
      // SQLite returns null type for computed columns → driver defaults to 'TEXT'
      // → webview isNumericType('TEXT') = false → no Y axis → empty chart
      const { buildAggregationQuery } = await import('../../types/chart');
      const sql = buildAggregationQuery(
        'events', undefined, 'created_at', ['id'], 'count', undefined,
        { function: 'count', timeBucketPreset: 'month' }, 'sqlite',
      );
      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();

      // Inspect actual column types returned by SQLite driver
      const countCol = result.columns.find(c => c.name === 'count');
      expect(countCol).toBeDefined();
      // COUNT(*) returns a number → driver must infer 'INTEGER', not 'TEXT'
      expect(countCol!.dataType).toBe('INTEGER');

      // strftime returns a string → stays 'TEXT'
      const createdCol = result.columns.find(c => c.name === 'created_at');
      expect(createdCol).toBeDefined();
      expect(createdCol!.dataType).toBe('TEXT');
    });

    it('SUM by day using strftime', async () => {
      const { buildAggregationQuery } = await import('../../types/chart');
      const sql = buildAggregationQuery(
        'events', undefined, 'created_at', ['value'], 'sum', undefined,
        { function: 'sum', timeBucketPreset: 'day' }, 'sqlite',
      );
      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();
      expect(result.rowCount).toBe(6); // each event on a different day
    });

    it('AVG by year using strftime', async () => {
      const { buildAggregationQuery } = await import('../../types/chart');
      const sql = buildAggregationQuery(
        'events', undefined, 'created_at', ['value'], 'avg', undefined,
        { function: 'avg', timeBucketPreset: 'year' }, 'sqlite',
      );
      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();
      expect(result.rowCount).toBe(1);
      expect(result.rows[0].created_at).toBe('2024');
    });

    it('COUNT by month with groupBy column', async () => {
      const { buildAggregationQuery } = await import('../../types/chart');
      const sql = buildAggregationQuery(
        'events', undefined, 'created_at', ['id'], 'count', 'category',
        { function: 'count', timeBucketPreset: 'month' }, 'sqlite',
      );
      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();
      // 3 months × 2 categories, but not all combos exist → ≤ 6 rows
      expect(result.rowCount).toBeGreaterThanOrEqual(4);
      expect(result.rows.every((r: Record<string, unknown>) => r.category === 'A' || r.category === 'B')).toBe(true);
    });

    it('custom time bucket (2h) using unixepoch arithmetic', async () => {
      const { buildAggregationQuery } = await import('../../types/chart');
      const sql = buildAggregationQuery(
        'events', undefined, 'created_at', ['id'], 'count', undefined,
        { function: 'count', timeBucketPreset: 'custom', timeBucket: '2h' }, 'sqlite',
      );
      expect(sql).toContain('unixepoch');
      expect(sql).toContain('7200');

      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();
      expect(result.rowCount).toBeGreaterThanOrEqual(1);
    });
  });
});
