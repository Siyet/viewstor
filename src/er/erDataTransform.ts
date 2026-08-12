import { ForeignKeyInfo, SchemaObject } from '../types/schema';

export interface ErColumn {
  name: string;
  dataType: string;
  primaryKey: boolean;
  foreignKey: boolean;
  notNullable: boolean;
  indexNames?: string[];
  comment?: string;
}

export interface ErTable {
  id: string;
  name: string;
  schema?: string;
  kind: 'table' | 'view';
  columns: ErColumn[];
}

export interface ErDiagramData {
  tables: ErTable[];
  foreignKeys: ForeignKeyInfo[];
  /** Label used for grouped areas in engines with named namespaces. */
  namespaceKind?: 'schema' | 'database';
  /** True when the driver cannot expose FK metadata. */
  foreignKeysUnsupported?: boolean;
}

export interface BuildErDiagramOptions {
  schema?: string;
  namespaceKind?: 'schema' | 'database';
  foreignKeysUnsupported?: boolean;
}

export function erTableId(schema: string | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

/**
 * Flatten a driver's schema tree into graph-ready tables and discard foreign
 * keys whose endpoints are outside the selected scope.
 */
export function buildErDiagramData(
  schemaObjects: SchemaObject[],
  foreignKeys: ForeignKeyInfo[],
  options: BuildErDiagramOptions = {},
): ErDiagramData {
  const tables: ErTable[] = [];

  function visit(objects: SchemaObject[], inheritedSchema?: string) {
    for (const object of objects) {
      const currentSchema = object.type === 'schema'
        ? object.name
        : object.schema ?? inheritedSchema;

      if ((object.type === 'table' || object.type === 'view')
        && (!options.schema || currentSchema === options.schema)) {
        const columns = (object.children ?? [])
          .filter(child => child.type === 'column')
          .map(child => ({
            name: child.name,
            dataType: columnDataType(child.detail),
            primaryKey: /\(\s*PK(?:\s*[,)]|\s*$)/i.test(child.detail ?? ''),
            foreignKey: false,
            notNullable: Boolean(child.notNullable) || /\(\s*PK(?:\s*[,)]|\s*$)/i.test(child.detail ?? ''),
            indexNames: child.indexNames,
            comment: child.comment,
          }));
        tables.push({
          id: erTableId(currentSchema, object.name),
          name: object.name,
          schema: currentSchema,
          kind: object.type,
          columns,
        });
      }

      if (object.children && object.type !== 'table' && object.type !== 'view') {
        visit(object.children, currentSchema);
      }
    }
  }

  visit(schemaObjects);
  tables.sort((left, right) => left.id.localeCompare(right.id));

  const tableIds = new Set(tables.map(table => table.id));
  const visibleForeignKeys = foreignKeys.filter(foreignKey => {
    const source = erTableId(foreignKey.sourceSchema, foreignKey.sourceTable);
    const target = erTableId(foreignKey.targetSchema, foreignKey.targetTable);
    return tableIds.has(source) && tableIds.has(target);
  });

  const tableById = new Map(tables.map(table => [table.id, table]));
  for (const foreignKey of visibleForeignKeys) {
    const source = tableById.get(erTableId(foreignKey.sourceSchema, foreignKey.sourceTable));
    const sourceColumns = new Set(foreignKey.sourceColumns);
    for (const column of source?.columns ?? []) {
      if (sourceColumns.has(column.name)) column.foreignKey = true;
    }
  }

  return {
    tables,
    foreignKeys: visibleForeignKeys,
    namespaceKind: tables.some(table => table.schema) ? (options.namespaceKind ?? 'schema') : undefined,
    foreignKeysUnsupported: options.foreignKeysUnsupported || undefined,
  };
}

/** Strip display badges such as "(PK)" while keeping types with parentheses. */
function columnDataType(detail?: string): string {
  if (!detail) return '';
  return detail.replace(/\s+\((?:PK|PK\s*,[^)]*)\)\s*$/i, '').trim();
}
