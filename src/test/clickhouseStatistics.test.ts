import { describe, expect, it, vi } from 'vitest';
import { ClickHouseDriver } from '../drivers/clickhouse';

describe('ClickHouseDriver.getTableStatistics', () => {
  it('falls back to an exact count when system.tables has no row count for a view', async () => {
    const tableJson = vi.fn().mockResolvedValue([{
      total_rows: null,
      total_bytes: null,
      total_bytes_uncompressed: null,
      lifetime_rows: null,
      lifetime_bytes: null,
      engine: 'View',
      metadata_modification_time: '2026-01-01 00:00:00',
    }]);
    const partsJson = vi.fn().mockResolvedValue([{
      active_parts: 0,
      total_parts: 0,
      last_modified: '1970-01-01T00:00:00Z',
    }]);
    const query = vi.fn()
      .mockResolvedValueOnce({ json: tableJson })
      .mockResolvedValueOnce({ json: partsJson });
    const driver = new ClickHouseDriver();
    (driver as unknown as { client: { query: typeof query } }).client = { query };
    (driver as unknown as { database: string }).database = 'demo';
    const execute = vi.spyOn(driver, 'execute').mockResolvedValue({
      columns: [{ name: 'cnt', dataType: 'UInt64' }],
      rows: [{ cnt: '500' }],
      rowCount: 1,
      executionTimeMs: 1,
    });

    const stats = await driver.getTableStatistics('customer_summary');

    expect(execute).toHaveBeenCalledWith('SELECT COUNT(*) AS cnt FROM demo.customer_summary');
    expect(stats.find(stat => stat.key === 'row_count')).toMatchObject({ value: 500, unit: 'count' });
  });

  it('keeps the view row count unknown when the exact fallback fails', async () => {
    const tableJson = vi.fn().mockResolvedValue([{
      total_rows: null,
      total_bytes: null,
      total_bytes_uncompressed: null,
      lifetime_rows: null,
      lifetime_bytes: null,
      engine: 'View',
      metadata_modification_time: null,
    }]);
    const partsJson = vi.fn().mockResolvedValue([]);
    const query = vi.fn()
      .mockResolvedValueOnce({ json: tableJson })
      .mockResolvedValueOnce({ json: partsJson });
    const driver = new ClickHouseDriver();
    (driver as unknown as { client: { query: typeof query } }).client = { query };
    vi.spyOn(driver, 'execute').mockResolvedValue({
      columns: [], rows: [], rowCount: 0, executionTimeMs: 1, error: 'denied',
    });

    const stats = await driver.getTableStatistics('private_view', 'demo');

    expect(stats.find(stat => stat.key === 'row_count')).toMatchObject({ value: null, unit: 'count' });
  });

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

describe('ClickHouseDriver.getTableInfo', () => {
  it('marks columns from the resolved ClickHouse primary key', async () => {
    const json = vi.fn().mockResolvedValue([
      {
        name: 'id', type: 'UInt64', default_kind: '', default_expression: '',
        comment: '', is_in_primary_key: 1,
      },
      {
        name: 'name', type: 'String', default_kind: '', default_expression: '',
        comment: 'Customer name', is_in_primary_key: 0,
      },
    ]);
    const query = vi.fn().mockResolvedValue({ json });
    const driver = new ClickHouseDriver();
    (driver as unknown as { client: { query: typeof query } }).client = { query };

    const info = await driver.getTableInfo('customers', 'demo');

    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      query_params: { db: 'demo', table: 'customers' },
    }));
    expect(info.columns).toEqual([
      expect.objectContaining({ name: 'id', isPrimaryKey: true }),
      expect.objectContaining({ name: 'name', isPrimaryKey: false, comment: 'Customer name' }),
    ]);
  });
});
