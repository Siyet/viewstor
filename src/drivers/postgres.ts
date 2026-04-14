import { Client, types } from 'pg';
import { DatabaseDriver } from '../types/driver';
import { ConnectionConfig } from '../types/connection';
import { QueryResult, QueryColumn, SortColumn, MAX_RESULT_ROWS } from '../types/query';
import { CompletionItem } from '../types/driver';
import { SchemaObject, TableInfo, ColumnInfo, TableObjects, TableStatistic, IndexInfo, ConstraintInfo, TriggerInfo, SequenceInfo } from '../types/schema';
import { createSSHTunnel, createSocks5Connection, TunnelInfo } from '../connections/tunnel';
import { quoteIdentifier } from '../utils/queryHelpers';

// Return raw strings for bigint, numeric, etc. instead of JS number
types.setTypeParser(20, (val: string) => val); // int8
types.setTypeParser(1700, (val: string) => val); // numeric

/**
 * PG array_agg can come back as a JS array or as a `{curly,brace}` string
 * depending on the driver/query; normalize both to string[].
 */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return value.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  return [];
}

export class PostgresDriver implements DatabaseDriver {
  private client: Client | undefined;
  private tunnel: TunnelInfo | undefined;

  async connect(config: ConnectionConfig): Promise<void> {
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

    this.client = new Client({
      host,
      port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10000,
      ...(stream ? { stream: () => stream as never } : {}),
    });
    try {
      await this.client.connect();
    } catch (err) {
      this.client = undefined;
      this.tunnel?.close();
      this.tunnel = undefined;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.end();
    this.client = undefined;
    this.tunnel?.close();
    this.tunnel = undefined;
  }

  async ping(): Promise<boolean> {
    const res = await this.client!.query('SELECT 1');
    return res.rowCount === 1;
  }

  async cancelQuery(): Promise<void> {
    if (!this.client) return;
    // pg Client exposes the underlying connection which has a processID
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pid = (this.client as any).processID;
    if (!pid) return;
    // Use a temporary connection to cancel the running query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cancelClient = new Client((this.client as any).connectionParameters);
    try {
      await cancelClient.connect();
      await cancelClient.query('SELECT pg_cancel_backend($1)', [pid]);
    } finally {
      await cancelClient.end().catch(() => {});
    }
  }

  async execute(query: string): Promise<QueryResult> {
    const start = Date.now();
    try {
      const rawRes = await this.client!.query(query);
      const executionTimeMs = Date.now() - start;

      // pg returns an array of Results for multi-statement queries
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = Array.isArray(rawRes) ? rawRes as any[] : null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = results ? results[results.length - 1] : rawRes;

      const columns: QueryColumn[] = (res.fields || []).map((f: { name: string; dataTypeID: number }) => ({
        name: f.name,
        dataType: pgTypeToString(f.dataTypeID),
      }));

      const rows = res.rows || [];
      const truncated = rows.length > MAX_RESULT_ROWS;

      // For multi-statement queries, sum up affectedRows from all non-SELECT results
      let affectedRows: number | undefined;
      if (res.command !== 'SELECT') {
        if (results) {
          affectedRows = 0;
          for (const result of results) {
            if (result.command !== 'SELECT' && result.rowCount != null) {
              affectedRows += result.rowCount;
            }
          }
        } else {
          affectedRows = res.rowCount ?? undefined;
        }
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
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getSchema(): Promise<SchemaObject[]> {
    // Tables with estimated row counts and sizes from pg_class
    const tablesRes = await this.client!.query(`
      SELECT t.schemaname, t.tablename,
             GREATEST(c.reltuples::bigint, 0) AS row_estimate,
             pg_total_relation_size(c.oid) AS total_bytes
      FROM pg_tables t
      LEFT JOIN pg_namespace n ON n.nspname = t.schemaname
      LEFT JOIN pg_class c ON c.relname = t.tablename AND c.relnamespace = n.oid
      WHERE t.schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY t.schemaname, t.tablename
    `);

    // Views
    const viewsRes = await this.client!.query(`
      SELECT schemaname, viewname
      FROM pg_views
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schemaname, viewname
    `);

    // Columns per table/view
    const columnsRes = await this.client!.query(`
      SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable,
             c.column_default,
             CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT ku.table_schema, ku.table_name, ku.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage ku
          ON tc.constraint_name = ku.constraint_name AND tc.table_schema = ku.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
      ) pk ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name AND pk.column_name = c.column_name
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY c.table_schema, c.table_name, c.ordinal_position
    `);

    // Indexes
    const indexesRes = await this.client!.query(`
      SELECT schemaname, tablename, indexname
      FROM pg_indexes
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schemaname, tablename, indexname
    `);

    // Column → index names mapping (which indexes cover each column).
    // Used to tint indexed columns blue in the tree and enable "Show index DDL".
    const columnIndexesRes = await this.client!.query(`
      SELECT n.nspname AS schema, t.relname AS tbl, a.attname AS col, i.relname AS index_name
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    `);
    const columnIndexesMap = new Map<string, string[]>();
    for (const row of columnIndexesRes.rows) {
      const key = `${row.schema}.${row.tbl}.${row.col}`;
      if (!columnIndexesMap.has(key)) columnIndexesMap.set(key, []);
      columnIndexesMap.get(key)!.push(row.index_name);
    }

    // Triggers
    const triggersRes = await this.client!.query(`
      SELECT trigger_schema, event_object_table, trigger_name
      FROM information_schema.triggers
      WHERE trigger_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY trigger_schema, event_object_table, trigger_name
    `);

    // Sequences
    const sequencesRes = await this.client!.query(`
      SELECT schemaname, sequencename
      FROM pg_sequences
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schemaname, sequencename
    `);

    // Build columns map: schema.table -> SchemaObject[]
    const columnsMap = new Map<string, SchemaObject[]>();
    for (const row of columnsRes.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      if (!columnsMap.has(key)) columnsMap.set(key, []);
      const badges = [];
      if (row.is_pk) badges.push('PK');
      // Strikethrough NULL via Unicode combining-long-stroke-overlay (U+0336).
      // Reads visually as N̶U̶L̶L̶ — compact and intuitive.
      if (row.is_nullable === 'NO' && !row.is_pk) badges.push('N\u0336U\u0336L\u0336L\u0336');
      const detail = `${row.data_type}${badges.length ? ' (' + badges.join(', ') + ')' : ''}`;
      const indexNames = columnIndexesMap.get(`${row.table_schema}.${row.table_name}.${row.column_name}`);
      columnsMap.get(key)!.push({
        name: row.column_name,
        type: 'column',
        schema: row.table_schema,
        detail,
        indexNames: indexNames && indexNames.length > 0 ? indexNames : undefined,
      });
    }

    // Build indexes map: schema.table -> SchemaObject[]
    const indexesMap = new Map<string, SchemaObject[]>();
    for (const row of indexesRes.rows) {
      const key = `${row.schemaname}.${row.tablename}`;
      if (!indexesMap.has(key)) indexesMap.set(key, []);
      indexesMap.get(key)!.push({
        name: row.indexname,
        type: 'index',
        schema: row.schemaname,
      });
    }

    // Build triggers map: schema.table -> SchemaObject[]
    const triggersMap = new Map<string, SchemaObject[]>();
    for (const row of triggersRes.rows) {
      const key = `${row.trigger_schema}.${row.event_object_table}`;
      if (!triggersMap.has(key)) triggersMap.set(key, []);
      triggersMap.get(key)!.push({
        name: row.trigger_name,
        type: 'trigger',
        schema: row.trigger_schema,
      });
    }

    const schemas = new Map<string, SchemaObject>();

    // Tables with children (columns, indexes, triggers)
    for (const row of tablesRes.rows) {
      const schemaName = row.schemaname;
      if (!schemas.has(schemaName)) {
        schemas.set(schemaName, { name: schemaName, type: 'schema', children: [] });
      }
      const tableKey = `${schemaName}.${row.tablename}`;
      const children: SchemaObject[] = [];

      const cols = columnsMap.get(tableKey);
      if (cols) children.push(...cols);

      const idxs = indexesMap.get(tableKey);
      if (idxs && idxs.length > 0) {
        children.push({ name: 'Indexes', type: 'group', children: idxs });
      }

      const trigs = triggersMap.get(tableKey);
      if (trigs && trigs.length > 0) {
        children.push({ name: 'Triggers', type: 'group', children: trigs });
      }

      const hasColumns = cols && cols.length > 0;
      const rowEstimate = parseInt(row.row_estimate, 10) || 0;
      const totalBytes = parseInt(row.total_bytes, 10) || 0;
      const detailStr = formatTableDetail(rowEstimate, totalBytes);
      schemas.get(schemaName)!.children!.push({
        name: row.tablename,
        type: 'table',
        schema: schemaName,
        children,
        detail: detailStr,
        inaccessible: !hasColumns ? true : undefined,
      });
    }

    // Views with columns
    for (const row of viewsRes.rows) {
      const schemaName = row.schemaname;
      if (!schemas.has(schemaName)) {
        schemas.set(schemaName, { name: schemaName, type: 'schema', children: [] });
      }
      const viewKey = `${schemaName}.${row.viewname}`;
      const cols = columnsMap.get(viewKey) || [];

      schemas.get(schemaName)!.children!.push({
        name: row.viewname,
        type: 'view',
        schema: schemaName,
        children: cols,
        inaccessible: cols.length === 0 ? true : undefined,
      });
    }

    // Sequences as a schema-level group
    const seqsBySchema = new Map<string, SchemaObject[]>();
    for (const row of sequencesRes.rows) {
      if (!seqsBySchema.has(row.schemaname)) seqsBySchema.set(row.schemaname, []);
      seqsBySchema.get(row.schemaname)!.push({
        name: row.sequencename,
        type: 'sequence',
        schema: row.schemaname,
      });
    }
    for (const [schemaName, seqs] of seqsBySchema) {
      if (!schemas.has(schemaName)) {
        schemas.set(schemaName, { name: schemaName, type: 'schema', children: [] });
      }
      schemas.get(schemaName)!.children!.push({
        name: 'Sequences',
        type: 'group',
        children: seqs,
      });
    }

    return Array.from(schemas.values());
  }

  async getDDL(name: string, type: string, schema = 'public'): Promise<string> {
    switch (type) {
      case 'table': {
        // Reconstruct CREATE TABLE from information_schema
        const colsRes = await this.client!.query(`
          SELECT column_name, data_type, is_nullable, column_default,
                 character_maximum_length, numeric_precision, numeric_scale
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `, [schema, name]);

        const pkRes = await this.client!.query(`
          SELECT ku.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku
            ON tc.constraint_name = ku.constraint_name AND tc.table_schema = ku.table_schema
          WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
          ORDER BY ku.ordinal_position
        `, [schema, name]);

        const pkColumns = new Set(pkRes.rows.map((r: any) => r.column_name));

        const colDefs = colsRes.rows.map((r: any) => {
          let def = `  "${r.column_name}" ${r.data_type}`;
          if (r.character_maximum_length) def += `(${r.character_maximum_length})`;
          if (r.column_default) def += ` DEFAULT ${r.column_default}`;
          if (r.is_nullable === 'NO') def += ' NOT NULL';
          return def;
        });

        if (pkColumns.size > 0) {
          colDefs.push(`  PRIMARY KEY (${[...pkColumns].map(c => `"${c}"`).join(', ')})`);
        }

        // Unique constraints
        const uniqueRes = await this.client!.query(`
          SELECT tc.constraint_name, array_agg(ku.column_name ORDER BY ku.ordinal_position) AS columns
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku
            ON tc.constraint_name = ku.constraint_name AND tc.table_schema = ku.table_schema
          WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'UNIQUE'
          GROUP BY tc.constraint_name
        `, [schema, name]);
        for (const r of uniqueRes.rows) {
          colDefs.push(`  CONSTRAINT "${r.constraint_name}" UNIQUE (${toStringArray(r.columns).map(c => `"${c}"`).join(', ')})`);
        }

        // Foreign keys
        const fkRes = await this.client!.query(`
          SELECT tc.constraint_name, ku.column_name, ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name AND tc.table_schema = ku.table_schema
          JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
          WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'
        `, [schema, name]);
        for (const r of fkRes.rows) {
          colDefs.push(`  CONSTRAINT "${r.constraint_name}" FOREIGN KEY ("${r.column_name}") REFERENCES "${r.ref_schema}"."${r.ref_table}" ("${r.ref_column}")`);
        }

        // Check constraints
        const checkRes = await this.client!.query(`
          SELECT cc.constraint_name, cc.check_clause
          FROM information_schema.check_constraints cc
          JOIN information_schema.table_constraints tc ON cc.constraint_name = tc.constraint_name AND cc.constraint_schema = tc.table_schema
          WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'CHECK'
            AND cc.constraint_name NOT LIKE '%_not_null'
        `, [schema, name]);
        for (const r of checkRes.rows) {
          colDefs.push(`  CONSTRAINT "${r.constraint_name}" CHECK (${r.check_clause})`);
        }

        let ddl = `CREATE TABLE "${schema}"."${name}" (\n${colDefs.join(',\n')}\n);`;

        // Indexes (excluding PK/unique — they're already in constraints)
        const idxRes = await this.client!.query(`
          SELECT indexdef FROM pg_indexes
          WHERE schemaname = $1 AND tablename = $2
            AND indexname NOT IN (
              SELECT constraint_name FROM information_schema.table_constraints
              WHERE table_schema = $1 AND table_name = $2
            )
        `, [schema, name]);
        if (idxRes.rows.length > 0) {
          ddl += '\n\n-- Indexes';
          for (const r of idxRes.rows) {
            ddl += `\n${r.indexdef};`;
          }
        }

        // Sequences owned by this table
        const seqRes = await this.client!.query(`
          SELECT s.relname AS seq_name, a.attname AS column_name
          FROM pg_class s
          JOIN pg_depend d ON d.objid = s.oid
          JOIN pg_class t ON t.oid = d.refobjid
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE s.relkind = 'S' AND n.nspname = $1 AND t.relname = $2
        `, [schema, name]);
        if (seqRes.rows.length > 0) {
          ddl += '\n\n-- Sequences';
          for (const r of seqRes.rows) {
            ddl += `\n-- "${r.seq_name}" owned by "${r.column_name}"`;
          }
        }

        return ddl;
      }
      case 'view': {
        const res = await this.client!.query(`
          SELECT definition FROM pg_views
          WHERE schemaname = $1 AND viewname = $2
        `, [schema, name]);
        const definition = res.rows[0]?.definition || '';
        return `CREATE OR REPLACE VIEW "${schema}"."${name}" AS\n${definition}`;
      }
      case 'index': {
        const res = await this.client!.query(`
          SELECT indexdef FROM pg_indexes
          WHERE schemaname = $1 AND indexname = $2
        `, [schema, name]);
        return res.rows[0]?.indexdef ? `${res.rows[0].indexdef};` : `-- DDL not found for index ${name}`;
      }
      case 'trigger': {
        const res = await this.client!.query(`
          SELECT pg_get_triggerdef(t.oid, true) as triggerdef
          FROM pg_trigger t
          JOIN pg_class c ON t.tgrelid = c.oid
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE n.nspname = $1 AND t.tgname = $2
        `, [schema, name]);
        return res.rows[0]?.triggerdef ? `${res.rows[0].triggerdef};` : `-- DDL not found for trigger ${name}`;
      }
      case 'sequence': {
        const res = await this.client!.query(`
          SELECT start_value, min_value, max_value, increment_by, cycle
          FROM pg_sequences
          WHERE schemaname = $1 AND sequencename = $2
        `, [schema, name]);
        const r = res.rows[0];
        if (!r) return `-- DDL not found for sequence ${name}`;
        return `CREATE SEQUENCE "${schema}"."${name}"\n  START WITH ${r.start_value}\n  INCREMENT BY ${r.increment_by}\n  MINVALUE ${r.min_value}\n  MAXVALUE ${r.max_value}${r.cycle ? '\n  CYCLE' : '\n  NO CYCLE'};`;
      }
      default:
        return `-- DDL generation not supported for ${type} "${name}"`;
    }
  }

  async getTableInfo(name: string, schema = 'public'): Promise<TableInfo> {
    const res = await this.client!.query(`
      SELECT
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk,
        col_description(
          (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass::oid,
          c.ordinal_position::int
        ) AS comment
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT ku.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage ku
          ON tc.constraint_name = ku.constraint_name
        WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
      ) pk ON pk.column_name = c.column_name
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position
    `, [schema, name]);

    const columns: ColumnInfo[] = res.rows.map(row => ({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === 'YES',
      isPrimaryKey: row.is_pk,
      defaultValue: row.column_default,
      comment: row.comment ?? undefined,
    }));

    return { name, schema, columns };
  }

  async getEstimatedRowCount(name: string, schema = 'public'): Promise<number> {
    const res = await this.client!.query(
      'SELECT reltuples::bigint AS cnt FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2',
      [schema, name],
    );
    return Math.max(0, parseInt(res.rows[0]?.cnt, 10) || 0);
  }

  async getTableRowCount(name: string, schema = 'public'): Promise<number> {
    const quoted = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
    const res = await this.client!.query(`SELECT COUNT(*) AS cnt FROM ${quoted}`);
    return parseInt(res.rows[0]?.cnt, 10) || 0;
  }

  async getTableData(name: string, schema = 'public', limit = MAX_RESULT_ROWS, offset = 0, orderBy?: SortColumn[]): Promise<QueryResult> {
    const quoted = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
    let sql = `SELECT * FROM ${quoted}`;
    if (orderBy && orderBy.length > 0) {
      const clauses = orderBy.map(s => `${quoteIdentifier(s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`);
      sql += ` ORDER BY ${clauses.join(', ')}`;
    }
    sql += ` LIMIT ${limit} OFFSET ${offset}`;
    const result = await this.execute(sql);
    result.query = sql;

    // Enrich columns with enum values and nullable info
    if (!result.error && result.columns.length > 0) {
      const metaRes = await this.client!.query(`
        SELECT c.column_name, c.is_nullable, c.data_type, c.udt_name
        FROM information_schema.columns c
        WHERE c.table_schema = $1 AND c.table_name = $2
      `, [schema, name]);

      const nullableMap = new Map<string, boolean>();
      const udtMap = new Map<string, string>();
      for (const row of metaRes.rows) {
        nullableMap.set(row.column_name, row.is_nullable === 'YES');
        udtMap.set(row.column_name, row.udt_name);
      }

      const enumRes = await this.client!.query(`
        SELECT c.column_name, e.enumlabel
        FROM information_schema.columns c
        JOIN pg_type t ON c.udt_name = t.typname
        JOIN pg_enum e ON t.oid = e.enumtypid
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.column_name, e.enumsortorder
      `, [schema, name]);

      const enumMap = new Map<string, string[]>();
      for (const row of enumRes.rows) {
        if (!enumMap.has(row.column_name)) enumMap.set(row.column_name, []);
        enumMap.get(row.column_name)!.push(row.enumlabel);
      }

      for (const col of result.columns) {
        col.nullable = nullableMap.get(col.name) ?? true;
        const vals = enumMap.get(col.name);
        if (vals) col.enumValues = vals;
      }
    }

    return result;
  }

  async getIndexedColumns(name: string, schema = 'public'): Promise<Set<string>> {
    const res = await this.client!.query(`
      SELECT a.attname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = $1 AND c.relname = $2
    `, [schema, name]);
    return new Set(res.rows.map((r: { attname: string }) => r.attname));
  }

  async getTableObjects(name: string, schema = 'public'): Promise<TableObjects> {
    // Indexes (excluding primary key indexes).
    // indnkeyatts < indnatts means the trailing columns are INCLUDE'd (covering), not key columns.
    const indexesRes = await this.client!.query(`
      SELECT i.relname AS index_name,
             array_agg(a.attname ORDER BY k.ordinality) AS all_columns,
             ix.indnkeyatts AS nkey_atts,
             ix.indisunique AS is_unique,
             am.amname AS index_type,
             pg_get_expr(ix.indpred, ix.indrelid) AS predicate
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_am am ON am.oid = i.relam
      CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ordinality)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = $1 AND t.relname = $2
        AND NOT ix.indisprimary
      GROUP BY i.relname, ix.indisunique, am.amname, ix.indpred, ix.indrelid, ix.indnkeyatts
      ORDER BY i.relname
    `, [schema, name]);

    const indexes: IndexInfo[] = indexesRes.rows.map((row: any) => {
      const allCols = toStringArray(row.all_columns);
      const nkey = parseInt(String(row.nkey_atts), 10) || allCols.length;
      const included = allCols.slice(nkey);
      return {
        name: row.index_name,
        columns: allCols.slice(0, nkey),
        included: included.length > 0 ? included : undefined,
        unique: row.is_unique,
        type: row.index_type,
        predicate: row.predicate ?? undefined,
      };
    });

    // Constraints
    const constraintsRes = await this.client!.query(`
      SELECT tc.constraint_name, tc.constraint_type,
             array_agg(DISTINCT kcu.column_name ORDER BY kcu.column_name) AS columns,
             ccu.table_schema || '.' || ccu.table_name AS ref_table,
             array_agg(DISTINCT ccu.column_name ORDER BY ccu.column_name) AS ref_columns,
             rc.delete_rule, rc.update_rule,
             cc.check_clause
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        AND tc.constraint_type = 'FOREIGN KEY'
      LEFT JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
      LEFT JOIN information_schema.check_constraints cc
        ON tc.constraint_name = cc.constraint_name AND tc.constraint_schema = cc.constraint_schema
      WHERE tc.table_schema = $1 AND tc.table_name = $2
        AND tc.constraint_name NOT LIKE '%_not_null'
      GROUP BY tc.constraint_name, tc.constraint_type, ccu.table_schema, ccu.table_name,
               rc.delete_rule, rc.update_rule, cc.check_clause
      ORDER BY tc.constraint_type, tc.constraint_name
    `, [schema, name]);

    const constraints: ConstraintInfo[] = constraintsRes.rows.map((row: any) => ({
      name: row.constraint_name,
      type: row.constraint_type as ConstraintInfo['type'],
      columns: toStringArray(row.columns),
      referencedTable: row.constraint_type === 'FOREIGN KEY' ? row.ref_table : undefined,
      referencedColumns: row.constraint_type === 'FOREIGN KEY'
        ? toStringArray(row.ref_columns) : undefined,
      onDelete: row.delete_rule ?? undefined,
      onUpdate: row.update_rule ?? undefined,
      checkExpression: row.check_clause ?? undefined,
    }));

    // Triggers
    const triggersRes = await this.client!.query(`
      SELECT t.tgname AS trigger_name,
             CASE WHEN t.tgtype & 2 = 2 THEN 'BEFORE'
                  WHEN t.tgtype & 64 = 64 THEN 'INSTEAD OF'
                  ELSE 'AFTER' END AS timing,
             concat_ws(', ',
               CASE WHEN t.tgtype & 4 = 4 THEN 'INSERT' END,
               CASE WHEN t.tgtype & 8 = 8 THEN 'DELETE' END,
               CASE WHEN t.tgtype & 16 = 16 THEN 'UPDATE' END
             ) AS events,
             p.proname AS function_name
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_proc p ON t.tgfoid = p.oid
      WHERE n.nspname = $1 AND c.relname = $2
        AND NOT t.tgisinternal
      ORDER BY t.tgname
    `, [schema, name]);

    const triggers: TriggerInfo[] = triggersRes.rows.map((row: any) => ({
      name: row.trigger_name,
      timing: row.timing,
      events: row.events,
      definition: row.function_name,
    }));

    // Sequences owned by this table
    const sequencesRes = await this.client!.query(`
      SELECT s.relname AS seq_name, sq.data_type,
             sq.start_value::bigint, sq.increment_by::bigint,
             sq.min_value::bigint, sq.max_value::bigint
      FROM pg_class s
      JOIN pg_depend d ON d.objid = s.oid
      JOIN pg_class t ON t.oid = d.refobjid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      LEFT JOIN pg_sequences sq ON sq.schemaname = n.nspname AND sq.sequencename = s.relname
      WHERE s.relkind = 'S' AND n.nspname = $1 AND t.relname = $2
      ORDER BY s.relname
    `, [schema, name]);

    const sequences: SequenceInfo[] = sequencesRes.rows.map((row: any) => ({
      name: row.seq_name,
      dataType: row.data_type ?? undefined,
      startValue: row.start_value != null ? Number(row.start_value) : undefined,
      increment: row.increment_by != null ? Number(row.increment_by) : undefined,
      minValue: row.min_value != null ? Number(row.min_value) : undefined,
      maxValue: row.max_value != null ? Number(row.max_value) : undefined,
    }));

    return { indexes, constraints, triggers, sequences };
  }

  async getTableStatistics(name: string, schema = 'public'): Promise<TableStatistic[]> {
    const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;

    const sizesRes = await this.client!.query(
      `SELECT
         pg_table_size($1::regclass)::bigint AS table_size,
         pg_indexes_size($1::regclass)::bigint AS indexes_size,
         pg_total_relation_size($1::regclass)::bigint AS total_size,
         (SELECT reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $2 AND c.relname = $3) AS est_rows`,
      [qualified, schema, name],
    );
    const sizes = sizesRes.rows[0] || {};

    // pg_stat_user_tables is only available for tables the user can select from;
    // for views or inaccessible tables this returns no rows — treat as missing.
    const statRes = await this.client!.query(
      `SELECT n_live_tup::bigint AS live_tup,
              n_dead_tup::bigint AS dead_tup,
              last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
              seq_scan::bigint AS seq_scan,
              idx_scan::bigint AS idx_scan,
              n_tup_ins::bigint AS n_tup_ins,
              n_tup_upd::bigint AS n_tup_upd,
              n_tup_del::bigint AS n_tup_del
       FROM pg_stat_user_tables
       WHERE schemaname = $1 AND relname = $2`,
      [schema, name],
    );
    const stat = statRes.rows[0] || {};

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

    const liveTuples = toNumber(stat.live_tup);
    const deadTuples = toNumber(stat.dead_tup);
    const deadPct = liveTuples !== null && deadTuples !== null && liveTuples + deadTuples > 0
      ? (deadTuples / (liveTuples + deadTuples)) * 100
      : null;

    const lastVacuum = toDate(stat.last_vacuum) || toDate(stat.last_autovacuum);
    const lastAnalyze = toDate(stat.last_analyze) || toDate(stat.last_autoanalyze);

    return [
      { key: 'row_count', label: 'Row count (estimated)', value: toNumber(sizes.est_rows), unit: 'count' },
      { key: 'live_tuples', label: 'Live tuples', value: liveTuples, unit: 'count' },
      { key: 'dead_tuples', label: 'Dead tuples', value: deadTuples, unit: 'count', badWhen: 'higher' },
      { key: 'dead_tuples_pct', label: 'Dead tuples %', value: deadPct !== null ? Number(deadPct.toFixed(2)) : null, unit: 'percent', badWhen: 'higher' },
      { key: 'table_size', label: 'Table size', value: toNumber(sizes.table_size), unit: 'bytes' },
      { key: 'indexes_size', label: 'Indexes size', value: toNumber(sizes.indexes_size), unit: 'bytes' },
      { key: 'total_size', label: 'Total size', value: toNumber(sizes.total_size), unit: 'bytes' },
      { key: 'last_vacuum', label: 'Last vacuum', value: lastVacuum, unit: 'date' },
      { key: 'last_analyze', label: 'Last analyze', value: lastAnalyze, unit: 'date' },
      { key: 'seq_scan', label: 'Sequential scans', value: toNumber(stat.seq_scan), unit: 'count', badWhen: 'higher' },
      { key: 'idx_scan', label: 'Index scans', value: toNumber(stat.idx_scan), unit: 'count', badWhen: 'lower' },
      { key: 'tup_inserted', label: 'Tuples inserted', value: toNumber(stat.n_tup_ins), unit: 'count' },
      { key: 'tup_updated', label: 'Tuples updated', value: toNumber(stat.n_tup_upd), unit: 'count' },
      { key: 'tup_deleted', label: 'Tuples deleted', value: toNumber(stat.n_tup_del), unit: 'count' },
    ];
  }

  async getCompletions(): Promise<CompletionItem[]> {
    const items: CompletionItem[] = [];

    // Schemas
    const schemasRes = await this.client!.query(
      'SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN (\'pg_catalog\',\'information_schema\',\'pg_toast\') ORDER BY schema_name'
    );
    for (const r of schemasRes.rows) {
      items.push({ label: r.schema_name, kind: 'schema' });
    }

    // Tables and views
    const tablesRes = await this.client!.query(
      'SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN (\'pg_catalog\',\'information_schema\') ORDER BY table_schema, table_name'
    );
    for (const r of tablesRes.rows) {
      items.push({
        label: r.table_name,
        kind: r.table_type === 'VIEW' ? 'view' : 'table',
        detail: r.table_schema !== 'public' ? r.table_schema : undefined,
      });
    }

    // Columns
    const colsRes = await this.client!.query(
      'SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema NOT IN (\'pg_catalog\',\'information_schema\') ORDER BY table_name, ordinal_position'
    );

    // Enum values per type (exclude system schemas)
    const enumRes = await this.client!.query(
      'SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid JOIN pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname NOT IN (\'pg_catalog\',\'information_schema\') ORDER BY t.typname, e.enumsortorder'
    );
    const enumMap = new Map<string, string[]>();
    for (const r of enumRes.rows) {
      if (!enumMap.has(r.typname)) enumMap.set(r.typname, []);
      enumMap.get(r.typname)!.push(r.enumlabel);
    }

    for (const r of colsRes.rows) {
      items.push({
        label: r.column_name,
        kind: 'column',
        detail: r.data_type,
        parent: r.table_name,
        enumValues: enumMap.get(r.udt_name),
      });
    }

    return items;
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

function pgTypeToString(oid: number): string {
  const map: Record<number, string> = {
    16: 'boolean', 20: 'bigint', 21: 'smallint', 23: 'integer',
    25: 'text', 700: 'real', 701: 'double precision', 1043: 'varchar',
    1082: 'date', 1114: 'timestamp', 1184: 'timestamptz', 2950: 'uuid',
    3802: 'jsonb', 114: 'json', 1700: 'numeric',
  };
  return map[oid] || `oid:${oid}`;
}
