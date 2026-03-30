export interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  totalRowCount?: number;
  affectedRows?: number;
  executionTimeMs: number;
  truncated?: boolean;
  error?: string;
}

export interface QueryColumn {
  name: string;
  dataType: string;
  enumValues?: string[];
  nullable?: boolean;
}

export interface SortColumn {
  column: string;
  direction: 'asc' | 'desc';
}

export interface QueryHistoryEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  query: string;
  executedAt: number;
  executionTimeMs: number;
  rowCount?: number;
  error?: string;
  /** Pinned entries are never auto-evicted */
  pinned?: boolean;
  /** Cached result (columns + rows) for instant replay without re-executing */
  cachedResult?: {
    columns: QueryColumn[];
    rows: Record<string, unknown>[];
  };
}

export const MAX_RESULT_ROWS = 1000;
