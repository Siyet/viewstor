import { describe, expect, it, vi } from 'vitest';
import { RedisDriver } from '../drivers/redis';

function installClient(driver: RedisDriver, client: Record<string, unknown>) {
  (driver as unknown as { client: Record<string, unknown> }).client = client;
}

describe('RedisDriver.getTableStatistics', () => {
  it('keeps available metrics when optional ACL-protected commands fail', async () => {
    const driver = new RedisDriver();
    installClient(driver, {
      type: vi.fn().mockResolvedValue('list'),
      llen: vi.fn().mockResolvedValue(3),
      memory: vi.fn().mockRejectedValue(new Error('NOPERM')),
      ttl: vi.fn().mockRejectedValue(new Error('NOPERM')),
      object: vi.fn().mockRejectedValue(new Error('NOPERM')),
    });

    const stats = await driver.getTableStatistics('items');
    const byKey = new Map(stats.map(stat => [stat.key, stat]));
    expect(byKey.get('row_count')?.value).toBe(3);
    expect(byKey.get('total_size')?.value).toBeNull();
    expect(byKey.get('ttl')?.value).toBeNull();
    expect(byKey.get('encoding')?.value).toBeNull();
  });

  it('keeps the common contract when cardinality itself is denied', async () => {
    const driver = new RedisDriver();
    installClient(driver, {
      type: vi.fn().mockResolvedValue('stream'),
      xlen: vi.fn().mockRejectedValue(new Error('NOPERM')),
      memory: vi.fn().mockResolvedValue(null),
      ttl: vi.fn().mockResolvedValue(-2),
      object: vi.fn().mockResolvedValue(null),
    });

    const stats = await driver.getTableStatistics('stream');
    expect(stats.map(stat => stat.key)).toEqual(expect.arrayContaining([
      'row_count', 'total_size', 'last_modified',
    ]));
    expect(stats.find(stat => stat.key === 'row_count')?.value).toBeNull();
    expect(stats.find(stat => stat.key === 'ttl')?.value).toBeNull();
  });

  it('returns the presence contract when TYPE itself is denied by ACL', async () => {
    const driver = new RedisDriver();
    installClient(driver, {
      type: vi.fn().mockRejectedValue(new Error('NOPERM')),
      memory: vi.fn().mockResolvedValue(64),
      ttl: vi.fn().mockResolvedValue(-1),
      object: vi.fn().mockResolvedValue('raw'),
    });

    const stats = await driver.getTableStatistics('hidden-type');
    expect(stats.map(stat => stat.key)).toEqual(expect.arrayContaining([
      'row_count', 'total_size', 'last_modified',
    ]));
    expect(stats.find(stat => stat.key === 'row_count')?.value).toBeNull();
    expect(stats.find(stat => stat.key === 'type')?.value).toBeNull();
    expect(stats.find(stat => stat.key === 'total_size')?.value).toBe(64);
  });
});
