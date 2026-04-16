export interface SchemaObject {
  name: string;
  type: SchemaObjectType;
  schema?: string;
  children?: SchemaObject[];
  /** Displayed as gray description text in the tree */
  detail?: string;
  /** Mark as inaccessible (no permissions) — renders with error color */
  inaccessible?: boolean;
  /** For column nodes: names of indexes that cover this column. Used for blue
   *  tint in the tree and the "Show index DDL" context menu item. */
  indexNames?: string[];
  /** For column nodes: column is NOT NULL. Tree appends a "*" to the label. */
  notNullable?: boolean;
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
  /** Non-key "covering" columns from PG's INCLUDE (col1, col2) clause */
  included?: string[];
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

/** A single table-level statistic (row count, size, last vacuum, etc.) */
export interface TableStatistic {
  /** Stable identifier, e.g. "row_count", "table_size" */
  key: string;
  /** Human-readable label */
  label: string;
  /** Raw value (numbers compared for delta, strings compared as-is, null = not available) */
  value: number | string | null;
  /** Hint for formatting: bytes → KB/MB/GB, count → thousands separator, date → ISO timestamp */
  unit?: 'bytes' | 'count' | 'percent' | 'date' | 'text';
  /**
   * For numeric stats, direction in which a larger value is considered "worse" (red):
   *   "higher-is-worse" — dead tuples, seq scans
   *   "lower-is-worse" — idx scans, row count (sometimes)
   *   undefined — neutral, no color coding
   */
  badWhen?: 'higher' | 'lower';
}

/** Summary entry for the top-N tables list in the database statistics view. */
export interface TopTableEntry {
  name: string;
  schema?: string;
  rowCount: number | null;
  sizeBytes: number | null;
  indexesSizeBytes: number | null;
  deadTuplesPct: number | null;
  lastVacuum: string | null;
}

/**
 * Database-level statistics: overview tiles, sortable top-N tables, and
 * connection-level metrics. Mirrors the per-table `TableStatistic` shape so
 * the same formatter / diff engine apply.
 */
export interface DatabaseStatistics {
  overview: TableStatistic[];
  topTables: TopTableEntry[];
  connectionLevel: TableStatistic[];
}
