import { describe, expect, it, vi } from 'vitest';
import { PostgresDriver } from '../drivers/postgres';

function installClient(driver: PostgresDriver, query: ReturnType<typeof vi.fn>) {
  (driver as unknown as { client: { query: typeof query } }).client = { query };
}

describe('PostgresDriver.getTableStatistics', () => {
  it('replaces the PostgreSQL -1 estimate sentinel with an exact count', async () => {
    const driver = new PostgresDriver();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ table_size: '0', indexes_size: '0', total_size: '0', est_rows: '-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ cnt: '500' }] });
    installClient(driver, query);

    const stats = await driver.getTableStatistics('customer_summary', 'public');
    const rowCount = stats.find(stat => stat.key === 'row_count');

    expect(rowCount).toMatchObject({ label: 'Row count', value: 500, unit: 'count' });
    expect(query).toHaveBeenLastCalledWith('SELECT COUNT(*) AS cnt FROM public.customer_summary');
  });

  it('keeps a non-negative catalog estimate without running COUNT', async () => {
    const driver = new PostgresDriver();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ table_size: '1', indexes_size: '2', total_size: '3', est_rows: '480' }] })
      .mockResolvedValueOnce({ rows: [] });
    installClient(driver, query);

    const stats = await driver.getTableStatistics('customers', 'public');
    expect(stats.find(stat => stat.key === 'row_count')).toMatchObject({
      label: 'Row count (estimated)', value: 480, unit: 'count',
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns a missing row count when the exact fallback is inaccessible', async () => {
    const driver = new PostgresDriver();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ table_size: '0', indexes_size: '0', total_size: '0', est_rows: '-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('permission denied'));
    installClient(driver, query);

    const stats = await driver.getTableStatistics('private_view', 'public');
    expect(stats.find(stat => stat.key === 'row_count')).toMatchObject({
      label: 'Row count', value: null, unit: 'count',
    });
  });
});
