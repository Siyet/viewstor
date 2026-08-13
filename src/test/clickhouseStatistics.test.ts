import { describe, expect, it, vi } from 'vitest';
import { ClickHouseDriver } from '../drivers/clickhouse';

describe('ClickHouseDriver.getTableStatistics', () => {
  it('derives last_modified only from active parts', async () => {
    const tableJson = vi.fn().mockResolvedValue([{
      total_rows: 2,
      total_bytes: 10,
      total_bytes_uncompressed: 20,
      lifetime_rows: 2,
      lifetime_bytes: 20,
      engine: 'MergeTree',
      metadata_modification_time: '2026-01-01 00:00:00',
    }]);
    const partsJson = vi.fn().mockResolvedValue([{
      active_parts: 1,
      total_parts: 2,
      last_modified: '2026-01-02T00:00:00Z',
    }]);
    const query = vi.fn()
      .mockResolvedValueOnce({ json: tableJson })
      .mockResolvedValueOnce({ json: partsJson });
    const driver = new ClickHouseDriver();
    (driver as unknown as { client: { query: typeof query } }).client = { query };
    (driver as unknown as { database: string }).database = 'db';

    const stats = await driver.getTableStatistics('events');
    const partsQuery = query.mock.calls[1][0].query as string;
    expect(partsQuery).toContain('formatDateTime(maxIf(modification_time, active), \'%FT%TZ\', \'UTC\')');
    expect(stats.find(stat => stat.key === 'last_modified')).toMatchObject({
      label: 'Latest active part write',
      value: '2026-01-02T00:00:00Z',
      unit: 'date',
    });
  });
});
