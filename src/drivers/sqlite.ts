import type BetterSqlite3 from 'better-sqlite3';
import { DatabaseDriver, CompletionItem } from '../types/driver';
import { ConnectionConfig } from '../types/connection';
import { QueryResult, QueryColumn, SortColumn, MAX_RESULT_ROWS } from '../types/query';
import { SchemaObject, TableInfo, ColumnInfo, TableObjects, TableStatistic, IndexInfo, ConstraintInfo, TriggerInfo } from '../types/schema';
import { quoteIdentifier } from '../utils/queryHelpers';
import { wrapError } from '../utils/errors';

// Lazy-load better-sqlite3 to avoid crashing the entire extension on ABI mismatch.
// Top-level require of this native module runs at bundle load time, which means
// a broken binary (wrong Electron ABI, missing prebuild) prevents activate() from
// ever executing — no commands get registered and all connections "disappear".
function loadSqlite(): typeof BetterSqlite3 {
  return require('better-sqlite3');
}

export class SqliteDriver implements DatabaseDriver {
  private db: BetterSqlite3.Database | undefined;

  async connect(config: ConnectionConfig): Promise<void> {
    const filePath = config.database || ':memory:';
    try {
      const Database = loadSqlite();
      this.db = new Database(filePath, {
        readonly: config.readonly || false,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('NODE_MODULE_VERSION')) {
        throw new Error(
          'SQLite native module was compiled for a different Node.js version. '
          + 'Run: node scripts/sqlite-rebuild.js electron',
        );
      }
      throw err;
    }
    // Enable WAL and foreign keys — skip WAL on readonly (it's a write operation)
    if (!config.readonly) {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('foreign_keys = ON');
  }

  async disconnect(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  async ping(): Promise<boolean> {
    const row = this.db!.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return row?.ok === 1;
  }

  async execute(query: string): Promise<QueryResult> {
    const start = Date.now();
    try {
      const trimmed = query.trim();
      const isSelect = /^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed);

      if (isSelect) {
        const stmt = this.db!.prepare(trimmed);
        const rows = stmt.all() as Record<string, unknown>[];
        const executionTimeMs = Date.now() - start;

        const firstRow = rows.length > 0 ? rows[0] : undefined;
        const columns: QueryColumn[] = stmt.columns().map(col => ({
          name: col.name,
          // For computed columns `col.type` is null. Prefer SQL-expression-based inference
          // (AVG/SUM/TOTAL return REAL even when the sampled value happens to be integer-valued)
          // before falling back to the JS-value heuristic.
          dataType: col.type || inferTypeFromExpression(trimmed, col.name) || inferTypeFromValue(firstRow?.[col.name]),
        }));

        const truncated = rows.length > MAX_RESULT_ROWS;
        return {
          columns,
          rows: truncated ? rows.slice(0, MAX_RESULT_ROWS) : rows,
          rowCount: rows.length,
          executionTimeMs,
          truncated,
        };
      }

      // Non-SELECT: exec for multi-statement DML
      this.db!.exec(trimmed);
      const executionTimeMs = Date.now() - start;
      const changes = this.db!.prepare('SELECT changes() AS cnt').get() as { cnt: number };
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: changes.cnt,
        executionTimeMs,
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
    // Tables
    const tables = this.db!.prepare(
      'SELECT name, sql FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name'
    ).all() as Array<{ name: string; sql: string }>;

    // Views
    const views = this.db!.prepare(
      'SELECT name, sql FROM sqlite_master WHERE type = \'view\' ORDER BY name'
    ).all() as Array<{ name: string; sql: string }>;

    // Indexes
    const indexes = this.db!.prepare(
      'SELECT name, tbl_name FROM sqlite_master WHERE type = \'index\' AND name NOT LIKE \'sqlite_%\' ORDER BY tbl_name, name'
    ).all() as Array<{ name: string; tbl_name: string }>;

    // Triggers
    const triggers = this.db!.prepare(
      'SELECT name, tbl_name FROM sqlite_master WHERE type = \'trigger\' ORDER BY tbl_name, name'
    ).all() as Array<{ name: string; tbl_name: string }>;

    // Build indexes map: table -> SchemaObject[]
    const indexesMap = new Map<string, SchemaObject[]>();
    for (const idx of indexes) {
      if (!indexesMap.has(idx.tbl_name)) indexesMap.set(idx.tbl_name, []);
      indexesMap.get(idx.tbl_name)!.push({ name: idx.name, type: 'index' });
    }

    // Build triggers map: table -> SchemaObject[]
    const triggersMap = new Map<string, SchemaObject[]>();
    for (const trg of triggers) {
      if (!triggersMap.has(trg.tbl_name)) triggersMap.set(trg.tbl_name, []);
      triggersMap.get(trg.tbl_name)!.push({ name: trg.name, type: 'trigger' });
    }

    const result: SchemaObject[] = [];

    for (const table of tables) {
      const columns = this.getColumnsForTable(table.name);
      const children: SchemaObject[] = [...columns];

      const idxs = indexesMap.get(table.name);
      if (idxs && idxs.length > 0) {
        children.push({ name: 'Indexes', type: 'group', children: idxs });
      }

      const trigs = triggersMap.get(table.name);
      if (trigs && trigs.length > 0) {
        children.push({ name: 'Triggers', type: 'group', children: trigs });
      }

      const rowCount = this.getRowCountSync(table.name);
      result.push({
        name: table.name,
        type: 'table',
        children,
        detail: rowCount > 0 ? `${formatRowCount(rowCount)} rows` : undefined,
        inaccessible: columns.length === 0 ? true : undefined,
      });
    }

    for (const view of views) {
      const columns = this.getColumnsForTable(view.name);
      result.push({
        name: view.name,
        type: 'view',
        children: columns,
        inaccessible: columns.length === 0 ? true : undefined,
      });
    }

    return result;
  }

  async getDDL(name: string, type: string): Promise<string> {
    const row = this.db!.prepare(
      'SELECT sql FROM sqlite_master WHERE name = ? AND type = ?'
    ).get(name, type) as { sql: string } | undefined;
    if (row?.sql) return row.sql + ';';
    return `-- DDL not found for ${type} "${name}"`;
  }

  async getTableInfo(name: string): Promise<TableInfo> {
    const pragmaRows = this.db!.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{
      cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
    }>;

    const columns: ColumnInfo[] = pragmaRows.map(row => ({
      name: row.name,
      dataType: row.type || 'TEXT',
      nullable: row.notnull === 0,
      isPrimaryKey: row.pk > 0,
      defaultValue: row.dflt_value ?? undefined,
    }));

    return { name, columns };
  }

  async getEstimatedRowCount(name: string): Promise<number> {
    // SQLite has no statistics table; fall back to exact count
    return this.getRowCountSync(name);
  }

  async getTableRowCount(name: string): Promise<number> {
    return this.getRowCountSync(name);
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

    // Enrich columns with nullable info
    if (!result.error && result.columns.length > 0) {
      const pragmaRows = this.db!.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{
        name: string; notnull: number;
      }>;
      const nullableMap = new Map<string, boolean>();
      for (const row of pragmaRows) {
        nullableMap.set(row.name, row.notnull === 0);
      }
      for (const col of result.columns) {
        col.nullable = nullableMap.get(col.name) ?? true;
      }
    }

    return result;
  }

  async getIndexedColumns(name: string): Promise<Set<string>> {
    const indexes = this.db!.prepare(
      'SELECT name FROM sqlite_master WHERE type = \'index\' AND tbl_name = ? AND name NOT LIKE \'sqlite_%\''
    ).all(name) as Array<{ name: string }>;

    const columns = new Set<string>();
    for (const idx of indexes) {
      const info = this.db!.prepare(`PRAGMA index_info(${quoteIdentifier(idx.name)})`).all() as Array<{ name: string }>;
      for (const col of info) {
        columns.add(col.name);
      }
    }
    return columns;
  }

  async getCompletions(): Promise<CompletionItem[]> {
    const items: CompletionItem[] = [];

    // Tables and views
    const objects = this.db!.prepare(
      'SELECT name, type FROM sqlite_master WHERE type IN (\'table\', \'view\') AND name NOT LIKE \'sqlite_%\' ORDER BY name'
    ).all() as Array<{ name: string; type: string }>;

    for (const obj of objects) {
      items.push({
        label: obj.name,
        kind: obj.type === 'view' ? 'view' : 'table',
      });
    }

    // Columns for each table/view
    for (const obj of objects) {
      const pragmaRows = this.db!.prepare(`PRAGMA table_info(${quoteIdentifier(obj.name)})`).all() as Array<{
        name: string; type: string;
      }>;
      for (const col of pragmaRows) {
        items.push({
          label: col.name,
          kind: 'column',
          detail: col.type || 'TEXT',
          parent: obj.name,
        });
      }
    }

    return items;
  }

  async getTableObjects(name: string): Promise<TableObjects> {
    // Indexes
    const rawIndexes = this.db!.prepare(`PRAGMA index_list(${quoteIdentifier(name)})`).all() as Array<{
      name: string; unique: number; origin: string;
    }>;
    const indexes: IndexInfo[] = [];
    for (const idx of rawIndexes) {
      const cols = this.db!.prepare(`PRAGMA index_info(${quoteIdentifier(idx.name)})`).all() as Array<{ name: string }>;
      indexes.push({
        name: idx.name,
        columns: cols.map(col => col.name),
        unique: idx.unique === 1,
      });
    }

    // Constraints: primary key from table_info
    const constraints: ConstraintInfo[] = [];
    const pragmaRows = this.db!.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{
      name: string; pk: number;
    }>;
    const pkColumns = pragmaRows.filter(row => row.pk > 0).sort((left, right) => left.pk - right.pk);
    if (pkColumns.length > 0) {
      constraints.push({
        name: 'PRIMARY KEY',
        type: 'PRIMARY KEY',
        columns: pkColumns.map(row => row.name),
      });
    }

    // Constraints: unique indexes (from index_list with origin = 'u')
    for (const idx of rawIndexes) {
      if (idx.unique === 1 && idx.origin === 'u') {
        const cols = this.db!.prepare(`PRAGMA index_info(${quoteIdentifier(idx.name)})`).all() as Array<{ name: string }>;
        constraints.push({
          name: idx.name,
          type: 'UNIQUE',
          columns: cols.map(col => col.name),
        });
      }
    }

    // Constraints: foreign keys
    const fks = this.db!.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all() as Array<{
      id: number; table: string; from: string; to: string; on_delete: string; on_update: string;
    }>;
    const fkGroups = new Map<number, typeof fks>();
    for (const fk of fks) {
      if (!fkGroups.has(fk.id)) fkGroups.set(fk.id, []);
      fkGroups.get(fk.id)!.push(fk);
    }
    for (const [fkId, group] of fkGroups) {
      constraints.push({
        name: `fk_${fkId}`,
        type: 'FOREIGN KEY',
        columns: group.map(fk => fk.from),
        referencedTable: group[0].table,
        referencedColumns: group.map(fk => fk.to),
        onDelete: group[0].on_delete !== 'NO ACTION' ? group[0].on_delete : undefined,
        onUpdate: group[0].on_update !== 'NO ACTION' ? group[0].on_update : undefined,
      });
    }

    // Triggers
    const rawTriggers = this.db!.prepare(
      'SELECT name, sql FROM sqlite_master WHERE type = \'trigger\' AND tbl_name = ?'
    ).all(name) as Array<{ name: string; sql: string }>;
    const triggers: TriggerInfo[] = rawTriggers.map(trigger => {
      const match = trigger.sql?.match(
        /CREATE\s+TRIGGER\s+\S+\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE)/i
      );
      return {
        name: trigger.name,
        timing: match ? match[1].toUpperCase() : 'UNKNOWN',
        events: match ? match[2].toUpperCase() : 'UNKNOWN',
        definition: trigger.sql ?? undefined,
      };
    });

    // SQLite has no sequences
    return { indexes, constraints, triggers, sequences: [] };
  }

  async getTableStatistics(name: string): Promise<TableStatistic[]> {
    const rowCount = this.getRowCountSync(name);

    // Count indexes for the table
    const idxCount = this.db!.prepare(
      'SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = ? AND tbl_name = ?'
    ).get('index', name) as { cnt: number };

    const triggerCount = this.db!.prepare(
      'SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = ? AND tbl_name = ?'
    ).get('trigger', name) as { cnt: number };

    // dbstat is an optional virtual table — present when SQLite is built with SQLITE_ENABLE_DBSTAT_VTAB.
    let tableSize: number | null = null;
    let totalSize: number | null = null;
    try {
      const row = this.db!.prepare(
        'SELECT SUM(pgsize) AS sz FROM dbstat WHERE name = ?'
      ).get(name) as { sz: number | null };
      tableSize = row?.sz ?? null;

      // total_size = table pages + all its index pages
      const indexNames = this.db!.prepare(
        'SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ?'
      ).all('index', name) as { name: string }[];
      let indexSize = 0;
      for (const idx of indexNames) {
        const idxRow = this.db!.prepare(
          'SELECT SUM(pgsize) AS sz FROM dbstat WHERE name = ?'
        ).get(idx.name) as { sz: number | null };
        indexSize += idxRow?.sz ?? 0;
      }
      totalSize = (tableSize ?? 0) + indexSize;
    } catch { /* dbstat unavailable */ }

    return [
      { key: 'row_count', label: 'Row count', value: rowCount, unit: 'count' },
      { key: 'total_size', label: 'Total size', value: totalSize, unit: 'bytes' },
      { key: 'table_size', label: 'Table size', value: tableSize, unit: 'bytes' },
      { key: 'index_count', label: 'Index count', value: idxCount.cnt, unit: 'count' },
      { key: 'trigger_count', label: 'Trigger count', value: triggerCount.cnt, unit: 'count' },
      { key: 'last_modified', label: 'Last modified', value: null, unit: 'date' },
    ];
  }

  // --- Private helpers ---

  private getColumnsForTable(tableName: string): SchemaObject[] {
    const pragmaRows = this.db!.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{
      cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
    }>;

    // Build column → index names map for this table
    const idxList = this.db!.prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`).all() as Array<{
      name: string;
    }>;
    const colToIndexes = new Map<string, string[]>();
    for (const idx of idxList) {
      const cols = this.db!.prepare(`PRAGMA index_info(${quoteIdentifier(idx.name)})`).all() as Array<{ name: string }>;
      for (const col of cols) {
        if (!colToIndexes.has(col.name)) colToIndexes.set(col.name, []);
        colToIndexes.get(col.name)!.push(idx.name);
      }
    }

    return pragmaRows.map(row => {
      const badges: string[] = [];
      if (row.pk > 0) badges.push('PK');
      const detail = `${row.type || 'TEXT'}${badges.length ? ' (' + badges.join(', ') + ')' : ''}`;
      const indexNames = colToIndexes.get(row.name);
      const notNullable = row.notnull === 1 && row.pk === 0;
      return {
        name: row.name,
        type: 'column' as const,
        detail,
        indexNames: indexNames && indexNames.length > 0 ? indexNames : undefined,
        notNullable: notNullable || undefined,
      };
    });
  }

  private getRowCountSync(tableName: string): number {
    try {
      const row = this.db!.prepare(`SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(tableName)}`).get() as { cnt: number };
      return row.cnt;
    } catch {
      return 0;
    }
  }
}

/**
 * Infer SQLite column type from the first row's value.
 * SQLite returns null type for computed columns (COUNT, strftime, etc.).
 * Without this, the chart webview can't detect numeric Y-axis columns.
 */
function inferTypeFromValue(value: unknown): string {
  if (value === null || value === undefined) return 'TEXT';
  if (typeof value === 'number') return Number.isInteger(value) ? 'INTEGER' : 'REAL';
  if (typeof value === 'bigint') return 'INTEGER';
  return 'TEXT';
}

/**
 * Infer type from a SQLite SELECT expression for a named output column.
 * AVG / TOTAL / SUM always widen to REAL (per SQLite docs AVG and TOTAL are always REAL;
 * SUM widens whenever any non-NULL operand is REAL — treating it as REAL is the safer default
 * because a whole-number REAL result like 7.0 is indistinguishable from INTEGER 7 in JS).
 */
function inferTypeFromExpression(sql: string, columnName: string): string | undefined {
  const escaped = columnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(AVG|TOTAL|SUM)\\s*\\([^()]*\\)\\s+AS\\s+(?:"|\`|\\[)?${escaped}(?:"|\`|\\])?`,
    'i',
  );
  return re.test(sql) ? 'REAL' : undefined;
}

function formatRowCount(count: number): string {
  if (count >= 1_000_000_000) return `~${(count / 1_000_000_000).toFixed(1)}b`;
  if (count >= 1_000_000) return `~${(count / 1_000_000).toFixed(1)}m`;
  if (count >= 1_000) return `~${(count / 1_000).toFixed(0)}k`;
  return String(count);
}
