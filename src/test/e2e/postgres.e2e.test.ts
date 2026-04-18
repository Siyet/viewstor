import { PostgresDriver } from '../../drivers/postgres';
import { ConnectionConfig } from '../../types/connection';
import { isDockerAvailable, describeIf } from './helpers/dockerCheck';
import { runDriverInterfaceTests } from './helpers/driverTestSuite';
import { startTestStack, stopTestStack, TestStack } from '../shared/containers';

describeIf(isDockerAvailable)('PostgreSQL Driver E2E', () => {
  let stack: TestStack;
  let driver: PostgresDriver;
  let config: ConnectionConfig;

  beforeAll(async () => {
    stack = await startTestStack({ pg: true, ch: false, redis: false });
    const pg = stack.pg!;

    // The shared stack seeds the base DB (viewstor_test) with customers/orders/events/etc.
    // This suite needs a clean DB to own its users/orders/settings/feedback tables without
    // colliding with the shared seed, so we create pilot_pg once per run.
    const admin = new PostgresDriver();
    await admin.connect({
      id: 'test-pg-admin',
      name: 'admin',
      type: 'postgresql',
      host: pg.host,
      port: pg.port,
      username: pg.username,
      password: pg.password,
      database: pg.database,
    });
    await admin.execute('DROP DATABASE IF EXISTS pilot_pg');
    await admin.execute('CREATE DATABASE pilot_pg');
    await admin.disconnect();

    config = {
      id: 'test-pg',
      name: 'Test PG',
      type: 'postgresql',
      host: pg.host,
      port: pg.port,
      username: pg.username,
      password: pg.password,
      database: 'pilot_pg',
    };

    driver = new PostgresDriver();
    await driver.connect(config);

    // Seed test data
    await driver.execute(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await driver.execute(`
      INSERT INTO users (name, email) VALUES
        ('Alice', 'alice@test.com'),
        ('Bob', 'bob@test.com')
    `);
    await driver.execute(`
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        amount NUMERIC(10,2),
        status VARCHAR(20) DEFAULT 'pending'
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
    await driver.execute('CREATE TYPE mood AS ENUM (\'happy\', \'sad\', \'neutral\')');
    await driver.execute(`
      CREATE TABLE feedback (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        mood mood NOT NULL,
        comment TEXT
      )
    `);
    await driver.execute(`
      INSERT INTO feedback (user_id, mood, comment) VALUES (1, 'happy', 'Great!'), (2, 'sad', 'Meh')
    `);
    await driver.execute(`
      CREATE TABLE settings (
        id SERIAL PRIMARY KEY,
        active BOOLEAN NOT NULL DEFAULT true,
        optional_flag BOOLEAN,
        metadata JSONB,
        config JSON
      )
    `);
    await driver.execute(`
      INSERT INTO settings (active, optional_flag, metadata, config) VALUES
        (true, NULL, '{"theme":"dark","fontSize":14}', '{"key":"val"}'),
        (false, true, '{"theme":"light"}', NULL)
    `);
    await driver.execute('CREATE INDEX idx_users_email ON users (email)');
    await driver.execute('CREATE INDEX idx_orders_user_id ON orders (user_id)');
    await driver.execute('CREATE SEQUENCE custom_seq START WITH 100 INCREMENT BY 10');
    await driver.execute(`
      CREATE OR REPLACE FUNCTION update_timestamp()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.created_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await driver.execute(`
      CREATE TRIGGER trg_users_update
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION update_timestamp()
    `);
  });

  afterAll(async () => {
    await driver?.disconnect();
    await stopTestStack(stack);
  });

  // Shared interface tests
  runDriverInterfaceTests(() => driver, 'users', 'public');

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

  it('getSchema returns complete structure: tables, views, columns, indexes, triggers, sequences', async () => {
    const schema = await driver.getSchema();
    const pub = schema.find(s => s.name === 'public')!;
    expect(pub).toBeDefined();
    expect(pub.type).toBe('schema');

    const childNames = pub.children!.map(c => c.name);
    expect(childNames).toContain('users');
    expect(childNames).toContain('orders');
    expect(childNames).toContain('user_order_summary');

    // Tables vs views
    expect(pub.children!.find(c => c.name === 'users')!.type).toBe('table');
    expect(pub.children!.find(c => c.name === 'user_order_summary')!.type).toBe('view');

    // Columns on table
    const usersTable = pub.children!.find(c => c.name === 'users')!;
    const columns = usersTable.children!.filter(c => c.type === 'column');
    expect(columns.length).toBe(4);

    const idCol = columns.find(c => c.name === 'id')!;
    expect(idCol.detail).toContain('integer');
    expect(idCol.detail).toContain('PK');

    const nameCol = columns.find(c => c.name === 'name')!;
    expect(nameCol.detail).toContain('character varying');

    // Columns on view
    const viewObj = pub.children!.find(c => c.name === 'user_order_summary')!;
    expect(viewObj.children!.length).toBeGreaterThan(0);
    expect(viewObj.children![0].type).toBe('column');

    // Indexes group
    const indexesGroup = usersTable.children!.find(c => c.name === 'Indexes' && c.type === 'group')!;
    expect(indexesGroup).toBeDefined();
    expect(indexesGroup.children!.map(c => c.name)).toContain('idx_users_email');
    expect(indexesGroup.children![0].type).toBe('index');

    // Triggers group
    const triggersGroup = usersTable.children!.find(c => c.name === 'Triggers' && c.type === 'group')!;
    expect(triggersGroup).toBeDefined();
    expect(triggersGroup.children!.map(c => c.name)).toContain('trg_users_update');
    expect(triggersGroup.children![0].type).toBe('trigger');

    // Sequences group
    const sequencesGroup = pub.children!.find(c => c.name === 'Sequences' && c.type === 'group')!;
    expect(sequencesGroup).toBeDefined();
    expect(sequencesGroup.children!.map(c => c.name)).toContain('custom_seq');
    expect(sequencesGroup.children![0].type).toBe('sequence');

    // Column detail contains the actual enum type name (not the placeholder "USER-DEFINED")
    const feedbackTable = pub.children!.find(c => c.name === 'feedback')!;
    const moodCol = feedbackTable.children!.filter(c => c.type === 'column').find(c => c.name === 'mood')!;
    expect(moodCol.detail).toContain('mood');
    expect(moodCol.detail).not.toContain('USER-DEFINED');
  });

  it.each([
    ['table', 'users', ['CREATE TABLE', '"users"', '"id"', '"name"', 'PRIMARY KEY']],
    ['view', 'user_order_summary', ['CREATE OR REPLACE VIEW', 'user_order_summary']],
    ['index', 'idx_users_email', ['CREATE INDEX', 'idx_users_email']],
    ['trigger', 'trg_users_update', ['trg_users_update', 'update_timestamp']],
    ['sequence', 'custom_seq', ['CREATE SEQUENCE', 'custom_seq', '100']],
  ])('getDDL returns correct DDL for %s', async (type, name, expectedFragments) => {
    const ddl = await driver.getDDL!(name, type, 'public');
    for (const fragment of expectedFragments) {
      expect(ddl).toContain(fragment);
    }
  });

  it('getTableInfo returns column details with PK, nullability, defaults', async () => {
    const info = await driver.getTableInfo('users', 'public');
    expect(info.columns.length).toBe(4);

    const idCol = info.columns.find(c => c.name === 'id')!;
    expect(idCol.isPrimaryKey).toBe(true);
    expect(idCol.nullable).toBe(false);

    const emailCol = info.columns.find(c => c.name === 'email')!;
    expect(emailCol.nullable).toBe(true);
    expect(emailCol.dataType).toBe('text');

    // Check defaults via orders table
    const ordersInfo = await driver.getTableInfo('orders', 'public');
    const statusCol = ordersInfo.columns.find(c => c.name === 'status')!;
    expect(statusCol.defaultValue).toContain('pending');
  });

  it('getTableData with limit and offset', async () => {
    const result = await driver.getTableData('users', 'public', 1, 1);
    expect(result.rows.length).toBe(1);
  });

  it('getCompletions returns table and column names', async () => {
    const completions = await driver.getCompletions!();
    const labels = completions.map(c => c.label);
    expect(labels).toContain('users');
    expect(labels).toContain('orders');
  });

  it('getTableData for enum columns includes enumValues', async () => {
    const result = await driver.getTableData('feedback', 'public');
    expect(result.error).toBeUndefined();
    expect(result.rowCount).toBe(2);

    const moodCol = result.columns.find(c => c.name === 'mood')!;
    expect(moodCol.enumValues).toEqual(expect.arrayContaining(['happy', 'sad', 'neutral']));
    expect(moodCol.enumValues!.length).toBe(3);

    const commentCol = result.columns.find(c => c.name === 'comment')!;
    expect(commentCol.enumValues).toBeUndefined();
  });

  it('getTableData respects custom limit', async () => {
    for (let i = 0; i < 10; i++) {
      await driver.execute(`INSERT INTO users (name, email) VALUES ('User${i}', 'u${i}@test.com')`);
    }
    const result = await driver.getTableData('users', 'public', 5, 0);
    expect(result.rows.length).toBe(5);
  });

  it('getTableData with orderBy sorts results', async () => {
    const result = await driver.getTableData('users', 'public', 100, 0, [{ column: 'name', direction: 'desc' }]);
    expect(result.error).toBeUndefined();
    const names = result.rows.map(r => r.name as string);
    for (let i = 1; i < names.length; i++) {
      expect(names[i - 1].localeCompare(names[i])).toBeGreaterThanOrEqual(0);
    }
  });

  it('getTableData with multi-column orderBy', async () => {
    const result = await driver.getTableData('orders', 'public', 100, 0, [
      { column: 'user_id', direction: 'asc' },
      { column: 'amount', direction: 'desc' },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.rows.length).toBe(3);
  });

  it('getTableData for settings: nullable, booleans, JSON/JSONB', async () => {
    const result = await driver.getTableData('settings', 'public');
    expect(result.error).toBeUndefined();

    // Nullable info
    expect(result.columns.find(c => c.name === 'active')!.nullable).toBe(false);
    expect(result.columns.find(c => c.name === 'optional_flag')!.nullable).toBe(true);

    // Boolean values
    expect(result.rows[0].active).toBe(true);
    expect(result.rows[1].active).toBe(false);
    expect(result.rows[0].optional_flag).toBeNull();
    expect(result.rows[1].optional_flag).toBe(true);

    // JSON/JSONB types and values
    expect(result.columns.find(c => c.name === 'metadata')!.dataType).toBe('jsonb');
    expect(result.columns.find(c => c.name === 'config')!.dataType).toBe('json');
    expect(result.rows[0].metadata).toMatchObject({ theme: 'dark', fontSize: 14 });
    expect(result.rows[1].config).toBeNull();
  });

  it('disconnect and reconnect works', async () => {
    await driver.disconnect();
    driver = new PostgresDriver();
    await driver.connect(config);
    const ping = await driver.ping();
    expect(ping).toBe(true);
  });

  // --- quoteIdentifier: SQL without unnecessary quotes ---

  it('getTableData generates SQL without quotes for simple names', async () => {
    // "users" and "public" are not reserved — no quotes needed
    const result = await driver.getTableData('users', 'public', 5, 0);
    expect(result.error).toBeUndefined();
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('getTableRowCount works without quotes for simple names', async () => {
    const count = await driver.getTableRowCount!('users', 'public');
    expect(count).toBeGreaterThan(0);
  });

  it('table with reserved-word column name works with quoteIdentifier', async () => {
    // "order" and "type" are reserved words — must be quoted
    await driver.execute('CREATE TABLE IF NOT EXISTS quote_test (id SERIAL PRIMARY KEY, "order" INTEGER, "type" VARCHAR(50))');
    await driver.execute('INSERT INTO quote_test ("order", "type") VALUES (1, \'premium\')');

    const result = await driver.getTableData('quote_test', 'public');
    expect(result.error).toBeUndefined();
    expect(result.rows.length).toBe(1);

    // Sort by reserved-word column should work
    const sorted = await driver.getTableData('quote_test', 'public', 100, 0, [{ column: 'order', direction: 'asc' }]);
    expect(sorted.error).toBeUndefined();

    // Cleanup
    await driver.execute('DROP TABLE quote_test');
  });

  it('quoteIdentifier only quotes when necessary', async () => {
    const { quoteIdentifier } = await import('../../utils/queryHelpers');
    // Simple names — no quotes
    expect(quoteIdentifier('users')).toBe('users');
    expect(quoteIdentifier('public')).toBe('public');
    expect(quoteIdentifier('my_table')).toBe('my_table');
    // Reserved words — quoted
    expect(quoteIdentifier('order')).toBe('"order"');
    expect(quoteIdentifier('user')).toBe('"user"');
    expect(quoteIdentifier('type')).toBe('"type"');
    // Uppercase — quoted
    expect(quoteIdentifier('MyTable')).toBe('"MyTable"');
  });

  // --- Bug regression tests ---

  it('getSchema does not duplicate tables when same name exists in multiple schemas', async () => {
    // Create a second schema with a table of the same name as in public
    await driver.execute('CREATE SCHEMA IF NOT EXISTS other_schema');
    await driver.execute('CREATE TABLE IF NOT EXISTS other_schema.users (id SERIAL PRIMARY KEY, label TEXT)');

    const schema = await driver.getSchema();
    const pub = schema.find(s => s.name === 'public')!;
    const other = schema.find(s => s.name === 'other_schema')!;

    // Each schema should have exactly one "users" table, no duplicates
    const pubUsers = pub.children!.filter(c => c.name === 'users' && c.type === 'table');
    const otherUsers = other.children!.filter(c => c.name === 'users' && c.type === 'table');
    expect(pubUsers.length).toBe(1);
    expect(otherUsers.length).toBe(1);

    // public.users should have 4 columns, other_schema.users should have 2
    const pubCols = pubUsers[0].children!.filter(c => c.type === 'column');
    const otherCols = otherUsers[0].children!.filter(c => c.type === 'column');
    expect(pubCols.length).toBe(4);
    expect(otherCols.length).toBe(2);

    await driver.execute('DROP TABLE other_schema.users');
    await driver.execute('DROP SCHEMA other_schema');
  });

  it('UPDATE with numeric PK executes without error', async () => {
    const result = await driver.execute(
      'UPDATE users SET name = \'Alice Updated\' WHERE id = 1'
    );
    expect(result.error).toBeUndefined();

    const check = await driver.execute('SELECT name FROM users WHERE id = 1');
    expect(check.rows[0].name).toBe('Alice Updated');

    // Restore
    await driver.execute('UPDATE users SET name = \'Alice\' WHERE id = 1');
  });

  it('UPDATE JSONB column with cast succeeds', async () => {
    const result = await driver.execute(
      'UPDATE settings SET metadata = \'{"theme":"blue","fontSize":16}\'::jsonb WHERE id = 1'
    );
    expect(result.error).toBeUndefined();

    const check = await driver.execute('SELECT metadata FROM settings WHERE id = 1');
    expect(check.rows[0].metadata).toMatchObject({ theme: 'blue', fontSize: 16 });

    // Restore
    await driver.execute(
      'UPDATE settings SET metadata = \'{"theme":"dark","fontSize":14}\'::jsonb WHERE id = 1'
    );
  });

  it('UPDATE JSON column with cast succeeds', async () => {
    const result = await driver.execute(
      'UPDATE settings SET config = \'{"newKey":"newVal"}\'::json WHERE id = 1'
    );
    expect(result.error).toBeUndefined();

    const check = await driver.execute('SELECT config FROM settings WHERE id = 1');
    expect(check.rows[0].config).toMatchObject({ newKey: 'newVal' });

    // Restore
    await driver.execute(
      'UPDATE settings SET config = \'{"key":"val"}\'::json WHERE id = 1'
    );
  });

  it('UPDATE boolean column with TRUE/FALSE succeeds', async () => {
    const result = await driver.execute(
      'UPDATE settings SET active = FALSE WHERE id = 1'
    );
    expect(result.error).toBeUndefined();

    const check = await driver.execute('SELECT active FROM settings WHERE id = 1');
    expect(check.rows[0].active).toBe(false);

    // Restore
    await driver.execute('UPDATE settings SET active = TRUE WHERE id = 1');
  });

  it('DELETE with numeric PK executes and removes row', async () => {
    await driver.execute('INSERT INTO users (name, email) VALUES (\'ToDelete\', \'del@test.com\')');
    const inserted = await driver.execute('SELECT id FROM users WHERE name = \'ToDelete\'');
    const deleteId = inserted.rows[0].id;

    const result = await driver.execute(`DELETE FROM users WHERE id = ${deleteId}`);
    expect(result.error).toBeUndefined();

    const check = await driver.execute(`SELECT COUNT(*) as cnt FROM users WHERE id = ${deleteId}`);
    expect(Number(check.rows[0].cnt)).toBe(0);
  });

  it('INSERT with DEFAULT values succeeds for table with defaults', async () => {
    const result = await driver.execute(
      'INSERT INTO settings ("id", "active", "optional_flag", "metadata", "config") VALUES (DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT) RETURNING *'
    );
    expect(result.error).toBeUndefined();
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].active).toBe(true); // DEFAULT is true

    // Cleanup
    await driver.execute(`DELETE FROM settings WHERE id = ${result.rows[0].id}`);
  });

  // --- Multi-statement execution tests ---

  it('multi-statement SELECT + UPDATE returns correct affectedRows', async () => {
    const result = await driver.execute(
      'SELECT * FROM users WHERE id = 1; UPDATE users SET name = \'MultiTest\' WHERE id = 1'
    );
    expect(result.error).toBeUndefined();
    // Last statement is UPDATE, so affectedRows should be reported
    expect(result.affectedRows).toBe(1);

    // Verify the UPDATE actually applied
    const check = await driver.execute('SELECT name FROM users WHERE id = 1');
    expect(check.rows[0].name).toBe('MultiTest');

    // Restore
    await driver.execute('UPDATE users SET name = \'Alice\' WHERE id = 1');
  });

  it('multi-statement with multiple UPDATEs sums affectedRows', async () => {
    const result = await driver.execute(
      'UPDATE users SET name = \'X\' WHERE id = 1; UPDATE users SET name = \'Y\' WHERE id = 2'
    );
    expect(result.error).toBeUndefined();
    expect(result.affectedRows).toBe(2);

    // Restore
    await driver.execute('UPDATE users SET name = \'Alice\' WHERE id = 1');
    await driver.execute('UPDATE users SET name = \'Bob\' WHERE id = 2');
  });

  it('multi-statement ending with SELECT returns rows', async () => {
    const result = await driver.execute(
      'UPDATE users SET name = \'Peek\' WHERE id = 1; SELECT * FROM users WHERE id = 1'
    );
    expect(result.error).toBeUndefined();
    expect(result.columns.length).toBeGreaterThan(0);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].name).toBe('Peek');
    // affectedRows should be undefined for SELECT
    expect(result.affectedRows).toBeUndefined();

    // Restore
    await driver.execute('UPDATE users SET name = \'Alice\' WHERE id = 1');
  });

  // --- Statement-at-cursor execution tests ---

  describe('statement-at-cursor execution', () => {
    it('executes only the statement at cursor (first of two)', async () => {
      const sql = 'SELECT * FROM users WHERE id = 1;\nUPDATE users SET name = \'CursorTest\' WHERE id = 1;';
      const { getStatementAtOffset } = await import('../../utils/queryHelpers');

      const stmt = getStatementAtOffset(sql, 5); // cursor in SELECT
      expect(stmt).toBeDefined();
      expect(stmt!.text).toContain('SELECT');
      expect(stmt!.text).not.toContain('UPDATE');

      const result = await driver.execute(stmt!.text);
      expect(result.error).toBeUndefined();
      expect(result.columns.length).toBeGreaterThan(0);
      expect(result.rows.length).toBe(1);
    });

    it('executes only the statement at cursor (second of two)', async () => {
      const sql = 'SELECT * FROM users WHERE id = 1;\nUPDATE users SET name = \'CursorTest2\' WHERE id = 2;';
      const { getStatementAtOffset } = await import('../../utils/queryHelpers');

      const stmt = getStatementAtOffset(sql, 40); // cursor in UPDATE
      expect(stmt).toBeDefined();
      expect(stmt!.text).toContain('UPDATE');
      expect(stmt!.text).not.toContain('SELECT');

      const result = await driver.execute(stmt!.text);
      expect(result.error).toBeUndefined();
      expect(result.affectedRows).toBe(1);

      // Verify the UPDATE applied
      const check = await driver.execute('SELECT name FROM users WHERE id = 2');
      expect(check.rows[0].name).toBe('CursorTest2');

      // Restore
      await driver.execute('UPDATE users SET name = \'Bob\' WHERE id = 2');
    });

    it('executes all statements when full text is selected', async () => {
      const sql = 'UPDATE users SET name = \'All1\' WHERE id = 1; UPDATE users SET name = \'All2\' WHERE id = 2';
      // Simulating "select all" — execute the whole text
      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();
      expect(result.affectedRows).toBe(2);

      const check1 = await driver.execute('SELECT name FROM users WHERE id = 1');
      expect(check1.rows[0].name).toBe('All1');
      const check2 = await driver.execute('SELECT name FROM users WHERE id = 2');
      expect(check2.rows[0].name).toBe('All2');

      // Restore
      await driver.execute('UPDATE users SET name = \'Alice\' WHERE id = 1');
      await driver.execute('UPDATE users SET name = \'Bob\' WHERE id = 2');
    });

    it('handles metadata line offset correctly', async () => {
      const { stripMetadataFromContent } = await import('../../utils/queryFileHelpers');
      const { getStatementAtOffset: getStmt } = await import('../../utils/queryHelpers');

      const metaLine = '-- viewstor:connectionId=test-pg&database=testdb';
      const queryPart = 'SELECT 1;\nSELECT name FROM users WHERE id = 1;';
      const fullContent = metaLine + '\n' + queryPart;

      const stripped = stripMetadataFromContent(fullContent);
      expect(stripped).toBe(queryPart);

      const metadataOffset = fullContent.length - stripped.length;
      // Cursor on the second SELECT (after metadata + first statement)
      const cursorInFull = metadataOffset + 11;
      const stmt = getStmt(stripped, cursorInFull - metadataOffset);
      expect(stmt).toBeDefined();
      expect(stmt!.text).toContain('users');

      const result = await driver.execute(stmt!.text);
      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(1);
    });

    it('cursor in third of three statements selects correct one', async () => {
      const { getStatementAtOffset: getStmt } = await import('../../utils/queryHelpers');
      const sql = [
        'SELECT 1 AS a;',
        'SELECT 2 AS b;',
        'SELECT name FROM users WHERE id = 1;',
      ].join('\n');

      // Cursor in third statement
      const thirdStart = sql.lastIndexOf('SELECT name');
      const stmt = getStmt(sql, thirdStart + 5);
      expect(stmt).toBeDefined();
      expect(stmt!.text).toContain('users');
      expect(stmt!.text).not.toContain('AS a');
      expect(stmt!.text).not.toContain('AS b');

      const result = await driver.execute(stmt!.text);
      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(1);
      expect(result.columns.map(c => c.name)).toContain('name');
    });

    it('cursor on blank line between statements picks nearest', async () => {
      const { getStatementAtOffset: getStmt } = await import('../../utils/queryHelpers');
      const sql = 'SELECT 1;\n\n\nSELECT name FROM users WHERE id = 2;';
      // Cursor on second empty line
      const stmt = getStmt(sql, 11);
      expect(stmt).toBeDefined();
      // Should pick a valid statement
      const result = await driver.execute(stmt!.text);
      expect(result.error).toBeUndefined();
    });

    it('single statement without semicolon executes correctly', async () => {
      const { getStatementAtOffset: getStmt } = await import('../../utils/queryHelpers');
      const sql = 'SELECT name FROM users WHERE id = 1';
      const stmt = getStmt(sql, 10);
      expect(stmt).toBeDefined();
      expect(stmt!.text).toBe(sql);

      const result = await driver.execute(stmt!.text);
      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(1);
    });

    it('statement with string containing semicolons is not split', async () => {
      const { splitStatements } = await import('../../utils/queryHelpers');
      const sql = 'SELECT \'a;b;c\' AS val; SELECT 2';
      const stmts = splitStatements(sql);
      expect(stmts.length).toBe(2);
      expect(stmts[0].text).toContain('\'a;b;c\'');

      // Execute the first statement with embedded semicolons
      const result = await driver.execute(stmts[0].text);
      expect(result.error).toBeUndefined();
      expect(result.rows[0].val).toBe('a;b;c');
    });

    it('statement with comment containing semicolons is not split', async () => {
      const { splitStatements } = await import('../../utils/queryHelpers');
      const sql = '-- this; is a; comment\nSELECT 1; SELECT 2';
      const stmts = splitStatements(sql);
      expect(stmts.length).toBe(2);
      expect(stmts[0].text).toContain('-- this; is a; comment');

      const result = await driver.execute(stmts[0].text);
      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(1);
    });

    it('dollar-quoted function body is not split on inner semicolons', async () => {
      const { splitStatements } = await import('../../utils/queryHelpers');
      const sql = [
        'CREATE OR REPLACE FUNCTION test_fn() RETURNS integer AS $$',
        'BEGIN',
        '  RETURN 42;',
        'END;',
        '$$ LANGUAGE plpgsql;',
        'SELECT test_fn() AS val;',
      ].join('\n');

      const stmts = splitStatements(sql);
      expect(stmts.length).toBe(2);
      expect(stmts[0].text).toContain('$$');
      expect(stmts[1].text).toContain('test_fn');

      // Execute both to verify
      const createResult = await driver.execute(stmts[0].text);
      expect(createResult.error).toBeUndefined();

      const callResult = await driver.execute(stmts[1].text);
      expect(callResult.error).toBeUndefined();
      expect(Number(callResult.rows[0].val)).toBe(42);

      // Cleanup
      await driver.execute('DROP FUNCTION test_fn()');
    });

    it('each statement independently reports correct result type', async () => {
      const { splitStatements } = await import('../../utils/queryHelpers');
      const sql = [
        'INSERT INTO users (name, email) VALUES (\'StmtTest\', \'s@t.com\');',
        'SELECT * FROM users WHERE name = \'StmtTest\';',
        'DELETE FROM users WHERE name = \'StmtTest\';',
      ].join('\n');

      const stmts = splitStatements(sql);
      expect(stmts.length).toBe(3);

      // INSERT → affectedRows
      const insertResult = await driver.execute(stmts[0].text);
      expect(insertResult.error).toBeUndefined();
      expect(insertResult.affectedRows).toBe(1);

      // SELECT → columns + rows
      const selectResult = await driver.execute(stmts[1].text);
      expect(selectResult.error).toBeUndefined();
      expect(selectResult.columns.length).toBeGreaterThan(0);
      expect(selectResult.rows.length).toBe(1);

      // DELETE → affectedRows
      const deleteResult = await driver.execute(stmts[2].text);
      expect(deleteResult.error).toBeUndefined();
      expect(deleteResult.affectedRows).toBe(1);
    });
  });

  it('multi-database: getTableData on second database returns correct data', async () => {
    // Create a second database and seed data
    await driver.execute('CREATE DATABASE testdb2');

    const driver2 = new PostgresDriver();
    const config2 = { ...config, database: 'testdb2' };
    await driver2.connect(config2);
    await driver2.execute('CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT)');
    await driver2.execute('INSERT INTO items (name) VALUES (\'ItemA\'), (\'ItemB\')');

    const result = await driver2.getTableData('items', 'public');
    expect(result.error).toBeUndefined();
    expect(result.rowCount).toBe(2);
    expect(result.rows[0].name).toBe('ItemA');

    // items should NOT exist in testdb
    const mainResult = await driver.execute('SELECT * FROM items');
    expect(mainResult.error).toBeDefined();
    expect(mainResult.error).toContain('items');

    await driver2.disconnect();
    // Cleanup: need to disconnect all before dropping DB
    await driver.execute('DROP DATABASE testdb2');
  });

  it('multi-database: getCompletions returns schema for the connected database only', async () => {
    // Create a second database with a unique table
    await driver.execute('CREATE DATABASE testdb_completions');

    const driver2 = new PostgresDriver();
    const config2 = { ...config, database: 'testdb_completions' };
    await driver2.connect(config2);
    await driver2.execute('CREATE TABLE completions_only_table (id SERIAL PRIMARY KEY, value TEXT)');

    // Completions on the second database should include the unique table
    const completions2 = await driver2.getCompletions!();
    const labels2 = completions2.map(c => c.label);
    expect(labels2).toContain('completions_only_table');

    // Completions on the main database should NOT include it
    const completions1 = await driver.getCompletions!();
    const labels1 = completions1.map(c => c.label);
    expect(labels1).not.toContain('completions_only_table');

    // Main DB tables should not leak into second DB
    expect(labels2).not.toContain('users');
    expect(labels2).not.toContain('orders');

    // Columns of the unique table should be in completions
    const colCompletions = completions2.filter(
      c => c.kind === 'column' && c.parent === 'completions_only_table'
    );
    expect(colCompletions.map(c => c.label)).toEqual(
      expect.arrayContaining(['id', 'value'])
    );

    await driver2.disconnect();
    await driver.execute('DROP DATABASE testdb_completions');
  });

  it('multi-database: getIndexedColumns works on second database', async () => {
    await driver.execute('CREATE DATABASE testdb_indexes');

    const driver2 = new PostgresDriver();
    const config2 = { ...config, database: 'testdb_indexes' };
    await driver2.connect(config2);
    await driver2.execute('CREATE TABLE idx_test (id SERIAL PRIMARY KEY, email TEXT, status TEXT)');
    await driver2.execute('CREATE INDEX idx_test_email ON idx_test (email)');

    const indexed = await driver2.getIndexedColumns!('idx_test', 'public');
    expect(indexed.has('id')).toBe(true);
    expect(indexed.has('email')).toBe(true);
    expect(indexed.has('status')).toBe(false);

    await driver2.disconnect();
    await driver.execute('DROP DATABASE testdb_indexes');
  });

  // --- showTableData pipeline: getTableInfo + getEstimatedRowCount + getTableData ---

  describe('showTableData pipeline', () => {
    it('full pipeline: getTableInfo → getEstimatedRowCount → getTableData succeeds', async () => {
      // This mirrors the exact sequence that viewstor.showTableData command executes
      const tableInfo = await driver.getTableInfo('users', 'public');
      expect(tableInfo.columns.length).toBeGreaterThan(0);
      const pkColumns = tableInfo.columns.filter(col => col.isPrimaryKey).map(col => col.name);
      expect(pkColumns).toContain('id');

      // Estimated count
      const estimated = await driver.getEstimatedRowCount!('users', 'public');
      expect(estimated).toBeDefined();
      expect(typeof estimated).toBe('number');

      // Exact count for small tables
      const exact = await driver.getTableRowCount!('users', 'public');
      expect(exact).toBeGreaterThanOrEqual(2);

      // Fetch page
      const result = await driver.getTableData('users', 'public', 100, 0);
      expect(result.error).toBeUndefined();
      expect(result.columns.length).toBeGreaterThan(0);
      expect(result.rows.length).toBeGreaterThanOrEqual(2);
      expect(result.rows[0].id).toBeDefined();
      expect(result.rows[0].name).toBeDefined();
    });

    it('getTableData result has correct column metadata', async () => {
      const result = await driver.getTableData('users', 'public', 100, 0);
      expect(result.columns.length).toBeGreaterThan(0);
      for (const col of result.columns) {
        expect(col.name).toBeTruthy();
        expect(col.dataType).toBeTruthy();
      }
      const idCol = result.columns.find(col => col.name === 'id');
      expect(idCol).toBeDefined();
      expect(idCol!.dataType).toMatch(/int/i);
    });

    it('getTableData result rows have all columns', async () => {
      const result = await driver.getTableData('users', 'public', 100, 0);
      const colNames = result.columns.map(col => col.name);
      for (const row of result.rows) {
        for (const colName of colNames) {
          expect(colName in row).toBe(true);
        }
      }
    });

    it('pipeline works for table with nullable/json columns', async () => {
      const tableInfo = await driver.getTableInfo('settings', 'public');
      expect(tableInfo.columns.length).toBeGreaterThan(0);

      const result = await driver.getTableData('settings', 'public', 100, 0);
      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBeGreaterThan(0);

      // Verify no column is missing from rows
      for (const col of result.columns) {
        expect(col.name in result.rows[0]).toBe(true);
      }
    });

    it('pipeline works for table with pagination', async () => {
      // Page 1
      const page1 = await driver.getTableData('users', 'public', 1, 0);
      expect(page1.error).toBeUndefined();
      expect(page1.rows.length).toBe(1);

      // Page 2
      const page2 = await driver.getTableData('users', 'public', 1, 1);
      expect(page2.error).toBeUndefined();
      expect(page2.rows.length).toBe(1);

      // Different rows
      expect(page1.rows[0].id).not.toBe(page2.rows[0].id);
    });

    it('getTableData result can be JSON-serialized (for webview)', async () => {
      const result = await driver.getTableData('users', 'public', 100, 0);
      // This is exactly what buildResultHtml does: safeJsonForScript(result.columns/rows)
      expect(() => JSON.stringify(result.columns)).not.toThrow();
      expect(() => JSON.stringify(result.rows)).not.toThrow();

      // Roundtrip check
      const parsed = JSON.parse(JSON.stringify(result.rows));
      expect(parsed.length).toBe(result.rows.length);
    });

    it('pipeline works for empty table', async () => {
      await driver.execute('CREATE TABLE empty_pipeline_test (id SERIAL PRIMARY KEY, value TEXT)');

      const tableInfo = await driver.getTableInfo('empty_pipeline_test', 'public');
      expect(tableInfo.columns.length).toBeGreaterThan(0);

      const result = await driver.getTableData('empty_pipeline_test', 'public', 100, 0);
      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(0);
      expect(result.columns.length).toBeGreaterThan(0);

      await driver.execute('DROP TABLE empty_pipeline_test');
    });
  });

  // --- Chart aggregation: buildAggregationQuery → driver.execute ---

  describe('chart aggregation queries on real DB', () => {
    beforeAll(async () => {
      // Seed time-based data for aggregation tests
      await driver.execute(`
        CREATE TABLE IF NOT EXISTS chart_events (
          id SERIAL PRIMARY KEY,
          event_type VARCHAR(50),
          amount NUMERIC(10,2),
          created_at TIMESTAMP NOT NULL
        )
      `);
      await driver.execute(`
        INSERT INTO chart_events (event_type, amount, created_at) VALUES
          ('purchase', 100, '2024-01-15 10:00:00'),
          ('purchase', 200, '2024-01-20 14:00:00'),
          ('refund',    50, '2024-01-25 09:00:00'),
          ('purchase', 150, '2024-02-10 11:00:00'),
          ('purchase', 300, '2024-02-20 16:00:00'),
          ('refund',    75, '2024-02-28 08:00:00'),
          ('purchase', 250, '2024-03-05 12:00:00')
      `);
    });

    afterAll(async () => {
      await driver.execute('DROP TABLE IF EXISTS chart_events');
    });

    it('COUNT per month executes and returns correct structure', async () => {
      const { buildAggregationQuery } = await import('../../types/chart');
      const sql = buildAggregationQuery(
        'chart_events', 'public', 'created_at', ['id'], 'count', undefined,
        { function: 'count', timeBucketPreset: 'month' }, 'postgresql',
      );

      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(3); // Jan, Feb, Mar
      expect(result.columns.length).toBeGreaterThanOrEqual(2);

      // Verify rows are ordered by time
      const timestamps = result.rows.map(r => new Date(r.created_at as string).getTime());
      for (let idx = 1; idx < timestamps.length; idx++) {
        expect(timestamps[idx]).toBeGreaterThanOrEqual(timestamps[idx - 1]);
      }
    });

    it('SUM per month returns numeric aggregation', async () => {
      const { buildAggregationQuery } = await import('../../types/chart');
      const sql = buildAggregationQuery(
        'chart_events', 'public', 'created_at', ['amount'], 'sum', undefined,
        { function: 'sum', timeBucketPreset: 'month' }, 'postgresql',
      );

      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(3);
      // Jan: 100 + 200 + 50 = 350
      const janRow = result.rows[0];
      expect(Number(janRow.amount)).toBeCloseTo(350, 0);
    });

    it('AVG per month returns averages', async () => {
      const { buildAggregationQuery } = await import('../../types/chart');
      const sql = buildAggregationQuery(
        'chart_events', 'public', 'created_at', ['amount'], 'avg', undefined,
        { function: 'avg', timeBucketPreset: 'month' }, 'postgresql',
      );

      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(3);
    });

    it('COUNT with GROUP BY event_type', async () => {
      const { buildAggregationQuery } = await import('../../types/chart');
      const sql = buildAggregationQuery(
        'chart_events', 'public', 'created_at', ['id'], 'count', 'event_type',
        { function: 'count', timeBucketPreset: 'month' }, 'postgresql',
      );

      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();
      // Should have more rows than without groupBy (purchase + refund per month)
      expect(result.rows.length).toBeGreaterThan(3);
      // Each row should have event_type
      for (const row of result.rows) {
        expect(row.event_type).toBeDefined();
        expect(['purchase', 'refund']).toContain(row.event_type);
      }
    });

    it('COUNT per day returns more granular data', async () => {
      const { buildAggregationQuery } = await import('../../types/chart');
      const sql = buildAggregationQuery(
        'chart_events', 'public', 'created_at', ['id'], 'count', undefined,
        { function: 'count', timeBucketPreset: 'day' }, 'postgresql',
      );

      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();
      // 7 events on 7 different days
      expect(result.rows.length).toBe(7);
    });

    it('COUNT per year aggregates everything', async () => {
      const { buildAggregationQuery } = await import('../../types/chart');
      const sql = buildAggregationQuery(
        'chart_events', 'public', 'created_at', ['id'], 'count', undefined,
        { function: 'count', timeBucketPreset: 'year' }, 'postgresql',
      );

      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(1); // All in 2024
    });

    it('buildFullDataQuery returns all rows without LIMIT', async () => {
      const { buildFullDataQuery } = await import('../../types/chart');
      const sql = buildFullDataQuery('chart_events', 'public', ['created_at', 'amount']);

      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(7);
      expect(result.columns.length).toBe(2);
      expect(result.columns.map(c => c.name).sort()).toEqual(['amount', 'created_at']);
    });

    it('aggregation result can be fed to buildEChartsOption', async () => {
      const { buildAggregationQuery } = await import('../../types/chart');
      const { buildEChartsOption } = await import('../../chart/chartDataTransform');
      const sql = buildAggregationQuery(
        'chart_events', 'public', 'created_at', ['id'], 'count', undefined,
        { function: 'count', timeBucketPreset: 'month' }, 'postgresql',
      );

      const result = await driver.execute(sql);
      expect(result.error).toBeUndefined();

      const option = buildEChartsOption(result, {
        chartType: 'line',
        axis: { xColumn: 'created_at', yColumns: [result.columns[1].name] },
        aggregation: { function: 'count', timeBucketPreset: 'month' },
      });

      const series = option.series as Array<Record<string, unknown>>;
      expect(series.length).toBe(1);
      expect(series[0].type).toBe('line');
      expect((series[0].data as unknown[]).length).toBe(3);
    });

    it('MIN/MAX aggregation works', async () => {
      const { buildAggregationQuery } = await import('../../types/chart');

      const minSql = buildAggregationQuery(
        'chart_events', 'public', 'created_at', ['amount'], 'min', undefined,
        { function: 'min', timeBucketPreset: 'month' }, 'postgresql',
      );
      const minResult = await driver.execute(minSql);
      expect(minResult.error).toBeUndefined();
      expect(minResult.rows.length).toBe(3);
      // Jan min: 50 (refund)
      expect(Number(minResult.rows[0].amount)).toBe(50);

      const maxSql = buildAggregationQuery(
        'chart_events', 'public', 'created_at', ['amount'], 'max', undefined,
        { function: 'max', timeBucketPreset: 'month' }, 'postgresql',
      );
      const maxResult = await driver.execute(maxSql);
      expect(maxResult.error).toBeUndefined();
      // Jan max: 200
      expect(Number(maxResult.rows[0].amount)).toBe(200);
    });
  });
});
