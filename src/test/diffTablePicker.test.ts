import { describe, expect, it } from 'vitest';
import { collectComparableTables } from '../diff/diffTablePicker';
import { SchemaObject } from '../types/schema';

describe('collectComparableTables', () => {
  it('collects PostgreSQL/ClickHouse tables nested under namespaces', () => {
    const schema: SchemaObject[] = [{
      name: 'public', type: 'schema', children: [
        { name: 'customers', type: 'table', schema: 'public' },
        { name: 'customer_summary', type: 'view', schema: 'public' },
        { name: 'customers_id_seq', type: 'sequence', schema: 'public' },
      ],
    }];

    expect(collectComparableTables(schema)).toEqual([
      { tableName: 'customers', schema: 'public' },
      { tableName: 'customer_summary', schema: 'public' },
    ]);
  });

  it('collects SQLite tables and views returned at the root', () => {
    const schema: SchemaObject[] = [
      { name: 'customers', type: 'table', children: [{ name: 'id', type: 'column' }] },
      { name: 'customer_summary', type: 'view', children: [{ name: 'id', type: 'column' }] },
    ];

    expect(collectComparableTables(schema)).toEqual([
      { tableName: 'customers', schema: undefined },
      { tableName: 'customer_summary', schema: undefined },
    ]);
  });

  it('inherits a namespace through intermediate grouping nodes', () => {
    const schema: SchemaObject[] = [{
      name: 'analytics', type: 'database', children: [{
        name: 'Tables', type: 'group', children: [{ name: 'events', type: 'table' }],
      }],
    }];

    expect(collectComparableTables(schema)).toEqual([
      { tableName: 'events', schema: 'analytics' },
    ]);
  });
});
