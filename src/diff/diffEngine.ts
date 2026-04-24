import { ColumnInfo, TableObjects, TableStatistic, IndexInfo, ConstraintInfo, TriggerInfo, SequenceInfo } from '../types/schema';
import { quoteTable } from '../utils/queryHelpers';
import { DiffOptions, DiffSource, MatchedRow, RowDiffResult, SchemaDiffResult, ColumnDiffInfo, ColumnCompare, ObjectDiffItem, ObjectsDiffResult, StatsDiffItem, StatsDiffResult, NWayDiffOptions, NWayMatchedRow, NWayRowDiffResult, NWayColumnCompare, NWaySchemaDiffResult, NWayStatsDiffItem, NWayStatsDiffResult } from './diffTypes';

/**
 * Generate the default diff query for a given table.
 * Pure function — unit-tested, no driver/vscode dependency.
 */
export function buildDefaultDiffQuery(tableName: string, schema: string | undefined, rowLimit: number): string {
  return `SELECT * FROM ${quoteTable(tableName, schema)} LIMIT ${rowLimit}`;
}

/**
 * Return true when `query` is a read-only statement (SELECT / EXPLAIN /
 * SHOW / WITH). Mirrors the whitelist in `src/mcp/server.ts`. Used by the
 * diff query editor to gate arbitrary SQL on readonly connections.
 */
export function isReadOnlyStatement(query: string): boolean {
  const trimmed = query.trim().toUpperCase();
  return (
    trimmed.startsWith('SELECT') ||
    trimmed.startsWith('EXPLAIN') ||
    trimmed.startsWith('SHOW') ||
    trimmed.startsWith('WITH')
  );
}

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
        comment: leftCol.comment,
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
        leftComment: leftCol.comment,
        rightComment: rightCol.comment,
        commentDiffers: (leftCol.comment || '') !== (rightCol.comment || ''),
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
        comment: rightCol.comment,
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

