import { ColumnInfo, TableObjects, IndexInfo, ConstraintInfo, TriggerInfo, SequenceInfo } from '../types/schema';
import { DiffOptions, DiffSource, MatchedRow, RowDiffResult, SchemaDiffResult, ColumnDiffInfo, ColumnCompare, ObjectDiffItem, ObjectsDiffResult } from './diffTypes';

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
 * Compare table objects (indexes, constraints, triggers, sequences) between two tables.
 */
export function computeObjectsDiff(
  leftObjects: TableObjects | undefined,
  rightObjects: TableObjects | undefined,
): ObjectsDiffResult {
  const empty: TableObjects = { indexes: [], constraints: [], triggers: [], sequences: [] };
  const left = leftObjects || empty;
  const right = rightObjects || empty;

  return {
    indexes: diffIndexes(left.indexes, right.indexes),
    constraints: diffConstraints(left.constraints, right.constraints),
    triggers: diffTriggers(left.triggers, right.triggers),
    sequences: diffSequences(left.sequences, right.sequences),
  };
}

function diffIndexes(leftIndexes: IndexInfo[], rightIndexes: IndexInfo[]): ObjectDiffItem[] {
  const leftMap = new Map(leftIndexes.map(idx => [idx.name, idx]));
  const rightMap = new Map(rightIndexes.map(idx => [idx.name, idx]));
  const result: ObjectDiffItem[] = [];

  for (const [name, leftIdx] of leftMap) {
    const rightIdx = rightMap.get(name);
    if (!rightIdx) {
      result.push({
        name,
        status: 'removed',
        leftDetail: formatIndex(leftIdx),
      });
    } else {
      const diffs: string[] = [];
      if (JSON.stringify(leftIdx.columns) !== JSON.stringify(rightIdx.columns)) {
        diffs.push(`columns: ${leftIdx.columns.join(', ')} → ${rightIdx.columns.join(', ')}`);
      }
      if (leftIdx.unique !== rightIdx.unique) {
        diffs.push(`unique: ${leftIdx.unique} → ${rightIdx.unique}`);
      }
      if ((leftIdx.type || '') !== (rightIdx.type || '')) {
        diffs.push(`type: ${leftIdx.type || '?'} → ${rightIdx.type || '?'}`);
      }
      if ((leftIdx.predicate || '') !== (rightIdx.predicate || '')) {
        diffs.push(`predicate: ${leftIdx.predicate || '—'} → ${rightIdx.predicate || '—'}`);
      }
      result.push({
        name,
        status: diffs.length > 0 ? 'differs' : 'same',
        leftDetail: formatIndex(leftIdx),
        rightDetail: formatIndex(rightIdx),
        differences: diffs.length > 0 ? diffs : undefined,
      });
    }
  }

  for (const [name, rightIdx] of rightMap) {
    if (!leftMap.has(name)) {
      result.push({
        name,
        status: 'added',
        rightDetail: formatIndex(rightIdx),
      });
    }
  }

  return result;
}

function formatIndex(idx: IndexInfo): string {
  const parts = [idx.unique ? 'UNIQUE' : '', idx.type || '', `(${idx.columns.join(', ')})`];
  if (idx.predicate) parts.push(`WHERE ${idx.predicate}`);
  return parts.filter(Boolean).join(' ').trim();
}

function diffConstraints(leftConstraints: ConstraintInfo[], rightConstraints: ConstraintInfo[]): ObjectDiffItem[] {
  const leftMap = new Map(leftConstraints.map(constraint => [constraint.name, constraint]));
  const rightMap = new Map(rightConstraints.map(constraint => [constraint.name, constraint]));
  const result: ObjectDiffItem[] = [];

  for (const [name, leftCon] of leftMap) {
    const rightCon = rightMap.get(name);
    if (!rightCon) {
      result.push({ name, status: 'removed', leftDetail: formatConstraint(leftCon) });
    } else {
      const diffs: string[] = [];
      if (leftCon.type !== rightCon.type) diffs.push(`type: ${leftCon.type} → ${rightCon.type}`);
      if (JSON.stringify(leftCon.columns) !== JSON.stringify(rightCon.columns)) {
        diffs.push(`columns: ${leftCon.columns.join(', ')} → ${rightCon.columns.join(', ')}`);
      }
      if (leftCon.referencedTable !== rightCon.referencedTable) {
        diffs.push(`references: ${leftCon.referencedTable || '—'} → ${rightCon.referencedTable || '—'}`);
      }
      if (leftCon.checkExpression !== rightCon.checkExpression) {
        diffs.push(`check: ${leftCon.checkExpression || '—'} → ${rightCon.checkExpression || '—'}`);
      }
      if ((leftCon.onDelete || '') !== (rightCon.onDelete || '')) {
        diffs.push(`onDelete: ${leftCon.onDelete || '—'} → ${rightCon.onDelete || '—'}`);
      }
      if ((leftCon.onUpdate || '') !== (rightCon.onUpdate || '')) {
        diffs.push(`onUpdate: ${leftCon.onUpdate || '—'} → ${rightCon.onUpdate || '—'}`);
      }
      result.push({
        name,
        status: diffs.length > 0 ? 'differs' : 'same',
        leftDetail: formatConstraint(leftCon),
        rightDetail: formatConstraint(rightCon),
        differences: diffs.length > 0 ? diffs : undefined,
      });
    }
  }

  for (const [name, rightCon] of rightMap) {
    if (!leftMap.has(name)) {
      result.push({ name, status: 'added', rightDetail: formatConstraint(rightCon) });
    }
  }

  return result;
}

