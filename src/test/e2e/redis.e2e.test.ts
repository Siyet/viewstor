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

  // --- Connection & basic commands ---

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

  it('execute empty command returns empty result', async () => {
    const result = await driver.execute('');
    expect(result.rowCount).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it('GET non-existent key returns nil', async () => {
    const result = await driver.execute('GET nonexistent_key_12345');
    expect(result.rows[0].result).toBe('(nil)');
  });

  // --- Key management ---

  it('DEL removes a key', async () => {
    await driver.execute('SET to_delete "bye"');
    const delResult = await driver.execute('DEL to_delete');
    expect(delResult.rows[0].result).toBe('1');

    const getResult = await driver.execute('GET to_delete');
    expect(getResult.rows[0].result).toBe('(nil)');
  });

  it('EXISTS checks key existence', async () => {
    const exists = await driver.execute('EXISTS greeting');
    expect(exists.rows[0].result).toBe('1');

    const notExists = await driver.execute('EXISTS nonexistent_key_67890');
    expect(notExists.rows[0].result).toBe('0');
  });

  it('TTL and EXPIRE work together', async () => {
    await driver.execute('SET ttl_key "temporary"');
    await driver.execute('EXPIRE ttl_key 3600');

    const ttlResult = await driver.execute('TTL ttl_key');
    const ttl = parseInt(ttlResult.rows[0].result as string, 10);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3600);

    // Clean up
    await driver.execute('DEL ttl_key');
  });

  it('TYPE returns correct types', async () => {
    const strType = await driver.execute('TYPE greeting');
    expect(strType.rows[0].result).toBe('string');

    const listType = await driver.execute('TYPE mylist');
    expect(listType.rows[0].result).toBe('list');

    const setType = await driver.execute('TYPE myset');
    expect(setType.rows[0].result).toBe('set');

    const zsetType = await driver.execute('TYPE myzset');
    expect(zsetType.rows[0].result).toBe('zset');

    const hashType = await driver.execute('TYPE myhash');
    expect(hashType.rows[0].result).toBe('hash');
  });

  // --- Multi-key commands ---

  it('MSET and MGET work', async () => {
    await driver.execute('MSET mk1 val1 mk2 val2 mk3 val3');

    const result = await driver.execute('MGET mk1 mk2 mk3');
    expect(result.rowCount).toBe(3);
    const values = result.rows.map(r => r.value);
    expect(values).toEqual(['val1', 'val2', 'val3']);

    // Clean up
    await driver.execute('DEL mk1 mk2 mk3');
  });

  it('KEYS returns matching keys', async () => {
    const result = await driver.execute('KEYS my*');
    expect(result.rowCount).toBeGreaterThanOrEqual(3);
    const keys = result.rows.map(r => r.value);
    expect(keys).toContain('mylist');
    expect(keys).toContain('myset');
    expect(keys).toContain('myzset');
  });

  // --- List commands ---

  it('LLEN returns list length', async () => {
    const result = await driver.execute('LLEN mylist');
    expect(result.rows[0].result).toBe('3');
  });

  it('RPUSH and LPOP work', async () => {
    await driver.execute('RPUSH tmplist item1 item2');
    const pop = await driver.execute('LPOP tmplist');
    expect(pop.rows[0].result).toBe('item1');

    // Clean up
    await driver.execute('DEL tmplist');
  });

  // --- Set commands ---

  it('SCARD returns set cardinality', async () => {
    const result = await driver.execute('SCARD myset');
    expect(result.rows[0].result).toBe('3');
  });

  it('SISMEMBER checks membership', async () => {
    const member = await driver.execute('SISMEMBER myset x');
    expect(member.rows[0].result).toBe('1');

    const notMember = await driver.execute('SISMEMBER myset nothere');
    expect(notMember.rows[0].result).toBe('0');
  });

  // --- Sorted set commands ---

  it('ZCARD returns zset cardinality', async () => {
    const result = await driver.execute('ZCARD myzset');
    expect(result.rows[0].result).toBe('3');
  });

  it('ZSCORE returns member score', async () => {
    const result = await driver.execute('ZSCORE myzset beta');
    expect(result.rows[0].result).toBe('2');
  });

  // --- Hash commands ---

  it('HGET returns specific field', async () => {
    const result = await driver.execute('HGET myhash field1');
    expect(result.rows[0].result).toBe('val1');
  });

  it('HLEN returns hash field count', async () => {
    const result = await driver.execute('HLEN myhash');
    expect(result.rows[0].result).toBe('2');
  });

  it('HKEYS returns field names', async () => {
    const result = await driver.execute('HKEYS myhash');
    const fields = result.rows.map(r => r.value);
    expect(fields.sort()).toEqual(['field1', 'field2']);
  });

  // --- Quoted strings ---

  it('handles single-quoted values', async () => {
    const setResult = await driver.execute('SET sqkey \'hello world\'');
    expect(setResult.rows[0].result).toBe('OK');

    const getResult = await driver.execute('GET sqkey');
    expect(getResult.rows[0].result).toBe('hello world');

    await driver.execute('DEL sqkey');
  });

  it('handles values with spaces in double quotes', async () => {
    const setResult = await driver.execute('SET spacekey "value with spaces"');
    expect(setResult.rows[0].result).toBe('OK');

    const getResult = await driver.execute('GET spacekey');
    expect(getResult.rows[0].result).toBe('value with spaces');

    await driver.execute('DEL spacekey');
  });

  // --- INCR / DECR ---

  it('INCR and DECR modify numeric values', async () => {
    await driver.execute('SET numkey 10');

    const incr = await driver.execute('INCR numkey');
    expect(incr.rows[0].result).toBe('11');

    const decr = await driver.execute('DECR numkey');
    expect(decr.rows[0].result).toBe('10');

    await driver.execute('DEL numkey');
  });

  // --- Schema & table info ---

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

  it('getTableInfo returns key type and TTL info', async () => {
    const info = await driver.getTableInfo('greeting');
    expect(info.name).toBe('greeting');

    const typeCol = info.columns.find(c => c.name === 'type');
    expect(typeCol?.dataType).toBe('string');

    const ttlCol = info.columns.find(c => c.name === 'ttl');
    expect(ttlCol).toBeDefined();
    expect(ttlCol?.dataType).toBe('integer');
  });

  it('getTableInfo for list key', async () => {
    const info = await driver.getTableInfo('mylist');
    expect(info.columns.find(c => c.name === 'type')?.dataType).toBe('list');
  });

  it('getTableInfo for hash key', async () => {
    const info = await driver.getTableInfo('myhash');
    expect(info.columns.find(c => c.name === 'type')?.dataType).toBe('hash');
  });

  it('getTableInfo for non-existent key returns none type', async () => {
    const info = await driver.getTableInfo('nonexistent_key_abcde');
    expect(info.columns.find(c => c.name === 'type')?.dataType).toBe('none');
  });

  // --- getTableData for all types ---

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

  it('getTableData for non-existent key returns unsupported type', async () => {
    const result = await driver.getTableData('nonexistent_key_xyz');
    expect(result.rows[0].info).toContain('Unsupported type');
  });

  // --- DB info ---

  it('DBSIZE returns key count', async () => {
    const result = await driver.execute('DBSIZE');
    const size = parseInt(result.rows[0].result as string, 10);
    expect(size).toBeGreaterThanOrEqual(6);
  });

  it('INFO server returns server information', async () => {
    const result = await driver.execute('INFO server');
    const info = result.rows[0].result as string;
    expect(info).toContain('redis_version');
  });

  // --- Disconnect / reconnect ---

  it('disconnect and reconnect works', async () => {
    await driver.disconnect();
    driver = new RedisDriver();
    await driver.connect(config);
    expect(await driver.ping()).toBe(true);
  });
});
