import { DatabaseDriver } from '../types/driver';

const READ_VERB_RE = /^\s*(SELECT|WITH|EXPLAIN|SHOW|VALUES|TABLE|DESCRIBE|DESC)\b/i;
// Verbs that mutate state — anywhere they appear (CTE body, EXPLAIN target, etc.) the statement is NOT read-only.
const WRITE_VERB_RE = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|MERGE|COPY|REPLACE|VACUUM|REFRESH|REINDEX|CALL|LOCK|NOTIFY|LISTEN|UNLISTEN|RESET|COMMIT|ROLLBACK|SAVEPOINT|INTO)\b/i;
// Known PostgreSQL functions that mutate sequences, sessions, files, or server state
// despite appearing inside an otherwise ordinary SELECT. Also conservatively reject
// Unicode-escaped quoted function identifiers (`U&"..."`, optionally with UESCAPE).
// Native readonly remains the second line of defense; this is not a SQL sandbox.
const SIDE_EFFECT_FUNCTION_RE = /(?:\b(?:nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_create_restore_point|pg_switch_wal|pg_switch_xlog|pg_start_backup|pg_stop_backup|pg_promote|pg_wal_replay_pause|pg_wal_replay_resume|pg_drop_replication_slot|pg_create_physical_replication_slot|pg_create_logical_replication_slot|pg_replication_slot_advance|pg_advisory_lock|pg_advisory_lock_shared|pg_notify|lo_import|lo_export|dblink(?:_[a-z0-9_]+)?)\s*\(|\bU&(?:\s+UESCAPE\s+)?\s*\()/i;
// PG: EXPLAIN ANALYZE actually executes the inner statement. ANALYZE may sit inside a parenthesized option list.
const EXPLAIN_ANALYZE_RE = /^\s*EXPLAIN\s+(?:\([^)]*\bANALYZE\b[^)]*\)|ANALYZE\b)/i;

/** Return the next code character after whitespace and comments. */
function nextSqlCodeIndex(sql: string, start: number): number {
  let i = start;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) { i++; continue; }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      if (end === -1) return sql.length;
      i = end + 1;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return sql.length;
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Build both masked forms in one input pass, preserving offsets. The function-scan form
 * reveals a quoted identifier only in function-call position, closing quoted side-effect
 * calls without exposing write verbs in ordinary identifiers such as `"delete_log"`.
 */