function diffIndexes(leftIndexes: IndexInfo[], rightIndexes: IndexInfo[]): ObjectDiffItem<IndexInfo>[] {
  const leftMap = new Map(leftIndexes.map(idx => [idx.name, idx]));
  const rightMap = new Map(rightIndexes.map(idx => [idx.name, idx]));
  const result: ObjectDiffItem<IndexInfo>[] = [];

  for (const [name, leftIdx] of leftMap) {
    const rightIdx = rightMap.get(name);
    if (!rightIdx) {
      result.push({
        name,
        status: 'removed',
        leftDetail: formatIndex(leftIdx),
        left: leftIdx,
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
      const leftInc = (leftIdx.included || []).join(',');
      const rightInc = (rightIdx.included || []).join(',');
      if (leftInc !== rightInc) {
        diffs.push(`included: (${leftInc || '—'}) → (${rightInc || '—'})`);
      }
      result.push({
        name,
        status: diffs.length > 0 ? 'differs' : 'same',
        leftDetail: formatIndex(leftIdx),
        rightDetail: formatIndex(rightIdx),
        left: leftIdx,
        right: rightIdx,
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
        right: rightIdx,
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

function diffConstraints(leftConstraints: ConstraintInfo[], rightConstraints: ConstraintInfo[]): ObjectDiffItem<ConstraintInfo>[] {
  const leftMap = new Map(leftConstraints.map(constraint => [constraint.name, constraint]));
  const rightMap = new Map(rightConstraints.map(constraint => [constraint.name, constraint]));
  const result: ObjectDiffItem<ConstraintInfo>[] = [];

  for (const [name, leftCon] of leftMap) {
    const rightCon = rightMap.get(name);
    if (!rightCon) {
      result.push({ name, status: 'removed', leftDetail: formatConstraint(leftCon), left: leftCon });
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
        left: leftCon,
        right: rightCon,
        differences: diffs.length > 0 ? diffs : undefined,
      });
    }
  }

  for (const [name, rightCon] of rightMap) {
    if (!leftMap.has(name)) {
      result.push({ name, status: 'added', rightDetail: formatConstraint(rightCon), right: rightCon });
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

function diffTriggers(leftTriggers: TriggerInfo[], rightTriggers: TriggerInfo[]): ObjectDiffItem<TriggerInfo>[] {
  const leftMap = new Map(leftTriggers.map(trigger => [trigger.name, trigger]));
  const rightMap = new Map(rightTriggers.map(trigger => [trigger.name, trigger]));
  const result: ObjectDiffItem<TriggerInfo>[] = [];

  for (const [name, leftTrig] of leftMap) {
    const rightTrig = rightMap.get(name);
    if (!rightTrig) {
      result.push({ name, status: 'removed', leftDetail: formatTrigger(leftTrig), left: leftTrig });
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
        left: leftTrig,
        right: rightTrig,
        differences: diffs.length > 0 ? diffs : undefined,
      });
    }
  }

  for (const [name, rightTrig] of rightMap) {
    if (!leftMap.has(name)) {
      result.push({ name, status: 'added', rightDetail: formatTrigger(rightTrig), right: rightTrig });
    }
  }

  return result;
}

function formatTrigger(trigger: TriggerInfo): string {
  return `${trigger.timing} ${trigger.events}${trigger.definition ? ` → ${trigger.definition}` : ''}`;
}

function diffSequences(leftSequences: SequenceInfo[], rightSequences: SequenceInfo[]): ObjectDiffItem<SequenceInfo>[] {
  const leftMap = new Map(leftSequences.map(seq => [seq.name, seq]));
  const rightMap = new Map(rightSequences.map(seq => [seq.name, seq]));
  const result: ObjectDiffItem<SequenceInfo>[] = [];

  for (const [name, leftSeq] of leftMap) {
    const rightSeq = rightMap.get(name);
    if (!rightSeq) {
      result.push({ name, status: 'removed', leftDetail: formatSequence(leftSeq), left: leftSeq });
    } else {
      const diffs: string[] = [];
      if (leftSeq.increment !== rightSeq.increment) diffs.push(`increment: ${leftSeq.increment} → ${rightSeq.increment}`);
      if (leftSeq.startValue !== rightSeq.startValue) diffs.push(`start: ${leftSeq.startValue} → ${rightSeq.startValue}`);
      result.push({
        name,
        status: diffs.length > 0 ? 'differs' : 'same',
        leftDetail: formatSequence(leftSeq),
        rightDetail: formatSequence(rightSeq),
        left: leftSeq,
        right: rightSeq,
        differences: diffs.length > 0 ? diffs : undefined,
      });
    }
  }

  for (const [name, rightSeq] of rightMap) {
    if (!leftMap.has(name)) {
      result.push({ name, status: 'added', rightDetail: formatSequence(rightSeq), right: rightSeq });
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
 * Apply a badge-filter click to a set of toggleable filters.
 *
 * Plain click: solo — activate only the clicked key, deactivate all others.
 * Shift+click: additive toggle — flip the clicked key, leave others as-is.
 *   Blocked from emptying the state: if the toggle would leave everything
 *   off, the previous state is returned unchanged.
 *
 * Unknown keys are ignored (state returned unchanged).
 *
 * Pure function — the same logic lives in the webview JS by necessity
 * (different bundle), so changes here must be mirrored in diff-panel.js.
 */
export function toggleFilter(
  state: Record<string, boolean>,
  key: string,
  shift: boolean,
): Record<string, boolean> {
  if (!(key in state)) return state;

  if (shift) {
    const next = { ...state, [key]: !state[key] };
    const hasAny = Object.keys(next).some(k => next[k]);
    return hasAny ? next : state;
  }

  const result: Record<string, boolean> = {};
  for (const k of Object.keys(state)) {
    result[k] = k === key;
  }
  return result;
}

/**
 * Compute diff between two lists of table statistics.
 * Matches items by key, preserves order of left (right-only items appended at the end).
 */
export function computeStatsDiff(
  leftStats: TableStatistic[] | undefined,
  rightStats: TableStatistic[] | undefined,
): StatsDiffResult {
  const left = leftStats || [];
  const right = rightStats || [];
  const rightMap = new Map(right.map(stat => [stat.key, stat]));

  const items: StatsDiffItem[] = [];
  const seen = new Set<string>();

  for (const leftStat of left) {
    seen.add(leftStat.key);
    const rightStat = rightMap.get(leftStat.key);
    items.push(buildStatsDiffItem(leftStat, rightStat));
  }

  for (const rightStat of right) {
    if (seen.has(rightStat.key)) continue;
    items.push(buildStatsDiffItem(undefined, rightStat));
  }

  return { items };
}

function buildStatsDiffItem(leftStat: TableStatistic | undefined, rightStat: TableStatistic | undefined): StatsDiffItem {
  const ref = leftStat || rightStat!;
  const leftValue = leftStat ? leftStat.value : null;
  const rightValue = rightStat ? rightStat.value : null;

  let status: StatsDiffItem['status'];
  if (!leftStat) status = 'rightOnly';
  else if (!rightStat) status = 'leftOnly';
  else if (leftValue === null && rightValue === null) status = 'missing';
  else if (String(leftValue) === String(rightValue)) status = 'same';
  else status = 'differs';

  let delta: number | undefined;
  let deltaPercent: number | undefined;
  if (typeof leftValue === 'number' && typeof rightValue === 'number') {
    delta = rightValue - leftValue;
    if (leftValue !== 0) {
      deltaPercent = (delta / Math.abs(leftValue)) * 100;
    }
  }

  return {
    key: ref.key,
    label: ref.label,
    unit: ref.unit,
    badWhen: ref.badWhen,
    leftValue,
    rightValue,
    delta,
    deltaPercent,
    status,
  };
}

/**
 * Format a statistic value for display. Pure function, used by both host and webview.
 */
export function formatStatValue(value: number | string | null, unit?: TableStatistic['unit']): string {
  if (value === null || value === undefined) return '—';
  if (unit === 'date') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  }
  if (typeof value === 'string') return value;
  if (unit === 'bytes') return formatBytes(value);
  if (unit === 'count') return formatCount(value);
  if (unit === 'percent') return `${value.toFixed(2)}%`;
  return String(value);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const abs = Math.abs(bytes);
  if (abs >= 1_099_511_627_776) return `${(bytes / 1_099_511_627_776).toFixed(2)} TB`;
  if (abs >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (abs >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function formatCount(count: number): string {
  return count.toLocaleString('en-US');
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

// ---------------------------------------------------------------------------
// N-way (multi-source) diff
// ---------------------------------------------------------------------------

/**
 * Compute row-level diff across N sources.
 * One source is the reference (default index 0). Every other source is
 * compared against it using the key columns.
 */
export function computeNWayRowDiff(sources: DiffSource[], options: NWayDiffOptions): NWayRowDiffResult {
  const n = sources.length;
  if (n < 2) throw new Error('computeNWayRowDiff requires at least 2 sources');

  const { keyColumns, rowLimit, referenceIndex = 0 } = options;
  if (referenceIndex < 0 || referenceIndex >= n) throw new Error(`referenceIndex ${referenceIndex} out of bounds`);

  const sliced = sources.map(s => s.rows.slice(0, rowLimit));
  const truncated = sources.some(s => s.rows.length > rowLimit);

  const allColumnsSet = new Set<string>();
  for (const s of sources) {
    for (const c of s.columns) allColumnsSet.add(c.name);
  }
  const allColumns = [...allColumnsSet];
  const nonKeyColumns = allColumns.filter(col => !keyColumns.includes(col));

  const indexes: Map<string, Record<string, unknown>>[] = sliced.map(rows => {
    const m = new Map<string, Record<string, unknown>>();
    for (const row of rows) m.set(buildRowKey(row, keyColumns), row);
    return m;
  });

  const allKeys = new Set<string>();
  for (const idx of indexes) {
    for (const key of idx.keys()) allKeys.add(key);
  }

  const matched: NWayMatchedRow[] = [];
  const sourceOnly: Record<string, unknown>[][] = Array.from({ length: n }, () => []);
  let unchanged = 0;
  let changed = 0;
  let added = 0;
  let removed = 0;

  for (const key of allKeys) {
    const values: (Record<string, unknown> | null)[] = indexes.map(idx => idx.get(key) ?? null);
    const refRow = values[referenceIndex];

    if (!refRow) {
      for (let i = 0; i < n; i++) {
        if (values[i]) sourceOnly[i].push(values[i]!);
      }
      added += values.filter((v, i) => v && i !== referenceIndex).length ? 1 : 0;
      continue;
    }

    const otherPresent = values.some((v, i) => i !== referenceIndex && v !== null);
    if (!otherPresent) {
      sourceOnly[referenceIndex].push(refRow);
      removed++;
      continue;
    }

    const changedCols: string[] = [];
    for (const col of nonKeyColumns) {
      const refVal = stringifyCell(refRow[col]);
      for (let i = 0; i < n; i++) {
        if (i === referenceIndex || !values[i]) continue;
        if (stringifyCell(values[i]![col]) !== refVal) {
          changedCols.push(col);
          break;
        }
      }
    }

    matched.push({ key, values, changedColumns: changedCols });
    if (changedCols.length === 0) unchanged++;
    else changed++;
  }

  const refRowCount = sliced[referenceIndex].length;
  return {
    sourceCount: n,
    allColumns,
    matched,
    sourceOnly,
    truncated,
    summary: {
      total: refRowCount + added,
      unchanged,
      changed,
      added,
      removed,
    },
  };
}

/**
 * Compute schema-level diff across N column lists.
 * Collects all column names and compares type, nullable, PK, and comment
 * across all sources.
 */
export function computeNWaySchemaDiff(columnSets: ColumnInfo[][]): NWaySchemaDiffResult {
  const n = columnSets.length;
  if (n < 2) throw new Error('computeNWaySchemaDiff requires at least 2 sources');

  const maps = columnSets.map(cols => {
    const m = new Map<string, ColumnInfo>();
    for (const c of cols) m.set(c.name, c);
    return m;
  });

  const allNames = new Set<string>();
  for (const m of maps) for (const name of m.keys()) allNames.add(name);

  const columns: NWayColumnCompare[] = [];

  for (const name of allNames) {
    const present = maps.map(m => m.has(name));
    const types = maps.map(m => m.get(name)?.dataType ?? '');
    const nullables = maps.map(m => m.get(name)?.nullable ?? false);
    const isPKs = maps.map(m => m.get(name)?.isPrimaryKey ?? false);
    const comments = maps.map(m => m.get(name)?.comment);

    const refType = types[0];
    const refNull = nullables[0];
    const refPK = isPKs[0];
    const refComment = comments[0] || '';

    let hasDifferences = !present.every(p => p === present[0]);
    if (!hasDifferences) {
      hasDifferences = types.some(t => t !== refType)
        || nullables.some(n => n !== refNull)
        || isPKs.some(pk => pk !== refPK)
        || comments.some(c => (c || '') !== refComment);
    }

    columns.push({ name, types, nullables, isPKs, comments, present, hasDifferences });
  }

  return { sourceCount: n, columns };
}

/**
 * Compute statistics diff across N stat lists.
 * Collects all keys and builds one row per unique key with values from
 * each source.
 */
export function computeNWayStatsDiff(statSets: (TableStatistic[] | undefined)[]): NWayStatsDiffResult {
  const n = statSets.length;
  if (n < 2) throw new Error('computeNWayStatsDiff requires at least 2 sources');

  const resolved = statSets.map(s => s || []);
  const maps = resolved.map(stats => {
    const m = new Map<string, TableStatistic>();
    for (const s of stats) m.set(s.key, s);
    return m;
  });

  const orderedKeys: string[] = [];
  const seen = new Set<string>();
  for (const stats of resolved) {
    for (const s of stats) {
      if (!seen.has(s.key)) {
        seen.add(s.key);
        orderedKeys.push(s.key);
      }
    }
  }

  const items: NWayStatsDiffItem[] = [];

  for (const key of orderedKeys) {
    const entries = maps.map(m => m.get(key));
    const ref = entries.find(e => e !== undefined)!;
    const present = entries.map(e => e !== undefined);
    const values = entries.map(e => e ? e.value : null);

    const firstNonNull = values.find(v => v !== null);
    let hasDifferences = !present.every(p => p === present[0]);
    if (!hasDifferences && firstNonNull !== undefined) {
      const refStr = String(values[0]);
      hasDifferences = values.some(v => String(v) !== refStr);
    }

    items.push({
      key,
      label: ref.label,
      unit: ref.unit,
      badWhen: ref.badWhen,
      values,
      present,
      hasDifferences,
    });
  }

  return { sourceCount: n, items };
}

/**
 * Adapt a 2-source computeRowDiff call to the N-way engine and convert
 * the result back to the legacy RowDiffResult shape.
 */
export function nwayToLegacyRowDiff(nway: NWayRowDiffResult): RowDiffResult {
  return {
    allColumns: nway.allColumns,
    matched: nway.matched.map(m => ({
      key: m.key,
      left: m.values[0]!,
      right: m.values[1]!,
      changedColumns: m.changedColumns,
    })),
    leftOnly: nway.sourceOnly[0],
    rightOnly: nway.sourceOnly[1],
    truncated: nway.truncated,
    summary: nway.summary,
  };
}
