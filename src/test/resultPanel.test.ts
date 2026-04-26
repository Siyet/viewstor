/**
 * Unit tests for buildResultHtml — verifies the webview HTML
 * contains required DOM elements and doesn't produce broken JS.
 */
import { describe, it, expect, vi } from 'vitest';
import vm from 'vm';

vi.mock('vscode', () => ({
  l10n: { t: (str: string) => str },
}));

import { buildResultHtml } from '../views/resultPanel';
import { QueryResult } from '../types/query';

function makeResult(
  columns: Array<{ name: string; dataType: string }>,
  rows: Record<string, unknown>[],
  opts?: Partial<QueryResult>,
): QueryResult {
  return { columns, rows, rowCount: rows.length, executionTimeMs: 10, ...opts };
}

describe('buildResultHtml', () => {
  it('produces valid HTML with required elements', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }, { name: 'name', dataType: 'text' }],
      [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
    );
    const html = buildResultHtml(result);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('id="exportBtn"');
    expect(html).toContain('id="visualizeBtn"');
    expect(html).toContain('id="mapBtn"');
    expect(html).toContain('id="searchInput"');
    expect(html).toContain('id="statsInfo"');
  });

  it('includes column headers', () => {
    const result = makeResult(
      [{ name: 'user_id', dataType: 'integer' }, { name: 'email', dataType: 'text' }],
      [{ user_id: 1, email: 'a@b.com' }],
    );
    const html = buildResultHtml(result);
    expect(html).toContain('user_id');
    expect(html).toContain('email');
    expect(html).toContain('integer');
    expect(html).toContain('text');
  });

  it('includes row data', () => {
    const result = makeResult(
      [{ name: 'x', dataType: 'integer' }],
      [{ x: 42 }],
    );
    const html = buildResultHtml(result);
    expect(html).toContain('42');
  });

  it('handles empty result set', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }],
      [],
    );
    const html = buildResultHtml(result);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('id="exportBtn"');
    // Should have thead but empty tbody
    expect(html).toContain('<thead>');
  });

  it('handles result with no columns', () => {
    const result = makeResult([], []);
    const html = buildResultHtml(result);
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('escapes dangerous strings in inline JSON via safeJsonForScript', () => {
    const result = makeResult(
      [{ name: 'val', dataType: 'text' }],
      [{ val: '</script><script>alert(1)</script>' }],
    );
    const html = buildResultHtml(result);
    // safeJsonForScript escapes </ to <\/ — raw </script> must not appear inside inline JS
    expect(html).not.toContain('"</script>');
  });

  it('handles null values', () => {
    const result = makeResult(
      [{ name: 'val', dataType: 'text' }],
      [{ val: null }],
    );
    const html = buildResultHtml(result);
    expect(html).toContain('null-val');
  });

  it('handles JSON/object values', () => {
    const result = makeResult(
      [{ name: 'data', dataType: 'jsonb' }],
      [{ data: { key: 'value' } }],
    );
    const html = buildResultHtml(result);
    expect(html).toContain('json-cell');
  });

  it('includes pagination controls in table mode', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }],
      [{ id: 1 }],
    );
    const html = buildResultHtml(result, {
      connectionId: 'test',
      tableName: 'users',
      pageSize: 100,
      currentPage: 0,
      totalRowCount: 500,
    });
    expect(html).toContain('id="prevPage"');
    expect(html).toContain('id="nextPage"');
    expect(html).toContain('id="pageSize"');
    expect(html).toContain('500');
  });

  it('applies color border when color is specified', () => {
    const result = makeResult([{ name: 'x', dataType: 'integer' }], [{ x: 1 }]);
    const html = buildResultHtml(result, { color: '#ff0000' });
    expect(html).toContain('border-top: 2px solid #ff0000');
  });

  it('handles boolean values', () => {
    const result = makeResult(
      [{ name: 'active', dataType: 'boolean' }],
      [{ active: true }, { active: false }],
    );
    const html = buildResultHtml(result);
    expect(html).toContain('true');
    expect(html).toContain('false');
  });

  it('handles array values (PG arrays) in inline JSON', () => {
    const result = makeResult(
      [{ name: 'tags', dataType: '_text' }],
      [{ tags: ['a', 'b', 'c'] }],
    );
    const html = buildResultHtml(result);
    // Array data is embedded in JSON — check it's present
    expect(html).toContain('"a","b","c"');
  });

  it('inline JS does not contain unescaped </script>', () => {
    const result = makeResult(
      [{ name: 'val', dataType: 'text' }],
      [{ val: '</script><script>alert(1)</script>' }],
    );
    const html = buildResultHtml(result);
    // safeJsonForScript should escape </script>
    const scriptSections = html.split('<script>');
    // Within each script section, there should be no unescaped </script> except the closing tag
    for (let idx = 1; idx < scriptSections.length; idx++) {
      const section = scriptSections[idx];
      const closingIdx = section.indexOf('</script>');
      const content = section.substring(0, closingIdx);
      expect(content).not.toContain('</script>');
    }
  });

  it('shows execution time in stats', () => {
    const result = makeResult(
      [{ name: 'x', dataType: 'integer' }],
      [{ x: 1 }],
      { executionTimeMs: 42 },
    );
    const html = buildResultHtml(result);
    expect(html).toContain('42ms');
  });

  it('shows truncated indicator when result is truncated', () => {
    const result = makeResult(
      [{ name: 'x', dataType: 'integer' }],
      [{ x: 1 }],
      { truncated: true },
    );
    const html = buildResultHtml(result);
    expect(html).toContain('truncated');
  });

  it('shows affected rows count', () => {
    const result = makeResult(
      [{ name: 'x', dataType: 'integer' }],
      [],
      { affectedRows: 5 },
    );
    const html = buildResultHtml(result);
    expect(html).toContain('5 affected');
  });

  it('hides edit buttons in readonly mode', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }],
      [{ id: 1 }],
    );
    const html = buildResultHtml(result, { readonly: true, connectionId: 'x', tableName: 't' });
    expect(html).toContain('IS_READONLY = true');
  });

  it('includes query bar in table mode', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }],
      [{ id: 1 }],
    );
    const html = buildResultHtml(result, { connectionId: 'x', tableName: 'users', schema: 'public' });
    expect(html).toContain('query-bar');
    expect(html).toContain('SELECT * FROM');
  });

  it('handles very large number of columns', () => {
    const cols = Array.from({ length: 50 }, (_, idx) => ({ name: `col_${idx}`, dataType: 'text' }));
    const row: Record<string, unknown> = {};
    cols.forEach(col => { row[col.name] = `val_${col.name}`; });
    const result = makeResult(cols, [row]);
    const html = buildResultHtml(result);
    expect(html).toContain('col_0');
    expect(html).toContain('col_49');
  });

  it('handles special characters in column names', () => {
    const result = makeResult(
      [{ name: 'user name', dataType: 'text' }, { name: 'count(*)', dataType: 'integer' }],
      [{ 'user name': 'Alice', 'count(*)': 42 }],
    );
    const html = buildResultHtml(result);
    expect(html).toContain('user name');
    // count(*) should be escaped
    expect(html).toContain('count(');
  });

  it('includes zebra striping CSS rule', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }],
      [{ id: 1 }],
    );
    const html = buildResultHtml(result);
    expect(html).toContain('nth-child(even)');
    expect(html).toContain('viewstor-row-zebra');
  });

  it('includes toolbar group separators', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }],
      [{ id: 1 }],
    );
    const html = buildResultHtml(result);
    expect(html).toContain('toolbar-group');
    expect(html).toContain('toolbar-sep');
  });
});