function maskLiteralsAndComments(sql: string): { masked: string; functionScan: string; hasAmbiguousEscape: boolean } {
  let masked = '';
  let functionScan = '';
  let hasAmbiguousEscape = false;
  const appendSpaces = (count: number) => {
    const spaces = ' '.repeat(count);
    masked += spaces;
    functionScan += spaces;
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    // Single-line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      appendSpaces(stop - i);
      i = stop;
      continue;
    }
    // Block comment
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      appendSpaces(stop - i);
      i = stop;
      continue;
    }
    // PostgreSQL escape string: backslash escapes the next character, including a quote.
    // Detect the prefix only outside an identifier so ordinary aliases are unaffected.
    if ((ch === 'E' || ch === 'e') && sql[i + 1] === '\'' && (i === 0 || !/[A-Za-z0-9_$]/.test(sql[i - 1]))) {
      let j = i + 2;
      while (j < sql.length) {
        if (sql[j] === '\\') { j = Math.min(j + 2, sql.length); continue; }
        if (sql[j] === '\'' && sql[j + 1] === '\'') { j += 2; continue; }
        if (sql[j] === '\'') { j++; break; }
        j++;
      }
      appendSpaces(j - i);
      i = j;
      continue;
    }
    // Single-quoted string literal (with '' escaping). With PostgreSQL's legacy
    // standard_conforming_strings=off, \' also escapes a quote. Reject that ambiguous
    // form instead of letting the server and this scanner disagree about boundaries.
    if (ch === '\'') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\' && sql[j + 1] === '\'') hasAmbiguousEscape = true;
        if (sql[j] === '\'' && sql[j + 1] === '\'') { j += 2; continue; }
        if (sql[j] === '\'') { j++; break; }
        j++;
      }
      appendSpaces(j - i);
      i = j;
      continue;
    }
    // Double-quoted identifier — reveal only a closed name immediately followed by `(`.
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
        if (sql[j] === '"') { j++; closed = true; break; }
        j++;
      }
      const functionCall = closed && sql[nextSqlCodeIndex(sql, j)] === '(';
      masked += ' '.repeat(j - i);
      functionScan += functionCall ? ` ${sql.slice(i + 1, j - 1)} ` : ' '.repeat(j - i);
      i = j;
      continue;
    }
    // Backtick-quoted identifier (MySQL-style)
    if (ch === '`') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== '`') j++;
      if (j < sql.length) j++;
      appendSpaces(j - i);
      i = j;
      continue;
    }
    // Dollar-quoted string (PostgreSQL): $tag$ ... $tag$. A delimiter directly
    // following an identifier character is part of that identifier, not a string.
    // Tags follow unquoted identifier rules and may contain digits after the first char.
    if (ch === '$' && (i === 0 || !/[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[i - 1]))) {
      let tagEnd = i + 1;
      const firstTagChar = sql[tagEnd];
      if (firstTagChar !== '$' && /[A-Za-z_]/.test(firstTagChar ?? '')) {
        tagEnd++;
        while (tagEnd < sql.length && /[A-Za-z0-9_]/.test(sql[tagEnd])) tagEnd++;
      }
      if (sql[tagEnd] === '$' && (tagEnd === i + 1 || /[A-Za-z_]/.test(firstTagChar ?? ''))) {
        const tag = sql.slice(i, tagEnd + 1);
        const endIdx = sql.indexOf(tag, tagEnd + 1);
        if (endIdx !== -1) {
          const stop = endIdx + tag.length;
          appendSpaces(stop - i);
          i = stop;
          continue;
        }
      }
    }
    masked += ch;
    functionScan += ch;
    i++;
  }
  return { masked, functionScan, hasAmbiguousEscape };
}

/**
 * True only when EVERY semicolon-separated statement is purely read-only.
 *
 * Rejects bypasses the simple "first verb is SELECT/WITH/EXPLAIN" check missed:
 *   - `WITH x AS (SELECT 1) INSERT INTO t VALUES (1)` (CTE chain ending in DML)
 *   - `EXPLAIN ANALYZE UPDATE t SET ...` (PG executes the inner statement)
 *   - `SELECT 1; DROP TABLE t` (multi-statement chain)
 *
 * String literals, double-quoted identifiers, dollar-quoted blocks, and comments
 * are masked first so identifiers like `"delete_log"` or `'INSERT'` don't trip the
 * write-verb regex. Only the side-effect function scan uses the second masked form.
 */
export function isReadOnlyQuery(sql: string): boolean {
  const { masked, functionScan, hasAmbiguousEscape } = maskLiteralsAndComments(sql);
  if (hasAmbiguousEscape) return false;
  // Split on ; outside of (already masked) strings/comments
  const parts = masked.split(';').map(p => p.trim()).filter(p => p.length > 0);
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (!READ_VERB_RE.test(part)) return false;
    if (EXPLAIN_ANALYZE_RE.test(part)) return false;
    if (WRITE_VERB_RE.test(part)) return false;
  }
  return !SIDE_EFFECT_FUNCTION_RE.test(masked) && !SIDE_EFFECT_FUNCTION_RE.test(functionScan);
}

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Strip a trailing `LIMIT N [OFFSET M]` from a SQL statement.
 * Returns the base query (without the tail), the user's explicit LIMIT, and
 * the user's explicit OFFSET (if either is present). Only the last LIMIT
 * clause is touched — a LIMIT inside a subquery stays intact.
 *
 * The query must already be trimmed and `;` stripped. When the user supplied
 * an explicit OFFSET, callers should NOT auto-paginate (we can't safely
 * combine their starting point with our page offset).
 */
