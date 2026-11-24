(function (root, factory) {
  const api = factory();
  root.ViewstorSql = Object.assign(root.ViewstorSql || {}, api);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const KEYWORDS = new Set([
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'AS', 'ON',
    'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'ORDER', 'BY',
    'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT', 'INTO', 'VALUES', 'UPDATE',
    'SET', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TABLE', 'INDEX', 'VIEW', 'DISTINCT',
    'BETWEEN', 'LIKE', 'ILIKE', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'UNION', 'ALL', 'ASC', 'DESC', 'WITH', 'DEFAULT', 'CASCADE', 'PRIMARY', 'KEY',
    'REFERENCES', 'FOREIGN', 'CONSTRAINT', 'RETURNING', 'EXPLAIN', 'ANALYZE',
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST', 'TRUE',
    'FALSE', 'BOOLEAN', 'INTEGER', 'TEXT', 'VARCHAR', 'NUMERIC', 'SERIAL',
    'BIGSERIAL', 'TIMESTAMP', 'TIMESTAMPTZ', 'DATE', 'TIME', 'INTERVAL', 'JSON',
    'JSONB', 'UUID', 'ARRAY', 'BIGINT', 'SMALLINT', 'REAL', 'DOUBLE', 'PRECISION',
    'CHAR', 'DECIMAL', 'FLOAT', 'MERGE', 'USING', 'MATCHED', 'WINDOW', 'OVER',
    'PARTITION', 'FILTER', 'LATERAL', 'MATERIALIZED', 'RECURSIVE', 'CONFLICT',
    'DO', 'NOTHING', 'REPLACE', 'TRUNCATE', 'GRANT', 'REVOKE', 'SHOW', 'DESCRIBE',
  ]);

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function span(kind, value) {
    return '<span class="tk-' + kind + '">' + escapeHtml(value) + '</span>';
  }

  const DOLLAR_DELIMITER = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
  const SINGLE_STRING = /'(?:''|\\[\s\S]|[^'\\])*(?:'|$)/y;
  const ANSI_IDENTIFIER = /"(?:""|[^"])*(?:"|$)/y;
  const MYSQL_IDENTIFIER = /`(?:``|[^`])*(?:`|$)/y;
  const MSSQL_IDENTIFIER = /\[(?:\]\]|[^\]])*(?:\]|$)/y;
  const LINE_COMMENT = /--[^\r\n]*/y;
  const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/y;
  const NUMBER = /-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?![A-Za-z0-9_$])/y;
  // SQL identifiers may use letters from any Unicode script. Combining marks,
  // decimal/letter numbers and connector punctuation are accepted after the
  // first code point; everything else still renders in the overlay's base color.
  const WORD = /[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{M}\p{Nd}\p{Pc}$]*/uy;
  const OPERATOR = /(?:::|->>|->|#>>|#>|<=>|<#>|<->|<\+>|<=|>=|<>|!=|:=|\|\||&&|[<>=!~+\/%^|&-]+|[;,()*.])/y;

  function matchAt(pattern, source, position) {
    pattern.lastIndex = position;
    return pattern.exec(source);
  }

  function highlightSql(value) {
    const source = String(value == null ? '' : value);
    const output = [];
    let position = 0;

    while (position < source.length) {
      let match;

      // PostgreSQL dollar-quoted strings, including tagged forms such as
      // $body$...$body$. Find the exact closing delimiter once instead of
      // repeatedly scanning the remaining source for unmatched unique tags.
      match = matchAt(DOLLAR_DELIMITER, source, position);
      if (match) {
        const delimiter = match[0];
        const closing = source.indexOf(delimiter, position + delimiter.length);
        const end = closing < 0 ? source.length : closing + delimiter.length;
        output.push(span('str', source.slice(position, end)));
        position = end;
        continue;
      }

      // SQL strings: doubled quotes and backslash escapes; an unterminated string is
      // consumed to EOF so HTML-like payloads never fall back to raw markup.
      match = matchAt(SINGLE_STRING, source, position);
      if (match) {
        output.push(span('str', match[0]));
        position += match[0].length;
        continue;
      }

      // ANSI, MySQL and SQL Server quoted identifiers.
      match = matchAt(ANSI_IDENTIFIER, source, position)
        || matchAt(MYSQL_IDENTIFIER, source, position)
        || matchAt(MSSQL_IDENTIFIER, source, position);
      if (match) {
        output.push(span('id', match[0]));
        position += match[0].length;
        continue;
      }

      match = matchAt(LINE_COMMENT, source, position) || matchAt(BLOCK_COMMENT, source, position);
      if (match) {
        output.push(span('cmt', match[0]));
        position += match[0].length;
        continue;
      }

      match = matchAt(NUMBER, source, position);
      if (match) {
        output.push(span('num', match[0]));
        position += match[0].length;
        continue;
      }

      match = matchAt(WORD, source, position);
      if (match) {
        output.push(span(KEYWORDS.has(match[0].toUpperCase()) ? 'kw' : 'id', match[0]));
        position += match[0].length;
        continue;
      }

      match = matchAt(OPERATOR, source, position);
      if (match) {
        output.push(span('op', match[0]));
        position += match[0].length;
        continue;
      }

      output.push(escapeHtml(source[position]));
      position++;
    }

    return output.join('');
  }

  return Object.freeze({ highlightSql });
});
