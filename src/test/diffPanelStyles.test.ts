import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression guards for the diff panel CSS (#87).
 *
 * These tests read the source CSS directly so they run in plain vitest without
 * needing a webpack build or the Extension Host. The `openDiffPanel` suite in
 * `src/test/vscode/extension.vscode.test.ts` covers the rendered HTML end-to-end.
 */

const CSS_PATH = path.join(__dirname, '..', 'webview', 'styles', 'diff-panel.css');

function readCss(): string {
  return fs.readFileSync(CSS_PATH, 'utf-8');
}

describe('diff-panel.css regressions', () => {
  it('hides inactive <vscode-tab-panel> via the [hidden] attribute', () => {
    // Without this rule our `display: flex` on vscode-tab-panel overrode the
    // native hidden default and all three tabs rendered stacked at once.
    const css = readCss();
    expect(css).toMatch(/vscode-tab-panel\[hidden\]\s*\{\s*display\s*:\s*none\s*;?\s*\}/);
  });

  it('applies zebra striping to row diff tables via --viewstor-row-zebra', () => {
    const css = readCss();
    expect(css).toMatch(/\.diff-table\s+tbody\s+tr:nth-child\(even\)\s+td\s*\{[^}]*--viewstor-row-zebra/);
  });

  it('applies zebra striping to schema / objects / Other stats tables', () => {
    const css = readCss();
    expect(css).toMatch(/\.diff-schema-table\s+tbody\s+tr:nth-child\(even\)\s+td\s*\{[^}]*--viewstor-row-zebra/);
  });

  it('status tints (added/removed/changed) override zebra striping', () => {
    // Status rows must declare their tint with the nth-child(even) selector too,
    // otherwise the zebra rule beats them on even rows.
    const css = readCss();
    expect(css).toMatch(/\.diff-table[^{]*\.diff-added:nth-child\(even\)\s+td\s*\{[^}]*--viewstor-row-added/);
    expect(css).toMatch(/\.diff-table[^{]*\.diff-removed:nth-child\(even\)\s+td\s*\{[^}]*--viewstor-row-removed/);
    expect(css).toMatch(/\.diff-table[^{]*\.diff-changed:nth-child\(even\)\s+td\s*\{[^}]*--viewstor-row-changed/);
  });
});

describe('diff-panel.ts filter chip defaults', () => {
  // The compiled TS source is plain text — we can assert on the generated HTML
  // template literal to make sure defaults don't silently drift back to
  // "hide unchanged / same by default".
  const TS_PATH = path.join(__dirname, '..', 'diff', 'diffPanel.ts');

  function readTs(): string {
    return fs.readFileSync(TS_PATH, 'utf-8');
  }

  it('all row-diff chips are active by default', () => {
    const ts = readTs();
    for (const key of ['unchanged', 'changed', 'added', 'removed']) {
      const re = new RegExp(`diff-chip ${key} active"[^>]*\\s+data-filter="${key}"[^>]*aria-pressed="true"`);
      expect(ts, `${key} chip must default to active`).toMatch(re);
    }
  });

  it('schema + stats chips are active by default (both differs and same)', () => {
    const ts = readTs();
    // `differs active` appears in both schema and stats panels; `same active` also.
    expect((ts.match(/diff-chip differs active/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((ts.match(/diff-chip same active/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('diff-panel.js filter defaults', () => {
  const JS_PATH = path.join(__dirname, '..', 'webview', 'scripts', 'diff-panel.js');

  it('activeFilters initializer enables every category', () => {
    const js = fs.readFileSync(JS_PATH, 'utf-8');
    // Find the activeFilters literal and make sure every value is `true`.
    const match = js.match(/const activeFilters = \{\s*rows:\s*\{([^}]*)\},\s*schema:\s*\{([^}]*)\},\s*stats:\s*\{([^}]*)\}/);
    expect(match, 'activeFilters literal not found in diff-panel.js').toBeTruthy();
    for (const group of match!.slice(1, 4)) {
      expect(group).not.toMatch(/:\s*false/);
    }
  });
});
