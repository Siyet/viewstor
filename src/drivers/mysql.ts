import { DatabaseDriver, CompletionItem } from '../types/driver';
import { ConnectionConfig } from '../types/connection';
import { QueryResult, QueryColumn, SortColumn, MAX_RESULT_ROWS } from '../types/query';
import { SchemaObject, TableInfo, ColumnInfo, TableObjects, TableStatistic, IndexInfo, ConstraintInfo, TriggerInfo, SequenceInfo } from '../types/schema';
import { createSSHTunnel, createSocks5Connection, TunnelInfo } from '../connections/tunnel';
import { wrapError } from '../utils/errors';

// eslint-disable-next-line @typescript-eslint/no-var-requires
function loadMysql(): typeof import('mysql2/promise') { return require('mysql2/promise'); }

function quoteIdentifier(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

export class MysqlDriver implements DatabaseDriver {
  private connection: import('mysql2/promise').Connection | undefined;
  private tunnel: TunnelInfo | undefined;

  async connect(config: ConnectionConfig): Promise<void> {
    const mysql = loadMysql();

    let host = config.host;
    let port = config.port;
    let stream: unknown;

    if (config.proxy?.type === 'ssh') {
      this.tunnel = await createSSHTunnel(config.proxy, config.host, config.port);
      host = this.tunnel.localHost;
      port = this.tunnel.localPort;
    } else if (config.proxy?.type === 'socks5') {
      stream = await createSocks5Connection(config.proxy, config.host, config.port);
    }

    try {
      this.connection = await mysql.createConnection({
        host,
        port,
        user: config.username,
        password: config.password,
        database: config.database,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        connectTimeout: 10000,
        ...(stream ? { stream: stream as import('net').Socket } : {}),
        // Return bigint/decimal as strings to avoid precision loss
        decimalNumbers: false,
      });
    } catch (err) {
      this.tunnel?.close();
      this.tunnel = undefined;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.connection?.end();
    this.connection = undefined;
    this.tunnel?.close();
    this.tunnel = undefined;
  }

  async ping(): Promise<boolean> {
    await this.connection!.ping();
    return true;
  }

  async cancelQuery(): Promise<void> {
    if (!this.connection) return;
    const threadId = this.connection.threadId;
    if (!threadId) return;
    const mysql = loadMysql();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connOpts = (this.connection as any).config || {};
    let cancelConn: import('mysql2/promise').Connection | undefined;
    try {
      cancelConn = await mysql.createConnection({
        host: connOpts.host,
        port: connOpts.port,
        user: connOpts.user,
        password: connOpts.password,
        ssl: connOpts.ssl,
      });
      await cancelConn.execute(`KILL QUERY ${threadId}`);
    } finally {
      await cancelConn?.end().catch(() => {});
    }
  }

  async execute(query: string): Promise<QueryResult> {
    const start = Date.now();
    try {
      const [rawRows, rawFields] = await this.connection!.query(query);
      const executionTimeMs = Date.now() - start;

      // mysql2 returns an array for SELECT, OkPacket for DML
      const isResult = Array.isArray(rawRows);
      const rows: Record<string, unknown>[] = isResult ? rawRows as Record<string, unknown>[] : [];
      const fields = (rawFields as Array<{ name: string; type: number; columnType: number }>) || [];

      const columns: QueryColumn[] = fields.map(f => ({
        name: f.name,
        dataType: mysqlFieldTypeToString(f.columnType ?? f.type),
      }));

      const truncated = rows.length > MAX_RESULT_ROWS;

      let affectedRows: number | undefined;
      if (!isResult) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        affectedRows = (rawRows as any).affectedRows ?? undefined;
      }

      return {
        columns,
        rows: truncated ? rows.slice(0, MAX_RESULT_ROWS) : rows,
        rowCount: rows.length,
        affectedRows,
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
    const db = this.getCurrentDatabase();

    // Tables with row estimates and sizes
    const [tablesRows] = await this.connection!.query(`
      SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `, [db]) as [Array<Record<string, unknown>>, unknown];

    // Columns
    const [columnsRows] = await this.connection!.query(`
      SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.COLUMN_TYPE, c.IS_NULLABLE,
             c.COLUMN_DEFAULT, c.COLUMN_KEY, c.ORDINAL_POSITION
      FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = ?
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
    `, [db]) as [Array<Record<string, unknown>>, unknown];

    // Indexes
    const [indexesRows] = await this.connection!.query(`
      SELECT TABLE_NAME, INDEX_NAME
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND INDEX_NAME != 'PRIMARY'
      GROUP BY TABLE_NAME, INDEX_NAME
      ORDER BY TABLE_NAME, INDEX_NAME
    `, [db]) as [Array<Record<string, unknown>>, unknown];

    // Column → index mapping
    const [columnIndexRows] = await this.connection!.query(`
      SELECT TABLE_NAME, COLUMN_NAME, INDEX_NAME
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
    `, [db]) as [Array<Record<string, unknown>>, unknown];

    const columnIndexesMap = new Map<string, string[]>();
    for (const row of columnIndexRows) {
      const key = `${row.TABLE_NAME}.${row.COLUMN_NAME}`;
      if (!columnIndexesMap.has(key)) columnIndexesMap.set(key, []);
      columnIndexesMap.get(key)!.push(String(row.INDEX_NAME));
    }

    // Triggers
    const [triggersRows] = await this.connection!.query(`
      SELECT EVENT_OBJECT_TABLE, TRIGGER_NAME
      FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ?
      ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME
    `, [db]) as [Array<Record<string, unknown>>, unknown];

    // Build columns map
    const columnsMap = new Map<string, SchemaObject[]>();
    for (const row of columnsRows) {
      const tableName = String(row.TABLE_NAME);
      if (!columnsMap.has(tableName)) columnsMap.set(tableName, []);
      const isPk = row.COLUMN_KEY === 'PRI';
      const badges = [];
      if (isPk) badges.push('PK');
      const detail = `${row.COLUMN_TYPE}${badges.length ? ' (' + badges.join(', ') + ')' : ''}`;
      const indexNames = columnIndexesMap.get(`${tableName}.${row.COLUMN_NAME}`);
      const notNullable = row.IS_NULLABLE === 'NO' && !isPk;
      columnsMap.get(tableName)!.push({
        name: String(row.COLUMN_NAME),
        type: 'column',
        detail,
        indexNames: indexNames && indexNames.length > 0 ? indexNames : undefined,
        notNullable: notNullable || undefined,
      });
    }

    // Build indexes map
    const indexesMap = new Map<string, SchemaObject[]>();
    for (const row of indexesRows) {
      const tableName = String(row.TABLE_NAME);
      if (!indexesMap.has(tableName)) indexesMap.set(tableName, []);
      indexesMap.get(tableName)!.push({
        name: String(row.INDEX_NAME),
        type: 'index',
      });
    }

    // Build triggers map
    const triggersMap = new Map<string, SchemaObject[]>();
    for (const row of triggersRows) {
      const tableName = String(row.EVENT_OBJECT_TABLE);
      if (!triggersMap.has(tableName)) triggersMap.set(tableName, []);
      triggersMap.get(tableName)!.push({
        name: String(row.TRIGGER_NAME),
        type: 'trigger',
      });
    }

    // MySQL has no schemas — return tables/views directly at the top level
    const result: SchemaObject[] = [];

    for (const row of tablesRows) {
      const tableName = String(row.TABLE_NAME);
      const isView = String(row.TABLE_TYPE).includes('VIEW');
      const children: SchemaObject[] = [];

      const cols = columnsMap.get(tableName);
      if (cols) children.push(...cols);

      if (!isView) {
        const idxs = indexesMap.get(tableName);
        if (idxs && idxs.length > 0) {
          children.push({ name: 'Indexes', type: 'group', children: idxs });
        }

        const trigs = triggersMap.get(tableName);
        if (trigs && trigs.length > 0) {
          children.push({ name: 'Triggers', type: 'group', children: trigs });
        }
      }

      const hasColumns = cols && cols.length > 0;
      const rowEstimate = parseInt(String(row.TABLE_ROWS ?? 0), 10) || 0;
      const dataLength = parseInt(String(row.DATA_LENGTH ?? 0), 10) || 0;
      const indexLength = parseInt(String(row.INDEX_LENGTH ?? 0), 10) || 0;
      const totalBytes = dataLength + indexLength;
      const detailStr = formatTableDetail(rowEstimate, totalBytes);

      result.push({
        name: tableName,
        type: isView ? 'view' : 'table',
        children,
        detail: detailStr,
        inaccessible: !hasColumns ? true : undefined,
      });
    }

    return result;
  }

  async getDDL(name: string, type: string): Promise<string> {
    switch (type) {
      case 'table': {
        const [rows] = await this.connection!.query(`SHOW CREATE TABLE ${quoteIdentifier(name)}`) as [Array<Record<string, unknown>>, unknown];
        return rows[0]?.['Create Table'] ? String(rows[0]['Create Table']) : `-- DDL not found for table ${name}`;
      }
      case 'view': {
        const [rows] = await this.connection!.query(`SHOW CREATE VIEW ${quoteIdentifier(name)}`) as [Array<Record<string, unknown>>, unknown];
        return rows[0]?.['Create View'] ? String(rows[0]['Create View']) : `-- DDL not found for view ${name}`;
      }
      case 'trigger': {
        const [rows] = await this.connection!.query(`SHOW CREATE TRIGGER ${quoteIdentifier(name)}`) as [Array<Record<string, unknown>>, unknown];
        return rows[0]?.['SQL Original Statement'] ? String(rows[0]['SQL Original Statement']) : `-- DDL not found for trigger ${name}`;
      }
      default:
        return `-- DDL generation not supported for ${type} "${name}"`;
    }
  }

  async getTableInfo(name: string): Promise<TableInfo> {
    const db = this.getCurrentDatabase();

    const [rows] = await this.connection!.query(`
      SELECT c.COLUMN_NAME, c.DATA_TYPE, c.COLUMN_TYPE, c.IS_NULLABLE,
             c.COLUMN_DEFAULT, c.COLUMN_KEY, c.COLUMN_COMMENT
      FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
      ORDER BY c.ORDINAL_POSITION
    `, [db, name]) as [Array<Record<string, unknown>>, unknown];

    const columns: ColumnInfo[] = rows.map(row => ({
      name: String(row.COLUMN_NAME),
      dataType: String(row.COLUMN_TYPE),
      nullable: row.IS_NULLABLE === 'YES',
      isPrimaryKey: row.COLUMN_KEY === 'PRI',
      defaultValue: row.COLUMN_DEFAULT != null ? String(row.COLUMN_DEFAULT) : undefined,
      comment: row.COLUMN_COMMENT ? String(row.COLUMN_COMMENT) : undefined,
    }));

    return { name, columns };
  }

  async getEstimatedRowCount(name: string): Promise<number> {
    const db = this.getCurrentDatabase();
    const [rows] = await this.connection!.query(
      'SELECT TABLE_ROWS AS cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [db, name],
    ) as [Array<Record<string, unknown>>, unknown];
    return Math.max(0, parseInt(String(rows[0]?.cnt ?? 0), 10) || 0);
  }

  async getTableRowCount(name: string): Promise<number> {
    const [rows] = await this.connection!.query(
      `SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(name)}`,
    ) as [Array<Record<string, unknown>>, unknown];
    return parseInt(String(rows[0]?.cnt ?? 0), 10) || 0;
  }

  async getTableData(name: string, _schema?: string, limit = MAX_RESULT_ROWS, offset = 0, orderBy?: SortColumn[]): Promise<QueryResult> {
    const quoted = quoteIdentifier(name);
    let sql = `SELECT * FROM ${quoted}`;
    if (orderBy && orderBy.length > 0) {
      const clauses = orderBy.map(s => `${quoteIdentifier(s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`);
      sql += ` ORDER BY ${clauses.join(', ')}`;
    }
    sql += ` LIMIT ${limit} OFFSET ${offset}`;
    const result = await this.execute(sql);
    result.query = sql;

    // Enrich columns with nullable info and enum values
    if (!result.error && result.columns.length > 0) {
      const db = this.getCurrentDatabase();
      const [metaRows] = await this.connection!.query(`
        SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      `, [db, name]) as [Array<Record<string, unknown>>, unknown];

      const nullableMap = new Map<string, boolean>();
      const enumMap = new Map<string, string[]>();
      for (const row of metaRows) {
        nullableMap.set(String(row.COLUMN_NAME), row.IS_NULLABLE === 'YES');
        const colType = String(row.COLUMN_TYPE);
        const enumMatch = colType.match(/^(?:enum|set)\((.+)\)$/i);
        if (enumMatch) {
          const values = enumMatch[1].split(',').map(v => v.trim().replace(/^'|'$/g, ''));
          enumMap.set(String(row.COLUMN_NAME), values);
        }
      }

      for (const col of result.columns) {
        col.nullable = nullableMap.get(col.name) ?? true;
        const vals = enumMap.get(col.name);
        if (vals) col.enumValues = vals;
      }
    }

    return result;
  }

  async getIndexedColumns(name: string): Promise<Set<string>> {
    const db = this.getCurrentDatabase();
    const [rows] = await this.connection!.query(`
      SELECT COLUMN_NAME
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `, [db, name]) as [Array<Record<string, unknown>>, unknown];
    return new Set(rows.map(r => String(r.COLUMN_NAME)));
  }

  async getTableObjects(name: string): Promise<TableObjects> {
    const db = this.getCurrentDatabase();

    // Indexes (excluding PRIMARY)
    const [indexRows] = await this.connection!.query(`
      SELECT INDEX_NAME,
             GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns,
             NON_UNIQUE, INDEX_TYPE, SUB_PART
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME != 'PRIMARY'
      GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE, SUB_PART
      ORDER BY INDEX_NAME
    `, [db, name]) as [Array<Record<string, unknown>>, unknown];

    const indexes: IndexInfo[] = indexRows.map((row: Record<string, unknown>) => ({
      name: String(row.INDEX_NAME),
      columns: String(row.columns).split(','),
      unique: row.NON_UNIQUE === 0 || row.NON_UNIQUE === '0',
      type: String(row.INDEX_TYPE).toLowerCase(),
    }));

    // Constraints
    const [constraintRows] = await this.connection!.query(`
      SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE,
             GROUP_CONCAT(DISTINCT kcu.COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION) AS columns,
             kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME,
             GROUP_CONCAT(DISTINCT kcu.REFERENCED_COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION) AS ref_columns,
             rc.DELETE_RULE, rc.UPDATE_RULE,
             cc.CHECK_CLAUSE
      FROM information_schema.TABLE_CONSTRAINTS tc
      LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA AND tc.TABLE_NAME = kcu.TABLE_NAME
      LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON tc.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
      LEFT JOIN information_schema.CHECK_CONSTRAINTS cc
        ON tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
      WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?
      GROUP BY tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, kcu.REFERENCED_TABLE_SCHEMA,
               kcu.REFERENCED_TABLE_NAME, rc.DELETE_RULE, rc.UPDATE_RULE, cc.CHECK_CLAUSE
      ORDER BY tc.CONSTRAINT_TYPE, tc.CONSTRAINT_NAME
    `, [db, name]) as [Array<Record<string, unknown>>, unknown];

    const constraints: ConstraintInfo[] = constraintRows.map((row: Record<string, unknown>) => ({
      name: String(row.CONSTRAINT_NAME),
      type: String(row.CONSTRAINT_TYPE) as ConstraintInfo['type'],
      columns: row.columns ? String(row.columns).split(',') : [],
      referencedTable: row.CONSTRAINT_TYPE === 'FOREIGN KEY' && row.REFERENCED_TABLE_NAME
        ? (row.REFERENCED_TABLE_SCHEMA ? `${row.REFERENCED_TABLE_SCHEMA}.${row.REFERENCED_TABLE_NAME}` : String(row.REFERENCED_TABLE_NAME))
        : undefined,
      referencedColumns: row.CONSTRAINT_TYPE === 'FOREIGN KEY' && row.ref_columns
        ? String(row.ref_columns).split(',') : undefined,
      onDelete: row.DELETE_RULE ? String(row.DELETE_RULE) : undefined,
      onUpdate: row.UPDATE_RULE ? String(row.UPDATE_RULE) : undefined,
      checkExpression: row.CHECK_CLAUSE ? String(row.CHECK_CLAUSE) : undefined,
    }));

    // Triggers
    const [triggerRows] = await this.connection!.query(`
      SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
      FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
      ORDER BY TRIGGER_NAME
    `, [db, name]) as [Array<Record<string, unknown>>, unknown];

    const triggers: TriggerInfo[] = triggerRows.map((row: Record<string, unknown>) => ({
      name: String(row.TRIGGER_NAME),
      timing: String(row.ACTION_TIMING),
      events: String(row.EVENT_MANIPULATION),
      definition: row.ACTION_STATEMENT ? String(row.ACTION_STATEMENT) : undefined,
    }));

    // MySQL doesn't have sequences (uses AUTO_INCREMENT)
    const sequences: SequenceInfo[] = [];

    return { indexes, constraints, triggers, sequences };
  }

  async getTableStatistics(name: string): Promise<TableStatistic[]> {
    const db = this.getCurrentDatabase();

    const [sizeRows] = await this.connection!.query(`
      SELECT TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, DATA_FREE,
             AUTO_INCREMENT, AVG_ROW_LENGTH, CREATE_TIME, UPDATE_TIME, ENGINE
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `, [db, name]) as [Array<Record<string, unknown>>, unknown];
    const info = sizeRows[0] || {};

    const toNumber = (value: unknown): number | null => {
      if (value === null || value === undefined) return null;
      const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const toDate = (value: unknown): string | null => {
      if (!value) return null;
      if (value instanceof Date) return value.toISOString();
      return String(value);
    };

    const dataLength = toNumber(info.DATA_LENGTH);
    const indexLength = toNumber(info.INDEX_LENGTH);
    const totalSize = dataLength !== null && indexLength !== null ? dataLength + indexLength : null;

    return [
      { key: 'row_count', label: 'Row count (estimated)', value: toNumber(info.TABLE_ROWS), unit: 'count' },
      { key: 'table_size', label: 'Data size', value: dataLength, unit: 'bytes' },
      { key: 'indexes_size', label: 'Index size', value: indexLength, unit: 'bytes' },
      { key: 'total_size', label: 'Total size', value: totalSize, unit: 'bytes' },
      { key: 'data_free', label: 'Free space', value: toNumber(info.DATA_FREE), unit: 'bytes', badWhen: 'higher' },
      { key: 'avg_row_length', label: 'Avg row length', value: toNumber(info.AVG_ROW_LENGTH), unit: 'bytes' },
      { key: 'auto_increment', label: 'Auto increment', value: toNumber(info.AUTO_INCREMENT), unit: 'count' },
      { key: 'engine', label: 'Engine', value: info.ENGINE ? String(info.ENGINE) : null, unit: 'text' },
      { key: 'create_time', label: 'Created', value: toDate(info.CREATE_TIME), unit: 'date' },
      { key: 'update_time', label: 'Last modified', value: toDate(info.UPDATE_TIME), unit: 'date' },
    ];
  }

  async getCompletions(): Promise<CompletionItem[]> {
    const db = this.getCurrentDatabase();
    const items: CompletionItem[] = [];

    // Tables and views
    const [tablesRows] = await this.connection!.query(
      'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [db],
    ) as [Array<Record<string, unknown>>, unknown];
    for (const r of tablesRows) {
      items.push({
        label: String(r.TABLE_NAME),
        kind: String(r.TABLE_TYPE).includes('VIEW') ? 'view' : 'table',
      });
    }

    // Columns
    const [colsRows] = await this.connection!.query(
      'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
      [db],
    ) as [Array<Record<string, unknown>>, unknown];

    for (const r of colsRows) {
      const colType = String(r.COLUMN_TYPE);
      const enumMatch = colType.match(/^(?:enum|set)\((.+)\)$/i);
      const enumValues = enumMatch
        ? enumMatch[1].split(',').map(v => v.trim().replace(/^'|'$/g, ''))
        : undefined;

      items.push({
        label: String(r.COLUMN_NAME),
        kind: 'column',
        detail: colType,
        parent: String(r.TABLE_NAME),
        enumValues,
      });
    }

    // Databases
    const [dbRows] = await this.connection!.query('SHOW DATABASES') as [Array<Record<string, unknown>>, unknown];
    for (const r of dbRows) {
      const dbName = String(Object.values(r)[0]);
      if (dbName !== 'information_schema' && dbName !== 'performance_schema' && dbName !== 'mysql' && dbName !== 'sys') {
        items.push({ label: dbName, kind: 'database' });
      }
    }

    return items;
  }

  private getCurrentDatabase(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.connection as any)?.config?.database || '';
  }
}

function formatTableDetail(rows: number, bytes: number): string | undefined {
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
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

// mysql2 field type constants (from mysql2/lib/constants/types.js)
function mysqlFieldTypeToString(type: number): string {
  const map: Record<number, string> = {
    0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int',
    4: 'float', 5: 'double', 6: 'null', 7: 'timestamp',
    8: 'bigint', 9: 'mediumint', 10: 'date', 11: 'time',
    12: 'datetime', 13: 'year', 14: 'newdate', 15: 'varchar',
    16: 'bit', 245: 'json', 246: 'newdecimal', 247: 'enum',
    248: 'set', 249: 'tinyblob', 250: 'mediumblob', 251: 'longblob',
    252: 'blob', 253: 'varchar', 254: 'char', 255: 'geometry',
  };
  return map[type] || `type:${type}`;
}
