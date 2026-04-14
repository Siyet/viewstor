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
