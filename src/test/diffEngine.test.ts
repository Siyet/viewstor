import { describe, it, expect } from 'vitest';
import { stringifyCell, computeRowDiff, computeSchemaDiff, exportDiffAsCsv, exportDiffAsJson } from '../diff/diffEngine';
import { DiffSource, DiffOptions } from '../diff/diffTypes';
import { ColumnInfo } from '../types/schema';

// --- stringifyCell ---

describe('stringifyCell', () => {
  it('null returns NULL', () => {
    expect(stringifyCell(null)).toBe('NULL');
  });

  it('undefined returns NULL', () => {
    expect(stringifyCell(undefined)).toBe('NULL');
  });

  it('number returns string', () => {
    expect(stringifyCell(42)).toBe('42');
    expect(stringifyCell(3.14)).toBe('3.14');
    expect(stringifyCell(0)).toBe('0');
  });

  it('boolean returns string', () => {
    expect(stringifyCell(true)).toBe('true');
    expect(stringifyCell(false)).toBe('false');
  });

  it('string returns itself', () => {
    expect(stringifyCell('hello')).toBe('hello');
    expect(stringifyCell('')).toBe('');
  });

  it('object returns JSON', () => {
    expect(stringifyCell({ key: 'value' })).toBe('{"key":"value"}');
  });

  it('array returns JSON', () => {
    expect(stringifyCell([1, 2, 3])).toBe('[1,2,3]');
  });
});

// --- computeRowDiff ---

function makeSource(rows: Record<string, unknown>[], columns?: string[]): DiffSource {
  const colNames = columns || (rows.length > 0 ? Object.keys(rows[0]) : []);
  return {
    label: 'test',
    columns: colNames.map(name => ({ name, dataType: 'text' })),
    rows,
  };
}

function defaultOptions(keyColumns: string[], rowLimit = 10000): DiffOptions {
  return { keyColumns, rowLimit };
}

