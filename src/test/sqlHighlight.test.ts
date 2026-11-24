import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const SCRIPT_PATH = path.join(__dirname, '..', 'webview', 'scripts', 'sql-highlight.js');

interface SqlHighlightApi {
  highlightSql(value: unknown): string;
}

function load(): { browserApi: SqlHighlightApi; commonJsApi: SqlHighlightApi; source: string } {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const sandbox = {
    window: {} as { ViewstorSql?: SqlHighlightApi },
    module: { exports: {} as SqlHighlightApi },
    globalThis: {},
    Set,
    Object,
    String,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  if (!sandbox.window.ViewstorSql) throw new Error('sql-highlight.js did not install window.ViewstorSql');
  return { browserApi: sandbox.window.ViewstorSql, commonJsApi: sandbox.module.exports, source };
}

function decodeRenderedText(html: string): string {
  return html
    .replace(/<span class="tk-(?:kw|str|num|cmt|op|id)">/g, '')
    .replace(/<\/span>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

describe('shared SQL highlighter module', () => {
  it('exports the same API to browser and CommonJS consumers', () => {
    const { browserApi, commonJsApi } = load();
    expect(typeof browserApi.highlightSql).toBe('function');
    expect(commonJsApi.highlightSql).toBe(browserApi.highlightSql);
    expect(Object.isFrozen(commonJsApi)).toBe(true);
  });

  it('preserves an existing namespace while installing the canonical API', () => {
    const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const sandbox = {
      window: { ViewstorSql: { marker: 42 } as Record<string, unknown> },
      module: { exports: {} },
      globalThis: {},
      Set,
      Object,
      String,
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    expect(sandbox.window.ViewstorSql.marker).toBe(42);
    expect(typeof sandbox.window.ViewstorSql.highlightSql).toBe('function');
  });
});

describe('highlightSql token classes', () => {
  const { browserApi: api } = load();

  it('highlights keywords, identifiers, operators, numbers, strings and comments', () => {
    const html = api.highlightSql('SELECT customer_id FROM orders WHERE amount >= -3.14e2 AND note = \'ok\' -- filter');
    expect(html).toContain('<span class="tk-kw">SELECT</span>');
    expect(html).toContain('<span class="tk-id">customer_id</span>');
    expect(html).toContain('<span class="tk-op">&gt;=</span>');
    expect(html).toContain('<span class="tk-num">-3.14e2</span>');
    expect(html).toContain('<span class="tk-str">&#39;ok&#39;</span>');
    expect(html).toContain('<span class="tk-cmt">-- filter</span>');
  });

  it('treats keywords case-insensitively without misclassifying longer identifiers', () => {
    const html = api.highlightSql('select From WhErE selector from_value');
    expect(html).toContain('<span class="tk-kw">select</span>');
    expect(html).toContain('<span class="tk-kw">From</span>');
    expect(html).toContain('<span class="tk-kw">WhErE</span>');
    expect(html).toContain('<span class="tk-id">selector</span>');
    expect(html).toContain('<span class="tk-id">from_value</span>');
  });

  it('keeps identifiers and search strings from different Unicode scripts visible', () => {
    const cases = [
      ['SELECT имя FROM клиенты WHERE имя ILIKE \'%Иван%\'', ['имя', 'клиенты']],
      ['SELECT 名称 FROM 客户 WHERE 名称 = \'東京\'', ['名称', '客户']],
      ['SELECT الاسم FROM العملاء WHERE الاسم = \'محمد\'', ['الاسم', 'العملاء']],
      ['SELECT नाम FROM ग्राहक WHERE नाम = \'अमित\'', ['नाम', 'ग्राहक']],
      ['SELECT 𐐀name FROM 𐐀table WHERE 𐐀name = \'value\'', ['𐐀name', '𐐀table']],
    ] as const;
    for (const [sql, identifiers] of cases) {
      const html = api.highlightSql(sql);
      for (const identifier of identifiers) {
        expect(html).toContain(`<span class="tk-id">${identifier}</span>`);
      }
      expect(decodeRenderedText(html)).toBe(sql);
    }
  });

  it('keeps doubled quotes and escaped quoted identifiers in one token', () => {
    expect(api.highlightSql('\'it\'\'s fine\''))
      .toBe('<span class="tk-str">&#39;it&#39;&#39;s fine&#39;</span>');
    expect(api.highlightSql('"a""b"'))
      .toBe('<span class="tk-id">&quot;a&quot;&quot;b&quot;</span>');
  });

  it('supports block comments, dollar strings and dialect-specific identifiers', () => {
    const sql = '/* block\r\ncomment */ SELECT $$a < b$$, $tag$x > y$tag$, `my``col`, [my]]col]';
    const html = api.highlightSql(sql);
    expect(html).toContain('<span class="tk-cmt">/* block\r\ncomment */</span>');
    expect(html).toContain('<span class="tk-str">$$a &lt; b$$</span>');
    expect(html).toContain('<span class="tk-str">$tag$x &gt; y$tag$</span>');
    expect(html).toContain('<span class="tk-id">`my``col`</span>');
    expect(html).toContain('<span class="tk-id">[my]]col]</span>');
  });

  it('consumes an unterminated dollar string to EOF without rescanning later tags', () => {
    const sql = Array.from({ length: 10_000 }, (_, i) => `$tag${i}$ value`).join(' ');
    const html = api.highlightSql(sql);
    expect(sql.length).toBeGreaterThan(100_000);
    expect(html).toBe(`<span class="tk-str">${sql}</span>`);
    expect(decodeRenderedText(html)).toBe(sql);
  });

  it('handles empty, null and unterminated input safely', () => {
    expect(api.highlightSql('')).toBe('');
    expect(api.highlightSql(null)).toBe('');
    expect(api.highlightSql('SELECT \'<img onerror=alert(1)>'))
      .toContain('<span class="tk-str">&#39;&lt;img onerror=alert(1)&gt;</span>');
  });
});

describe('highlightSql output safety and fidelity', () => {
  const { browserApi: api } = load();
  const corpus = [
    'SELECT \'& < > \\" \' </script> <!--\' AS payload',
    'SELECT \'<img src=x onerror=alert(1)>\'',
    '-- </script><script>alert(1)</script>\r\nSELECT 1',
    '/* <svg onload=alert(1)> */ SELECT "<column>" FROM t',
    'SELECT \'it\'\'s fine\', E\'back\\\\slash\', $$<b>literal</b>$$',
    'SELECT имя, emoji_😀 FROM таблица',
    'SELECT "😀", \'café é 東京 مرحبا नमस्ते 🚀\' -- 🔎 поиск',
  ];

  it.each(corpus)('emits only allow-listed span tags and preserves source text: %s', (sql) => {
    const html = api.highlightSql(sql);
    const tags = html.match(/<[^>]+>/g) || [];
    expect(tags.every(tag => /^<span class="tk-(?:kw|str|num|cmt|op|id)">$|^<\/span>$/.test(tag))).toBe(true);
    expect(decodeRenderedText(html)).toBe(sql);
  });

  it('processes a large SQL editor value without losing text', () => {
    const sql = Array.from({ length: 6000 }, (_, i) => `SELECT ${i} AS n -- row ${i}\n`).join('');
    const html = api.highlightSql(sql);
    expect(sql.length).toBeGreaterThan(100_000);
    expect(decodeRenderedText(html)).toBe(sql);
  });
});

describe('Result and Diff consumer contracts', () => {
  it('contains no legacy tokenizer implementation in either consumer', () => {
    const resultSource = fs.readFileSync(path.join(__dirname, '..', 'views', 'resultPanel.ts'), 'utf8');
    const diffSource = fs.readFileSync(path.join(__dirname, '..', 'webview', 'scripts', 'diff-panel.js'), 'utf8');
    expect(resultSource).not.toContain('SQL_KEYWORDS');
    expect(diffSource).not.toContain('SQL_KW');
    expect(resultSource).not.toMatch(/function\s+highlightSql\s*\(/);
    expect(diffSource).not.toMatch(/function\s+highlightSql\s*\(/);
    expect(resultSource).toContain('window.ViewstorSql.highlightSql');
    expect(diffSource).toContain('window.ViewstorSql.highlightSql');
  });

  it('loads the shared asset before the Diff Panel consumer', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'diff', 'diffPanel.ts'), 'utf8');
    const shared = source.indexOf('<script src="${sqlHighlightJsUri}"></script>');
    const consumer = source.indexOf('<script src="${jsUri}"></script>');
    expect(shared).toBeGreaterThan(-1);
    expect(consumer).toBeGreaterThan(shared);
  });
});
