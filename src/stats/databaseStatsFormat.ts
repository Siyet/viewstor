import { DatabaseStatistics, TopTableEntry } from '../types/schema';

/**
 * Pure helpers for the database-statistics view. No vscode / driver deps —
 * safe to unit-test and reuse in the webview bundle.
 */

export type TopTableSortKey = 'size' | 'rows' | 'indexes' | 'dead' | 'name';

export function sortTopTables(
  rows: TopTableEntry[],
  key: TopTableSortKey,
  direction: 'asc' | 'desc' = 'desc',
): TopTableEntry[] {
  const selector = (row: TopTableEntry): number | string | null => {
    switch (key) {
      case 'size': return row.sizeBytes;
      case 'rows': return row.rowCount;
      case 'indexes': return row.indexesSizeBytes;
      case 'dead': return row.deadTuplesPct;
      case 'name': return row.name;
    }
  };

  const cmp = (leftRow: TopTableEntry, rightRow: TopTableEntry): number => {
    const leftVal = selector(leftRow);
    const rightVal = selector(rightRow);
    // null/undefined always sorted last regardless of direction
    if (leftVal === null || leftVal === undefined) {
      return rightVal === null || rightVal === undefined ? 0 : 1;
    }
    if (rightVal === null || rightVal === undefined) return -1;
    if (typeof leftVal === 'number' && typeof rightVal === 'number') {
      return direction === 'asc' ? leftVal - rightVal : rightVal - leftVal;
    }
    const leftStr = String(leftVal);
    const rightStr = String(rightVal);
    return direction === 'asc' ? leftStr.localeCompare(rightStr) : rightStr.localeCompare(leftStr);
  };

  return [...rows].sort(cmp);
}

/**
 * Given a set of numeric values, return the max (for inline-bar normalization).
 * Missing values contribute 0; all-null → 0.
 */
export function maxNumericValue(values: (number | null | undefined)[]): number {
  let max = 0;
  for (const value of values) {
    if (typeof value === 'number' && value > max) max = value;
  }
  return max;
}

/**
 * Validate+clamp topTablesLimit coming from user settings. Never returns
 * less than 1 (the UI can't render zero rows meaningfully) or more than 500
 * (upper guardrail that matches the driver clamp).
 */
export function clampTopTablesLimit(raw: unknown, fallback = 50): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return Math.max(1, Math.min(value, 500));
}

/**
 * Validate+clamp autoRefreshSeconds. `0` means disabled. Any negative / non-finite
 * value is treated as disabled. Cap at 3600 (one hour) to avoid absurd schedules.
 */
export function clampAutoRefreshSeconds(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), 3600);
}

/**
 * Shape check + guard for a DatabaseStatistics payload. Returns true iff the
 * object has the three expected buckets as arrays. Used by the webview to
 * fall back to an error state when a driver returns an incomplete result.
 */
export function isValidDatabaseStatistics(value: unknown): value is DatabaseStatistics {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DatabaseStatistics>;
  return Array.isArray(candidate.overview)
    && Array.isArray(candidate.topTables)
    && Array.isArray(candidate.connectionLevel);
}
