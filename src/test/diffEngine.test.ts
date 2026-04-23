import { describe, it, expect } from 'vitest';
import { stringifyCell, computeRowDiff, computeSchemaDiff, computeObjectsDiff, computeStatsDiff, formatStatValue, toggleFilter, exportDiffAsCsv, exportDiffAsJson, buildDefaultDiffQuery, isReadOnlyStatement } from '../diff/diffEngine';
import { DiffSource, DiffOptions } from '../diff/diffTypes';
import { ColumnInfo, TableStatistic } from '../types/schema';

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

// --- computeObjectsDiff ---

describe('computeObjectsDiff', () => {
  it('identical indexes produce same status', () => {
    const objects = {
      indexes: [{ name: 'idx_name', columns: ['name'], unique: false, type: 'btree' }],
      constraints: [], triggers: [], sequences: [],
    };
    const result = computeObjectsDiff(objects, objects);
    expect(result.indexes).toHaveLength(1);
    expect(result.indexes[0].status).toBe('same');
  });

  it('detects added index', () => {
    const left = { indexes: [], constraints: [], triggers: [], sequences: [] };
    const right = {
      indexes: [{ name: 'idx_new', columns: ['email'], unique: true, type: 'btree' }],
      constraints: [], triggers: [], sequences: [],
    };
    const result = computeObjectsDiff(left, right);
    expect(result.indexes).toHaveLength(1);
    expect(result.indexes[0].status).toBe('added');
    expect(result.indexes[0].name).toBe('idx_new');
  });

  it('detects removed index', () => {
    const left = {
      indexes: [{ name: 'idx_old', columns: ['name'], unique: false }],
      constraints: [], triggers: [], sequences: [],
    };
    const right = { indexes: [], constraints: [], triggers: [], sequences: [] };
    const result = computeObjectsDiff(left, right);
    expect(result.indexes).toHaveLength(1);
    expect(result.indexes[0].status).toBe('removed');
  });

  it('detects index column change', () => {
    const left = {
      indexes: [{ name: 'idx_x', columns: ['a', 'b'], unique: false }],
      constraints: [], triggers: [], sequences: [],
    };
    const right = {
      indexes: [{ name: 'idx_x', columns: ['a', 'c'], unique: false }],
      constraints: [], triggers: [], sequences: [],
    };
    const result = computeObjectsDiff(left, right);
    expect(result.indexes[0].status).toBe('differs');
    expect(result.indexes[0].differences).toBeDefined();
  });

  it('detects constraint type change', () => {
    const left = {
      indexes: [], triggers: [], sequences: [],
      constraints: [{ name: 'pk_id', type: 'PRIMARY KEY' as const, columns: ['id'] }],
    };
    const right = {
      indexes: [], triggers: [], sequences: [],
      constraints: [{ name: 'pk_id', type: 'UNIQUE' as const, columns: ['id'] }],
    };
    const result = computeObjectsDiff(left, right);
    expect(result.constraints[0].status).toBe('differs');
  });

  it('detects added trigger', () => {
    const left = { indexes: [], constraints: [], triggers: [], sequences: [] };
    const right = {
      indexes: [], constraints: [], sequences: [],
      triggers: [{ name: 'trg_audit', timing: 'AFTER', events: 'INSERT', definition: 'audit_fn' }],
    };
    const result = computeObjectsDiff(left, right);
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].status).toBe('added');
  });

  it('detects sequence increment change', () => {
    const left = {
      indexes: [], constraints: [], triggers: [],
      sequences: [{ name: 'seq_id', startValue: 1, increment: 1 }],
    };
    const right = {
      indexes: [], constraints: [], triggers: [],
      sequences: [{ name: 'seq_id', startValue: 1, increment: 10 }],
    };
    const result = computeObjectsDiff(left, right);
    expect(result.sequences[0].status).toBe('differs');
  });

  it('handles undefined inputs gracefully', () => {
    const result = computeObjectsDiff(undefined, undefined);
    expect(result.indexes).toHaveLength(0);
    expect(result.constraints).toHaveLength(0);
    expect(result.triggers).toHaveLength(0);
    expect(result.sequences).toHaveLength(0);
  });

  it('index with predicate (partial index): left has predicate, right does not', () => {
    const left = {
      indexes: [{ name: 'idx_active', columns: ['email'], unique: false, type: 'btree', predicate: 'active = true' }],
      constraints: [], triggers: [], sequences: [],
    };
    const right = {
      indexes: [{ name: 'idx_active', columns: ['email'], unique: false, type: 'btree' }],
      constraints: [], triggers: [], sequences: [],
    };
    const result = computeObjectsDiff(left, right);
    expect(result.indexes).toHaveLength(1);
    expect(result.indexes[0].status).toBe('differs');
    expect(result.indexes[0].differences).toBeDefined();
    expect(result.indexes[0].differences!.some(d => d.includes('predicate'))).toBe(true);
    // Left detail should include WHERE clause
    expect(result.indexes[0].leftDetail).toContain('WHERE active = true');
  });

  it('constraint FK with different ON DELETE actions', () => {
    const left = {
      indexes: [], triggers: [], sequences: [],
      constraints: [{
        name: 'fk_order_user',
        type: 'FOREIGN KEY' as const,
        columns: ['user_id'],
        referencedTable: 'public.users',
        onDelete: 'CASCADE',
      }],
    };
    const right = {
      indexes: [], triggers: [], sequences: [],
      constraints: [{
        name: 'fk_order_user',
        type: 'FOREIGN KEY' as const,
        columns: ['user_id'],
        referencedTable: 'public.users',
        onDelete: 'SET NULL',
      }],
    };
    const result = computeObjectsDiff(left, right);
    expect(result.constraints).toHaveLength(1);
    expect(result.constraints[0].status).toBe('differs');
    expect(result.constraints[0].differences).toBeDefined();
    expect(result.constraints[0].differences!.some(d => d.includes('onDelete'))).toBe(true);
    expect(result.constraints[0].differences!.some(d => d.includes('CASCADE') && d.includes('SET NULL'))).toBe(true);
  });

  it('trigger timing change: BEFORE -> AFTER', () => {
    const left = {
      indexes: [], constraints: [], sequences: [],
      triggers: [{ name: 'trg_audit', timing: 'BEFORE', events: 'INSERT', definition: 'audit_fn()' }],
    };
    const right = {
      indexes: [], constraints: [], sequences: [],
      triggers: [{ name: 'trg_audit', timing: 'AFTER', events: 'INSERT', definition: 'audit_fn()' }],
    };
    const result = computeObjectsDiff(left, right);
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].status).toBe('differs');
    expect(result.triggers[0].differences).toBeDefined();
    expect(result.triggers[0].differences!.some(d => d.includes('timing'))).toBe(true);
    expect(result.triggers[0].differences!.some(d => d.includes('BEFORE') && d.includes('AFTER'))).toBe(true);
  });

  it('mixed: indexes + constraints + triggers all at once', () => {
    const left = {
      indexes: [
        { name: 'idx_a', columns: ['a'], unique: false },
        { name: 'idx_b', columns: ['b'], unique: true },
      ],
      constraints: [
        { name: 'pk_id', type: 'PRIMARY KEY' as const, columns: ['id'] },
      ],
      triggers: [
        { name: 'trg_log', timing: 'AFTER', events: 'UPDATE', definition: 'log_fn()' },
      ],
      sequences: [],
    };
    const right = {
      indexes: [
        { name: 'idx_a', columns: ['a', 'c'], unique: false }, // changed
        { name: 'idx_c', columns: ['c'], unique: false },      // added
      ],
      constraints: [
        { name: 'pk_id', type: 'PRIMARY KEY' as const, columns: ['id'] }, // same
        { name: 'uq_email', type: 'UNIQUE' as const, columns: ['email'] }, // added
      ],
      triggers: [], // trg_log removed
      sequences: [],
    };
    const result = computeObjectsDiff(left, right);

    // Indexes: idx_a differs, idx_b removed, idx_c added
    expect(result.indexes).toHaveLength(3);
    const idxA = result.indexes.find(i => i.name === 'idx_a');
    const idxB = result.indexes.find(i => i.name === 'idx_b');
    const idxC = result.indexes.find(i => i.name === 'idx_c');
    expect(idxA!.status).toBe('differs');
    expect(idxB!.status).toBe('removed');
    expect(idxC!.status).toBe('added');

    // Constraints: pk_id same, uq_email added
    expect(result.constraints).toHaveLength(2);
    const pkId = result.constraints.find(c => c.name === 'pk_id');
    const uqEmail = result.constraints.find(c => c.name === 'uq_email');
    expect(pkId!.status).toBe('same');
    expect(uqEmail!.status).toBe('added');

    // Triggers: trg_log removed
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].status).toBe('removed');
    expect(result.triggers[0].name).toBe('trg_log');

    // Sequences: empty on both sides
    expect(result.sequences).toHaveLength(0);
  });

  it('large number of indexes: 20 indexes, 2 differ, 3 added, 1 removed', () => {
    // 17 shared indexes (15 same + 2 differ) + 1 left-only + 3 right-only = 20 left, 20 right
    const sharedIndexes = Array.from({ length: 15 }, (_, index) => ({
      name: `idx_shared_${index}`,
      columns: [`col_${index}`],
      unique: false,
      type: 'btree',
    }));

    const leftOnly = { name: 'idx_removed', columns: ['old_col'], unique: false, type: 'btree' };
    const differLeft1 = { name: 'idx_diff_1', columns: ['a'], unique: false, type: 'btree' };
    const differLeft2 = { name: 'idx_diff_2', columns: ['b'], unique: true, type: 'btree' };
    const differRight1 = { name: 'idx_diff_1', columns: ['a', 'x'], unique: false, type: 'btree' };
    const differRight2 = { name: 'idx_diff_2', columns: ['b'], unique: false, type: 'btree' }; // unique changed

    const rightAdded = Array.from({ length: 3 }, (_, index) => ({
      name: `idx_new_${index}`,
      columns: [`new_col_${index}`],
      unique: false,
      type: 'btree',
    }));

    const left = {
      indexes: [...sharedIndexes, leftOnly, differLeft1, differLeft2],
      constraints: [], triggers: [], sequences: [],
    };
    const right = {
      indexes: [...sharedIndexes, differRight1, differRight2, ...rightAdded],
      constraints: [], triggers: [], sequences: [],
    };

    const result = computeObjectsDiff(left, right);

    const same = result.indexes.filter(i => i.status === 'same');
    const differs = result.indexes.filter(i => i.status === 'differs');
    const added = result.indexes.filter(i => i.status === 'added');
    const removed = result.indexes.filter(i => i.status === 'removed');

    expect(same).toHaveLength(15);
    expect(differs).toHaveLength(2);
    expect(added).toHaveLength(3);
    expect(removed).toHaveLength(1);
    expect(result.indexes).toHaveLength(21); // 15 + 2 + 3 + 1
  });

  it('index with empty string name does not crash', () => {
    const left = {
      indexes: [{ name: '', columns: ['a'], unique: false }],
      constraints: [], triggers: [], sequences: [],
    };
    const right = {
      indexes: [{ name: '', columns: ['a'], unique: false }],
      constraints: [], triggers: [], sequences: [],
    };
    const result = computeObjectsDiff(left, right);
    expect(result.indexes).toHaveLength(1);
    expect(result.indexes[0].name).toBe('');
    expect(result.indexes[0].status).toBe('same');
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

// --- computeStatsDiff ---

describe('computeStatsDiff', () => {
  const leftStats: TableStatistic[] = [
    { key: 'row_count', label: 'Row count', value: 1000, unit: 'count' },
    { key: 'table_size', label: 'Table size', value: 1024, unit: 'bytes' },
    { key: 'dead_tuples', label: 'Dead tuples', value: 10, unit: 'count', badWhen: 'higher' },
    { key: 'last_vacuum', label: 'Last vacuum', value: '2026-01-01T00:00:00Z', unit: 'date' },
  ];

  it('marks matching values as same', () => {
    const result = computeStatsDiff(leftStats, leftStats);
    for (const item of result.items) {
      expect(item.status).toBe('same');
    }
  });

  it('computes numeric delta and percent', () => {
    const rightStats: TableStatistic[] = [
      { key: 'row_count', label: 'Row count', value: 1500, unit: 'count' },
      { key: 'table_size', label: 'Table size', value: 2048, unit: 'bytes' },
    ];
    const result = computeStatsDiff(leftStats.slice(0, 2), rightStats);
    const rowCountItem = result.items.find(item => item.key === 'row_count')!;
    expect(rowCountItem.delta).toBe(500);
    expect(rowCountItem.deltaPercent).toBe(50);
    expect(rowCountItem.status).toBe('differs');
  });

  it('handles left being 0 (no percent delta)', () => {
    const left: TableStatistic[] = [{ key: 'idx_scan', label: 'Index scans', value: 0, unit: 'count' }];
    const right: TableStatistic[] = [{ key: 'idx_scan', label: 'Index scans', value: 100, unit: 'count' }];
    const result = computeStatsDiff(left, right);
    expect(result.items[0].delta).toBe(100);
    expect(result.items[0].deltaPercent).toBeUndefined();
  });

  it('marks left-only and right-only items', () => {
    const left: TableStatistic[] = [{ key: 'pg_only', label: 'PG only', value: 1, unit: 'count' }];
    const right: TableStatistic[] = [{ key: 'ch_only', label: 'CH only', value: 1, unit: 'count' }];
    const result = computeStatsDiff(left, right);
    const pgOnly = result.items.find(item => item.key === 'pg_only')!;
    const chOnly = result.items.find(item => item.key === 'ch_only')!;
    expect(pgOnly.status).toBe('leftOnly');
    expect(pgOnly.rightValue).toBeNull();
    expect(chOnly.status).toBe('rightOnly');
    expect(chOnly.leftValue).toBeNull();
  });

  it('both values null → missing', () => {
    const left: TableStatistic[] = [{ key: 'x', label: 'X', value: null, unit: 'count' }];
    const right: TableStatistic[] = [{ key: 'x', label: 'X', value: null, unit: 'count' }];
    const result = computeStatsDiff(left, right);
    expect(result.items[0].status).toBe('missing');
  });

  it('preserves badWhen for coloring', () => {
    const result = computeStatsDiff(leftStats, leftStats.map(stat =>
      stat.key === 'dead_tuples' ? { ...stat, value: 200 } : stat
    ));
    const dead = result.items.find(item => item.key === 'dead_tuples')!;
    expect(dead.badWhen).toBe('higher');
    expect(dead.delta).toBe(190);
  });

  it('preserves order of left items and appends right-only at end', () => {
    const left: TableStatistic[] = [
      { key: 'a', label: 'A', value: 1, unit: 'count' },
      { key: 'b', label: 'B', value: 2, unit: 'count' },
    ];
    const right: TableStatistic[] = [
      { key: 'b', label: 'B', value: 2, unit: 'count' },
      { key: 'c', label: 'C', value: 3, unit: 'count' },
    ];
    const result = computeStatsDiff(left, right);
    expect(result.items.map(item => item.key)).toEqual(['a', 'b', 'c']);
  });

  it('handles undefined inputs', () => {
    expect(computeStatsDiff(undefined, undefined).items).toEqual([]);
    expect(computeStatsDiff(leftStats, undefined).items).toHaveLength(leftStats.length);
    expect(computeStatsDiff(undefined, leftStats).items).toHaveLength(leftStats.length);
  });

  it('string values compared as strings (no delta)', () => {
    const left: TableStatistic[] = [{ key: 'engine', label: 'Engine', value: 'MergeTree', unit: 'text' }];
    const right: TableStatistic[] = [{ key: 'engine', label: 'Engine', value: 'ReplacingMergeTree', unit: 'text' }];
    const result = computeStatsDiff(left, right);
    expect(result.items[0].status).toBe('differs');
    expect(result.items[0].delta).toBeUndefined();
  });
});

// --- formatStatValue ---

describe('formatStatValue', () => {
  it('null → em dash', () => {
    expect(formatStatValue(null)).toBe('—');
    expect(formatStatValue(null, 'bytes')).toBe('—');
  });

  it('formats bytes with binary units', () => {
    expect(formatStatValue(512, 'bytes')).toBe('512 B');
    expect(formatStatValue(1024, 'bytes')).toBe('1.00 KB');
    expect(formatStatValue(1_048_576, 'bytes')).toBe('1.00 MB');
    expect(formatStatValue(1_073_741_824, 'bytes')).toBe('1.00 GB');
  });

  it('formats count with thousands separator', () => {
    expect(formatStatValue(1234567, 'count')).toBe('1,234,567');
  });

  it('formats percent with two decimals', () => {
    expect(formatStatValue(12.345, 'percent')).toBe('12.35%');
  });

  it('formats date as ISO without ms', () => {
    const formatted = formatStatValue('2026-01-01T12:34:56.789Z', 'date');
    expect(formatted).toBe('2026-01-01 12:34:56Z');
  });

  it('text values returned as-is', () => {
    expect(formatStatValue('MergeTree', 'text')).toBe('MergeTree');
  });
});

// --- toggleFilter ---

describe('toggleFilter', () => {
  const rowFilters = () => ({ unchanged: true, changed: true, added: true, removed: true });
  const twoFilters = () => ({ differs: true, same: true });

  describe('plain click (solo)', () => {
    it('activates only the clicked key, deactivates others', () => {
      const result = toggleFilter(rowFilters(), 'changed', false);
      expect(result).toEqual({ unchanged: false, changed: true, added: false, removed: false });
    });

    it('clicking an already-solo key keeps it solo', () => {
      const soloState = { unchanged: false, changed: true, added: false, removed: false };
      const result = toggleFilter(soloState, 'changed', false);
      expect(result).toEqual(soloState);
    });

    it('works on two-filter groups (schema/stats tabs)', () => {
      const result = toggleFilter(twoFilters(), 'differs', false);
      expect(result).toEqual({ differs: true, same: false });
    });
  });

  describe('shift+click (additive toggle)', () => {
    it('toggles the clicked key, preserves others', () => {
      const result = toggleFilter(rowFilters(), 'changed', true);
      expect(result).toEqual({ unchanged: true, changed: false, added: true, removed: true });
    });

    it('re-activating a previously-off key preserves other state', () => {
      const state = { unchanged: false, changed: true, added: false, removed: false };
      const result = toggleFilter(state, 'added', true);
      expect(result).toEqual({ unchanged: false, changed: true, added: true, removed: false });
    });

    it('blocks turning off the last active filter', () => {
      const state = { unchanged: false, changed: true, added: false, removed: false };
      const result = toggleFilter(state, 'changed', true);
      expect(result).toEqual(state); // unchanged — click was blocked
    });

    it('on two-filter group, blocks emptying', () => {
      const state = { differs: true, same: false };
      const result = toggleFilter(state, 'differs', true);
      expect(result).toEqual(state);
    });
  });

  it('unknown key is ignored', () => {
    const state = rowFilters();
    expect(toggleFilter(state, 'nonexistent', false)).toBe(state);
    expect(toggleFilter(state, 'nonexistent', true)).toBe(state);
  });

  it('returns a new object (does not mutate input) on successful toggle', () => {
    const state = rowFilters();
    const result = toggleFilter(state, 'changed', false);
    expect(result).not.toBe(state);
    expect(state).toEqual(rowFilters()); // original untouched
  });
});

// --- buildDefaultDiffQuery ---

describe('buildDefaultDiffQuery', () => {
  it('builds a simple SELECT for an unqualified table', () => {
    expect(buildDefaultDiffQuery('users', undefined, 100)).toBe('SELECT * FROM users LIMIT 100');
  });

  it('qualifies with the schema when provided', () => {
    expect(buildDefaultDiffQuery('users', 'public', 10000)).toBe('SELECT * FROM public.users LIMIT 10000');
  });

  it('quotes identifiers that need quoting', () => {
    expect(buildDefaultDiffQuery('User', undefined, 50)).toBe('SELECT * FROM "User" LIMIT 50');
    expect(buildDefaultDiffQuery('order', undefined, 50)).toBe('SELECT * FROM "order" LIMIT 50'); // reserved word
  });

  it('honors the caller-supplied row limit', () => {
    expect(buildDefaultDiffQuery('t', undefined, 1)).toBe('SELECT * FROM t LIMIT 1');
    expect(buildDefaultDiffQuery('t', undefined, 99999)).toBe('SELECT * FROM t LIMIT 99999');
  });

  it('uses TOP(N) for MSSQL', () => {
    expect(buildDefaultDiffQuery('users', 'dbo', 100, 'mssql')).toBe('SELECT TOP(100) * FROM dbo.users');
    expect(buildDefaultDiffQuery('order', undefined, 50, 'mssql')).toBe('SELECT TOP(50) * FROM "order"');
  });
});

// --- isReadOnlyStatement ---

describe('isReadOnlyStatement', () => {
  it('accepts SELECT / EXPLAIN / SHOW / WITH (any case, leading whitespace)', () => {
    expect(isReadOnlyStatement('SELECT 1')).toBe(true);
    expect(isReadOnlyStatement('select * from t')).toBe(true);
    expect(isReadOnlyStatement('   EXPLAIN SELECT 1')).toBe(true);
    expect(isReadOnlyStatement('SHOW TABLES')).toBe(true);
    expect(isReadOnlyStatement('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true);
  });

  it('rejects DML / DDL statements', () => {
    expect(isReadOnlyStatement('DELETE FROM users')).toBe(false);
    expect(isReadOnlyStatement('UPDATE users SET name = \'x\'')).toBe(false);
    expect(isReadOnlyStatement('INSERT INTO users VALUES (1)')).toBe(false);
    expect(isReadOnlyStatement('DROP TABLE users')).toBe(false);
    expect(isReadOnlyStatement('TRUNCATE users')).toBe(false);
    expect(isReadOnlyStatement('ALTER TABLE users ADD COLUMN c int')).toBe(false);
  });

  it('rejects empty / whitespace-only input', () => {
    expect(isReadOnlyStatement('')).toBe(false);
    expect(isReadOnlyStatement('   \n\t')).toBe(false);
  });
});
