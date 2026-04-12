/**
 * Undo manager for result panel cell edits and row operations.
 * Pure logic, no vscode dependency — fully unit-testable.
 */

export interface EditAction {
  type: 'edit';
  rowIdx: number;
  colName: string;
  oldVal: unknown;
}

export interface AddRowAction {
  type: 'addRow';
  rowIdx: number;
}

export type UndoAction = EditAction | AddRowAction;

export interface EditRecord {
  rowIdx: number;
  changes: Record<string, unknown>;
  columnTypes: Record<string, string>;
  pkValues: Record<string, unknown>;
  pkTypes: Record<string, string>;
}

export interface NewRowRecord {
  values: Record<string, unknown>;
  editedCols: Set<string>;
}

export interface UndoState {
  pageRows: Record<string, unknown>[];
  originalRows: Record<string, unknown>[];
  pendingEdits: Map<string, EditRecord>;
  pendingNewRows: Map<string, NewRowRecord>;
  undoStack: UndoAction[];
}

function stringify(val: unknown): string {
  return typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val);
}

/** Record an edit in the undo stack. Returns true if value actually changed. */
export function recordEdit(
  state: UndoState,
  rowIdx: number,
  colName: string,
  newVal: unknown,
): boolean {
  const prevVal = state.pageRows[rowIdx][colName];
  if (stringify(newVal) === stringify(prevVal)) return false;
  state.undoStack.push({ type: 'edit', rowIdx, colName, oldVal: prevVal });
  return true;
}

/** Record adding a new row in the undo stack. */
export function recordAddRow(state: UndoState, rowIdx: number): void {
  state.undoStack.push({ type: 'addRow', rowIdx });
}

/** Perform one undo step. Returns the action undone, or undefined if stack is empty. */
export function performUndo(state: UndoState): UndoAction | undefined {
  if (state.undoStack.length === 0) return undefined;
  const action = state.undoStack.pop()!;

  if (action.type === 'edit') {
    const { rowIdx, colName, oldVal } = action;
    state.pageRows[rowIdx][colName] = oldVal;

    const key = rowIdx.toString();
    if (state.pendingNewRows.has(key)) {
      const nr = state.pendingNewRows.get(key)!;
      nr.values[colName] = oldVal;
      nr.editedCols.delete(colName);
    } else {
      const origVal = state.originalRows[rowIdx][colName];
      if (stringify(origVal) === stringify(oldVal)) {
        // Back to original — remove from pendingEdits
        const edit = state.pendingEdits.get(key);
        if (edit) {
          delete edit.changes[colName];
          delete edit.columnTypes[colName];
          if (Object.keys(edit.changes).length === 0) {
            state.pendingEdits.delete(key);
          }
        }
      } else if (state.pendingEdits.has(key)) {
        state.pendingEdits.get(key)!.changes[colName] = oldVal;
      }
    }
  } else if (action.type === 'addRow') {
    const key = action.rowIdx.toString();
    state.pendingNewRows.delete(key);
    state.pageRows.splice(action.rowIdx, 1);
    state.originalRows.splice(action.rowIdx, 1);
  }

  return action;
}

/** Clear the undo stack (called on save/discard). */
export function clearUndo(state: UndoState): void {
  state.undoStack.length = 0;
}
