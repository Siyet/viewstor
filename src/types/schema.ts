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

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  /** Index type: btree, hash, gin, gist, etc. */
  type?: string;
  /** Partial index WHERE clause */
  predicate?: string;
}

export interface ConstraintInfo {
  name: string;
  type: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK';
  columns: string[];
  /** FK: referenced table (schema.table) */
  referencedTable?: string;
  /** FK: referenced columns */
  referencedColumns?: string[];
  /** FK: ON DELETE action */
  onDelete?: string;
  /** FK: ON UPDATE action */
  onUpdate?: string;
  /** CHECK: expression */
  checkExpression?: string;
}

export interface TriggerInfo {
  name: string;
  /** BEFORE, AFTER, INSTEAD OF */
  timing: string;
  /** INSERT, UPDATE, DELETE (comma-separated if multiple) */
  events: string;
  /** Trigger function name (PG) or full SQL (SQLite) */
  definition?: string;
}

export interface SequenceInfo {
  name: string;
  dataType?: string;
  startValue?: number;
  increment?: number;
  minValue?: number;
  maxValue?: number;
}

/** Extended table metadata including related schema objects */
export interface TableObjects {
  indexes: IndexInfo[];
  constraints: ConstraintInfo[];
  triggers: TriggerInfo[];
  sequences: SequenceInfo[];
}