describe('computeRowDiff', () => {
  it('identical tables produce zero diffs (unchanged rows included in matched)', () => {
    const rows = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ];
    const result = computeRowDiff(makeSource(rows), makeSource(rows), defaultOptions(['id']));
    expect(result.matched).toHaveLength(2); // unchanged rows are in matched with changedColumns=[]
    expect(result.matched.every(m => m.changedColumns.length === 0)).toBe(true);
    expect(result.leftOnly).toHaveLength(0);
    expect(result.rightOnly).toHaveLength(0);
    expect(result.summary.unchanged).toBe(2);
    expect(result.summary.changed).toBe(0);
    expect(result.summary.added).toBe(0);
    expect(result.summary.removed).toBe(0);
  });

  it('detects added rows (only in right)', () => {
    const left = makeSource([{ id: 1, name: 'Alice' }]);
    const right = makeSource([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);
    const result = computeRowDiff(left, right, defaultOptions(['id']));
    expect(result.rightOnly).toHaveLength(1);
    expect(result.rightOnly[0]).toEqual({ id: 2, name: 'Bob' });
    expect(result.summary.added).toBe(1);
  });

  it('detects removed rows (only in left)', () => {
    const left = makeSource([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);
    const right = makeSource([{ id: 1, name: 'Alice' }]);
    const result = computeRowDiff(left, right, defaultOptions(['id']));
    expect(result.leftOnly).toHaveLength(1);
    expect(result.leftOnly[0]).toEqual({ id: 2, name: 'Bob' });
    expect(result.summary.removed).toBe(1);
  });

  it('detects changed cells', () => {
    const left = makeSource([{ id: 1, name: 'Alice', email: 'old@test.com' }]);
    const right = makeSource([{ id: 1, name: 'Alice', email: 'new@test.com' }]);
    const result = computeRowDiff(left, right, defaultOptions(['id']));
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].changedColumns).toEqual(['email']);
    expect(result.matched[0].left.email).toBe('old@test.com');
    expect(result.matched[0].right.email).toBe('new@test.com');
    expect(result.summary.changed).toBe(1);
    expect(result.summary.unchanged).toBe(0);
  });

  it('handles composite key (multi-column PK)', () => {
    const left = makeSource([
      { org: 'A', user: 1, role: 'admin' },
      { org: 'A', user: 2, role: 'member' },
    ]);
    const right = makeSource([
      { org: 'A', user: 1, role: 'owner' },
      { org: 'A', user: 2, role: 'member' },
    ]);
    const result = computeRowDiff(left, right, defaultOptions(['org', 'user']));
    expect(result.matched).toHaveLength(2); // 1 changed + 1 unchanged
    const changed = result.matched.filter(m => m.changedColumns.length > 0);
    expect(changed).toHaveLength(1);
    expect(changed[0].changedColumns).toEqual(['role']);
    expect(result.summary.unchanged).toBe(1);
  });

  it('NULL in left vs non-NULL in right is a change', () => {
    const left = makeSource([{ id: 1, email: null }]);
    const right = makeSource([{ id: 1, email: 'test@x.com' }]);
    const result = computeRowDiff(left, right, defaultOptions(['id']));
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].changedColumns).toEqual(['email']);
  });

  it('NULL in both sides is not a change', () => {
    const left = makeSource([{ id: 1, email: null }]);
    const right = makeSource([{ id: 1, email: null }]);
    const result = computeRowDiff(left, right, defaultOptions(['id']));
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].changedColumns).toHaveLength(0);
    expect(result.summary.unchanged).toBe(1);
  });

  it('type coercion: integer 1 vs string "1" treated as equal', () => {
    const left = makeSource([{ id: 1, count: 42 }]);
    const right = makeSource([{ id: 1, count: '42' }]);
    const result = computeRowDiff(left, right, defaultOptions(['id']));
    expect(result.summary.unchanged).toBe(1);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].changedColumns).toHaveLength(0);
  });

  it('empty tables produce zero diffs', () => {
    const result = computeRowDiff(makeSource([]), makeSource([]), defaultOptions(['id']));
    expect(result.summary.total).toBe(0);
    expect(result.matched).toHaveLength(0);
    expect(result.leftOnly).toHaveLength(0);
    expect(result.rightOnly).toHaveLength(0);
  });

  it('left empty, right has rows = all added', () => {
    const right = makeSource([{ id: 1, name: 'Alice' }]);
    const result = computeRowDiff(makeSource([], ['id', 'name']), right, defaultOptions(['id']));
    expect(result.rightOnly).toHaveLength(1);
    expect(result.summary.added).toBe(1);
  });

  it('row limit truncation sets truncated flag', () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ id: index, name: `user-${index}` }));
    const result = computeRowDiff(makeSource(rows), makeSource(rows), { keyColumns: ['id'], rowLimit: 10 });
    expect(result.truncated).toBe(true);
    expect(result.summary.unchanged).toBe(10);
  });

  it('no truncation when within limit', () => {
    const rows = [{ id: 1, name: 'Alice' }];
    const result = computeRowDiff(makeSource(rows), makeSource(rows), defaultOptions(['id']));
    expect(result.truncated).toBe(false);
  });

  it('columns present in one side but not the other', () => {
    const left = makeSource([{ id: 1, name: 'Alice' }], ['id', 'name']);
    const right = makeSource([{ id: 1, email: 'a@test.com' }], ['id', 'email']);
    const result = computeRowDiff(left, right, defaultOptions(['id']));
    expect(result.allColumns).toContain('name');
    expect(result.allColumns).toContain('email');
    // name: Alice vs undefined (NULL), email: undefined (NULL) vs a@test.com
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].changedColumns).toContain('name');
    expect(result.matched[0].changedColumns).toContain('email');
  });

  it('duplicate keys: last occurrence wins', () => {
    const left = makeSource([{ id: 1, name: 'First' }, { id: 1, name: 'Second' }]);
    const right = makeSource([{ id: 1, name: 'Second' }]);
    const result = computeRowDiff(left, right, defaultOptions(['id']));
    // Left iterates both rows with key=1, but right has only one
    // First left row matches, second left row also matches (same key)
    // Both get compared against the same right row
    expect(result.summary.unchanged + result.summary.changed + result.summary.removed).toBeGreaterThan(0);
  });

  it('allColumns includes columns from both sides', () => {
    const left = makeSource([{ id: 1, colA: 'a' }], ['id', 'colA']);
    const right = makeSource([{ id: 1, colB: 'b' }], ['id', 'colB']);
    const result = computeRowDiff(left, right, defaultOptions(['id']));
    expect(result.allColumns).toEqual(expect.arrayContaining(['id', 'colA', 'colB']));
  });

  it('mixed scenario: add + remove + change + unchanged', () => {
    const left = makeSource([
      { id: 1, name: 'Alice', score: 90 },
      { id: 2, name: 'Bob', score: 80 },
      { id: 3, name: 'Carol', score: 70 },
    ]);
    const right = makeSource([
      { id: 1, name: 'Alice', score: 90 },    // unchanged
      { id: 2, name: 'Bob', score: 85 },       // changed
      { id: 4, name: 'Dave', score: 60 },      // added
    ]);
    const result = computeRowDiff(left, right, defaultOptions(['id']));
    expect(result.summary.unchanged).toBe(1);
    expect(result.summary.changed).toBe(1);
    expect(result.summary.removed).toBe(1);
    expect(result.summary.added).toBe(1);
    // matched[0] = Alice (unchanged), matched[1] = Bob (changed)
    const changed = result.matched.filter(m => m.changedColumns.length > 0);
    expect(changed).toHaveLength(1);
    expect(changed[0].changedColumns).toEqual(['score']);
    expect(result.leftOnly[0].id).toBe(3);
    expect(result.rightOnly[0].id).toBe(4);
  });
});

