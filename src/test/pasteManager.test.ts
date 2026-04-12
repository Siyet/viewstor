import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseClipboardTsv,
  getSelectionBounds,
  applyPaste,
  ColumnInfo,
} from '../utils/pasteManager';
import { UndoState } from '../utils/undoManager';

function makeState(rows: Record<string, unknown>[]): UndoState {
  return {
    pageRows: rows.map(r => ({ ...r })),
    originalRows: rows.map(r => ({ ...r })),
    pendingEdits: new Map(),
    pendingNewRows: new Map(),
    undoStack: [],
  };
}

const testColumns: ColumnInfo[] = [
  { name: 'id', dataType: 'integer' },
  { name: 'name', dataType: 'varchar' },
  { name: 'email', dataType: 'text' },
];

describe('parseClipboardTsv', () => {
  it('parses single cell', () => {
    expect(parseClipboardTsv('hello')).toEqual([['hello']]);
  });

  it('parses single row with tabs', () => {
    expect(parseClipboardTsv('a\tb\tc')).toEqual([['a', 'b', 'c']]);
  });

  it('parses multiple rows', () => {
    expect(parseClipboardTsv('a\tb\nc\td')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('handles Windows line endings', () => {
    expect(parseClipboardTsv('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('handles trailing newline', () => {
    expect(parseClipboardTsv('a\tb\n')).toEqual([['a', 'b']]);
  });

  it('preserves empty cells in TSV', () => {
    expect(parseClipboardTsv('a\t\tc')).toEqual([['a', '', 'c']]);
  });

  it('parses single value with trailing newline', () => {
    expect(parseClipboardTsv('hello\n')).toEqual([['hello']]);
  });
});

describe('getSelectionBounds', () => {
  it('returns sorted unique indices for single cell', () => {
    const result = getSelectionBounds(new Set(['2:1']));
    expect(result).toEqual({ rowIdxs: [2], colIdxs: [1] });
  });

  it('returns sorted bounds for rectangular selection', () => {
    const result = getSelectionBounds(new Set(['1:0', '1:1', '2:0', '2:1']));
    expect(result).toEqual({ rowIdxs: [1, 2], colIdxs: [0, 1] });
  });

  it('handles non-contiguous selection', () => {
    const result = getSelectionBounds(new Set(['0:0', '2:2']));
    expect(result).toEqual({ rowIdxs: [0, 2], colIdxs: [0, 2] });
  });

  it('returns empty for empty selection', () => {
    const result = getSelectionBounds(new Set());
    expect(result).toEqual({ rowIdxs: [], colIdxs: [] });
  });
});

describe('applyPaste', () => {
  let state: UndoState;
  const pkColumns = ['id'];

  beforeEach(() => {
    state = makeState([
      { id: 1, name: 'Alice', email: 'alice@test.com' },
      { id: 2, name: 'Bob', email: 'bob@test.com' },
      { id: 3, name: 'Carol', email: 'carol@test.com' },
    ]);
  });

  it('single value paste fills all selected cells', () => {
    const grid = [['X']];
    const selected = new Set(['0:1', '1:1', '2:1']); // name column, 3 rows
    const result = applyPaste(grid, selected, state, testColumns, pkColumns, new Map());

    expect(result.modified).toHaveLength(3);
    expect(state.pageRows[0].name).toBe('X');
    expect(state.pageRows[1].name).toBe('X');
    expect(state.pageRows[2].name).toBe('X');
  });

  it('single value paste into single cell', () => {
    const grid = [['NewName']];
    const selected = new Set(['0:1']);
    const result = applyPaste(grid, selected, state, testColumns, pkColumns, new Map());

    expect(result.modified).toEqual([[0, 1]]);
    expect(state.pageRows[0].name).toBe('NewName');
    expect(state.pageRows[1].name).toBe('Bob'); // untouched
  });

  it('multi-cell paste maps row by row', () => {
    const grid = [['X', 'x@test.com'], ['Y', 'y@test.com']];
    const selected = new Set(['0:1', '0:2', '1:1', '1:2']); // 2x2 block
    const result = applyPaste(grid, selected, state, testColumns, pkColumns, new Map());

    expect(result.modified).toHaveLength(4);
    expect(state.pageRows[0].name).toBe('X');
    expect(state.pageRows[0].email).toBe('x@test.com');
    expect(state.pageRows[1].name).toBe('Y');
    expect(state.pageRows[1].email).toBe('y@test.com');
  });

  it('clipboard smaller than selection cycles values', () => {
    const grid = [['A'], ['B']]; // 2 rows, 1 col
    const selected = new Set(['0:1', '1:1', '2:1']); // 3 rows selected
    applyPaste(grid, selected, state, testColumns, pkColumns, new Map());

    expect(state.pageRows[0].name).toBe('A');
    expect(state.pageRows[1].name).toBe('B');
    expect(state.pageRows[2].name).toBe('A'); // cycled
  });

  it('NULL/empty clipboard values become null', () => {
    const grid = [['NULL'], ['']];
    const selected = new Set(['0:1', '1:1']);
    applyPaste(grid, selected, state, testColumns, pkColumns, new Map());

    expect(state.pageRows[0].name).toBeNull();
    expect(state.pageRows[1].name).toBeNull();
  });

  it('records undo entries for each modified cell', () => {
    const grid = [['X']];
    const selected = new Set(['0:1', '1:1']);
    applyPaste(grid, selected, state, testColumns, pkColumns, new Map());

    expect(state.undoStack).toHaveLength(2);
    expect(state.undoStack[0]).toEqual({ type: 'edit', rowIdx: 0, colName: 'name', oldVal: 'Alice' });
    expect(state.undoStack[1]).toEqual({ type: 'edit', rowIdx: 1, colName: 'name', oldVal: 'Bob' });
  });

  it('does not record undo if value is unchanged', () => {
    const grid = [['Alice']];
    const selected = new Set(['0:1']); // already "Alice"
    applyPaste(grid, selected, state, testColumns, pkColumns, new Map());

    expect(state.undoStack).toHaveLength(0);
  });

  it('skips rows without PK and not in pendingNewRows', () => {
    const grid = [['X']];
    const selected = new Set(['0:1', '1:1']);
    // No PK columns → can't edit existing rows
    const result = applyPaste(grid, selected, state, testColumns, [], new Map());

    expect(result.modified).toHaveLength(0);
    expect(state.pageRows[0].name).toBe('Alice'); // unchanged
  });

  it('edits pendingNewRows cells even without PK', () => {
    const newRows = new Map<string, unknown>();
    newRows.set('0', { values: { id: null, name: null, email: null }, editedCols: new Set() });

    const grid = [['NewUser']];
    const selected = new Set(['0:1']);
    const result = applyPaste(grid, selected, state, testColumns, [], newRows);

    expect(result.modified).toHaveLength(1);
    expect(state.pageRows[0].name).toBe('NewUser');
    const nr = newRows.get('0') as { values: Record<string, unknown>; editedCols: Set<string> };
    expect(nr.values.name).toBe('NewUser');
    expect(nr.editedCols.has('name')).toBe(true);
  });

  it('does not modify cells outside selection', () => {
    const grid = [['X', 'Y']];
    const selected = new Set(['0:1']); // only name col selected, not email
    applyPaste(grid, selected, state, testColumns, pkColumns, new Map());

    expect(state.pageRows[0].name).toBe('X');
    expect(state.pageRows[0].email).toBe('alice@test.com'); // untouched
  });

  it('returns empty result for empty selection', () => {
    const grid = [['X']];
    const result = applyPaste(grid, new Set(), state, testColumns, pkColumns, new Map());
    expect(result.modified).toHaveLength(0);
  });

  it('returns empty result for empty clipboard', () => {
    const result = applyPaste([], new Set(['0:1']), state, testColumns, pkColumns, new Map());
    expect(result.modified).toHaveLength(0);
  });

  it('paste 2x2 grid onto 3x3 selection cycles both axes', () => {
    const grid = [['A', 'B'], ['C', 'D']];
    const selected = new Set([
      '0:0', '0:1', '0:2',
      '1:0', '1:1', '1:2',
      '2:0', '2:1', '2:2',
    ]);
    applyPaste(grid, selected, state, testColumns, pkColumns, new Map());

    // Row 0: A B A (cols cycle)
    expect(state.pageRows[0].id).toBe('A');
    expect(state.pageRows[0].name).toBe('B');
    expect(state.pageRows[0].email).toBe('A');
    // Row 1: C D C
    expect(state.pageRows[1].id).toBe('C');
    expect(state.pageRows[1].name).toBe('D');
    expect(state.pageRows[1].email).toBe('C');
    // Row 2: A B A (rows cycle)
    expect(state.pageRows[2].id).toBe('A');
    expect(state.pageRows[2].name).toBe('B');
    expect(state.pageRows[2].email).toBe('A');
  });

  it('paste into non-contiguous selection only modifies selected cells', () => {
    const grid = [['X']];
    // Select diagonal: (0,1) and (2,2)
    const selected = new Set(['0:1', '2:2']);
    applyPaste(grid, selected, state, testColumns, pkColumns, new Map());

    expect(state.pageRows[0].name).toBe('X');
    expect(state.pageRows[0].email).toBe('alice@test.com'); // not selected
    expect(state.pageRows[1].name).toBe('Bob'); // row not selected
    expect(state.pageRows[2].email).toBe('X');
    expect(state.pageRows[2].name).toBe('Carol'); // not selected
  });

  it('case-insensitive NULL handling', () => {
    const grid = [['null'], ['Null'], ['NULL']];
    const selected = new Set(['0:1', '1:1', '2:1']);
    applyPaste(grid, selected, state, testColumns, pkColumns, new Map());

    expect(state.pageRows[0].name).toBeNull();
    expect(state.pageRows[1].name).toBeNull();
    expect(state.pageRows[2].name).toBeNull();
  });
});
