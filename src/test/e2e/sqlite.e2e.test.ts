import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteDriver } from '../../drivers/sqlite';
import { ConnectionConfig } from '../../types/connection';
import { runDriverInterfaceTests } from './helpers/driverTestSuite';

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
    expect(nameCol.detail).toContain('NOT NULL');

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
});
