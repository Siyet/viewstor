import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clientConstructor } = vi.hoisted(() => {
  const client = {
    connect: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    query: vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 })),
  };
  return { clientConstructor: vi.fn(function () { return client; }), client };
});

vi.mock('pg', () => ({
  Client: clientConstructor,
  types: { setTypeParser: vi.fn() },
}));

import { PostgresDriver } from '../drivers/postgres';

describe('PostgresDriver native readonly mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets readonly mode and standard string parsing on readonly connections', async () => {
    const driver = new PostgresDriver();
    await driver.connect({
      id: 'ro', name: 'Read only', type: 'postgresql', host: 'localhost', port: 5432, readonly: true,
    });

    expect(clientConstructor).toHaveBeenCalledWith(expect.objectContaining({
      options: '-c default_transaction_read_only=on -c standard_conforming_strings=on',
    }));
    await driver.disconnect();
  });

  it('does not force readonly mode on ordinary connections', async () => {
    const driver = new PostgresDriver();
    await driver.connect({
      id: 'rw', name: 'Writable', type: 'postgresql', host: 'localhost', port: 5432,
    });

    expect(clientConstructor.mock.calls[0][0].options).toBeUndefined();
  });
});
