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
}

// --- Schema objects diff (indexes, constraints, triggers, sequences) ---

export interface ObjectDiffItem {
  name: string;
  status: 'same' | 'differs' | 'added' | 'removed';
  leftDetail?: string;
  rightDetail?: string;
  differences?: string[];
}

export interface ObjectsDiffResult {
  indexes: ObjectDiffItem[];
  constraints: ObjectDiffItem[];
  triggers: ObjectDiffItem[];
  sequences: ObjectDiffItem[];
}
