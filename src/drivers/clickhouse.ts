import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { DatabaseDriver, CompletionItem } from '../types/driver';
import { ConnectionConfig } from '../types/connection';
import { QueryResult, QueryColumn, SortColumn, MAX_RESULT_ROWS } from '../types/query';
import { SchemaObject, TableInfo, ColumnInfo } from '../types/schema';
import { quoteIdentifier } from '../utils/queryHelpers';

export class ClickHouseDriver implements DatabaseDriver {
  private client: ClickHouseClient | undefined;
  private abortController: AbortController | undefined;
  private database: string | undefined;

  async connect(config: ConnectionConfig): Promise<void> {
    const protocol = config.ssl ? 'https' : 'http';
    this.database = config.database;
    this.client = createClient({
      host: `${protocol}://${config.host}:${config.port}`,
      username: config.username || 'default',
      password: config.password || '',
      database: config.database || 'default',
      request_timeout: 30000,
    });
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  async ping(): Promise<boolean> {
    const res = await this.client!.ping();
    return res.success;
  }

  async cancelQuery(): Promise<void> {
    this.abortController?.abort();
  }

  async execute(query: string): Promise<QueryResult> {
    const start = Date.now();
    const abortController = new AbortController();
    this.abortController = abortController;
    try {
      const trimmed = query.trim().toUpperCase();
      const isSelect = trimmed.startsWith('SELECT') || trimmed.startsWith('SHOW') || trimmed.startsWith('DESCRIBE') || trimmed.startsWith('EXPLAIN');

      if (!isSelect) {
        await this.client!.command({ query, abort_signal: abortController.signal });
        return {
          columns: [{ name: 'status', dataType: 'string' }],
          rows: [{ status: 'OK' }],
          rowCount: 1,
          executionTimeMs: Date.now() - start,
        };
      }

      const resultSet = await this.client!.query({ query, format: 'JSON', abort_signal: abortController.signal });
      const json = await resultSet.json<{
        meta: { name: string; type: string }[];
        data: Record<string, unknown>[];
        rows: number;
      }>();
      const executionTimeMs = Date.now() - start;

      const rows = json.data ?? [];
      const columns: QueryColumn[] = (json.meta ?? []).map(m => ({ name: m.name, dataType: m.type }));

      const truncated = rows.length > MAX_RESULT_ROWS;

      return {
        columns,
        rows: truncated ? rows.slice(0, MAX_RESULT_ROWS) : rows,
        rowCount: rows.length,
        executionTimeMs,
        truncated,
      };
    } catch (err) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getSchema(): Promise<SchemaObject[]> {
    let userDbs: { name: string }[];

    if (this.database) {
      // Single-database mode: only fetch schema for the connected database
      userDbs = [{ name: this.database }];
    } else {
      const dbResult = await this.client!.query({
        query: 'SHOW DATABASES',
        format: 'JSONEachRow',
      });
      const databases = await dbResult.json<{ name: string }[]>();

      userDbs = databases.filter(db =>
        db.name !== 'system' && db.name !== 'INFORMATION_SCHEMA' && db.name !== 'information_schema'
      );
    }

    if (userDbs.length === 0) return [];

    // Batch: fetch all tables and columns for user databases in two queries
    const dbNames = userDbs.map(db => db.name);

    const tablesResult = await this.client!.query({
      query: 'SELECT database, name, engine, total_rows, total_bytes FROM system.tables WHERE database IN ({dbs:Array(String)})',
      format: 'JSONEachRow',
      query_params: { dbs: dbNames },
    });
    const allTables = await tablesResult.json<{ database: string; name: string; engine: string; total_rows: number; total_bytes: number }[]>();

    const colsResult = await this.client!.query({
      query: 'SELECT database, table, name, type FROM system.columns WHERE database IN ({dbs:Array(String)})',
      format: 'JSONEachRow',
      query_params: { dbs: dbNames },
    });
    const allCols = await colsResult.json<{ database: string; table: string; name: string; type: string }[]>();

    // Build columns map: "db.table" -> SchemaObject[]
    const colsMap = new Map<string, SchemaObject[]>();
    for (const c of allCols) {
      const key = `${c.database}.${c.table}`;
      if (!colsMap.has(key)) colsMap.set(key, []);
      colsMap.get(key)!.push({
        name: c.name,
        type: 'column' as const,
        schema: c.database,
        detail: c.type,
      });
    }

    // Group tables by database
    const tablesByDb = new Map<string, typeof allTables>();
    for (const t of allTables) {
      if (!tablesByDb.has(t.database)) tablesByDb.set(t.database, []);
      tablesByDb.get(t.database)!.push(t);
    }

    const schema: SchemaObject[] = [];
    for (const db of userDbs) {
      const tables = tablesByDb.get(db.name) || [];
      const tableChildren: SchemaObject[] = tables.map(t => ({
        name: t.name,
        type: 'table' as const,
        schema: db.name,
        children: colsMap.get(`${db.name}.${t.name}`) || [],
        detail: formatChRowCount(t.total_rows, t.total_bytes),
      }));

      schema.push({
        name: db.name,
        type: 'database',
        children: tableChildren,
      });
    }

    return schema;
  }

  async getDDL(name: string, type: string, schema?: string): Promise<string> {
    const db = schema || 'default';
    if (type === 'table') {
      const result = await this.client!.query({
        query: `SHOW CREATE TABLE ${quoteIdentifier(db)}.${quoteIdentifier(name)}`,
        format: 'JSONEachRow',
      });
      const rows = await result.json<{ statement: string }[]>();
      return rows[0]?.statement || `-- DDL not found for table ${name}`;
    }
    return `-- DDL generation not supported for ${type} "${name}"`;
  }

  async getTableInfo(name: string, schema?: string): Promise<TableInfo> {
    const db = schema || 'default';
    const result = await this.client!.query({
      query: `DESCRIBE TABLE ${quoteIdentifier(db)}.${quoteIdentifier(name)}`,
      format: 'JSONEachRow',
    });
    const colRows = await result.json<{
      name: string;
      type: string;
      default_type: string;
      default_expression: string;
      comment: string;
    }[]>();

    const columns: ColumnInfo[] = colRows.map(row => ({
      name: row.name,
      dataType: row.type,
      nullable: row.type.startsWith('Nullable'),
      isPrimaryKey: false,
      defaultValue: row.default_expression || undefined,
      comment: row.comment || undefined,
    }));

    return { name, schema: db, columns };
  }

  async getEstimatedRowCount(name: string, schema?: string): Promise<number> {
    const db = schema || 'default';
    const result = await this.client!.query({
      query: 'SELECT total_rows AS cnt FROM system.tables WHERE database = {db:String} AND name = {name:String}',
      format: 'JSONEachRow',
      query_params: { db, name },
    });
    const rows = await result.json<{ cnt: number }[]>();
    return Math.max(0, parseInt(String(rows[0]?.cnt), 10) || 0);
  }

  async getTableRowCount(name: string, schema?: string): Promise<number> {
    const db = schema || 'default';
    const result = await this.execute(`SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(db)}.${quoteIdentifier(name)}`);
    return parseInt(String(result.rows[0]?.cnt), 10) || 0;
  }

  async getTableData(name: string, schema?: string, limit = MAX_RESULT_ROWS, offset = 0, orderBy?: SortColumn[]): Promise<QueryResult> {
    const db = schema || 'default';
    let sql = `SELECT * FROM ${quoteIdentifier(db)}.${quoteIdentifier(name)}`;
    if (orderBy && orderBy.length > 0) {
      const clauses = orderBy.map(s => `${quoteIdentifier(s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`);
      sql += ` ORDER BY ${clauses.join(', ')}`;
    }
    sql += ` LIMIT ${limit} OFFSET ${offset}`;
    const result = await this.execute(sql);
    result.query = sql;
    return result;
  }

  async getCompletions(): Promise<CompletionItem[]> {
    const items: CompletionItem[] = [];

    const tablesRes = await this.client!.query({
      query: 'SELECT database, name, engine FROM system.tables WHERE database NOT IN (\'system\',\'INFORMATION_SCHEMA\',\'information_schema\')',
      format: 'JSONEachRow',
    });
    const tables = await tablesRes.json<{ database: string; name: string; engine: string }[]>();
    for (const t of tables) {
      items.push({ label: t.name, kind: t.engine.includes('View') ? 'view' : 'table', detail: t.database });
    }

    const colsRes = await this.client!.query({
      query: 'SELECT table, name, type FROM system.columns WHERE database NOT IN (\'system\',\'INFORMATION_SCHEMA\',\'information_schema\')',
      format: 'JSONEachRow',
    });
    const cols = await colsRes.json<{ table: string; name: string; type: string }[]>();
    for (const c of cols) {
      items.push({ label: c.name, kind: 'column', detail: c.type, parent: c.table });
    }

    return items;
  }
}

function formatChRowCount(rows: number, bytes: number): string | undefined {
  if (!rows && !bytes) return undefined;
  const parts: string[] = [];
  if (rows > 0) {
    if (rows >= 1_000_000_000) parts.push(`~${(rows / 1_000_000_000).toFixed(1)}b rows`);
    else if (rows >= 1_000_000) parts.push(`~${(rows / 1_000_000).toFixed(1)}m rows`);
    else if (rows >= 1_000) parts.push(`~${(rows / 1_000).toFixed(0)}k rows`);
    else parts.push(`${rows} rows`);
  }
  if (bytes > 0) {
    if (bytes >= 1_073_741_824) parts.push(`${(bytes / 1_073_741_824).toFixed(1)} GB`);
    else if (bytes >= 1_048_576) parts.push(`${(bytes / 1_048_576).toFixed(1)} MB`);
    else if (bytes >= 1024) parts.push(`${(bytes / 1024).toFixed(0)} KB`);
    else parts.push(`${bytes} B`);
  }
  return parts.join(' · ') || undefined;
}
