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
    await driver.execute(`
      CREATE INDEX idx_users_email ON users (email)
    `);
    await driver.execute(`
      CREATE INDEX idx_orders_user_id ON orders (user_id)
    `);
    await driver.execute(`
      CREATE SEQUENCE custom_seq START WITH 100 INCREMENT BY 10
    `);
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

  it('getSchema returns public schema with tables and views', async () => {
    const schema = await driver.getSchema();
    const publicSchema = schema.find(s => s.name === 'public');
    expect(publicSchema).toBeDefined();
    expect(publicSchema!.type).toBe('schema');

    const childNames = publicSchema!.children!.map(c => c.name);
    expect(childNames).toContain('users');
    expect(childNames).toContain('orders');
    expect(childNames).toContain('user_order_summary');

    const usersObj = publicSchema!.children!.find(c => c.name === 'users');
    const viewObj = publicSchema!.children!.find(c => c.name === 'user_order_summary');
    expect(usersObj!.type).toBe('table');
    expect(viewObj!.type).toBe('view');
  });

  it('getSchema tables contain column children', async () => {
    const schema = await driver.getSchema();
    const publicSchema = schema.find(s => s.name === 'public')!;
    const usersTable = publicSchema.children!.find(c => c.name === 'users')!;

    expect(usersTable.children).toBeDefined();
    expect(usersTable.children!.length).toBeGreaterThan(0);

    // Columns should have type 'column' with name and detail (type info)
    const columns = usersTable.children!.filter(c => c.type === 'column');
    expect(columns.length).toBe(4); // id, name, email, created_at

    const idCol = columns.find(c => c.name === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.detail).toContain('integer');
    expect(idCol!.detail).toContain('PK');

    const nameCol = columns.find(c => c.name === 'name');
    expect(nameCol).toBeDefined();
    expect(nameCol!.detail).toContain('character varying');

    const emailCol = columns.find(c => c.name === 'email');
    expect(emailCol).toBeDefined();
  });

  it('getSchema tables contain indexes group', async () => {
    const schema = await driver.getSchema();
    const publicSchema = schema.find(s => s.name === 'public')!;
    const usersTable = publicSchema.children!.find(c => c.name === 'users')!;

    const indexesGroup = usersTable.children!.find(c => c.name === 'Indexes' && c.type === 'group');
    expect(indexesGroup).toBeDefined();
    expect(indexesGroup!.children!.length).toBeGreaterThan(0);

    const indexNames = indexesGroup!.children!.map(c => c.name);
    expect(indexNames).toContain('idx_users_email');
    expect(indexesGroup!.children![0].type).toBe('index');
  });

  it('getSchema tables contain triggers group', async () => {
    const schema = await driver.getSchema();
    const publicSchema = schema.find(s => s.name === 'public')!;
    const usersTable = publicSchema.children!.find(c => c.name === 'users')!;

    const triggersGroup = usersTable.children!.find(c => c.name === 'Triggers' && c.type === 'group');
    expect(triggersGroup).toBeDefined();
    expect(triggersGroup!.children!.length).toBeGreaterThan(0);

    const triggerNames = triggersGroup!.children!.map(c => c.name);
    expect(triggerNames).toContain('trg_users_update');
    expect(triggersGroup!.children![0].type).toBe('trigger');
  });

  it('getSchema contains sequences group', async () => {
    const schema = await driver.getSchema();
    const publicSchema = schema.find(s => s.name === 'public')!;

    const sequencesGroup = publicSchema.children!.find(c => c.name === 'Sequences' && c.type === 'group');
    expect(sequencesGroup).toBeDefined();

    const seqNames = sequencesGroup!.children!.map(c => c.name);
    expect(seqNames).toContain('custom_seq');
    expect(sequencesGroup!.children![0].type).toBe('sequence');
  });

  it('getSchema views contain column children', async () => {
    const schema = await driver.getSchema();
    const publicSchema = schema.find(s => s.name === 'public')!;
    const viewObj = publicSchema.children!.find(c => c.name === 'user_order_summary')!;

    expect(viewObj.children).toBeDefined();
    expect(viewObj.children!.length).toBeGreaterThan(0);
    expect(viewObj.children![0].type).toBe('column');
  });

  it('getDDL returns CREATE TABLE for tables', async () => {
    const ddl = await driver.getDDL!('users', 'table', 'public');
    expect(ddl).toContain('CREATE TABLE');
    expect(ddl).toContain('"users"');
    expect(ddl).toContain('"id"');
    expect(ddl).toContain('"name"');
    expect(ddl).toContain('PRIMARY KEY');
  });

  it('getDDL returns CREATE VIEW for views', async () => {
    const ddl = await driver.getDDL!('user_order_summary', 'view', 'public');
    expect(ddl).toContain('CREATE OR REPLACE VIEW');
    expect(ddl).toContain('user_order_summary');
  });

  it('getDDL returns index definition', async () => {
    const ddl = await driver.getDDL!('idx_users_email', 'index', 'public');
    expect(ddl).toContain('CREATE INDEX');
    expect(ddl).toContain('idx_users_email');
  });

  it('getDDL returns trigger definition', async () => {
    const ddl = await driver.getDDL!('trg_users_update', 'trigger', 'public');
    expect(ddl).toContain('trg_users_update');
    expect(ddl).toContain('update_timestamp');
  });

  it('getDDL returns sequence definition', async () => {
    const ddl = await driver.getDDL!('custom_seq', 'sequence', 'public');
    expect(ddl).toContain('CREATE SEQUENCE');
    expect(ddl).toContain('custom_seq');
    expect(ddl).toContain('100'); // START WITH 100
  });

  it('getTableInfo returns column details with PK and nullability', async () => {
    const info = await driver.getTableInfo('users', 'public');
    expect(info.columns.length).toBe(4);

    const idCol = info.columns.find(c => c.name === 'id');
    expect(idCol!.isPrimaryKey).toBe(true);
    expect(idCol!.nullable).toBe(false);

    const emailCol = info.columns.find(c => c.name === 'email');
    expect(emailCol!.nullable).toBe(true);
    expect(emailCol!.dataType).toBe('text');
  });

  it('getTableInfo for orders shows default value', async () => {
    const info = await driver.getTableInfo('orders', 'public');
    const statusCol = info.columns.find(c => c.name === 'status');
    expect(statusCol!.defaultValue).toContain('pending');
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

    const moodCol = result.columns.find(c => c.name === 'mood');
    expect(moodCol).toBeDefined();
    expect(moodCol!.enumValues).toBeDefined();
    expect(moodCol!.enumValues).toEqual(expect.arrayContaining(['happy', 'sad', 'neutral']));
    expect(moodCol!.enumValues!.length).toBe(3);

    // Non-enum columns should not have enumValues
    const commentCol = result.columns.find(c => c.name === 'comment');
    expect(commentCol!.enumValues).toBeUndefined();
  });

  it('getTableData respects custom limit', async () => {
    // Insert more data
    for (let i = 0; i < 10; i++) {
      await driver.execute(`INSERT INTO users (name, email) VALUES ('User${i}', 'u${i}@test.com')`);
    }
    const result = await driver.getTableData('users', 'public', 5, 0);
    expect(result.rows.length).toBe(5);
  });

  it('getSchema column detail contains data type', async () => {
    const schema = await driver.getSchema();
    const publicSchema = schema.find(s => s.name === 'public')!;
    const feedbackTable = publicSchema.children!.find(c => c.name === 'feedback')!;
    const cols = feedbackTable.children!.filter(c => c.type === 'column');

    const moodCol = cols.find(c => c.name === 'mood');
    expect(moodCol).toBeDefined();
    expect(moodCol!.detail).toBeDefined();
    expect(moodCol!.detail).toContain('USER-DEFINED');
  });

  it('getTableData with orderBy sorts results', async () => {
    const result = await driver.getTableData('users', 'public', 100, 0, [{ column: 'name', direction: 'desc' }]);
    expect(result.error).toBeUndefined();
    expect(result.rows.length).toBeGreaterThan(1);
    // First row should have a name that comes later alphabetically
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

  it('getTableData returns nullable info for columns', async () => {
    const result = await driver.getTableData('settings', 'public');
    expect(result.error).toBeUndefined();

    const activeCol = result.columns.find(c => c.name === 'active');
    expect(activeCol).toBeDefined();
    expect(activeCol!.nullable).toBe(false);

    const optionalCol = result.columns.find(c => c.name === 'optional_flag');
    expect(optionalCol).toBeDefined();
    expect(optionalCol!.nullable).toBe(true);
  });

  it('getTableData returns boolean values correctly', async () => {
    const result = await driver.getTableData('settings', 'public');
    expect(result.error).toBeUndefined();
    expect(result.rows[0].active).toBe(true);
    expect(result.rows[1].active).toBe(false);
    expect(result.rows[0].optional_flag).toBeNull();
    expect(result.rows[1].optional_flag).toBe(true);
  });

  it('getTableData returns JSON/JSONB values', async () => {
    const result = await driver.getTableData('settings', 'public');
    expect(result.error).toBeUndefined();

    const metadataCol = result.columns.find(c => c.name === 'metadata');
    expect(metadataCol!.dataType).toBe('jsonb');

    const configCol = result.columns.find(c => c.name === 'config');
    expect(configCol!.dataType).toBe('json');

    // JSONB values should be objects
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
