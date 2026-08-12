import { ForeignKeyInfo, SchemaObject } from '../types/schema';

export interface ErColumn {
  name: string;
  dataType: string;
  primaryKey: boolean;
  notNullable: boolean;
}

export interface ErTable {
  id: string;
  name: string;
  schema?: string;
  columns: ErColumn[];
}

export interface ErDiagramData {
  tables: ErTable[];
  foreignKeys: ForeignKeyInfo[];
  /** True when the driver cannot expose FK metadata. */
  foreignKeysUnsupported?: boolean;
}

export interface BuildErDiagramOptions {
  schema?: string;
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

      if (object.type === 'table' && (!options.schema || currentSchema === options.schema)) {
        const columns = (object.children ?? [])
          .filter(child => child.type === 'column')
          .map(child => ({
            name: child.name,
            dataType: columnDataType(child.detail),
            primaryKey: /\(\s*PK(?:\s*[,)]|\s*$)/i.test(child.detail ?? ''),
            notNullable: Boolean(child.notNullable) || /\(\s*PK(?:\s*[,)]|\s*$)/i.test(child.detail ?? ''),
          }));
        tables.push({
          id: erTableId(currentSchema, object.name),
          name: object.name,
          schema: currentSchema,
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

  return {
    tables,
    foreignKeys: visibleForeignKeys,
    foreignKeysUnsupported: options.foreignKeysUnsupported || undefined,
  };
}

/** Strip display badges such as "(PK)" while keeping types with parentheses. */
function columnDataType(detail?: string): string {
  if (!detail) return '';
  return detail.replace(/\s+\((?:PK|PK\s*,[^)]*)\)\s*$/i, '').trim();
}
