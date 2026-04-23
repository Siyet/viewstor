import * as sql from 'mssql';
import { DatabaseDriver, CompletionItem } from '../types/driver';
import { ConnectionConfig } from '../types/connection';
import { QueryResult, QueryColumn, SortColumn, MAX_RESULT_ROWS } from '../types/query';
import {
  SchemaObject, TableInfo, ColumnInfo, TableObjects, TableStatistic,
  IndexInfo, ConstraintInfo, TriggerInfo,
} from '../types/schema';
import { quoteIdentifier } from '../utils/queryHelpers';
import { wrapError } from '../utils/errors';

function mssqlQuote(name: string): string {
  return `[${name.replace(/]/g, ']]')}]`;
}

export class MssqlDriver implements DatabaseDriver {
  private pool: sql.ConnectionPool | undefined;
  private currentRequest: sql.Request | undefined;

  async connect(config: ConnectionConfig): Promise<void> {
    const mssqlConfig: sql.config = {
      server: config.host || 'localhost',
      port: config.port || 1433,
      user: config.username,
      password: config.password,
      database: config.database || 'master',
      options: {
        encrypt: config.ssl !== false,
        trustServerCertificate: !config.ssl,
      },
      requestTimeout: 30000,
      connectionTimeout: 15000,
    };

    this.pool = new sql.ConnectionPool(mssqlConfig);
    await this.pool.connect();
  }

  async disconnect(): Promise<void> {
    await this.pool?.close();
    this.pool = undefined;
  }

  async ping(): Promise<boolean> {
    const result = await this.pool!.request().query('SELECT 1 AS ok');
    return result.recordset[0]?.ok === 1;
  }

  async cancelQuery(): Promise<void> {
    this.currentRequest?.cancel();
  }

