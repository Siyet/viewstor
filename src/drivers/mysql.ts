import mysql from 'mysql2/promise';
import { DatabaseDriver, CompletionItem } from '../types/driver';
import { ConnectionConfig } from '../types/connection';
import { QueryResult, QueryColumn, SortColumn, MAX_RESULT_ROWS } from '../types/query';
import { SchemaObject, TableInfo, ColumnInfo, TableObjects, TableStatistic, IndexInfo, ConstraintInfo, TriggerInfo } from '../types/schema';
import { wrapError } from '../utils/errors';

function quoteId(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

function quoteTable(table: string, schema?: string): string {
  return schema ? `${quoteId(schema)}.${quoteId(table)}` : quoteId(table);
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

export class MysqlDriver implements DatabaseDriver {
  private pool: mysql.Pool | undefined;
  private config: ConnectionConfig | undefined;

  async connect(config: ConnectionConfig): Promise<void> {
    this.config = config;
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      connectionLimit: 5,
      connectTimeout: 10000,
      decimalNumbers: false,
      bigNumberStrings: true,
      dateStrings: true,
    });
    const conn = await this.pool.getConnection();
    conn.release();
  }

  async disconnect(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
    this.config = undefined;
  }

  async ping(): Promise<boolean> {
    const [rows] = await this.pool!.query('SELECT 1');
    return Array.isArray(rows) && rows.length === 1;
  }

  async cancelQuery(): Promise<void> {
    if (!this.pool) return;
    const conn = await this.pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT CONNECTION_ID() AS id');
      const id = (rows as mysql.RowDataPacket[])[0]?.id;
      if (id) await conn.query(`KILL QUERY ${id}`);
    } finally {
      conn.release();
    }
  }

  async execute(query: string): Promise<QueryResult> {
    const start = Date.now();
    try {
      const [rawResult, fields] = await this.pool!.query(query);
      const executionTimeMs = Date.now() - start;

      if (!Array.isArray(rawResult)) {
        const result = rawResult as mysql.ResultSetHeader;
        return {
          columns: [{ name: 'status', dataType: 'string' }],
          rows: [{ status: `OK — ${result.affectedRows} row(s) affected` }],
          rowCount: 1,
          affectedRows: result.affectedRows,
          executionTimeMs,
        };
      }

      const rows = rawResult as mysql.RowDataPacket[];
      const columns: QueryColumn[] = (fields as mysql.FieldPacket[] || []).map(f => ({
        name: f.name,
        dataType: mysqlTypeToString(f.type, typeof f.flags === 'number' ? f.flags : undefined),
      }));

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
    const db = this.config?.database;
    if (!db) return [];

    const [tablesRaw] = await this.pool!.query(`
      SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH AS total_bytes
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `, [db]);
    const tables = tablesRaw as mysql.RowDataPacket[];

    const [colsRaw] = await this.pool!.query(`
      SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION
    `, [db]);
    const cols = colsRaw as mysql.RowDataPacket[];

    const [idxRaw] = await this.pool!.query(`
      SELECT TABLE_NAME, INDEX_NAME
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND INDEX_NAME != 'PRIMARY'
      GROUP BY TABLE_NAME, INDEX_NAME
      ORDER BY TABLE_NAME, INDEX_NAME
    `, [db]);
    const indexes = idxRaw as mysql.RowDataPacket[];

    const [trigRaw] = await this.pool!.query(`
      SELECT EVENT_OBJECT_TABLE, TRIGGER_NAME
      FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ?
      ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME
    `, [db]);
    const triggers = trigRaw as mysql.RowDataPacket[];

    const colsMap = new Map<string, SchemaObject[]>();
    const colIndexMap = new Map<string, string[]>();

    // Build column-to-index mapping
    const [colIdxRaw] = await this.pool!.query(`
      SELECT TABLE_NAME, COLUMN_NAME, INDEX_NAME
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
    `, [db]);
    for (const row of colIdxRaw as mysql.RowDataPacket[]) {
      const key = `${row.TABLE_NAME}.${row.COLUMN_NAME}`;
      if (!colIndexMap.has(key)) colIndexMap.set(key, []);
      colIndexMap.get(key)!.push(row.INDEX_NAME);
    }

    for (const col of cols) {
      const tbl = col.TABLE_NAME;
      if (!colsMap.has(tbl)) colsMap.set(tbl, []);
      const isPk = col.COLUMN_KEY === 'PRI';
      const badges = [];
      if (isPk) badges.push('PK');
      const detail = `${col.COLUMN_TYPE}${badges.length ? ' (' + badges.join(', ') + ')' : ''}`;
      const indexNames = colIndexMap.get(`${tbl}.${col.COLUMN_NAME}`);
      const notNullable = col.IS_NULLABLE === 'NO' && !isPk;
      colsMap.get(tbl)!.push({
        name: col.COLUMN_NAME,
        type: 'column',
        schema: db,
        detail,
        indexNames: indexNames && indexNames.length > 0 ? indexNames : undefined,
        notNullable: notNullable || undefined,
      });
    }

    const idxMap = new Map<string, SchemaObject[]>();
    for (const idx of indexes) {
      const tbl = idx.TABLE_NAME;
      if (!idxMap.has(tbl)) idxMap.set(tbl, []);
      idxMap.get(tbl)!.push({
        name: idx.INDEX_NAME,
        type: 'index',
        schema: db,
      });
    }

    const trigMap = new Map<string, SchemaObject[]>();
    for (const trig of triggers) {
      const tbl = trig.EVENT_OBJECT_TABLE;
      if (!trigMap.has(tbl)) trigMap.set(tbl, []);
      trigMap.get(tbl)!.push({
        name: trig.TRIGGER_NAME,
        type: 'trigger',
        schema: db,
      });
    }

    const schema: SchemaObject[] = [];
    for (const tbl of tables) {
      const name = tbl.TABLE_NAME;
      const isView = tbl.TABLE_TYPE === 'VIEW';
      const children: SchemaObject[] = [];

      const tableCols = colsMap.get(name);
      if (tableCols) children.push(...tableCols);

      if (!isView) {
        const tableIdxs = idxMap.get(name);
        if (tableIdxs && tableIdxs.length > 0) {
          children.push({ name: 'Indexes', type: 'group', children: tableIdxs });
        }
        const tableTrigs = trigMap.get(name);
        if (tableTrigs && tableTrigs.length > 0) {
          children.push({ name: 'Triggers', type: 'group', children: tableTrigs });
        }
      }

      const rowEstimate = parseInt(String(tbl.TABLE_ROWS), 10) || 0;
      const totalBytes = parseInt(String(tbl.total_bytes), 10) || 0;

      schema.push({
        name,
        type: isView ? 'view' : 'table',
        schema: db,
        children,
        detail: isView ? undefined : formatTableDetail(rowEstimate, totalBytes),
        inaccessible: (!tableCols || tableCols.length === 0) ? true : undefined,
      });
    }

    return schema;
  }

  async getDDL(name: string, type: string): Promise<string> {
    if (type === 'table' || type === 'view') {
      const keyword = type === 'view' ? 'VIEW' : 'TABLE';
      const [rows] = await this.pool!.query(`SHOW CREATE ${keyword} ${quoteId(name)}`);
      const row = (rows as mysql.RowDataPacket[])[0];
      return row?.['Create Table'] || row?.['Create View'] || `-- DDL not found for ${type} ${name}`;
    }
    if (type === 'trigger') {
      const [rows] = await this.pool!.query(`SHOW CREATE TRIGGER ${quoteId(name)}`);
      const row = (rows as mysql.RowDataPacket[])[0];
      return row?.['SQL Original Statement'] || `-- DDL not found for trigger ${name}`;
    }
    return `-- DDL generation not supported for ${type} "${name}"`;
  }

  async getTableInfo(name: string, schema?: string): Promise<TableInfo> {
    const db = schema || this.config?.database;
    const [colsRaw] = await this.pool!.query(`
      SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_KEY, c.COLUMN_DEFAULT, c.COLUMN_COMMENT
      FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
      ORDER BY c.ORDINAL_POSITION
    `, [db, name]);

    const columns: ColumnInfo[] = (colsRaw as mysql.RowDataPacket[]).map(row => ({
      name: row.COLUMN_NAME,
      dataType: row.COLUMN_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      isPrimaryKey: row.COLUMN_KEY === 'PRI',
      defaultValue: row.COLUMN_DEFAULT ?? undefined,
      comment: row.COLUMN_COMMENT || undefined,
    }));

    return { name, schema: db, columns };
  }

  async getEstimatedRowCount(name: string, schema?: string): Promise<number> {
    const db = schema || this.config?.database;
    const [rows] = await this.pool!.query(
      'SELECT TABLE_ROWS AS cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [db, name],
    );
    return Math.max(0, parseInt(String((rows as mysql.RowDataPacket[])[0]?.cnt), 10) || 0);
  }

  async getTableRowCount(name: string, schema?: string): Promise<number> {
    const db = schema || this.config?.database;
    const [rows] = await this.pool!.query(`SELECT COUNT(*) AS cnt FROM ${quoteTable(name, db)}`);
    return parseInt(String((rows as mysql.RowDataPacket[])[0]?.cnt), 10) || 0;
  }

  async getTableData(name: string, schema?: string, limit = MAX_RESULT_ROWS, offset = 0, orderBy?: SortColumn[]): Promise<QueryResult> {
    const db = schema || this.config?.database;
    let sql = `SELECT * FROM ${quoteTable(name, db)}`;
    if (orderBy && orderBy.length > 0) {
      const clauses = orderBy.map(s => `${quoteId(s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`);
      sql += ` ORDER BY ${clauses.join(', ')}`;
    }
    sql += ` LIMIT ${limit} OFFSET ${offset}`;
    const result = await this.execute(sql);
    result.query = sql;

    if (!result.error && result.columns.length > 0) {
      const [metaRaw] = await this.pool!.query(`
        SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      `, [db, name]);
      const nullableMap = new Map<string, boolean>();
      for (const row of metaRaw as mysql.RowDataPacket[]) {
        nullableMap.set(row.COLUMN_NAME, row.IS_NULLABLE === 'YES');
      }
      for (const col of result.columns) {
        col.nullable = nullableMap.get(col.name) ?? true;
      }

      const [enumRaw] = await this.pool!.query(`
        SELECT COLUMN_NAME, COLUMN_TYPE
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          AND DATA_TYPE IN ('enum', 'set')
      `, [db, name]);
      for (const row of enumRaw as mysql.RowDataPacket[]) {
        const match = String(row.COLUMN_TYPE).match(/^(?:enum|set)\((.+)\)$/i);
        if (match) {
          const values = match[1].split(',').map((v: string) => v.trim().replace(/^'|'$/g, ''));
          const col = result.columns.find(c => c.name === row.COLUMN_NAME);
          if (col) col.enumValues = values;
        }
      }
    }

    return result;
  }

  async getIndexedColumns(name: string, schema?: string): Promise<Set<string>> {
    const db = schema || this.config?.database;
    const [rows] = await this.pool!.query(`
      SELECT COLUMN_NAME
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `, [db, name]);
    return new Set((rows as mysql.RowDataPacket[]).map(r => r.COLUMN_NAME));
  }

  async getTableObjects(name: string, schema?: string): Promise<TableObjects> {
    const db = schema || this.config?.database;

    // Indexes
    const [idxRaw] = await this.pool!.query(`
      SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns,
             NOT NON_UNIQUE AS is_unique, INDEX_TYPE
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME != 'PRIMARY'
      GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE
      ORDER BY INDEX_NAME
    `, [db, name]);
    const indexes: IndexInfo[] = (idxRaw as mysql.RowDataPacket[]).map(row => ({
      name: row.INDEX_NAME,
      columns: String(row.columns).split(','),
      unique: Boolean(row.is_unique),
      type: row.INDEX_TYPE,
    }));

    // Constraints
    const [conRaw] = await this.pool!.query(`
      SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE,
             GROUP_CONCAT(DISTINCT kcu.COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION) AS columns,
             kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME,
             GROUP_CONCAT(DISTINCT kcu.REFERENCED_COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION) AS ref_columns,
             rc.DELETE_RULE, rc.UPDATE_RULE
      FROM information_schema.TABLE_CONSTRAINTS tc
      LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA AND tc.TABLE_NAME = kcu.TABLE_NAME
      LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON tc.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
      WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?
      GROUP BY tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE,
               kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME,
               rc.DELETE_RULE, rc.UPDATE_RULE
      ORDER BY tc.CONSTRAINT_TYPE, tc.CONSTRAINT_NAME
    `, [db, name]);
    const constraints: ConstraintInfo[] = (conRaw as mysql.RowDataPacket[]).map(row => ({
      name: row.CONSTRAINT_NAME,
      type: row.CONSTRAINT_TYPE as ConstraintInfo['type'],
      columns: String(row.columns || '').split(',').filter(Boolean),
      referencedTable: row.CONSTRAINT_TYPE === 'FOREIGN KEY' && row.REFERENCED_TABLE_NAME
        ? `${row.REFERENCED_TABLE_SCHEMA}.${row.REFERENCED_TABLE_NAME}` : undefined,
      referencedColumns: row.CONSTRAINT_TYPE === 'FOREIGN KEY' && row.ref_columns
        ? String(row.ref_columns).split(',').filter(Boolean) : undefined,
      onDelete: row.DELETE_RULE ?? undefined,
      onUpdate: row.UPDATE_RULE ?? undefined,
    }));

    // Triggers
    const [trigRaw] = await this.pool!.query(`
      SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
      FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
      ORDER BY TRIGGER_NAME
    `, [db, name]);
    const triggers: TriggerInfo[] = (trigRaw as mysql.RowDataPacket[]).map(row => ({
      name: row.TRIGGER_NAME,
      timing: row.ACTION_TIMING,
      events: row.EVENT_MANIPULATION,
      definition: row.ACTION_STATEMENT,
    }));

    return { indexes, constraints, triggers, sequences: [] };
  }

  async getTableStatistics(name: string, schema?: string): Promise<TableStatistic[]> {
    const db = schema || this.config?.database;

    const [rows] = await this.pool!.query(`
      SELECT TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH,
             DATA_LENGTH + INDEX_LENGTH AS total_size,
             DATA_FREE, AVG_ROW_LENGTH, AUTO_INCREMENT,
             CREATE_TIME, UPDATE_TIME, ENGINE, TABLE_COLLATION
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `, [db, name]);
    const row = (rows as mysql.RowDataPacket[])[0];

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

    return [
      { key: 'row_count', label: 'Row count (estimated)', value: toNumber(row?.TABLE_ROWS), unit: 'count' },
      { key: 'data_size', label: 'Data size', value: toNumber(row?.DATA_LENGTH), unit: 'bytes' },
      { key: 'indexes_size', label: 'Index size', value: toNumber(row?.INDEX_LENGTH), unit: 'bytes' },
      { key: 'total_size', label: 'Total size', value: toNumber(row?.total_size), unit: 'bytes' },
      { key: 'data_free', label: 'Free space', value: toNumber(row?.DATA_FREE), unit: 'bytes', badWhen: 'higher' },
      { key: 'avg_row_length', label: 'Avg row length', value: toNumber(row?.AVG_ROW_LENGTH), unit: 'bytes' },
      { key: 'auto_increment', label: 'Auto increment', value: toNumber(row?.AUTO_INCREMENT), unit: 'count' },
      { key: 'create_time', label: 'Created', value: toDate(row?.CREATE_TIME), unit: 'date' },
      { key: 'update_time', label: 'Last updated', value: toDate(row?.UPDATE_TIME), unit: 'date' },
      { key: 'engine', label: 'Engine', value: row?.ENGINE ?? null, unit: 'text' },
      { key: 'collation', label: 'Collation', value: row?.TABLE_COLLATION ?? null, unit: 'text' },
    ];
  }

  async getCompletions(): Promise<CompletionItem[]> {
    const db = this.config?.database;
    if (!db) return [];
    const items: CompletionItem[] = [];

    const [tablesRaw] = await this.pool!.query(`
      SELECT TABLE_NAME, TABLE_TYPE
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `, [db]);
    for (const r of tablesRaw as mysql.RowDataPacket[]) {
      items.push({
        label: r.TABLE_NAME,
        kind: r.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
      });
    }

    const [colsRaw] = await this.pool!.query(`
      SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION
    `, [db]);

    const [enumRaw] = await this.pool!.query(`
      SELECT COLUMN_NAME, TABLE_NAME, COLUMN_TYPE
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('enum', 'set')
    `, [db]);
    const enumMap = new Map<string, string[]>();
    for (const r of enumRaw as mysql.RowDataPacket[]) {
      const match = String(r.COLUMN_TYPE).match(/^(?:enum|set)\((.+)\)$/i);
      if (match) {
        enumMap.set(`${r.TABLE_NAME}.${r.COLUMN_NAME}`, match[1].split(',').map((v: string) => v.trim().replace(/^'|'$/g, '')));
      }
    }

    for (const r of colsRaw as mysql.RowDataPacket[]) {
      items.push({
        label: r.COLUMN_NAME,
        kind: 'column',
        detail: r.COLUMN_TYPE,
        parent: r.TABLE_NAME,
        enumValues: enumMap.get(`${r.TABLE_NAME}.${r.COLUMN_NAME}`),
      });
    }

    return items;
  }
}

function mysqlTypeToString(typeId: number | undefined, flags: number | undefined): string {
  // mysql2 FieldPacket.type values (from mysql2 constants)
  const map: Record<number, string> = {
    0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int',
    4: 'float', 5: 'double', 6: 'null', 7: 'timestamp',
    8: 'bigint', 9: 'mediumint', 10: 'date', 11: 'time',
    12: 'datetime', 13: 'year', 14: 'newdate',
    15: 'varchar', 16: 'bit', 245: 'json', 246: 'newdecimal',
    247: 'enum', 248: 'set', 249: 'tinyblob', 250: 'mediumblob',
    251: 'longblob', 252: 'blob', 253: 'varchar', 254: 'char',
    255: 'geometry',
  };
  let name = map[typeId ?? -1] || `type:${typeId}`;
  if (flags && (flags & 32) !== 0) name = `unsigned ${name}`;
  return name;
}
