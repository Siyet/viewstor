import { ColumnInfo } from '../types/schema';
import { DiffOptions, DiffSource, MatchedRow, RowDiffResult, SchemaDiffResult, ColumnDiffInfo, ColumnCompare } from './diffTypes';

/**
 * Stringify a cell value for comparison.
 * Produces consistent string representation across all database types.
 */
export function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Build a composite key string from a row's key columns.
 * Uses null-byte separator to avoid collisions.
 */
function buildRowKey(row: Record<string, unknown>, keyColumns: string[]): string {
  return keyColumns.map(col => stringifyCell(row[col])).join('\0');
}

/**
 * Compute row-level diff between two data sources.
 * Matches rows by key columns, then compares all other columns.
 */
export function computeRowDiff(left: DiffSource, right: DiffSource, options: DiffOptions): RowDiffResult {
  const { keyColumns, rowLimit } = options;

  // Enforce row limit
  const leftRows = left.rows.slice(0, rowLimit);
  const rightRows = right.rows.slice(0, rowLimit);
  const truncated = left.rows.length > rowLimit || right.rows.length > rowLimit;

  // Collect all columns from both sides
  const leftColNames = left.columns.map(c => c.name);
  const rightColNames = right.columns.map(c => c.name);
  const allColumnsSet = new Set([...leftColNames, ...rightColNames]);
  const allColumns = [...allColumnsSet];
  const nonKeyColumns = allColumns.filter(col => !keyColumns.includes(col));

  // Build index for right side (key -> row)
  // If duplicate keys exist, last occurrence wins
  const rightIndex = new Map<string, Record<string, unknown>>();
  for (const row of rightRows) {
    rightIndex.set(buildRowKey(row, keyColumns), row);
  }

  const matched: MatchedRow[] = [];
  const leftOnly: Record<string, unknown>[] = [];
  let unchanged = 0;

  // Pass 1: iterate left rows, match against right index
  const matchedKeys = new Set<string>();
  for (const leftRow of leftRows) {
    const key = buildRowKey(leftRow, keyColumns);
    const rightRow = rightIndex.get(key);

    if (rightRow) {
      matchedKeys.add(key);
      // Compare non-key columns
      const changedColumns: string[] = [];
      for (const col of nonKeyColumns) {
        if (stringifyCell(leftRow[col]) !== stringifyCell(rightRow[col])) {
          changedColumns.push(col);
        }
      }
      matched.push({ key, left: leftRow, right: rightRow, changedColumns });
      if (changedColumns.length === 0) {
        unchanged++;
      }
    } else {
      leftOnly.push(leftRow);
    }
  }

  // Pass 2: remaining right rows not matched
  const rightOnly: Record<string, unknown>[] = [];
  for (const row of rightRows) {
    const key = buildRowKey(row, keyColumns);
    if (!matchedKeys.has(key)) {
      rightOnly.push(row);
    }
  }

  return {
    allColumns,
    matched,
    leftOnly,
    rightOnly,
    truncated,
    summary: {
      total: leftRows.length + rightOnly.length,
      unchanged,
      changed: matched.length - unchanged,
      added: rightOnly.length,
      removed: leftOnly.length,
    },
  };
}

/**
 * Compute schema-level diff between two tables.
 * Compares column names, data types, nullability, and primary key status.
 */
export function computeSchemaDiff(leftColumns: ColumnInfo[], rightColumns: ColumnInfo[]): SchemaDiffResult {
  const leftMap = new Map<string, ColumnInfo>();
  for (const col of leftColumns) {
    leftMap.set(col.name, col);
  }

  const rightMap = new Map<string, ColumnInfo>();
  for (const col of rightColumns) {
    rightMap.set(col.name, col);
  }

  const leftOnlyColumns: ColumnDiffInfo[] = [];
  const commonColumns: ColumnCompare[] = [];

  for (const [name, leftCol] of leftMap) {
    const rightCol = rightMap.get(name);
    if (!rightCol) {
      leftOnlyColumns.push({
        name: leftCol.name,
        dataType: leftCol.dataType,
        nullable: leftCol.nullable,
        isPrimaryKey: leftCol.isPrimaryKey,
      });
    } else {
      commonColumns.push({
        name,
        leftType: leftCol.dataType,
        rightType: rightCol.dataType,
        typeDiffers: leftCol.dataType !== rightCol.dataType,
        leftNullable: leftCol.nullable,
        rightNullable: rightCol.nullable,
        nullableDiffers: leftCol.nullable !== rightCol.nullable,
        leftIsPK: leftCol.isPrimaryKey,
        rightIsPK: rightCol.isPrimaryKey,
        pkDiffers: leftCol.isPrimaryKey !== rightCol.isPrimaryKey,
      });
    }
  }

  const rightOnlyColumns: ColumnDiffInfo[] = [];
  for (const [name, rightCol] of rightMap) {
    if (!leftMap.has(name)) {
      rightOnlyColumns.push({
        name: rightCol.name,
        dataType: rightCol.dataType,
        nullable: rightCol.nullable,
        isPrimaryKey: rightCol.isPrimaryKey,
      });
    }
  }

  return { leftOnlyColumns, rightOnlyColumns, commonColumns };
}

/**
 * Export a row diff result as CSV.
 * Adds a _diff_status column indicating added/removed/changed for each row.
 */
export function exportDiffAsCsv(result: RowDiffResult, _keyColumns: string[]): string {
  const header = ['_diff_status', ...result.allColumns];
  const lines: string[] = [header.join(',')];

  const escapeValue = (value: unknown): string => {
    const str = stringifyCell(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const formatRow = (row: Record<string, unknown>, status: string): string => {
    return [status, ...result.allColumns.map(col => escapeValue(row[col]))].join(',');
  };

  for (const row of result.leftOnly) {
    lines.push(formatRow(row, 'removed'));
  }
  for (const match of result.matched) {
    lines.push(formatRow(match.right, 'changed'));
  }
  for (const row of result.rightOnly) {
    lines.push(formatRow(row, 'added'));
  }

  return lines.join('\n');
}

/**
 * Export a row diff result as JSON.
 */
export function exportDiffAsJson(result: RowDiffResult): string {
  return JSON.stringify({
    summary: result.summary,
    changed: result.matched.map(match => ({
      key: match.key,
      changedColumns: match.changedColumns,
      left: match.left,
      right: match.right,
    })),
    added: result.rightOnly,
    removed: result.leftOnly,
  }, null, 2);
}