  async execute(query: string): Promise<QueryResult> {
    const start = Date.now();
    const request = this.pool!.request();
    this.currentRequest = request;
    try {
      const trimmed = query.trim().toUpperCase();
      const isSelect = trimmed.startsWith('SELECT') || trimmed.startsWith('EXEC') ||
        trimmed.startsWith('EXECUTE') || trimmed.startsWith('SP_') ||
        trimmed.startsWith('WITH');

      const result = await request.query(query);
      const executionTimeMs = Date.now() - start;

      if (!result.recordset || result.recordset.length === 0) {
        const affected = result.rowsAffected.reduce((a: number, b: number) => a + b, 0);
        return {
          columns: [{ name: 'status', dataType: 'nvarchar' }],
          rows: [{ status: `OK — ${affected} row(s) affected` }],
          rowCount: 1,
          affectedRows: affected,
          executionTimeMs,
        };
      }

      const columns: QueryColumn[] = Object.entries(result.recordset.columns).map(
        ([name, col]: [string, any]) => ({
          name,
          dataType: mapMssqlType(col.type),
          nullable: col.nullable,
        })
      );

      const rows = result.recordset as Record<string, unknown>[];
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
        error: wrapError(err),
      };
    }
  }

  async getSchema(): Promise<SchemaObject[]> {
    const tablesResult = await this.pool!.request().query(`
      SELECT s.name AS schema_name, t.name AS table_name, t.type AS obj_type
      FROM sys.tables t
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      UNION ALL
      SELECT s.name, v.name, 'V'
      FROM sys.views v
      JOIN sys.schemas s ON v.schema_id = s.schema_id
      ORDER BY schema_name, table_name
    `);

    const colsResult = await this.pool!.request().query(`
      SELECT s.name AS schema_name, t.name AS table_name,
             c.name AS column_name, ty.name AS data_type,
             c.max_length, c.precision, c.scale, c.is_nullable
      FROM sys.columns c
      JOIN sys.tables t ON c.object_id = t.object_id
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      JOIN sys.types ty ON c.user_type_id = ty.user_type_id
      UNION ALL
      SELECT s.name, v.name, c.name, ty.name,
             c.max_length, c.precision, c.scale, c.is_nullable
      FROM sys.columns c
      JOIN sys.views v ON c.object_id = v.object_id
      JOIN sys.schemas s ON v.schema_id = s.schema_id
      JOIN sys.types ty ON c.user_type_id = ty.user_type_id
      ORDER BY schema_name, table_name
    `);

    const colsMap = new Map<string, SchemaObject[]>();
    for (const c of colsResult.recordset) {
      const key = `${c.schema_name}.${c.table_name}`;
      if (!colsMap.has(key)) colsMap.set(key, []);
      colsMap.get(key)!.push({
        name: c.column_name,
        type: 'column' as const,
        schema: c.schema_name,
        detail: formatMssqlColumnType(c.data_type, c.max_length, c.precision, c.scale),
      });
    }

    const schemaMap = new Map<string, SchemaObject[]>();
    for (const t of tablesResult.recordset) {
      if (!schemaMap.has(t.schema_name)) schemaMap.set(t.schema_name, []);
      const key = `${t.schema_name}.${t.table_name}`;
      schemaMap.get(t.schema_name)!.push({
        name: t.table_name,
        type: t.obj_type.trim() === 'V' ? 'view' : 'table',
        schema: t.schema_name,
        children: colsMap.get(key) || [],
      });
    }

    const schemas: SchemaObject[] = [];
    for (const [name, children] of schemaMap) {
      schemas.push({ name, type: 'schema', children });
    }
    return schemas;
  }

  async getTableInfo(name: string, schema?: string): Promise<TableInfo> {
    const schemaName = schema || 'dbo';
    const result = await this.pool!.request()
      .input('schema', sql.NVarChar, schemaName)
      .input('table', sql.NVarChar, name)
      .query(`
        SELECT c.name, ty.name AS data_type, c.max_length, c.precision, c.scale,
               c.is_nullable, c.is_identity,
               CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_pk,
               dc.definition AS default_value
        FROM sys.columns c
        JOIN sys.objects o ON c.object_id = o.object_id
        JOIN sys.schemas s ON o.schema_id = s.schema_id
        JOIN sys.types ty ON c.user_type_id = ty.user_type_id
        LEFT JOIN (
          SELECT ic.object_id, ic.column_id
          FROM sys.index_columns ic
          JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
          WHERE i.is_primary_key = 1
        ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
        LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
        WHERE s.name = @schema AND o.name = @table
        ORDER BY c.column_id
      `);

    const columns: ColumnInfo[] = result.recordset.map((row: any) => ({
      name: row.name,
      dataType: formatMssqlColumnType(row.data_type, row.max_length, row.precision, row.scale),
      nullable: row.is_nullable,
      isPrimaryKey: row.is_pk === 1,
      defaultValue: row.default_value?.replace(/^\(+/, '').replace(/\)+$/, '') || undefined,
    }));

    return { name, schema: schemaName, columns };
  }

  async getTableData(name: string, schema?: string, limit = MAX_RESULT_ROWS, offset = 0, orderBy?: SortColumn[]): Promise<QueryResult> {
    const schemaName = schema || 'dbo';
    const table = `${mssqlQuote(schemaName)}.${mssqlQuote(name)}`;

    let orderClause: string;
    if (orderBy && orderBy.length > 0) {
      orderClause = orderBy.map(s =>
        `${mssqlQuote(s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`
      ).join(', ');
    } else {
      orderClause = '(SELECT NULL)';
    }

    const sql_query = `SELECT * FROM ${table} ORDER BY ${orderClause} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
    const result = await this.execute(sql_query);
    result.query = sql_query;
    return result;
  }

  async getTableRowCount(name: string, schema?: string): Promise<number> {
    const schemaName = schema || 'dbo';
    const result = await this.execute(
      `SELECT COUNT(*) AS cnt FROM ${mssqlQuote(schemaName)}.${mssqlQuote(name)}`
    );
    return parseInt(String(result.rows[0]?.cnt), 10) || 0;
  }

  async getEstimatedRowCount(name: string, schema?: string): Promise<number> {
    const schemaName = schema || 'dbo';
    const result = await this.pool!.request()
      .input('schema', sql.NVarChar, schemaName)
      .input('table', sql.NVarChar, name)
      .query(`
        SELECT SUM(p.rows) AS cnt
        FROM sys.partitions p
        JOIN sys.tables t ON p.object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE s.name = @schema AND t.name = @table AND p.index_id IN (0, 1)
      `);
    return Math.max(0, parseInt(String(result.recordset[0]?.cnt), 10) || 0);
  }

  async getDDL(name: string, type: string, schema?: string): Promise<string> {
    const schemaName = schema || 'dbo';
    if (type === 'view') {
      const result = await this.pool!.request()
        .input('schema', sql.NVarChar, schemaName)
        .input('name', sql.NVarChar, name)
        .query(`
          SELECT m.definition
          FROM sys.sql_modules m
          JOIN sys.views v ON m.object_id = v.object_id
          JOIN sys.schemas s ON v.schema_id = s.schema_id
          WHERE s.name = @schema AND v.name = @name
        `);
      return result.recordset[0]?.definition || `-- DDL not found for view ${name}`;
    }

    if (type === 'table') {
      const info = await this.getTableInfo(name, schemaName);
      const cols = info.columns.map(c => {
        let def = `  ${mssqlQuote(c.name)} ${c.dataType}`;
        if (!c.nullable) def += ' NOT NULL';
        if (c.defaultValue) def += ` DEFAULT ${c.defaultValue}`;
        return def;
      });
      const pkCols = info.columns.filter(c => c.isPrimaryKey).map(c => mssqlQuote(c.name));
      if (pkCols.length > 0) {
        cols.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
      }
      return `CREATE TABLE ${mssqlQuote(schemaName)}.${mssqlQuote(name)} (\n${cols.join(',\n')}\n);`;
    }

    return `-- DDL generation not supported for ${type} "${name}"`;
  }

  async getCompletions(): Promise<CompletionItem[]> {
    const items: CompletionItem[] = [];

    const tablesRes = await this.pool!.request().query(`
      SELECT s.name AS schema_name, t.name AS table_name, t.type AS obj_type
      FROM sys.objects t
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE t.type IN ('U', 'V')
    `);
    for (const t of tablesRes.recordset) {
      items.push({
        label: t.table_name,
        kind: t.obj_type.trim() === 'V' ? 'view' : 'table',
        detail: t.schema_name,
      });
    }

    const colsRes = await this.pool!.request().query(`
      SELECT o.name AS table_name, c.name AS column_name, ty.name AS data_type
      FROM sys.columns c
      JOIN sys.objects o ON c.object_id = o.object_id
      JOIN sys.types ty ON c.user_type_id = ty.user_type_id
      WHERE o.type IN ('U', 'V')
    `);
    for (const c of colsRes.recordset) {
      items.push({
        label: c.column_name,
        kind: 'column',
        detail: c.data_type,
        parent: c.table_name,
      });
    }

    return items;
  }

  async getIndexedColumns(name: string, schema?: string): Promise<Set<string>> {
    const schemaName = schema || 'dbo';
    const result = await this.pool!.request()
      .input('schema', sql.NVarChar, schemaName)
      .input('table', sql.NVarChar, name)
      .query(`
        SELECT DISTINCT c.name
        FROM sys.index_columns ic
        JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.tables t ON i.object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE s.name = @schema AND t.name = @table AND i.is_primary_key = 0
      `);
    return new Set(result.recordset.map((r: any) => r.name));
  }

  async getTableObjects(name: string, schema?: string): Promise<TableObjects> {
    const schemaName = schema || 'dbo';

    const indexResult = await this.pool!.request()
      .input('schema', sql.NVarChar, schemaName)
      .input('table', sql.NVarChar, name)
      .query(`
        SELECT i.name, i.is_unique, i.type_desc,
               STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns
        FROM sys.indexes i
        JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        JOIN sys.tables t ON i.object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE s.name = @schema AND t.name = @table AND i.is_primary_key = 0 AND i.name IS NOT NULL
        GROUP BY i.name, i.is_unique, i.type_desc
      `);
    const indexes: IndexInfo[] = indexResult.recordset.map((r: any) => ({
      name: r.name,
      columns: r.columns.split(','),
      unique: r.is_unique,
      type: r.type_desc,
    }));

    const constraintResult = await this.pool!.request()
      .input('schema', sql.NVarChar, schemaName)
      .input('table', sql.NVarChar, name)
      .query(`
        SELECT
          kc.name AS constraint_name,
          kc.type_desc,
          STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns,
          rs.name AS ref_schema,
          rt.name AS ref_table,
          fkc_ref.ref_columns,
          fk.delete_referential_action_desc AS on_delete,
          fk.update_referential_action_desc AS on_update,
          cc.definition AS check_expr
        FROM sys.key_constraints kc
        JOIN sys.tables t ON kc.parent_object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        LEFT JOIN sys.index_columns ic ON kc.unique_index_id = ic.index_id AND kc.parent_object_id = ic.object_id
        LEFT JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        LEFT JOIN sys.foreign_keys fk ON 1=0
        LEFT JOIN sys.schemas rs ON 1=0
        LEFT JOIN sys.tables rt ON 1=0
        LEFT JOIN (SELECT NULL AS ref_columns WHERE 1=0) fkc_ref ON 1=0
        LEFT JOIN sys.check_constraints cc ON 1=0
        WHERE s.name = @schema AND t.name = @table
        GROUP BY kc.name, kc.type_desc, rs.name, rt.name, fkc_ref.ref_columns,
                 fk.delete_referential_action_desc, fk.update_referential_action_desc, cc.definition

        UNION ALL

        SELECT
          fk.name, 'FOREIGN_KEY_CONSTRAINT',
          STRING_AGG(pc.name, ',') WITHIN GROUP (ORDER BY fkc.constraint_column_id),
          rs.name, rt.name,
          STRING_AGG(rc.name, ',') WITHIN GROUP (ORDER BY fkc.constraint_column_id),
          fk.delete_referential_action_desc,
          fk.update_referential_action_desc,
          NULL
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
        JOIN sys.columns pc ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id
        JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
        JOIN sys.tables t ON fk.parent_object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        JOIN sys.tables rt ON fk.referenced_object_id = rt.object_id
        JOIN sys.schemas rs ON rt.schema_id = rs.schema_id
        WHERE s.name = @schema AND t.name = @table
        GROUP BY fk.name, rs.name, rt.name,
                 fk.delete_referential_action_desc, fk.update_referential_action_desc

        UNION ALL

        SELECT cc.name, 'CHECK_CONSTRAINT', NULL, NULL, NULL, NULL, NULL, NULL, cc.definition
        FROM sys.check_constraints cc
        JOIN sys.tables t ON cc.parent_object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE s.name = @schema AND t.name = @table
      `);

    const constraints: ConstraintInfo[] = constraintResult.recordset.map((r: any) => {
      const typeDesc = r.type_desc as string;
      let type: ConstraintInfo['type'];
      if (typeDesc.includes('PRIMARY')) type = 'PRIMARY KEY';
      else if (typeDesc.includes('UNIQUE')) type = 'UNIQUE';
      else if (typeDesc.includes('FOREIGN')) type = 'FOREIGN KEY';
      else type = 'CHECK';

      return {
        name: r.constraint_name,
        type,
        columns: r.columns ? r.columns.split(',') : [],
        referencedTable: r.ref_table ? `${r.ref_schema}.${r.ref_table}` : undefined,
        referencedColumns: r.ref_columns ? r.ref_columns.split(',') : undefined,
        onDelete: r.on_delete?.replace(/_/g, ' ') || undefined,
        onUpdate: r.on_update?.replace(/_/g, ' ') || undefined,
        checkExpression: r.check_expr || undefined,
      };
    });

    const triggerResult = await this.pool!.request()
      .input('schema', sql.NVarChar, schemaName)
      .input('table', sql.NVarChar, name)
      .query(`
        SELECT tr.name,
               CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing,
               STUFF((
                 SELECT ',' + te.type_desc
                 FROM sys.trigger_events te
                 WHERE te.object_id = tr.object_id
                 FOR XML PATH('')
               ), 1, 1, '') AS events,
               m.definition
        FROM sys.triggers tr
        JOIN sys.sql_modules m ON tr.object_id = m.object_id
        JOIN sys.tables t ON tr.parent_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE s.name = @schema AND t.name = @table
      `);
    const triggers: TriggerInfo[] = triggerResult.recordset.map((r: any) => ({
      name: r.name,
      timing: r.timing,
      events: r.events,
      definition: r.definition,
    }));

    return { indexes, constraints, triggers, sequences: [] };
  }

  async getTableStatistics(name: string, schema?: string): Promise<TableStatistic[]> {
    const schemaName = schema || 'dbo';

    const result = await this.pool!.request()
      .input('schema', sql.NVarChar, schemaName)
      .input('table', sql.NVarChar, name)
      .query(`
        SELECT
          SUM(p.rows) AS row_count,
          SUM(a.total_pages) * 8 * 1024 AS total_size,
          SUM(a.data_pages) * 8 * 1024 AS data_size,
          SUM(CASE WHEN i.type > 0 THEN a.used_pages ELSE 0 END) * 8 * 1024 AS index_size
        FROM sys.partitions p
        JOIN sys.allocation_units a ON p.partition_id = a.container_id
        JOIN sys.tables t ON p.object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        LEFT JOIN sys.indexes i ON p.object_id = i.object_id AND p.index_id = i.index_id
        WHERE s.name = @schema AND t.name = @table AND p.index_id IN (0, 1)
      `);
    const row = result.recordset[0];

    const statsResult = await this.pool!.request()
      .input('schema', sql.NVarChar, schemaName)
      .input('table', sql.NVarChar, name)
      .query(`
        SELECT
          t.create_date,
          t.modify_date,
          (SELECT COUNT(*) FROM sys.indexes i2
           WHERE i2.object_id = t.object_id AND i2.type > 0) AS index_count
        FROM sys.tables t
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE s.name = @schema AND t.name = @table
      `);
    const meta = statsResult.recordset[0];

    const toNumber = (value: unknown): number | null => {
      if (value === null || value === undefined) return null;
      const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
      return Number.isFinite(parsed) ? parsed : null;
    };

    return [
      { key: 'row_count', label: 'Row count', value: toNumber(row?.row_count), unit: 'count' },
      { key: 'total_size', label: 'Total size', value: toNumber(row?.total_size), unit: 'bytes' },
      { key: 'data_size', label: 'Data size', value: toNumber(row?.data_size), unit: 'bytes' },
      { key: 'index_size', label: 'Index size', value: toNumber(row?.index_size), unit: 'bytes' },
      { key: 'index_count', label: 'Index count', value: toNumber(meta?.index_count), unit: 'count' },
      { key: 'created', label: 'Created', value: meta?.create_date?.toISOString?.() ?? null, unit: 'date' },
      { key: 'last_modified', label: 'Last modified', value: meta?.modify_date?.toISOString?.() ?? null, unit: 'date' },
    ];
  }
}

function mapMssqlType(type: any): string {
  if (!type) return 'unknown';
  const name = type?.declaration?.replace(/\(.*\)/, '') || type?.name || '';
  return name.toLowerCase() || 'unknown';
}

function formatMssqlColumnType(
  typeName: string, maxLength: number, precision: number, scale: number
): string {
  switch (typeName) {
    case 'nvarchar':
    case 'nchar':
      return maxLength === -1 ? `${typeName}(max)` : `${typeName}(${maxLength / 2})`;
    case 'varchar':
    case 'char':
    case 'varbinary':
    case 'binary':
      return maxLength === -1 ? `${typeName}(max)` : `${typeName}(${maxLength})`;
    case 'decimal':
    case 'numeric':
      return `${typeName}(${precision},${scale})`;
    case 'float':
      return precision === 53 ? 'float' : `float(${precision})`;
    case 'datetime2':
    case 'datetimeoffset':
    case 'time':
      return scale === 7 ? typeName : `${typeName}(${scale})`;
    default:
      return typeName;
  }
}