function formatConstraint(constraint: ConstraintInfo): string {
  let detail = `${constraint.type} (${constraint.columns.join(', ')})`;
  if (constraint.referencedTable) detail += ` → ${constraint.referencedTable}`;
  if (constraint.checkExpression) detail += ` ${constraint.checkExpression}`;
  return detail;
}

function diffTriggers(leftTriggers: TriggerInfo[], rightTriggers: TriggerInfo[]): ObjectDiffItem[] {
  const leftMap = new Map(leftTriggers.map(trigger => [trigger.name, trigger]));
  const rightMap = new Map(rightTriggers.map(trigger => [trigger.name, trigger]));
  const result: ObjectDiffItem[] = [];

  for (const [name, leftTrig] of leftMap) {
    const rightTrig = rightMap.get(name);
    if (!rightTrig) {
      result.push({ name, status: 'removed', leftDetail: formatTrigger(leftTrig) });
    } else {
      const diffs: string[] = [];
      if (leftTrig.timing !== rightTrig.timing) diffs.push(`timing: ${leftTrig.timing} → ${rightTrig.timing}`);
      if (leftTrig.events !== rightTrig.events) diffs.push(`events: ${leftTrig.events} → ${rightTrig.events}`);
      if ((leftTrig.definition || '') !== (rightTrig.definition || '')) diffs.push('definition differs');
      result.push({
        name,
        status: diffs.length > 0 ? 'differs' : 'same',
        leftDetail: formatTrigger(leftTrig),
        rightDetail: formatTrigger(rightTrig),
        differences: diffs.length > 0 ? diffs : undefined,
      });
    }
  }

  for (const [name, rightTrig] of rightMap) {
    if (!leftMap.has(name)) {
      result.push({ name, status: 'added', rightDetail: formatTrigger(rightTrig) });
    }
  }

  return result;
}

function formatTrigger(trigger: TriggerInfo): string {
  return `${trigger.timing} ${trigger.events}${trigger.definition ? ` → ${trigger.definition}` : ''}`;
}

function diffSequences(leftSequences: SequenceInfo[], rightSequences: SequenceInfo[]): ObjectDiffItem[] {
  const leftMap = new Map(leftSequences.map(seq => [seq.name, seq]));
  const rightMap = new Map(rightSequences.map(seq => [seq.name, seq]));
  const result: ObjectDiffItem[] = [];

  for (const [name, leftSeq] of leftMap) {
    const rightSeq = rightMap.get(name);
    if (!rightSeq) {
      result.push({ name, status: 'removed', leftDetail: formatSequence(leftSeq) });
    } else {
      const diffs: string[] = [];
      if (leftSeq.increment !== rightSeq.increment) diffs.push(`increment: ${leftSeq.increment} → ${rightSeq.increment}`);
      if (leftSeq.startValue !== rightSeq.startValue) diffs.push(`start: ${leftSeq.startValue} → ${rightSeq.startValue}`);
      result.push({
        name,
        status: diffs.length > 0 ? 'differs' : 'same',
        leftDetail: formatSequence(leftSeq),
        rightDetail: formatSequence(rightSeq),
        differences: diffs.length > 0 ? diffs : undefined,
      });
    }
  }

  for (const [name, rightSeq] of rightMap) {
    if (!leftMap.has(name)) {
      result.push({ name, status: 'added', rightDetail: formatSequence(rightSeq) });
    }
  }

  return result;
}

function formatSequence(seq: SequenceInfo): string {
  const parts: string[] = [];
  if (seq.dataType) parts.push(seq.dataType);
  if (seq.startValue !== undefined) parts.push(`start=${seq.startValue}`);
  if (seq.increment !== undefined) parts.push(`inc=${seq.increment}`);
  return parts.join(', ') || seq.name;
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