export function splitCustomQueryLimit(sql: string): {
  baseQuery: string;
  userLimit: number | undefined;
  userOffset: number | undefined;
} {
  const match = sql.match(/\s+LIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?\s*$/i);
  if (!match) return { baseQuery: sql, userLimit: undefined, userOffset: undefined };
  return {
    baseQuery: sql.slice(0, match.index),
    userLimit: parseInt(match[1], 10),
    userOffset: match[2] !== undefined ? parseInt(match[2], 10) : undefined,
  };
}

/** Parse table names from a SQL query (FROM / JOIN clauses) */
export function parseTablesFromQuery(sql: string): Array<{ table: string; schema?: string }> {
  const tables: Array<{ table: string; schema?: string }> = [];
  const re = /(?:FROM|JOIN)\s+"?(\w+)"?\s*\.\s*"?(\w+)"?|(?:FROM|JOIN)\s+"?(\w+)"?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m[1] && m[2]) tables.push({ schema: m[1], table: m[2] });
    else if (m[3]) tables.push({ table: m[3] });
  }
  return tables;
}

// SQL reserved words that require quoting when used as identifiers
const SQL_RESERVED = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null', 'as', 'on',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'order', 'by',
  'group', 'having', 'limit', 'offset', 'insert', 'into', 'values', 'update',
  'set', 'delete', 'create', 'alter', 'drop', 'table', 'index', 'view',
  'distinct', 'between', 'like', 'ilike', 'exists', 'case', 'when', 'then',
  'else', 'end', 'union', 'all', 'asc', 'desc', 'with', 'default', 'cascade',
  'primary', 'key', 'references', 'foreign', 'constraint', 'returning',
  'explain', 'analyze', 'true', 'false', 'boolean', 'integer', 'text', 'varchar',
  'numeric', 'serial', 'bigserial', 'timestamp', 'timestamptz', 'date', 'time',
  'interval', 'json', 'jsonb', 'uuid', 'array', 'bigint', 'smallint', 'real',
  'double', 'precision', 'char', 'decimal', 'float', 'check', 'unique',
  'grant', 'revoke', 'role', 'user', 'type', 'enum', 'schema', 'database',
  'sequence', 'trigger', 'function', 'procedure', 'begin', 'commit', 'rollback',
  'abort', 'do', 'for', 'if', 'loop', 'return', 'raise', 'exception',
]);

