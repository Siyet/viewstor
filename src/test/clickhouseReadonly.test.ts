import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createClientMock, client } = vi.hoisted(() => {
  const client = {
    query: vi.fn(async () => ({
      json: async () => ({ meta: [], data: [], rows: 0 }),
    })),
    command: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return { createClientMock: vi.fn(() => client), client };
});

vi.mock('@clickhouse/client', () => ({ createClient: createClientMock }));

import { ClickHouseDriver } from '../drivers/clickhouse';

describe('ClickHouseDriver native readonly mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function connect(readonly: boolean) {
    const driver = new ClickHouseDriver();
    await driver.connect({
      id: readonly ? 'ro' : 'rw', name: 'CH', type: 'clickhouse', host: 'localhost', port: 8123, readonly,
    });
    return driver;
  }

  it('applies readonly=1 to queries', async () => {
    const driver = await connect(true);
    const result = await driver.execute('SELECT 1');

    expect(result.error).toBeUndefined();
    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({
      clickhouse_settings: { readonly: '1' },
    }));
  });

  it('applies readonly=1 to commands as defense in depth', async () => {
    const driver = await connect(true);
    await driver.execute('CREATE TABLE should_not_run (id UInt8) ENGINE = Memory');

    expect(client.command).toHaveBeenCalledWith(expect.objectContaining({
      clickhouse_settings: { readonly: '1' },
    }));
  });

  it('leaves ordinary connections writable', async () => {
    const driver = await connect(false);
    await driver.execute('SELECT 1');

    expect(client.query).toHaveBeenCalledWith(expect.not.objectContaining({
      clickhouse_settings: expect.anything(),
    }));
  });
});
