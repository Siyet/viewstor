// Pure functions extracted from resultPanel.ts webview JS for testability.
// The webview still uses its own inline copy; keep logic in sync.

import { quoteIdentifier } from './queryHelpers';

const NUMERIC_TYPE_RE = /^(int|integer|bigint|smallint|serial|bigserial|numeric|decimal|real|float|double|money|oid|Int8|Int16|Int32|Int64|UInt8|UInt16|UInt32|UInt64|Float32|Float64)/i;
const BOOL_TYPES = new Set(['boolean', 'Bool']);

export function isNumericType(dataType: string): boolean {
  return NUMERIC_TYPE_RE.test(dataType) || BOOL_TYPES.has(dataType);
}

/**
 * Format selected cell values as a one-row string.
 * Numeric values are unquoted, strings are quoted, NULL/empty → NULL.
 */
export function formatOneRow(
  rows: string[][],
  columnTypes: string[],
  quote: '\'' | '"',
): string {
  const vals: string[] = [];
  for (const row of rows) {
    for (let index = 0; index < row.length; index++) {
      const value = row[index];
      if (value === '' || value === null || value === undefined) {
        vals.push(quote === '"' ? 'null' : 'NULL');
      } else if (isNumericType(columnTypes[index])) {
        vals.push(value);
      } else {
        const escaped = quote === '"'
          ? value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
          : value.replace(/'/g, '\'\'');
        vals.push(quote + escaped + quote);
      }
    }
  }
  return vals.join(', ');
}

/**
 * Apply ORDER BY to a SQL query, replacing any existing ORDER BY clause.
 * Inserts before LIMIT/OFFSET if present.
 */
/**
 * Find the position of an outermost SQL keyword, skipping parenthesized subqueries and string literals.
 * Returns -1 if not found at the top level.
 */
function findOuterKeyword(sql: string, keyword: RegExp): number {
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const ch = sql[index];
    if (ch === '(') { depth++; index++; continue; }
    if (ch === ')') { depth--; index++; continue; }
    if (ch === '\'') {
      index++;
      while (index < sql.length) {
        if (sql[index] === '\'' && sql[index + 1] === '\'') { index += 2; continue; }
        if (sql[index] === '\'') { index++; break; }
        index++;
      }
      continue;
    }
    if (depth === 0 && keyword.test(sql.substring(index))) {
      return index;
    }
    index++;
  }
  return -1;
}

export function applySortToQuery(
  query: string,
  sorts: { column: string; direction: 'asc' | 'desc' }[],
): string {
  let result = query.replace(/;+\s*$/, '');

  // Remove outermost ORDER BY clause (skip subqueries)
  const orderPos = findOuterKeyword(result, /^\s*ORDER\s+BY\b/i);
  if (orderPos >= 0) {
    // Find where ORDER BY clause ends: at outermost LIMIT, OFFSET, or end
    const afterOrder = result.substring(orderPos);
    const endMatch = afterOrder.match(/\s+ORDER\s+BY\b/i);
    const orderLen = endMatch ? endMatch[0].length : 0;
    const rest = result.substring(orderPos + orderLen);
    // Walk past the ORDER BY columns to find LIMIT/OFFSET at top level
    const limitPos = findOuterKeyword(rest, /^\s*(LIMIT|OFFSET)\b/i);
    if (limitPos >= 0) {
      result = result.substring(0, orderPos) + rest.substring(limitPos);
    } else {
      result = result.substring(0, orderPos);
    }
  }

  if (sorts.length > 0) {
    const orderClause = ' ORDER BY ' + sorts
      .map(s => quoteIdentifier(s.column) + ' ' + s.direction.toUpperCase())
      .join(', ');
    const limitPos = findOuterKeyword(result, /^\s*(LIMIT|OFFSET)\b/i);
    if (limitPos >= 0) {
      result = result.substring(0, limitPos) + orderClause + result.substring(limitPos);
    } else {
      result += orderClause;
    }
  }
  return result;
}

const SQL_KEYWORDS = /\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|AS|ON|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|DISTINCT|BETWEEN|LIKE|ILIKE|EXISTS|CASE|WHEN|THEN|ELSE|END|UNION|ALL|ASC|DESC|WITH|DEFAULT|CASCADE|PRIMARY|KEY|REFERENCES|FOREIGN|CONSTRAINT|RETURNING|EXPLAIN|ANALYZE|COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|TRUE|FALSE|BOOLEAN|INTEGER|TEXT|VARCHAR|NUMERIC|SERIAL|BIGSERIAL|TIMESTAMP|TIMESTAMPTZ|DATE|TIME|INTERVAL|JSONB?|UUID|ARRAY|BIGINT|SMALLINT|REAL|DOUBLE|PRECISION|CHAR|DECIMAL|FLOAT)\b/i;

export interface SqlToken {
  type: 'keyword' | 'string' | 'number' | 'comment' | 'operator' | 'text';
  value: string;
}

/**
 * Tokenize a SQL string into typed tokens for syntax highlighting.
 */
export function tokenizeSql(text: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // String literal (handles SQL '' escaping and backslash escaping)
    const strMatch = remaining.match(/^'(?:[^'\\]|\\.|'{2})*'/);
    if (strMatch) {
      tokens.push({ type: 'string', value: strMatch[0] });
      remaining = remaining.substring(strMatch[0].length);
      continue;
    }
    // Quoted identifier ("table_name")
    const qidMatch = remaining.match(/^"[^"]*"/);
    if (qidMatch) {
      tokens.push({ type: 'text', value: qidMatch[0] });
      remaining = remaining.substring(qidMatch[0].length);
      continue;
    }
    // Comment
    const cmtMatch = remaining.match(/^--[^\n]*/);
    if (cmtMatch) {
      tokens.push({ type: 'comment', value: cmtMatch[0] });
      remaining = remaining.substring(cmtMatch[0].length);
      continue;
    }
    // Number
    const numMatch = remaining.match(/^-?\d+(?:\.\d+)?(?![a-zA-Z_])/);
    if (numMatch) {
      tokens.push({ type: 'number', value: numMatch[0] });
      remaining = remaining.substring(numMatch[0].length);
      continue;
    }
    // Word (keyword or identifier)
    const wordMatch = remaining.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
    if (wordMatch) {
      const word = wordMatch[0];
      if (SQL_KEYWORDS.test(word)) {
        tokens.push({ type: 'keyword', value: word });
      } else {
        tokens.push({ type: 'text', value: word });
      }
      remaining = remaining.substring(word.length);
      continue;
    }
    // Operators
    const opMatch = remaining.match(/^[<>=!]+|^[;,()*.]/);
    if (opMatch) {
      tokens.push({ type: 'operator', value: opMatch[0] });
      remaining = remaining.substring(opMatch[0].length);
      continue;
    }
    // Other (whitespace, etc.)
    tokens.push({ type: 'text', value: remaining[0] });
    remaining = remaining.substring(1);
  }
  return tokens;
}
