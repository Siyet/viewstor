import { DatabaseDriver } from '../../../types/driver';

/**
 * Shared assertions for the DatabaseDriver interface contract.
 * Call within a describe() block after the driver is connected.
 */
export function runDriverInterfaceTests(getDriver: () => DatabaseDriver, tableName: string, schema?: string) {
  it('ping returns true', async () => {
    const result = await getDriver().ping();
    expect(result).toBe(true);
  });

  it('getSchema returns non-empty array', async () => {
    const schema = await getDriver().getSchema();
    expect(Array.isArray(schema)).toBe(true);
    expect(schema.length).toBeGreaterThan(0);
  });

  it('getTableInfo returns columns', async () => {
    const info = await getDriver().getTableInfo(tableName, schema);
    expect(info.name).toBe(tableName);
    expect(info.columns.length).toBeGreaterThan(0);
  });

  it('getTableData returns rows', async () => {
    const result = await getDriver().getTableData(tableName, schema);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.columns.length).toBeGreaterThan(0);
  });

  it('getTableData with orderBy does not error', async () => {
    const result = await getDriver().getTableData(tableName, schema, 10, 0, []);
    expect(result.rows.length).toBeGreaterThan(0);
  });
}
