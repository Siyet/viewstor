import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { PostgresDriver } from '../../drivers/postgres';
import { ConnectionConfig } from '../../types/connection';
import { isDockerAvailable, describeIf } from './helpers/dockerCheck';
import { runDriverInterfaceTests } from './helpers/driverTestSuite';

describeIf(isDockerAvailable)('PostgreSQL Driver E2E', () => {
  let container: StartedTestContainer;
  let driver: PostgresDriver;
  let config: ConnectionConfig;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:16-alpine')
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_USER: 'test',
        POSTGRES_PASSWORD: 'test',
        POSTGRES_DB: 'testdb',
      })
      .start();

    config = {
      id: 'test-pg',
      name: 'Test PG',
      type: 'postgresql',
      host: container.getHost(),
      port: container.getMappedPort(5432),
      username: 'test',
      password: 'test',
      database: 'testdb',
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
    await container?.stop();
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

    // Column detail contains data type
    const feedbackTable = pub.children!.find(c => c.name === 'feedback')!;
    const moodCol = feedbackTable.children!.filter(c => c.type === 'column').find(c => c.name === 'mood')!;
    expect(moodCol.detail).toContain('USER-DEFINED');
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
    expect(completions).toContain('users');
    expect(completions).toContain('orders');
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
});
