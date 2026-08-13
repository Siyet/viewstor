import { SchemaObject } from '../types/schema';

export interface ComparableTable {
  tableName: string;
  schema?: string;
}

/**
 * Flatten driver schema trees into tables/views available to Data Diff.
 * PostgreSQL and ClickHouse return namespace containers, while SQLite returns
 * tables and views directly at the root.
 */
export function collectComparableTables(schemaObjects: SchemaObject[]): ComparableTable[] {
  const result: ComparableTable[] = [];

  function visit(node: SchemaObject, namespace?: string): void {
    if (node.type === 'table' || node.type === 'view') {
      result.push({ tableName: node.name, schema: node.schema || namespace });
      return;
    }

    const childNamespace = node.type === 'schema' || node.type === 'database'
      ? node.name
      : namespace;
    for (const child of node.children || []) visit(child, childNamespace);
  }

  for (const node of schemaObjects) visit(node);
  return result;
}
