import { QueryColumn } from '../types/query';

export interface DiffSource {
  label: string;
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  connectionId?: string;
  tableName?: string;
  schema?: string;
  databaseName?: string;
}

export interface DiffOptions {
  keyColumns: string[];
  rowLimit: number;
}

export interface RowDiffResult {
  allColumns: string[];
  matched: MatchedRow[];
  leftOnly: Record<string, unknown>[];
  rightOnly: Record<string, unknown>[];
  truncated: boolean;
  summary: {
    total: number;
    unchanged: number;
    changed: number;
    added: number;
    removed: number;
  };
}

export interface MatchedRow {
  key: string;
  left: Record<string, unknown>;
  right: Record<string, unknown>;
  changedColumns: string[];
}

export interface SchemaDiffResult {
  leftOnlyColumns: ColumnDiffInfo[];
  rightOnlyColumns: ColumnDiffInfo[];
  commonColumns: ColumnCompare[];
}

export interface ColumnDiffInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  comment?: string;
}

export interface ColumnCompare {
  name: string;
  leftType: string;
  rightType: string;
  typeDiffers: boolean;
  leftNullable: boolean;
  rightNullable: boolean;
  nullableDiffers: boolean;
  leftIsPK: boolean;
  rightIsPK: boolean;
  pkDiffers: boolean;
  leftComment?: string;
  rightComment?: string;
  commentDiffers: boolean;
}

// --- Schema objects diff (indexes, constraints, triggers, sequences) ---

export interface ObjectDiffItem<T = unknown> {
  name: string;
  status: 'same' | 'differs' | 'added' | 'removed';
  leftDetail?: string;
  rightDetail?: string;
  /** Structured info for the left side — the concrete type depends on which section this item belongs to. */
  left?: T;
  /** Structured info for the right side. */
  right?: T;
  differences?: string[];
}

export interface ObjectsDiffResult {
  indexes: ObjectDiffItem<import('../types/schema').IndexInfo>[];
  constraints: ObjectDiffItem<import('../types/schema').ConstraintInfo>[];
  triggers: ObjectDiffItem<import('../types/schema').TriggerInfo>[];
  sequences: ObjectDiffItem<import('../types/schema').SequenceInfo>[];
}

// --- Statistics diff (row count, sizes, vacuum info, scan counters) ---

export interface StatsDiffItem {
  key: string;
  label: string;
  unit?: 'bytes' | 'count' | 'percent' | 'date' | 'text';
  badWhen?: 'higher' | 'lower';
  leftValue: number | string | null;
  rightValue: number | string | null;
  /** Absolute delta (right - left) for numeric values. Undefined if either side is non-numeric. */
  delta?: number;
  /** Percentage delta relative to left. Undefined when left is 0 or values non-numeric. */
  deltaPercent?: number;
  status: 'same' | 'differs' | 'leftOnly' | 'rightOnly' | 'missing';
}

export interface StatsDiffResult {
  items: StatsDiffItem[];
}

// --- N-way (multi-source) diff types ---

export interface NWayDiffOptions extends DiffOptions {
  /** Index of the reference source (default 0). All other sources are compared against it. */
  referenceIndex?: number;
}

export interface NWayMatchedRow {
  key: string;
  /** One entry per source. null when the source does not contain this key. */
  values: (Record<string, unknown> | null)[];
  /** Columns that differ from the reference in at least one other source. */
  changedColumns: string[];
}

export interface NWayRowDiffResult {
  sourceCount: number;
  allColumns: string[];
  matched: NWayMatchedRow[];
  /** sourceOnly[i] = rows present only in source i and no other. */
  sourceOnly: Record<string, unknown>[][];
  truncated: boolean;
  summary: {
    total: number;
    unchanged: number;
    changed: number;
    /** Rows present in non-reference sources but absent from the reference. */
    added: number;
    /** Rows present only in the reference and absent from all other sources. */
    removed: number;
  };
}

export interface NWayColumnCompare {
  name: string;
  /** Data type per source (empty string when column is absent). */
  types: string[];
  nullables: boolean[];
  isPKs: boolean[];
  comments: (string | undefined)[];
  /** Whether each source contains this column. */
  present: boolean[];
  hasDifferences: boolean;
}

export interface NWaySchemaDiffResult {
  sourceCount: number;
  columns: NWayColumnCompare[];
}

export interface NWayStatsDiffItem {
  key: string;
  label: string;
  unit?: 'bytes' | 'count' | 'percent' | 'date' | 'text';
  badWhen?: 'higher' | 'lower';
  /** One value per source, null when the source does not report this metric. */
  values: (number | string | null)[];
  /** Whether each source contains this key. */
  present: boolean[];
  hasDifferences: boolean;
}

export interface NWayStatsDiffResult {
  sourceCount: number;
  items: NWayStatsDiffItem[];
}
