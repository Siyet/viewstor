import { DatabaseDriver } from '../types/driver';

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

/** Quote a table name with optional schema */
export function quoteTable(tableName: string, schema?: string): string {
  return schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
}

/** Escape a value for SQL: NULL → NULL, otherwise single-quoted with escaped quotes */
const NUMERIC_TYPES = new Set([
  'integer', 'int', 'int2', 'int4', 'int8', 'bigint', 'smallint',
  'serial', 'bigserial', 'smallserial',
  'numeric', 'decimal', 'real', 'float', 'float4', 'float8', 'double precision',
  'money', 'oid',
]);

const JSON_TYPES = new Set(['json', 'jsonb']);

/** Escape a value for SQL, respecting column type */
export function sqlValue(val: unknown, dataType?: string): string {
  if (val === null || val === undefined) return 'NULL';
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

/** Build UPDATE statement from edit object */
export function buildUpdateSql(
  tableName: string,
  schema: string | undefined,
  pkColumns: string[],
  edit: { changes: Record<string, unknown>; columnTypes?: Record<string, string>; pkValues: Record<string, unknown>; pkTypes?: Record<string, string> },
): string {
  const setClauses = Object.entries(edit.changes)
    .map(([col, val]) => {
      const colType = edit.columnTypes?.[col];
      const cast = colType && JSON_TYPES.has(colType) ? `::${colType}` : '';
      return `"${col}" = ${sqlValue(val, colType)}${cast}`;
    })
    .join(', ');
  const whereClauses = pkColumns
    .map(pk => `"${pk}" = ${sqlValue(edit.pkValues[pk], edit.pkTypes?.[pk])}`)
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
    .map(pk => `"${pk}" = ${sqlValue(pkValues[pk], pkTypes?.[pk])}`)
    .join(' AND ');
  return `DELETE FROM ${quoteTable(tableName, schema)} WHERE ${whereClauses}`;
}

/** Build INSERT with DEFAULT values */
export function buildInsertDefaultSql(
  tableName: string,
  schema: string | undefined,
  columnNames: string[],
): string {
  return `INSERT INTO ${quoteTable(tableName, schema)} (${columnNames.map(c => `"${c}"`).join(', ')}) VALUES (${columnNames.map(() => 'DEFAULT').join(', ')}) RETURNING *`;
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
