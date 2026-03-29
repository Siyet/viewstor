export interface SchemaObject {
  name: string;
  type: SchemaObjectType;
  schema?: string;
  children?: SchemaObject[];
  /** Displayed as gray description text in the tree */
  detail?: string;
  /** Mark as inaccessible (no permissions) — renders with error color */
  inaccessible?: boolean;
}

export type SchemaObjectType =
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'column'
  | 'index'
  | 'key'
  | 'keyspace'
  | 'trigger'
  | 'sequence'
  | 'group';

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  defaultValue?: string;
  comment?: string;
}

export interface TableInfo {
  name: string;
  schema?: string;
  columns: ColumnInfo[];
  rowCount?: number;
  sizeBytes?: number;
}
