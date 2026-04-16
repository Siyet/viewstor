/**
 * Unit tests for the shared SQL highlighter. Verifies
 *   - the pure TS `highlightSql` against expected token output, and
 *   - that the `SQL_HIGHLIGHT_SCRIPT` IIFE (consumed by both the Result
 *     Panel and the Diff Panel webviews) produces byte-identical output
 *     to the TS version, so the two cannot drift.
 */
import { describe, it, expect } from 'vitest';
import vm from 'vm';
import { highlightSql, SQL_HIGHLIGHT_SCRIPT } from '../webview/sqlHighlight';

function evalScript(): (text: string) => string {
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(SQL_HIGHLIGHT_SCRIPT, sandbox);
  const ns = sandbox.window.ViewstorSql as { highlightSql: (t: string) => string } | undefined;
  if (!ns || typeof ns.highlightSql !== 'function') {
    throw new Error('SQL_HIGHLIGHT_SCRIPT did not install window.ViewstorSql.highlightSql');
  }
  return ns.highlightSql;
}

describe('highlightSql', () => {
  it('wraps SQL keywords in tk-kw spans', () => {
    const out = highlightSql('SELECT * FROM users');
    expect(out).toContain('<span class="tk-kw">SELECT</span>');
    expect(out).toContain('<span class="tk-kw">FROM</span>');
  });

  it('treats non-keyword identifiers as tk-id', () => {
    const out = highlightSql('myFunc(x)');
    expect(out).toContain('<span class="tk-id">myFunc</span>');
    expect(out).toContain('<span class="tk-id">x</span>');
  });

  it('wraps string literals in tk-str', () => {
    const out = highlightSql('SELECT \'hello\' FROM t');
    expect(out).toContain('<span class="tk-str">&#39;hello&#39;</span>');
  });

  it('wraps numbers in tk-num', () => {
    const out = highlightSql('WHERE id = 42');
    expect(out).toContain('<span class="tk-num">42</span>');
  });

  it('wraps comments in tk-cmt and stops at newline', () => {
    const out = highlightSql('-- this is a comment\nSELECT 1');
    expect(out).toContain('<span class="tk-cmt">-- this is a comment</span>');
    expect(out).toContain('<span class="tk-kw">SELECT</span>');
  });

  it('wraps quoted identifiers in tk-id', () => {
    const out = highlightSql('SELECT "col" FROM "public"."t"');
    expect(out).toContain('<span class="tk-id">&quot;col&quot;</span>');
    expect(out).toContain('<span class="tk-id">&quot;public&quot;</span>');
    expect(out).toContain('<span class="tk-id">&quot;t&quot;</span>');
  });

  it('escapes HTML entities in identifiers and literals', () => {
    const out = highlightSql('SELECT \'<script>alert(1)</script>\' as x');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('is case-insensitive for keywords', () => {
    const out = highlightSql('select From WhErE');
    expect(out).toContain('<span class="tk-kw">select</span>');
    expect(out).toContain('<span class="tk-kw">From</span>');
    expect(out).toContain('<span class="tk-kw">WhErE</span>');
  });

  it('returns empty string for empty input', () => {
    expect(highlightSql('')).toBe('');
  });
});

describe('SQL_HIGHLIGHT_SCRIPT (webview IIFE)', () => {
  const scriptHighlight = evalScript();

  const inputs = [
    'SELECT * FROM users',
    'SELECT \'hello world\' FROM t WHERE id = 42',
    '-- a comment\nSELECT COUNT(*) FROM "public"."t"',
    'UPDATE t SET x = 1 WHERE id IN (1,2,3)',
    'SELECT a, b, c FROM t JOIN u ON t.id = u.tid',
    'SELECT \'it\'\'s fine\' FROM t',
    'CREATE INDEX idx_x ON t (x)',
    '',
    'nonkeyword_identifier(1 + 2)',
    'SELECT \'<b>xss</b>\' AS html FROM t',
  ];

  it.each(inputs)('produces byte-identical output to the pure TS version for: %s', (input) => {
    expect(scriptHighlight(input)).toBe(highlightSql(input));
  });

  it('installs window.ViewstorSql.highlightSql', () => {
    const sandbox: { window: Record<string, unknown> } = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(SQL_HIGHLIGHT_SCRIPT, sandbox);
    const ns = sandbox.window.ViewstorSql as { highlightSql: unknown };
    expect(typeof ns.highlightSql).toBe('function');
  });

  it('does not clobber an existing ViewstorSql namespace', () => {
    const sandbox: { window: Record<string, { marker?: number; highlightSql?: unknown }> } = {
      window: { ViewstorSql: { marker: 123 } },
    };
    vm.createContext(sandbox);
    vm.runInContext(SQL_HIGHLIGHT_SCRIPT, sandbox);
    expect(sandbox.window.ViewstorSql.marker).toBe(123);
    expect(typeof sandbox.window.ViewstorSql.highlightSql).toBe('function');
  });
});