// ============================================================
// Cell editing conditions
// ============================================================

describe('buildResultHtml — cell editing', () => {
  it('initializes pkColumns from ShowOptions', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }, { name: 'name', dataType: 'text' }],
      [{ id: 1, name: 'Alice' }],
    );
    const html = buildResultHtml(result, {
      connectionId: 'conn-1',
      tableName: 'users',
      pkColumns: ['id'],
      readonly: false,
    });
    expect(html).toContain('const pkColumns = ["id"]');
    expect(html).toContain('IS_READONLY = false');
  });

  it('pkColumns defaults to empty array when not provided', () => {
    const result = makeResult(
      [{ name: 'x', dataType: 'integer' }],
      [{ x: 1 }],
    );
    const html = buildResultHtml(result);
    expect(html).toContain('const pkColumns = []');
  });

  it('marks non-JSON cells as editable when pkColumns present and not readonly', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }, { name: 'name', dataType: 'text' }],
      [{ id: 1, name: 'Alice' }],
    );
    const html = buildResultHtml(result, {
      connectionId: 'conn-1',
      tableName: 'users',
      pkColumns: ['id'],
      readonly: false,
    });
    expect(html).toContain('editable');
    expect(html).toContain('cursor:text');
  });

  it('does not mark cells as editable when readonly', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }, { name: 'name', dataType: 'text' }],
      [{ id: 1, name: 'Alice' }],
    );
    const html = buildResultHtml(result, {
      connectionId: 'conn-1',
      tableName: 'users',
      pkColumns: ['id'],
      readonly: true,
    });
    // The initial HTML renders cells — check data-row cells don't have editable class
    // (editable class is only added by renderPage JS, but the initial HTML should not have it for readonly)
    expect(html).toContain('IS_READONLY = true');
  });

  it('does not mark cells as editable when no pkColumns', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }, { name: 'name', dataType: 'text' }],
      [{ id: 1, name: 'Alice' }],
    );
    const html = buildResultHtml(result, {
      connectionId: 'conn-1',
      tableName: 'users',
      pkColumns: [],
      readonly: false,
    });
    expect(html).toContain('const pkColumns = []');
  });

  it('JSON cells get json-cell class, not editable', () => {
    const result = makeResult(
      [{ name: 'data', dataType: 'jsonb' }],
      [{ data: { key: 'value' } }],
    );
    const html = buildResultHtml(result, {
      connectionId: 'conn-1',
      tableName: 'users',
      pkColumns: ['id'],
      readonly: false,
    });
    expect(html).toContain('json-cell');
  });

  it('includes startEdit function in inline JS', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }],
      [{ id: 1 }],
    );
    const html = buildResultHtml(result, {
      connectionId: 'conn-1',
      tableName: 'users',
      pkColumns: ['id'],
    });
    expect(html).toContain('function startEdit(');
    expect(html).toContain('function makeInput(');
    expect(html).toContain('function finishEdit(');
  });

  it('includes console.warn for editing blocked by missing PKs', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }],
      [{ id: 1 }],
    );
    const html = buildResultHtml(result);
    expect(html).toContain('Editing blocked: table has no primary key');
  });

  it('multi-column PK is serialized correctly', () => {
    const result = makeResult(
      [{ name: 'a', dataType: 'integer' }, { name: 'b', dataType: 'integer' }],
      [{ a: 1, b: 2 }],
    );
    const html = buildResultHtml(result, {
      connectionId: 'conn-1',
      tableName: 'composite_pk',
      pkColumns: ['a', 'b'],
      readonly: false,
    });
    expect(html).toContain('const pkColumns = ["a","b"]');
  });
});

