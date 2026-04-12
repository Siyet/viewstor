/**
 * Paste manager for result panel.
 * Parses clipboard text (TSV) and applies values to selected cells.
 * Pure logic, no vscode dependency — fully unit-testable.
 */

import { UndoState, recordEdit } from './undoManager';

export interface ColumnInfo {
  name: string;
  dataType: string;
}

export interface PasteResult {
  /** Cells that were actually modified: [rowIdx, colIdx][] */
  modified: [number, number][];
}

/**
 * Parse clipboard text as TSV grid.
 * Single cell → one value to fill into all selected cells.
 * Multi-cell → row-by-row, column-by-column mapping onto selection bounding box.
 */
export function parseClipboardTsv(text: string): string[][] {
  const lines = text.replace(/\r\n$/, '').replace(/\n$/, '').split(/\r?\n/);
  return lines.map(line => line.split('\t'));
}

/**
 * Get the bounding box of selected cells.
 * Returns sorted unique row and column indices.
 */
export function getSelectionBounds(selectedKeys: Set<string>): { rowIdxs: number[]; colIdxs: number[] } {
  const rows = new Set<number>();
  const cols = new Set<number>();
  for (const key of selectedKeys) {
    const [r, c] = key.split(':').map(Number);
    rows.add(r);
    cols.add(c);
  }
  return {
    rowIdxs: [...rows].sort((a, b) => a - b),
    colIdxs: [...cols].sort((a, b) => a - b),
  };
}

/**
 * Apply pasted values to cells within the selection.
 *
 * Behavior:
 * - Single clipboard cell → fill all selected cells with that value
 * - Multi clipboard cells → map row-by-row, col-by-col onto selection bounding box,
 *   cycling if clipboard is smaller than selection
 *
 * Only modifies cells that are within the selectedKeys set, editable (has PK or is new row),
 * and not readonly.
 */
export function applyPaste(
  clipboardGrid: string[][],
  selectedKeys: Set<string>,
  state: UndoState,
  columns: ColumnInfo[],
  pkColumns: string[],
  pendingNewRows: Map<string, unknown>,
): PasteResult {
  if (selectedKeys.size === 0 || clipboardGrid.length === 0) return { modified: [] };

  const { rowIdxs, colIdxs } = getSelectionBounds(selectedKeys);
  const isSingleValue = clipboardGrid.length === 1 && clipboardGrid[0].length === 1;
  const modified: [number, number][] = [];

  for (let ri = 0; ri < rowIdxs.length; ri++) {
    const rowIdx = rowIdxs[ri];
    // Can only edit rows with PK or new rows
    if (pkColumns.length === 0 && !pendingNewRows.has(rowIdx.toString())) continue;

    for (let ci = 0; ci < colIdxs.length; ci++) {
      const colIdx = colIdxs[ci];
      const key = rowIdx + ':' + colIdx;
      if (!selectedKeys.has(key)) continue;
      if (colIdx >= columns.length) continue;

      const clipRow = isSingleValue ? 0 : ri % clipboardGrid.length;
      const clipCol = isSingleValue ? 0 : ci % (clipboardGrid[clipRow]?.length || 1);
      const rawValue = clipboardGrid[clipRow]?.[clipCol] ?? '';

      const colName = columns[colIdx].name;
      const newVal = parseValue(rawValue);

      recordEdit(state, rowIdx, colName, newVal);
      state.pageRows[rowIdx][colName] = newVal;

      // Update pendingNewRows if applicable
      const nrKey = rowIdx.toString();
      if (pendingNewRows.has(nrKey)) {
        const nr = pendingNewRows.get(nrKey) as { values: Record<string, unknown>; editedCols: Set<string> };
        nr.values[colName] = newVal;
        nr.editedCols.add(colName);
      }

      modified.push([rowIdx, colIdx]);
    }
  }

  return { modified };
}

/** Parse a pasted string value into an appropriate JS value. */
function parseValue(raw: string): unknown {
  if (raw === '' || raw.toUpperCase() === 'NULL') return null;
  return raw;
}
