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
    expect(await driver.ping()).toBe(true);
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

    const keyspace = schema[0];
    expect(keyspace.type).toBe('keyspace');

    const keyNames = keyspace.children!.map(k => k.name);
    expect(keyNames).toContain('greeting');
    expect(keyNames).toContain('mylist');
    expect(keyNames).toContain('myhash');
  });

  it('getTableInfo returns key type info', async () => {
    const info = await driver.getTableInfo('greeting');
    expect(info.name).toBe('greeting');
    expect(info.columns.find(c => c.name === 'type')?.dataType).toBe('string');
  });

  it.each([
    ['string', 'greeting', ['value'], 1, (rows: Record<string, unknown>[]) => {
      expect(rows[0].value).toBe('hello world');
    }],
    ['list', 'mylist', ['index', 'value'], 3, (rows: Record<string, unknown>[]) => {
      // LPUSH pushes in reverse: c, b, a
      expect(rows.map(r => r.value)).toEqual(['c', 'b', 'a']);
    }],
    ['set', 'myset', ['member'], 3, (rows: Record<string, unknown>[]) => {
      expect(rows.map(r => r.member).sort()).toEqual(['x', 'y', 'z']);
    }],
    ['zset', 'myzset', ['member', 'score'], 3, (rows: Record<string, unknown>[]) => {
      expect(rows[0]).toMatchObject({ member: 'alpha', score: '1' });
      expect(rows[1]).toMatchObject({ member: 'beta', score: '2' });
      expect(rows[2]).toMatchObject({ member: 'gamma', score: '3' });
    }],
    ['hash', 'myhash', ['field', 'value'], 2, (rows: Record<string, unknown>[]) => {
      expect(rows.map(r => r.field).sort()).toEqual(['field1', 'field2']);
    }],
  ] as const)('getTableData for %s key', async (_type, key, expectedColumns, expectedLen, assertRows) => {
    const result = await driver.getTableData(key as string);
    expect(result.columns.map(c => c.name)).toEqual(expectedColumns);
    expect(result.rows.length).toBe(expectedLen);
    assertRows(result.rows);
  });

  it('disconnect and reconnect works', async () => {
    await driver.disconnect();
    driver = new RedisDriver();
    await driver.connect(config);
    expect(await driver.ping()).toBe(true);
  });
});
