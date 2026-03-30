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
