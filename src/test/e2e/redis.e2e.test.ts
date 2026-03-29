import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { RedisDriver } from '../../drivers/redis';
import { ConnectionConfig } from '../../types/connection';
import { isDockerAvailable, describeIf } from './helpers/dockerCheck';

describeIf(isDockerAvailable)('Redis Driver E2E', () => {
  let container: StartedTestContainer;
  let driver: RedisDriver;
  let config: ConnectionConfig;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();

    config = {
      id: 'test-redis',
      name: 'Test Redis',
      type: 'redis',
      host: container.getHost(),
      port: container.getMappedPort(6379),
    };

    driver = new RedisDriver();
    await driver.connect(config);

    // Seed test data
    await driver.execute('SET greeting "hello world"');
    await driver.execute('SET counter 42');
    await driver.execute('LPUSH mylist a b c');
    await driver.execute('SADD myset x y z');
    await driver.execute('ZADD myzset 1 alpha 2 beta 3 gamma');
    await driver.execute('HSET myhash field1 val1 field2 val2');
  });

  afterAll(async () => {
    await driver?.disconnect();
    await container?.stop();
  });

  it('ping returns true', async () => {
    const result = await driver.ping();
    expect(result).toBe(true);
  });

  it('execute SET/GET works', async () => {
    const setResult = await driver.execute('SET testkey testval');
    expect(setResult.rows[0].result).toBe('OK');

    const getResult = await driver.execute('GET testkey');
    expect(getResult.rows[0].result).toBe('testval');
  });

  it('execute with error returns error string', async () => {
    const result = await driver.execute('HGET');
    expect(result.error).toBeDefined();
  });

  it('getSchema returns keyspaces with keys', async () => {
    const schema = await driver.getSchema();
    expect(schema.length).toBeGreaterThan(0);

    // Should have at least one keyspace
    const keyspace = schema[0];
    expect(keyspace.type).toBe('keyspace');

    // Should contain the seeded keys
    const keyNames = keyspace.children!.map(k => k.name);
    expect(keyNames).toContain('greeting');
    expect(keyNames).toContain('mylist');
    expect(keyNames).toContain('myhash');
  });

  it('getTableInfo returns key type info', async () => {
    const info = await driver.getTableInfo('greeting');
    expect(info.name).toBe('greeting');
    // Should have type column showing 'string'
    const typeCol = info.columns.find(c => c.name === 'type');
    expect(typeCol?.dataType).toBe('string');
  });

  it('getTableData for string key', async () => {
    const result = await driver.getTableData('greeting');
    expect(result.columns[0].name).toBe('value');
    expect(result.rows[0].value).toBe('hello world');
  });

  it('getTableData for list key', async () => {
    const result = await driver.getTableData('mylist');
    expect(result.columns.map(c => c.name)).toEqual(['index', 'value']);
    expect(result.rows.length).toBe(3);
    // LPUSH pushes in reverse: c, b, a
    expect(result.rows.map(r => r.value)).toEqual(['c', 'b', 'a']);
  });

  it('getTableData for set key', async () => {
    const result = await driver.getTableData('myset');
    expect(result.columns[0].name).toBe('member');
    expect(result.rows.length).toBe(3);
    const members = result.rows.map(r => r.member).sort();
    expect(members).toEqual(['x', 'y', 'z']);
  });

  it('getTableData for zset key', async () => {
    const result = await driver.getTableData('myzset');
    expect(result.columns.map(c => c.name)).toEqual(['member', 'score']);
    expect(result.rows.length).toBe(3);
    expect(result.rows[0]).toMatchObject({ member: 'alpha', score: '1' });
    expect(result.rows[1]).toMatchObject({ member: 'beta', score: '2' });
    expect(result.rows[2]).toMatchObject({ member: 'gamma', score: '3' });
  });

  it('getTableData for hash key', async () => {
    const result = await driver.getTableData('myhash');
    expect(result.columns.map(c => c.name)).toEqual(['field', 'value']);
    expect(result.rows.length).toBe(2);
    const fields = result.rows.map(r => r.field).sort();
    expect(fields).toEqual(['field1', 'field2']);
  });

  it('disconnect completes without error', async () => {
    await driver.disconnect();
    // Reconnect for other tests
    driver = new RedisDriver();
    await driver.connect(config);
    const ping = await driver.ping();
    expect(ping).toBe(true);
  });
});