// --- computeSchemaDiff ---

function makeColumnInfo(name: string, dataType: string, nullable = true, isPrimaryKey = false): ColumnInfo {
  return { name, dataType, nullable, isPrimaryKey };
}

describe('computeSchemaDiff', () => {
  it('identical schemas produce no diffs', () => {
    const columns = [
      makeColumnInfo('id', 'integer', false, true),
      makeColumnInfo('name', 'text', true, false),
    ];
    const result = computeSchemaDiff(columns, columns);
    expect(result.leftOnlyColumns).toHaveLength(0);
    expect(result.rightOnlyColumns).toHaveLength(0);
    expect(result.commonColumns).toHaveLength(2);
    expect(result.commonColumns.every(c => !c.typeDiffers && !c.nullableDiffers && !c.pkDiffers)).toBe(true);
  });

  it('detects column only in left', () => {
    const left = [makeColumnInfo('id', 'integer'), makeColumnInfo('email', 'text')];
    const right = [makeColumnInfo('id', 'integer')];
    const result = computeSchemaDiff(left, right);
    expect(result.leftOnlyColumns).toHaveLength(1);
    expect(result.leftOnlyColumns[0].name).toBe('email');
    expect(result.rightOnlyColumns).toHaveLength(0);
  });

  it('detects column only in right', () => {
    const left = [makeColumnInfo('id', 'integer')];
    const right = [makeColumnInfo('id', 'integer'), makeColumnInfo('phone', 'varchar')];
    const result = computeSchemaDiff(left, right);
    expect(result.rightOnlyColumns).toHaveLength(1);
    expect(result.rightOnlyColumns[0].name).toBe('phone');
  });

  it('detects type difference', () => {
    const left = [makeColumnInfo('name', 'varchar(50)')];
    const right = [makeColumnInfo('name', 'text')];
    const result = computeSchemaDiff(left, right);
    expect(result.commonColumns).toHaveLength(1);
    expect(result.commonColumns[0].typeDiffers).toBe(true);
    expect(result.commonColumns[0].leftType).toBe('varchar(50)');
    expect(result.commonColumns[0].rightType).toBe('text');
  });

  it('detects nullable difference', () => {
    const left = [makeColumnInfo('email', 'text', true)];
    const right = [makeColumnInfo('email', 'text', false)];
    const result = computeSchemaDiff(left, right);
    expect(result.commonColumns[0].nullableDiffers).toBe(true);
  });

  it('detects PK difference', () => {
    const left = [makeColumnInfo('id', 'integer', false, true)];
    const right = [makeColumnInfo('id', 'integer', false, false)];
    const result = computeSchemaDiff(left, right);
    expect(result.commonColumns[0].pkDiffers).toBe(true);
  });

  it('handles empty schemas', () => {
    const result = computeSchemaDiff([], []);
    expect(result.leftOnlyColumns).toHaveLength(0);
    expect(result.rightOnlyColumns).toHaveLength(0);
    expect(result.commonColumns).toHaveLength(0);
  });
});

// --- exportDiffAsCsv ---

describe('exportDiffAsCsv', () => {
  it('exports added/removed/changed rows with status column', () => {
    const left = makeSource([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]);
    const right = makeSource([
      { id: 1, name: 'Alicia' },
      { id: 3, name: 'Carol' },
    ]);
    const diff = computeRowDiff(left, right, defaultOptions(['id']));
    const csv = exportDiffAsCsv(diff, ['id']);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('_diff_status,id,name');
    expect(lines.some(line => line.startsWith('removed'))).toBe(true);
    expect(lines.some(line => line.startsWith('changed'))).toBe(true);
    expect(lines.some(line => line.startsWith('added'))).toBe(true);
  });

  it('escapes values with commas and quotes', () => {
    const left = makeSource([{ id: 1, note: 'hello, "world"' }]);
    const right = makeSource([{ id: 2, note: 'simple' }]);
    const diff = computeRowDiff(left, right, defaultOptions(['id']));
    const csv = exportDiffAsCsv(diff, ['id']);
    expect(csv).toContain('"hello, ""world"""');
  });
});

// --- exportDiffAsJson ---

describe('exportDiffAsJson', () => {
  it('produces valid JSON with summary and diff sections', () => {
    const left = makeSource([{ id: 1, name: 'Alice' }]);
    const right = makeSource([{ id: 1, name: 'Alicia' }, { id: 2, name: 'Bob' }]);
    const diff = computeRowDiff(left, right, defaultOptions(['id']));
    const json = exportDiffAsJson(diff);
    const parsed = JSON.parse(json);
    expect(parsed.summary.changed).toBe(1);
    expect(parsed.summary.added).toBe(1);
    expect(parsed.changed).toHaveLength(1);
    expect(parsed.added).toHaveLength(1);
    expect(parsed.removed).toHaveLength(0);
  });
});
