import { describe, expect, it } from 'vitest';
import { buildErDiagramData, erTableId } from '../er/erDataTransform';
import { ForeignKeyInfo, SchemaObject } from '../types/schema';

const schema: SchemaObject[] = [
  {
    name: 'public',
    type: 'schema',
    children: [
      {
        name: 'users',
        type: 'table',
        children: [
          { name: 'id', type: 'column', detail: 'integer (PK)' },
          {
            name: 'email',
            type: 'column',
            detail: 'character varying(255)',
            notNullable: true,
            indexNames: ['users_email_idx'],
            comment: 'Primary contact address',
          },
          { name: 'Indexes', type: 'group', children: [{ name: 'users_pkey', type: 'index' }] },
        ],
      },
      {
        name: 'orders',
        type: 'table',
        children: [
          { name: 'id', type: 'column', detail: 'bigint (PK)' },
          { name: 'user_id', type: 'column', detail: 'integer' },
        ],
      },
      { name: 'user_summary', type: 'view', children: [{ name: 'id', type: 'column', detail: 'integer' }] },
    ],
  },
  {
    name: 'audit',
    type: 'schema',
    children: [{
      name: 'events',
      type: 'table',
      children: [{ name: 'user_id', type: 'column', detail: 'integer' }],
    }],
  },
];

const foreignKeys: ForeignKeyInfo[] = [
  {
    name: 'orders_user_id_fkey',
    sourceSchema: 'public',
    sourceTable: 'orders',
    sourceColumns: ['user_id'],
    targetSchema: 'public',
    targetTable: 'users',
    targetColumns: ['id'],
  },
  {
    name: 'events_user_id_fkey',
    sourceSchema: 'audit',
    sourceTable: 'events',
    sourceColumns: ['user_id'],
    targetSchema: 'public',
    targetTable: 'users',
    targetColumns: ['id'],
  },
  {
    name: 'dangling',
    sourceSchema: 'public',
    sourceTable: 'orders',
    sourceColumns: ['missing_id'],
    targetSchema: 'public',
    targetTable: 'missing',
    targetColumns: ['id'],
  },
];

describe('ER diagram data transform', () => {
  it('flattens schema tables, columns, PKs and types', () => {
    const result = buildErDiagramData(schema, foreignKeys);

    expect(result.tables.map(table => table.id)).toEqual([
      'audit.events',
      'public.orders',
      'public.user_summary',
      'public.users',
    ]);
    expect(result.tables.find(table => table.id === 'public.users')?.columns).toEqual([
      {
        name: 'id', dataType: 'integer', primaryKey: true, foreignKey: false,
        notNullable: true, indexNames: undefined, comment: undefined,
      },
      {
        name: 'email',
        dataType: 'character varying(255)',
        primaryKey: false,
        foreignKey: false,
        notNullable: true,
        indexNames: ['users_email_idx'],
        comment: 'Primary contact address',
      },
    ]);
    expect(result.tables.find(table => table.id === 'public.orders')?.columns).toEqual([
      expect.objectContaining({ name: 'id', primaryKey: true, foreignKey: false }),
      expect.objectContaining({ name: 'user_id', primaryKey: false, foreignKey: true }),
    ]);
    expect(result.tables.find(table => table.id === 'public.user_summary')?.kind).toBe('view');
    expect(result.foreignKeys.map(foreignKey => foreignKey.name)).toEqual([
      'orders_user_id_fkey',
      'events_user_id_fkey',
    ]);
    expect(result.namespaceKind).toBe('schema');
  });

  it('limits tables and relationships to one schema', () => {
    const result = buildErDiagramData(schema, foreignKeys, { schema: 'public' });

    expect(result.tables.map(table => table.id)).toEqual([
      'public.orders',
      'public.user_summary',
      'public.users',
    ]);
    expect(result.foreignKeys.map(foreignKey => foreignKey.name)).toEqual(['orders_user_id_fkey']);
  });

  it('supports flat schema trees such as SQLite', () => {
    const result = buildErDiagramData([
      { name: 'parent', type: 'table', children: [{ name: 'id', type: 'column', detail: 'INTEGER (PK)' }] },
      { name: 'child', type: 'table', children: [{ name: 'parent_id', type: 'column', detail: 'INTEGER' }] },
    ], [{
      name: 'fk_child_0',
      sourceTable: 'child',
      sourceColumns: ['parent_id'],
      targetTable: 'parent',
      targetColumns: ['id'],
    }], { foreignKeysUnsupported: true });

    expect(result.tables.map(table => table.id)).toEqual(['child', 'parent']);
    expect(result.foreignKeys).toHaveLength(1);
    expect(result.foreignKeysUnsupported).toBe(true);
    expect(result.namespaceKind).toBeUndefined();
  });

  it('labels ClickHouse namespaces as databases', () => {
    const result = buildErDiagramData(schema, foreignKeys, { namespaceKind: 'database' });
    expect(result.namespaceKind).toBe('database');
  });

  it('qualifies table ids only when a schema is present', () => {
    expect(erTableId('public', 'users')).toBe('public.users');
    expect(erTableId(undefined, 'users')).toBe('users');
  });
});