/** Quote an identifier only if it needs quoting (reserved word, special chars, or uppercase) */
export function quoteIdentifier(name: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name) && !SQL_RESERVED.has(name)) {
    return name;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a table name with optional schema */
export function quoteTable(tableName: string, schema?: string): string {
  return schema ? `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}` : quoteIdentifier(tableName);
}

/** Escape a value for SQL: NULL → NULL, otherwise single-quoted with escaped quotes */
const NUMERIC_TYPES = new Set([
  'integer', 'int', 'int2', 'int4', 'int8', 'bigint', 'smallint',
  'serial', 'bigserial', 'smallserial',
  'numeric', 'decimal', 'real', 'float', 'float4', 'float8', 'double precision',
  'money', 'oid',
]);

const JSON_TYPES = new Set(['json', 'jsonb']);

/** Convert a JS array to PostgreSQL array literal: {1,2,"has spaces"} */
function pgArrayLiteral(arr: unknown[]): string {
  const inner = arr.map(v => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return pgArrayLiteral(v);
    if (typeof v === 'object') return JSON.stringify(v);
    const s = String(v);
    if (s === '' || /[,"{}\s]/.test(s)) return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    return s;
  }).join(',');
  return '{' + inner + '}';
}

/** Escape a value for SQL, respecting column type */
export function sqlValue(val: unknown, dataType?: string): string {
  if (val === null || val === undefined) return 'NULL';
  // PostgreSQL arrays: dataType starts with _ (e.g. _text, _int4) or contains []
  if (Array.isArray(val)) {
    const str = pgArrayLiteral(val);
    return `'${str.replace(/'/g, '\'\'')}'`;
  }
  if (typeof val === 'object') {
    const str = JSON.stringify(val);
    return `'${str.replace(/'/g, '\'\'')}'`;
  }
  // Numeric types: no quotes if the value is actually a number
  if (dataType && NUMERIC_TYPES.has(dataType.toLowerCase())) {
    const num = Number(val);
    if (!isNaN(num)) return String(num);
  }
  // Boolean
  if (dataType && (dataType === 'boolean' || dataType === 'bool')) {
    return val === true || val === 'true' ? 'TRUE' : 'FALSE';
  }
  const str = String(val);
  return `'${str.replace(/'/g, '\'\'')}'`;
}

export interface RowEdit {
  changes: Record<string, unknown>;
  columnTypes?: Record<string, string>;
  pkValues: Record<string, unknown>;
  pkTypes?: Record<string, string>;
}

/** Build UPDATE statement from edit object */
export function buildUpdateSql(
  tableName: string,
  schema: string | undefined,
  pkColumns: string[],
  edit: RowEdit,
): string {
  const setClauses = Object.entries(edit.changes)
    .map(([col, val]) => {
      const colType = edit.columnTypes?.[col];
      const cast = colType && JSON_TYPES.has(colType) ? `::${colType}` : '';
      return `${quoteIdentifier(col)} = ${sqlValue(val, colType)}${cast}`;
    })
    .join(', ');
  const whereClauses = pkColumns
    .map(pk => `${quoteIdentifier(pk)} = ${sqlValue(edit.pkValues[pk], edit.pkTypes?.[pk])}`)
    .join(' AND ');
  return `UPDATE ${quoteTable(tableName, schema)} SET ${setClauses} WHERE ${whereClauses}`;
}

/** Build DELETE statement from PK values */
export function buildDeleteSql(
  tableName: string,
  schema: string | undefined,
  pkColumns: string[],
  pkValues: Record<string, unknown>,
  pkTypes?: Record<string, string>,
): string {
  const whereClauses = pkColumns
    .map(pk => `${quoteIdentifier(pk)} = ${sqlValue(pkValues[pk], pkTypes?.[pk])}`)
    .join(' AND ');
  return `DELETE FROM ${quoteTable(tableName, schema)} WHERE ${whereClauses}`;
}

/** Build INSERT with DEFAULT values */
export function buildInsertDefaultSql(
  tableName: string,
  schema: string | undefined,
  columnNames: string[],
): string {
  return `INSERT INTO ${quoteTable(tableName, schema)} (${columnNames.map(c => quoteIdentifier(c)).join(', ')}) VALUES (${columnNames.map(() => 'DEFAULT').join(', ')}) RETURNING *`;
}

/** Build INSERT with explicit values (for inline row editing). __DEFAULT__ → DEFAULT keyword. */
export function buildInsertRowSql(
  tableName: string,
  schema: string | undefined,
  values: Record<string, unknown>,
  columnTypes: Record<string, string>,
): string {
  const colNames = Object.keys(values);
  const sqlValues = colNames.map(col => {
    const val = values[col];
    if (val === '__DEFAULT__') return 'DEFAULT';
    return sqlValue(val, columnTypes[col]);
  });
  return `INSERT INTO ${quoteTable(tableName, schema)} (${colNames.map(c => quoteIdentifier(c)).join(', ')}) VALUES (${sqlValues.join(', ')}) RETURNING *`;
}

export interface StatementRange {
  /** SQL text of the statement (trimmed) */
  text: string;
  /** Start offset in the original string */
  start: number;
  /** End offset in the original string (exclusive) */
  end: number;
}

/**
 * Split SQL text into individual statements, respecting string literals and comments.
 * Returns ranges so callers can map back to line numbers.
 */
export function splitStatements(sql: string): StatementRange[] {
  const statements: StatementRange[] = [];
  let current = '';
  let stmtStart = 0;
  let index = 0;

  while (index < sql.length) {
    const ch = sql[index];

    // Single-line comment
    if (ch === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      if (end === -1) { index = sql.length; }
      else { current += sql.substring(index, end + 1); index = end + 1; }
      continue;
    }
    // Block comment
    if (ch === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) { index = sql.length; }
      else { current += sql.substring(index, end + 2); index = end + 2; }
      continue;
    }
    // String literal (single-quoted, with '' escaping)
    if (ch === '\'') {
      let j = index + 1;
      while (j < sql.length) {
        if (sql[j] === '\'' && sql[j + 1] === '\'') { j += 2; continue; }
        if (sql[j] === '\'') { j++; break; }
        j++;
      }
      current += sql.substring(index, j);
      index = j;
      continue;
    }
    // Dollar-quoted string (PostgreSQL)
    if (ch === '$') {
      const tagMatch = sql.substring(index).match(/^\$([a-zA-Z_]*)\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const endIdx = sql.indexOf(tag, index + tag.length);
        if (endIdx !== -1) {
          current += sql.substring(index, endIdx + tag.length);
          index = endIdx + tag.length;
          continue;
        }
      }
    }
    // Statement separator
    if (ch === ';') {
      current += ';';
      const trimmed = current.trim();
      if (trimmed.length > 0 && trimmed !== ';') {
        statements.push({ text: trimmed, start: stmtStart, end: index + 1 });
      }
      current = '';
      stmtStart = index + 1;
      index++;
      continue;
    }
    current += ch;
    index++;
  }

  // Last statement (no trailing semicolon)
  const trimmed = current.trim();
  if (trimmed.length > 0) {
    statements.push({ text: trimmed, start: stmtStart, end: sql.length });
  }

  return statements;
}

/**
 * Get the SQL statement at the given cursor offset.
 * Returns the statement whose range contains the offset, or the nearest one.
 */
export function getStatementAtOffset(sql: string, offset: number): StatementRange | undefined {
  const statements = splitStatements(sql);
  if (statements.length === 0) return undefined;
  if (statements.length === 1) return statements[0];

  // Find statement containing the offset
  for (const stmt of statements) {
    if (offset >= stmt.start && offset <= stmt.end) return stmt;
  }

  // If offset is between statements (in whitespace), pick the nearest
  let closest = statements[0];
  let minDist = Infinity;
  for (const stmt of statements) {
    const dist = offset < stmt.start ? stmt.start - offset : offset - stmt.end;
    if (dist < minDist) {
      minDist = dist;
      closest = stmt;
    }
  }
  return closest;
}

/**
 * Find the offset of the first non-comment, non-whitespace character in a SQL string.
 * Skips leading whitespace, single-line comments (--), and block comments.
 */
export function firstSqlTokenOffset(sql: string): number {
  let pos = 0;
  while (pos < sql.length) {
    // Skip whitespace
    if (/\s/.test(sql[pos])) { pos++; continue; }
    // Skip single-line comment
    if (sql[pos] === '-' && sql[pos + 1] === '-') {
      const end = sql.indexOf('\n', pos);
      if (end === -1) return sql.length;
      pos = end + 1;
      continue;
    }
    // Skip block comment
    if (sql[pos] === '/' && sql[pos + 1] === '*') {
      const end = sql.indexOf('*/', pos + 2);
      if (end === -1) return sql.length;
      pos = end + 2;
      continue;
    }
    break;
  }
  return pos;
}

/** Enhance "column X does not exist" errors with "Did you mean: Y?" */
export async function enhanceColumnError(
  error: string,
  query: string,
  driver: DatabaseDriver,
): Promise<string> {
  const colMatch = error.match(/column "(\w+)" does not exist/i)
    || error.match(/Unknown column '(\w+)'/i);
  if (!colMatch) return error;

  const badColumn = colMatch[1].toLowerCase();
  const tables = parseTablesFromQuery(query);
  if (tables.length === 0) return error;

  const allColumns: string[] = [];
  for (const t of tables) {
    try {
      const info = await driver.getTableInfo(t.table, t.schema);
      allColumns.push(...info.columns.map(c => c.name));
    } catch { /* skip */ }
  }
  if (allColumns.length === 0) return error;

  let bestMatch = '';
  let bestDist = Infinity;
  for (const col of allColumns) {
    const dist = levenshtein(badColumn, col.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = col;
    }
  }

  if (bestDist > 0 && bestDist <= 3) {
    return `${error}\n\nDid you mean: "${bestMatch}"?`;
  }
  return error;
}
