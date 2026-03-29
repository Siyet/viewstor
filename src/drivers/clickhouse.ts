import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { DatabaseDriver, CompletionItem } from '../types/driver';
import { ConnectionConfig } from '../types/connection';
import { QueryResult, QueryColumn, SortColumn, MAX_RESULT_ROWS } from '../types/query';
import { SchemaObject, TableInfo, ColumnInfo } from '../types/schema';

export class ClickHouseDriver implements DatabaseDriver {
  private client: ClickHouseClient | undefined;
  private abortController: AbortController | undefined;

  async connect(config: ConnectionConfig): Promise<void> {
    const protocol = config.ssl ? 'https' : 'http';
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
    this.abortController = new AbortController();
    try {
      const trimmed = query.trim().toUpperCase();
      const isSelect = trimmed.startsWith('SELECT') || trimmed.startsWith('SHOW') || trimmed.startsWith('DESCRIBE') || trimmed.startsWith('EXPLAIN');

      if (!isSelect) {
        await this.client!.command({ query, abort_signal: this.abortController.signal });
        return {
          columns: [{ name: 'status', dataType: 'string' }],
          rows: [{ status: 'OK' }],
          rowCount: 1,
          executionTimeMs: Date.now() - start,
        };
      }

      const resultSet = await this.client!.query({ query, format: 'JSONEachRow', abort_signal: this.abortController.signal });
      const rows = await resultSet.json<Record<string, unknown>[]>();
      const executionTimeMs = Date.now() - start;

      const columns: QueryColumn[] = rows.length > 0
        ? Object.keys(rows[0]).map(name => ({ name, dataType: typeof rows[0][name] }))
        : [];

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
    const dbResult = await this.client!.query({
      query: 'SHOW DATABASES',
      format: 'JSONEachRow',
    });
    const databases = await dbResult.json<{ name: string }[]>();

    const schema: SchemaObject[] = [];

    for (const db of databases) {
      if (db.name === 'system' || db.name === 'INFORMATION_SCHEMA' || db.name === 'information_schema') {
        continue;
      }

      const tablesResult = await this.client!.query({
        query: `SHOW TABLES FROM "${db.name}"`,
        format: 'JSONEachRow',
      });
      const tables = await tablesResult.json<{ name: string }[]>();

      const tableChildren: SchemaObject[] = [];
      for (const t of tables) {
        // Get columns for each table
        const colResult = await this.client!.query({
          query: `DESCRIBE TABLE "${db.name}"."${t.name}"`,
          format: 'JSONEachRow',
        });
        const cols = await colResult.json<{ name: string; type: string }[]>();
        const colObjects: SchemaObject[] = cols.map(c => ({
          name: c.name,
          type: 'column' as const,
          schema: db.name,
          detail: c.type,
        }));

        tableChildren.push({
          name: t.name,
          type: 'table' as const,
          schema: db.name,
          children: colObjects,
        });
      }

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
        query: `SHOW CREATE TABLE "${db}"."${name}"`,
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
      query: `DESCRIBE TABLE "${db}"."${name}"`,
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
    const result = await this.execute(
      `SELECT total_rows AS cnt FROM system.tables WHERE database = '${db}' AND name = '${name}'`
    );
    return Math.max(0, parseInt(String(result.rows[0]?.cnt), 10) || 0);
  }

  async getTableRowCount(name: string, schema?: string): Promise<number> {
    const db = schema || 'default';
    const result = await this.execute(`SELECT COUNT(*) AS cnt FROM "${db}"."${name}"`);
    return parseInt(String(result.rows[0]?.cnt), 10) || 0;
  }

  async getTableData(name: string, schema?: string, limit = MAX_RESULT_ROWS, offset = 0, orderBy?: SortColumn[]): Promise<QueryResult> {
    const db = schema || 'default';
    let sql = `SELECT * FROM "${db}"."${name}"`;
    if (orderBy && orderBy.length > 0) {
      const clauses = orderBy.map(s => `"${s.column}" ${s.direction === 'desc' ? 'DESC' : 'ASC'}`);
      sql += ` ORDER BY ${clauses.join(', ')}`;
    }
    sql += ` LIMIT ${limit} OFFSET ${offset}`;
    return this.execute(sql);
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
