import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordEdit,
  recordAddRow,
  performUndo,
  clearUndo,
  UndoState,
} from '../utils/undoManager';

function makeState(rows: Record<string, unknown>[]): UndoState {
  return {
    pageRows: rows.map(r => ({ ...r })),
    originalRows: rows.map(r => ({ ...r })),
    pendingEdits: new Map(),
    pendingNewRows: new Map(),
    undoStack: [],
  };
}

describe('undoManager', () => {
  let state: UndoState;

  beforeEach(() => {
    state = makeState([
      { id: 1, name: 'Alice', email: 'alice@test.com' },
      { id: 2, name: 'Bob', email: 'bob@test.com' },
    ]);
  });

  // --- recordEdit ---

  describe('recordEdit', () => {
    it('records edit when value changes', () => {
      const changed = recordEdit(state, 0, 'name', 'Charlie');
      expect(changed).toBe(true);
      expect(state.undoStack).toHaveLength(1);
      expect(state.undoStack[0]).toEqual({
        type: 'edit',
        rowIdx: 0,
        colName: 'name',
        oldVal: 'Alice',
      });
    });

    it('does not record edit when value is the same', () => {
      const changed = recordEdit(state, 0, 'name', 'Alice');
      expect(changed).toBe(false);
      expect(state.undoStack).toHaveLength(0);
    });

    it('records multiple sequential edits to same cell', () => {
      recordEdit(state, 0, 'name', 'Charlie');
      state.pageRows[0].name = 'Charlie';

      recordEdit(state, 0, 'name', 'Diana');
      state.pageRows[0].name = 'Diana';

      expect(state.undoStack).toHaveLength(2);
      expect(state.undoStack[0].type === 'edit' && state.undoStack[0].oldVal).toBe('Alice');
      expect(state.undoStack[1].type === 'edit' && state.undoStack[1].oldVal).toBe('Charlie');
    });

    it('records edits to different cells independently', () => {
      recordEdit(state, 0, 'name', 'Charlie');
      state.pageRows[0].name = 'Charlie';

      recordEdit(state, 1, 'email', 'new@test.com');
      state.pageRows[1].email = 'new@test.com';

      expect(state.undoStack).toHaveLength(2);
    });

    it('handles JSON object values', () => {
      const stateWithJson = makeState([{ id: 1, meta: { theme: 'dark' } }]);
      const changed = recordEdit(stateWithJson, 0, 'meta', { theme: 'light' });
      expect(changed).toBe(true);
      expect(stateWithJson.undoStack[0]).toMatchObject({
        type: 'edit',
        oldVal: { theme: 'dark' },
      });
    });

    it('detects no change for equivalent JSON objects', () => {
      const stateWithJson = makeState([{ id: 1, meta: { theme: 'dark' } }]);
      const changed = recordEdit(stateWithJson, 0, 'meta', { theme: 'dark' });
      expect(changed).toBe(false);
    });

    it('handles null values', () => {
      const stateWithNull = makeState([{ id: 1, name: null }]);
      const changed = recordEdit(stateWithNull, 0, 'name', 'Alice');
      expect(changed).toBe(true);
      expect(stateWithNull.undoStack[0]).toMatchObject({ oldVal: null });
    });
  });

  // --- performUndo — cell edits ---

  describe('performUndo — cell edits', () => {
    it('restores previous cell value', () => {
      recordEdit(state, 0, 'name', 'Charlie');
      state.pageRows[0].name = 'Charlie';

      const action = performUndo(state);
      expect(action).toEqual({ type: 'edit', rowIdx: 0, colName: 'name', oldVal: 'Alice' });
      expect(state.pageRows[0].name).toBe('Alice');
    });

    it('returns undefined when stack is empty', () => {
      expect(performUndo(state)).toBeUndefined();
    });

    it('undoes multiple edits in LIFO order', () => {
      recordEdit(state, 0, 'name', 'Charlie');
      state.pageRows[0].name = 'Charlie';
      recordEdit(state, 0, 'name', 'Diana');
      state.pageRows[0].name = 'Diana';

      performUndo(state);
      expect(state.pageRows[0].name).toBe('Charlie');

      performUndo(state);
      expect(state.pageRows[0].name).toBe('Alice');
    });

    it('removes pendingEdit when value returns to original', () => {
      // Simulate finishEdit: record + update pageRows + create pendingEdit
      recordEdit(state, 0, 'name', 'Charlie');
      state.pageRows[0].name = 'Charlie';
      state.pendingEdits.set('0', {
        rowIdx: 0,
        changes: { name: 'Charlie' },
        columnTypes: { name: 'varchar' },
        pkValues: { id: 1 },
        pkTypes: { id: 'integer' },
      });

      performUndo(state);
      expect(state.pendingEdits.has('0')).toBe(false);
    });

    it('updates pendingEdit when undo goes to intermediate (non-original) value', () => {
      // Edit: Alice → Charlie → Diana
      recordEdit(state, 0, 'name', 'Charlie');
      state.pageRows[0].name = 'Charlie';
      state.pendingEdits.set('0', {
        rowIdx: 0,
        changes: { name: 'Charlie' },
        columnTypes: { name: 'varchar' },
        pkValues: { id: 1 },
        pkTypes: { id: 'integer' },
      });

      recordEdit(state, 0, 'name', 'Diana');
      state.pageRows[0].name = 'Diana';
      state.pendingEdits.get('0')!.changes.name = 'Diana';

      // Undo Diana → Charlie (still not original "Alice")
      performUndo(state);
      expect(state.pendingEdits.has('0')).toBe(true);
      expect(state.pendingEdits.get('0')!.changes.name).toBe('Charlie');
    });

    it('removes only the undone column from pendingEdit, keeps others', () => {
      // Edit two different columns
      recordEdit(state, 0, 'name', 'Charlie');
      state.pageRows[0].name = 'Charlie';
      recordEdit(state, 0, 'email', 'new@test.com');
      state.pageRows[0].email = 'new@test.com';

      state.pendingEdits.set('0', {
        rowIdx: 0,
        changes: { name: 'Charlie', email: 'new@test.com' },
        columnTypes: { name: 'varchar', email: 'text' },
        pkValues: { id: 1 },
        pkTypes: { id: 'integer' },
      });

      // Undo email (last edit)
      performUndo(state);
      expect(state.pendingEdits.has('0')).toBe(true);
      expect(state.pendingEdits.get('0')!.changes.email).toBeUndefined();
      expect(state.pendingEdits.get('0')!.changes.name).toBe('Charlie');
    });

    it('handles undo of new row cell edits', () => {
      const newRow = { id: null, name: null, email: null };
      state.pageRows.push({ ...newRow });
      state.originalRows.push({ ...newRow });
      const rowIdx = state.pageRows.length - 1;
      state.pendingNewRows.set(rowIdx.toString(), {
        values: { ...newRow },
        editedCols: new Set(),
      });

      recordEdit(state, rowIdx, 'name', 'NewUser');
      state.pageRows[rowIdx].name = 'NewUser';
      const nr = state.pendingNewRows.get(rowIdx.toString())!;
      nr.values.name = 'NewUser';
      nr.editedCols.add('name');

      performUndo(state);
      expect(state.pageRows[rowIdx].name).toBeNull();
      expect(nr.values.name).toBeNull();
      expect(nr.editedCols.has('name')).toBe(false);
    });
  });

  // --- performUndo — add row ---

  describe('performUndo — add row', () => {
    it('removes added row', () => {
      const newRow = { id: null, name: null, email: null };
      state.pageRows.push({ ...newRow });
      state.originalRows.push({ ...newRow });
      const rowIdx = state.pageRows.length - 1;
      state.pendingNewRows.set(rowIdx.toString(), {
        values: { ...newRow },
        editedCols: new Set(),
      });
      recordAddRow(state, rowIdx);

      expect(state.pageRows).toHaveLength(3);

      const action = performUndo(state);
      expect(action).toEqual({ type: 'addRow', rowIdx });
      expect(state.pageRows).toHaveLength(2);
      expect(state.originalRows).toHaveLength(2);
      expect(state.pendingNewRows.has(rowIdx.toString())).toBe(false);
    });

    it('undoes add row after editing its cells', () => {
      const newRow = { id: null, name: null, email: null };
      state.pageRows.push({ ...newRow });
      state.originalRows.push({ ...newRow });
      const rowIdx = state.pageRows.length - 1;
      state.pendingNewRows.set(rowIdx.toString(), {
        values: { ...newRow },
        editedCols: new Set(),
      });
      recordAddRow(state, rowIdx);

      // Edit a cell in the new row
      recordEdit(state, rowIdx, 'name', 'NewUser');
      state.pageRows[rowIdx].name = 'NewUser';

      // Undo the cell edit first
      performUndo(state);
      expect(state.pageRows[rowIdx].name).toBeNull();

      // Undo the row add
      performUndo(state);
      expect(state.pageRows).toHaveLength(2);
      expect(state.pendingNewRows.size).toBe(0);
    });
  });

  // --- clearUndo ---

  describe('clearUndo', () => {
    it('empties the undo stack', () => {
      recordEdit(state, 0, 'name', 'Charlie');
      recordEdit(state, 1, 'name', 'Diana');
      expect(state.undoStack).toHaveLength(2);

      clearUndo(state);
      expect(state.undoStack).toHaveLength(0);
    });

    it('performUndo returns undefined after clearUndo', () => {
      recordEdit(state, 0, 'name', 'Charlie');
      clearUndo(state);
      expect(performUndo(state)).toBeUndefined();
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('undo edit on row 0 does not affect row 1', () => {
      recordEdit(state, 0, 'name', 'Changed0');
      state.pageRows[0].name = 'Changed0';
      recordEdit(state, 1, 'name', 'Changed1');
      state.pageRows[1].name = 'Changed1';

      // Undo last (row 1)
      performUndo(state);
      expect(state.pageRows[0].name).toBe('Changed0');
      expect(state.pageRows[1].name).toBe('Bob');
    });

    it('handles rapid edit-undo-edit cycle on same cell', () => {
      recordEdit(state, 0, 'name', 'X');
      state.pageRows[0].name = 'X';
      state.pendingEdits.set('0', {
        rowIdx: 0,
        changes: { name: 'X' },
        columnTypes: { name: 'varchar' },
        pkValues: { id: 1 },
        pkTypes: { id: 'integer' },
      });

      performUndo(state);
      expect(state.pageRows[0].name).toBe('Alice');
      expect(state.pendingEdits.has('0')).toBe(false);

      // Edit again
      recordEdit(state, 0, 'name', 'Y');
      state.pageRows[0].name = 'Y';
      state.pendingEdits.set('0', {
        rowIdx: 0,
        changes: { name: 'Y' },
        columnTypes: { name: 'varchar' },
        pkValues: { id: 1 },
        pkTypes: { id: 'integer' },
      });

      expect(state.undoStack).toHaveLength(1);
      expect(state.pageRows[0].name).toBe('Y');
    });

    it('undo with empty pageRows does nothing', () => {
      const emptyState = makeState([]);
      expect(performUndo(emptyState)).toBeUndefined();
    });
  });
});
