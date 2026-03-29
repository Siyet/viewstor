import { ConnectionConfig } from './connection';
import { QueryResult, SortColumn } from './query';
import { SchemaObject, TableInfo } from './schema';

/**
 * Unified interface that all database drivers must implement.
 */
export interface DatabaseDriver {
  connect(config: ConnectionConfig): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
  execute(query: string): Promise<QueryResult>;
  getSchema(): Promise<SchemaObject[]>;
  getTableInfo(name: string, schema?: string): Promise<TableInfo>;
  getTableData(name: string, schema?: string, limit?: number, offset?: number, orderBy?: SortColumn[]): Promise<QueryResult>;
  getTableRowCount?(name: string, schema?: string): Promise<number>;
  /** Fast approximate count from statistics (pg_class.reltuples, etc.) */
  getEstimatedRowCount?(name: string, schema?: string): Promise<number>;
  getDDL?(name: string, type: string, schema?: string): Promise<string>;
  cancelQuery?(): Promise<void>;
  getCompletions?(): Promise<CompletionItem[]>;
  /** Returns column names that have indexes for a given table */
  getIndexedColumns?(name: string, schema?: string): Promise<Set<string>>;
}

export interface CompletionItem {
  label: string;
  kind: 'table' | 'view' | 'column' | 'schema' | 'database' | 'function' | 'keyword';
  detail?: string;
  /** Parent table/view name for columns */
  parent?: string;
}
