import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { ClickHouseDriver } from '../../drivers/clickhouse';
import { ConnectionConfig } from '../../types/connection';
import { isDockerAvailable, describeIf } from './helpers/dockerCheck';
import { runDriverInterfaceTests } from './helpers/driverTestSuite';

describeIf(isDockerAvailable)('ClickHouse Driver E2E', () => {
  let container: StartedTestContainer;
  let driver: ClickHouseDriver;
  let config: ConnectionConfig;

  beforeAll(async () => {
    container = await new GenericContainer('clickhouse/clickhouse-server:24-alpine')
      .withExposedPorts(8123)
      .withWaitStrategy(Wait.forHttp('/', 8123).forStatusCode(200))
      .start();

    config = {
      id: 'test-ch',
      name: 'Test CH',
      type: 'clickhouse',
      host: container.getHost(),
      port: container.getMappedPort(8123),
      username: 'default',
      password: '',
      database: 'default',
    };

    driver = new ClickHouseDriver();
    await driver.connect(config);

    // Seed test data — each statement separately
    await driver.execute('CREATE DATABASE IF NOT EXISTS testdb');
    await driver.execute(`
      CREATE TABLE testdb.events (
        id UInt64,
        event_type String,
        payload String,
        created_at DateTime DEFAULT now()
      ) ENGINE = MergeTree() ORDER BY id
    `);
    await driver.execute(`
      INSERT INTO testdb.events (id, event_type, payload) VALUES
        (1, 'click', '{"page": "/home"}'),
        (2, 'view', '{"page": "/about"}'),
        (3, 'click', '{"page": "/pricing"}')
    `);
    await driver.execute(`
      CREATE TABLE testdb.metrics (
        ts DateTime,
        name String,
        value Float64
      ) ENGINE = MergeTree() ORDER BY ts
    `);
    await driver.execute(`
      INSERT INTO testdb.metrics (ts, name, value) VALUES
        ('2025-01-01 00:00:00', 'cpu', 0.75),
        ('2025-01-01 00:01:00', 'cpu', 0.82)
    `);

    // Reconnect targeting testdb for getCompletions tests
    await driver.disconnect();
    config = { ...config, database: 'testdb' };
    driver = new ClickHouseDriver();
    await driver.connect(config);
  });

  afterAll(async () => {
    await driver?.disconnect();
    await container?.stop();
  });

  // Shared interface tests
  runDriverInterfaceTests(() => driver, 'events', 'testdb');

  it('execute DDL returns OK status', async () => {
    const result = await driver.execute(`
      CREATE TABLE IF NOT EXISTS testdb.temp_test (x UInt8) ENGINE = Memory
    `);
    expect(result.error).toBeUndefined();
    expect(result.rows[0]).toMatchObject({ status: 'OK' });
  });

  it('execute SELECT returns correct data', async () => {
    const result = await driver.execute('SELECT * FROM testdb.events ORDER BY id');
    expect(result.error).toBeUndefined();
    expect(result.rowCount).toBe(3);
    expect(result.rows[0]).toMatchObject({ event_type: 'click' });
    expect(result.rows[1]).toMatchObject({ event_type: 'view' });
  });

  it('execute with error returns error string', async () => {
    const result = await driver.execute('SELECT * FROM nonexistent.table');
    expect(result.error).toBeDefined();
  });

  it('getSchema returns testdb with tables, excludes system databases', async () => {
    const schema = await driver.getSchema();
    const dbNames = schema.map(s => s.name);

    expect(dbNames).toContain('testdb');
    expect(dbNames).not.toContain('system');
    expect(dbNames).not.toContain('INFORMATION_SCHEMA');

    const testdb = schema.find(s => s.name === 'testdb');
    const tableNames = testdb!.children!.map(t => t.name);
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('metrics');
  });

  it('getSchema tables contain column children', async () => {
    const schema = await driver.getSchema();
    const testdb = schema.find(s => s.name === 'testdb')!;
    const eventsTable = testdb.children!.find(c => c.name === 'events')!;

    expect(eventsTable.children).toBeDefined();
    expect(eventsTable.children!.length).toBe(4); // id, event_type, payload, created_at

    const columns = eventsTable.children!.filter(c => c.type === 'column');
    expect(columns.length).toBe(4);

    const idCol = columns.find(c => c.name === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.detail).toBe('UInt64');

    const eventTypeCol = columns.find(c => c.name === 'event_type');
    expect(eventTypeCol).toBeDefined();
    expect(eventTypeCol!.detail).toBe('String');
  });

  it('getDDL returns CREATE TABLE for tables', async () => {
    const ddl = await driver.getDDL!('events', 'table', 'testdb');
    expect(ddl).toContain('CREATE TABLE');
    expect(ddl).toContain('events');
  });

  it('getTableInfo returns column details', async () => {
    const info = await driver.getTableInfo('events', 'testdb');
    expect(info.columns.length).toBe(4);

    const idCol = info.columns.find(c => c.name === 'id');
    expect(idCol!.dataType).toBe('UInt64');

    const createdCol = info.columns.find(c => c.name === 'created_at');
    expect(createdCol!.defaultValue).toContain('now()');
  });

  it('getTableData with limit', async () => {
    const result = await driver.getTableData('events', 'testdb', 1, 0);
    expect(result.rows.length).toBe(1);
  });

  it('getCompletions returns table names', async () => {
    const completions = await driver.getCompletions!();
    const labels = completions.map(c => c.label);
    expect(labels).toContain('events');
    expect(labels).toContain('metrics');
  });

  it('getTableData with orderBy sorts results', async () => {
    const result = await driver.getTableData('events', 'testdb', 100, 0, [{ column: 'id', direction: 'desc' }]);
    expect(result.error).toBeUndefined();
    expect(result.rows.length).toBe(3);
    // IDs should be descending
    const ids = result.rows.map(r => Number(r.id));
    expect(ids[0]).toBeGreaterThan(ids[1]);
    expect(ids[1]).toBeGreaterThan(ids[2]);
  });

  it('disconnect completes without error', async () => {
    await driver.disconnect();
    driver = new ClickHouseDriver();
    await driver.connect(config);
    const ping = await driver.ping();
    expect(ping).toBe(true);
  });
});
