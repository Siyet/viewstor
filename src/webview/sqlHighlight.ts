/**
 * Shared lightweight SQL syntax highlighter for webviews.
 *
 * - `highlightSql` is the pure TypeScript implementation, used by unit tests
 *   and by any future TS consumer.
 * - `SQL_HIGHLIGHT_SCRIPT` is a JavaScript IIFE source string that installs
 *   the same function at `window.ViewstorSql.highlightSql`. Both the Result
 *   Panel (inlined) and the Diff Panel (inlined) embed this string so the
 *   two panels cannot drift. Parity is enforced by `sqlHighlight.test.ts`.
 */

const SQL_KEYWORDS =
  /\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|AS|ON|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|DISTINCT|BETWEEN|LIKE|ILIKE|EXISTS|CASE|WHEN|THEN|ELSE|END|UNION|ALL|ASC|DESC|WITH|DEFAULT|CASCADE|PRIMARY|KEY|REFERENCES|FOREIGN|CONSTRAINT|RETURNING|EXPLAIN|ANALYZE|COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|TRUE|FALSE|BOOLEAN|INTEGER|TEXT|VARCHAR|NUMERIC|SERIAL|BIGSERIAL|TIMESTAMP|TIMESTAMPTZ|DATE|TIME|INTERVAL|JSONB?|UUID|ARRAY|BIGINT|SMALLINT|REAL|DOUBLE|PRECISION|CHAR|DECIMAL|FLOAT)\b/i;

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function highlightSql(text: string): string {
  const tokens: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let m: RegExpMatchArray | null;
    // String literal
    if ((m = remaining.match(/^'(?:[^'\\]|\\.)*'|^'(?:[^']|'')*'/))) {
      tokens.push('<span class="tk-str">' + escHtml(m[0]) + '</span>');
      remaining = remaining.substring(m[0].length);
      continue;
    }
    // Quoted identifier
    if ((m = remaining.match(/^"[^"]*"/))) {
      tokens.push('<span class="tk-id">' + escHtml(m[0]) + '</span>');
      remaining = remaining.substring(m[0].length);
      continue;
    }
    // Comment
    if ((m = remaining.match(/^--[^\n]*/))) {
      tokens.push('<span class="tk-cmt">' + escHtml(m[0]) + '</span>');
      remaining = remaining.substring(m[0].length);
      continue;
    }
    // Number
    if ((m = remaining.match(/^-?\d+(?:\.\d+)?(?![a-zA-Z_])/))) {
      tokens.push('<span class="tk-num">' + escHtml(m[0]) + '</span>');
      remaining = remaining.substring(m[0].length);
      continue;
    }
    // Word (keyword or identifier)
    if ((m = remaining.match(/^[a-zA-Z_][a-zA-Z0-9_]*/))) {
      const w = m[0];
      tokens.push(
        SQL_KEYWORDS.test(w)
          ? '<span class="tk-kw">' + escHtml(w) + '</span>'
          : '<span class="tk-id">' + escHtml(w) + '</span>',
      );
      remaining = remaining.substring(w.length);
      continue;
    }
    // Operators
    if ((m = remaining.match(/^[<>=!]+|^[;,()*.]/))) {
      tokens.push('<span class="tk-op">' + escHtml(m[0]) + '</span>');
      remaining = remaining.substring(m[0].length);
      continue;
    }
    // Other (whitespace, etc.)
    tokens.push(escHtml(remaining[0]));
    remaining = remaining.substring(1);
  }
  return tokens.join('');
}

/**
 * JavaScript IIFE source that installs `window.ViewstorSql.highlightSql`.
 *
 * Must stay byte-equivalent in behavior to the TS `highlightSql` above.
 * `sqlHighlight.test.ts` eval's this string in a sandbox and compares
 * outputs for a representative input set.
 */
export const SQL_HIGHLIGHT_SCRIPT = `
(function () {
  var SQL_KEYWORDS = /\\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|AS|ON|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|DISTINCT|BETWEEN|LIKE|ILIKE|EXISTS|CASE|WHEN|THEN|ELSE|END|UNION|ALL|ASC|DESC|WITH|DEFAULT|CASCADE|PRIMARY|KEY|REFERENCES|FOREIGN|CONSTRAINT|RETURNING|EXPLAIN|ANALYZE|COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|TRUE|FALSE|BOOLEAN|INTEGER|TEXT|VARCHAR|NUMERIC|SERIAL|BIGSERIAL|TIMESTAMP|TIMESTAMPTZ|DATE|TIME|INTERVAL|JSONB?|UUID|ARRAY|BIGINT|SMALLINT|REAL|DOUBLE|PRECISION|CHAR|DECIMAL|FLOAT)\\b/i;
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function highlightSql(text) {
    var tokens = [];
    var remaining = String(text);
    while (remaining.length > 0) {
      var m;
      if ((m = remaining.match(/^'(?:[^'\\\\]|\\\\.)*'|^'(?:[^']|'')*'/))) {
        tokens.push('<span class="tk-str">' + escHtml(m[0]) + '</span>');
        remaining = remaining.substring(m[0].length);
        continue;
      }
      if ((m = remaining.match(/^"[^"]*"/))) {
        tokens.push('<span class="tk-id">' + escHtml(m[0]) + '</span>');
        remaining = remaining.substring(m[0].length);
        continue;
      }
      if ((m = remaining.match(/^--[^\\n]*/))) {
        tokens.push('<span class="tk-cmt">' + escHtml(m[0]) + '</span>');
        remaining = remaining.substring(m[0].length);
        continue;
      }
      if ((m = remaining.match(/^-?\\d+(?:\\.\\d+)?(?![a-zA-Z_])/))) {
        tokens.push('<span class="tk-num">' + escHtml(m[0]) + '</span>');
        remaining = remaining.substring(m[0].length);
        continue;
      }
      if ((m = remaining.match(/^[a-zA-Z_][a-zA-Z0-9_]*/))) {
        var w = m[0];
        tokens.push(
          SQL_KEYWORDS.test(w)
            ? '<span class="tk-kw">' + escHtml(w) + '</span>'
            : '<span class="tk-id">' + escHtml(w) + '</span>'
        );
        remaining = remaining.substring(w.length);
        continue;
      }
      if ((m = remaining.match(/^[<>=!]+|^[;,()*.]/))) {
        tokens.push('<span class="tk-op">' + escHtml(m[0]) + '</span>');
        remaining = remaining.substring(m[0].length);
        continue;
      }
      tokens.push(escHtml(remaining[0]));
      remaining = remaining.substring(1);
    }
    return tokens.join('');
  }
  var ns = (typeof window !== 'undefined' ? window : globalThis);
  ns.ViewstorSql = ns.ViewstorSql || {};
  ns.ViewstorSql.highlightSql = highlightSql;
})();
`.trim();
