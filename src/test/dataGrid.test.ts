import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

/**
 * Unit tests for the shared data-grid interaction module (#94).
 *
 * Like context-menu.test.ts, the IIFE is loaded via Node's `vm` module.
 * Tests cover pure formatting functions (copyAsText, buildCopyMenuItems)
 * and the cellKey/parseKey helpers.
 */

const SCRIPT_PATH = path.join(__dirname, '..', 'webview', 'scripts', 'data-grid.js');

interface DataGridApi {
  cellKey(r: number, c: number): string;
  parseKey(key: string): { row: number; col: number };
  copyAsText(
    headers: string[],
    rows: string[][],
    format: string,
    opts?: { isNumericValue?: (v: string) => boolean },
  ): string;
  buildCopyMenuItems(
    onCopy: (format: string) => void,
    extra?: Array<{ label?: string; onClick?: () => void; separator?: boolean }>,
  ): Array<{ label?: string; onClick?: () => void; separator?: boolean }>;
  createSelectionManager(opts: Record<string, unknown>): Record<string, unknown>;
}

function loadModule(): DataGridApi {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf-8');
  const exports: Record<string, unknown> = {};
  const sandbox = { module: { exports }, window: undefined as unknown };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.module.exports as DataGridApi;
}

describe('data-grid module', () => {
  const api = loadModule();

  describe('cellKey / parseKey', () => {
    it('round-trips row:col', () => {
      expect(api.cellKey(3, 7)).toBe('3:7');
      expect(api.parseKey('3:7')).toEqual({ row: 3, col: 7 });
    });

    it('handles zero indices', () => {
      expect(api.cellKey(0, 0)).toBe('0:0');
      expect(api.parseKey('0:0')).toEqual({ row: 0, col: 0 });
    });
  });

  describe('copyAsText', () => {
    const headers = ['name', 'age', 'city'];
    const rows = [
      ['Alice', '30', 'NYC'],
      ['Bob', '25', 'LA'],
    ];

    it('formats TSV', () => {
      const result = api.copyAsText(headers, rows, 'tsv');
      expect(result).toBe('Alice\t30\tNYC\nBob\t25\tLA');
    });

    it('formats TSV with header', () => {
      const result = api.copyAsText(headers, rows, 'tsv-header');
      expect(result).toBe('name\tage\tcity\nAlice\t30\tNYC\nBob\t25\tLA');
    });

    it('formats CSV with escaping', () => {
      const h = ['name', 'bio'];
      const r = [['Alice', 'likes "quotes"'], ['Bob', 'a,b']];
      const result = api.copyAsText(h, r, 'csv');
      expect(result).toBe('name,bio\nAlice,"likes ""quotes"""\nBob,"a,b"');
    });

    it('formats one-row SQL (single quotes)', () => {
      const result = api.copyAsText(headers, [['Alice', '30', 'NYC']], 'onerow-sq');
      expect(result).toBe('\'Alice\', 30, \'NYC\'');
    });

    it('formats one-row JSON (double quotes)', () => {
      const result = api.copyAsText(headers, [['Alice', '30', 'NYC']], 'onerow-dq');
      expect(result).toBe('"Alice", 30, "NYC"');
    });

    it('one-row treats NULL/empty as NULL', () => {
      const result = api.copyAsText(['a', 'b'], [['', 'NULL']], 'onerow-sq');
      expect(result).toBe('NULL, NULL');
    });

    it('one-row escapes quotes in values', () => {
      const result = api.copyAsText(['a'], [['it\'s']], 'onerow-sq');
      expect(result).toBe('\'it\'\'s\'');
    });

    it('formats Markdown table', () => {
      const result = api.copyAsText(['id', 'name'], [['1', 'Alice']], 'md');
      const lines = result.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('| id');
      expect(lines[0]).toContain('| name');
      expect(lines[1]).toMatch(/^\|[-| ]+\|$/);
      expect(lines[2]).toContain('| 1');
      expect(lines[2]).toContain('| Alice');
    });

    it('pads Markdown columns to minimum 3 chars', () => {
      const result = api.copyAsText(['a'], [['b']], 'md');
      expect(result).toContain('| a  ');
      expect(result).toContain('|-----');
    });

    it('formats JSON', () => {
      const result = api.copyAsText(['id'], [['1'], ['2']], 'json');
      const parsed = JSON.parse(result);
      expect(parsed).toEqual([{ id: '1' }, { id: '2' }]);
    });

    it('JSON uses fallback column names for empty headers', () => {
      const result = api.copyAsText(['', 'b'], [['x', 'y']], 'json');
      const parsed = JSON.parse(result);
      expect(parsed[0]).toHaveProperty('col0', 'x');
      expect(parsed[0]).toHaveProperty('b', 'y');
    });

    it('returns empty string for unknown format', () => {
      expect(api.copyAsText(['a'], [['b']], 'unknown')).toBe('');
    });

    it('uses custom isNumericValue for onerow', () => {
      const result = api.copyAsText(
        ['val'],
        [['abc']],
        'onerow-sq',
        { isNumericValue: () => true },
      );
      expect(result).toBe('abc');
    });
  });

  describe('buildCopyMenuItems', () => {
    it('returns 7 standard copy items', () => {
      const items = api.buildCopyMenuItems(() => {});
      expect(items).toHaveLength(7);
      expect(items[0].label).toBe('Copy');
      expect(items[6].label).toBe('Copy as JSON');
    });

    it('calls onCopy with the correct format', () => {
      const formats: string[] = [];
      const items = api.buildCopyMenuItems((fmt) => formats.push(fmt));
      items.forEach((item) => {
        if (item.onClick) item.onClick();
      });
      expect(formats).toEqual([
        'tsv', 'onerow-sq', 'onerow-dq', 'csv', 'tsv-header', 'md', 'json',
      ]);
    });

    it('appends extra items with separator', () => {
      const items = api.buildCopyMenuItems(() => {}, [
        { label: 'Delete', onClick: () => {} },
      ]);
      expect(items).toHaveLength(9);
      expect(items[7]).toHaveProperty('separator', true);
      expect(items[8].label).toBe('Delete');
    });

    it('skips separator when extra is empty', () => {
      const items = api.buildCopyMenuItems(() => {}, []);
      expect(items).toHaveLength(7);
    });
  });
});
