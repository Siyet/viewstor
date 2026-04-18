/**
 * Shared, vscode-free formatters for MCP tool responses.
 * Used by both the in-process MCP commands (src/mcp/server.ts) and the
 * standalone stdio MCP server (src/mcp-server/index.ts) so the JSON shape
 * an AI agent sees is identical regardless of transport.
 */
import { QueryResult } from '../types/query';
import { TableInfo, SchemaObject } from '../types/schema';

export interface ExecuteQueryPayload {
  columns: string[];
  columnTypes: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTimeMs: number;
  error?: string;
}

export function formatExecuteQuery(result: QueryResult): ExecuteQueryPayload {
  return {
    columns: result.columns.map(c => c.name),
    columnTypes: result.columns.map(c => c.dataType),
    rows: result.rows,
    rowCount: result.rowCount,
    executionTimeMs: result.executionTimeMs,
    error: result.error,
  };
}

export interface TableDataPayload {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export function formatTableData(result: QueryResult): TableDataPayload {
  return {
    columns: result.columns.map(c => ({ name: c.name, type: c.dataType })),
    rows: result.rows,
    rowCount: result.rowCount,
  };
}

export interface TableInfoPayload {
  name: string;
  schema?: string;
  columns: {
    name: string;
    type: string;
    nullable: boolean;
    isPrimaryKey: boolean;
    defaultValue?: string;
  }[];
}

export function formatTableInfo(info: TableInfo): TableInfoPayload {
  return {
    name: info.name,
    schema: info.schema,
    columns: info.columns.map(c => ({
      name: c.name,
      type: c.dataType,
      nullable: c.nullable,
      isPrimaryKey: c.isPrimaryKey,
      defaultValue: c.defaultValue,
    })),
  };
}

export interface FlatSchemaEntry {
  name: string;
  type: string;
  path: string;
  detail?: string;
  schema?: string;
}

/** Flatten a nested SchemaObject tree into a single list of dot-paths. */
export function flattenSchema(objects: SchemaObject[], parentPath = ''): FlatSchemaEntry[] {
  const result: FlatSchemaEntry[] = [];
  for (const obj of objects) {
    const objPath = parentPath ? `${parentPath}.${obj.name}` : obj.name;
    result.push({ name: obj.name, type: obj.type, path: objPath, detail: obj.detail, schema: obj.schema });
    if (obj.children) {
      result.push(...flattenSchema(obj.children, objPath));
    }
  }
  return result;
}