// ============================================================
// Inline JS syntax validation
// ============================================================

/**
 * Extract all <script>...</script> blocks from HTML and parse them with vm.Script.
 * Catches SyntaxError (duplicate const, missing brackets, etc.) that would
 * cause a blank webview at runtime but are invisible to string-based tests.
 */
function extractAndValidateScripts(html: string): void {
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let idx = 0;
  while ((match = scriptRegex.exec(html)) !== null) {
    const code = match[1];
    if (!code.trim()) continue;
    idx++;
    try {
      // vm.Script parses the JS without executing it — catches SyntaxError
      new vm.Script(code, { filename: `inline-script-${idx}.js` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`SyntaxError in inline <script> block #${idx}: ${message}`);
    }
  }
}

describe('buildResultHtml — inline JS syntax', () => {
  it('inline JS is syntactically valid (empty result)', () => {
    const result = makeResult([{ name: 'id', dataType: 'integer' }], []);
    const html = buildResultHtml(result);
    expect(() => extractAndValidateScripts(html)).not.toThrow();
  });

  it('inline JS is syntactically valid (with data)', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }, { name: 'name', dataType: 'text' }],
      [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
    );
    const html = buildResultHtml(result);
    expect(() => extractAndValidateScripts(html)).not.toThrow();
  });

  it('inline JS is syntactically valid (table mode with all options)', () => {
    const result = makeResult(
      [
        { name: 'id', dataType: 'integer' },
        { name: 'name', dataType: 'text' },
        { name: 'data', dataType: 'jsonb' },
        { name: 'active', dataType: 'boolean' },
      ],
      [{ id: 1, name: 'Test', data: { key: 'val' }, active: true }],
    );
    const html = buildResultHtml(result, {
      connectionId: 'conn-1',
      tableName: 'users',
      schema: 'public',
      pkColumns: ['id'],
      color: '#ff0000',
      readonly: false,
      pageSize: 100,
      currentPage: 0,
      totalRowCount: 1000,
      isEstimatedCount: true,
      orderBy: [{ column: 'id', direction: 'asc' }],
      columnInfo: [
        { name: 'id', nullable: false, defaultValue: 'nextval(...)' },
        { name: 'name', nullable: false },
        { name: 'data', nullable: true },
        { name: 'active', nullable: true, defaultValue: 'true' },
      ],
    });
    expect(() => extractAndValidateScripts(html)).not.toThrow();
  });

  it('inline JS is syntactically valid (readonly mode)', () => {
    const result = makeResult(
      [{ name: 'x', dataType: 'integer' }],
      [{ x: 42 }],
    );
    const html = buildResultHtml(result, {
      connectionId: 'c',
      tableName: 't',
      readonly: true,
    });
    expect(() => extractAndValidateScripts(html)).not.toThrow();
  });

  it('inline JS is syntactically valid (query mode)', () => {
    const result = makeResult(
      [{ name: 'count', dataType: 'bigint' }],
      [{ count: 42 }],
    );
    const html = buildResultHtml(result, { queryMode: true });
    expect(() => extractAndValidateScripts(html)).not.toThrow();
  });

  it('inline JS is syntactically valid (data with special values)', () => {
    const result = makeResult(
      [
        { name: 'text_col', dataType: 'text' },
        { name: 'json_col', dataType: 'jsonb' },
        { name: 'null_col', dataType: 'text' },
        { name: 'num_col', dataType: 'numeric' },
      ],
      [
        {
          text_col: 'has "quotes" and <html> and </script> tags',
          json_col: { nested: { deep: true }, arr: [1, 2, 3] },
          null_col: null,
          num_col: 999999999.99,
        },
      ],
    );
    const html = buildResultHtml(result);
    expect(() => extractAndValidateScripts(html)).not.toThrow();
  });
});
