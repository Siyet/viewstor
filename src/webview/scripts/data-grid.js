/* eslint-disable */
/**
 * Shared data-grid interaction layer for Viewstor webviews (#94).
 *
 * Installs `window.ViewstorDataGrid` with:
 *
 *   copyAsText(headers, rows, format, opts?)
 *       Format selected cells as a string. `headers` is string[],
 *       `rows` is string[][]. Returns the formatted text (caller
 *       writes to clipboard). Supported formats: tsv, tsv-header,
 *       csv, onerow-sq, onerow-dq, md, json.
 *
 *   buildCopyMenuItems(onCopy, extra?)
 *       Returns an items array suitable for ViewstorContextMenu.open().
 *       `onCopy(format)` is called when the user picks a format.
 *       `extra` (optional) is appended after a separator.
 *
 *   createSelectionManager(opts)
 *       Factory for per-table cell-selection management: drag-select,
 *       Shift+click range, Ctrl/Cmd+C, context menu, Escape.
 *
 * Also exported as CommonJS for node:vm unit tests.
 */
(function (root) {
  'use strict';

  // ---- helpers ----
  function cellKey(r, c) { return r + ':' + c; }
  function parseKey(key) {
    var parts = key.split(':');
    return { row: +parts[0], col: +parts[1] };
  }

  // ---- copy formatting (pure, no DOM) ----
  function copyAsText(headers, rows, format, opts) {
    opts = opts || {};
    var isNumeric = opts.isNumericValue || function (v) {
      return /^-?\d+(\.\d+)?$/.test(v);
    };

    function quoteFlat(v, quote) {
      if (v === '' || v === 'NULL' || v === 'null') return 'NULL';
      if (isNumeric(v)) return v;
      return quote + v.replace(new RegExp(quote, 'g'), quote + quote) + quote;
    }

    switch (format) {
      case 'tsv':
        return rows.map(function (r) { return r.join('\t'); }).join('\n');

      case 'tsv-header':
        return headers.join('\t') + '\n' +
          rows.map(function (r) { return r.join('\t'); }).join('\n');

      case 'csv': {
        var esc = function (v) {
          return /[,"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        };
        return headers.map(esc).join(',') + '\n' +
          rows.map(function (r) { return r.map(esc).join(','); }).join('\n');
      }

      case 'onerow-sq':
      case 'onerow-dq': {
        var q = format === 'onerow-sq' ? "'" : '"';
        var parts = [];
        rows.forEach(function (r) {
          r.forEach(function (v) { parts.push(quoteFlat(v, q)); });
        });
        return parts.join(', ');
      }

      case 'md': {
        var widths = headers.map(function (h, i) {
          var max = h.length;
          rows.forEach(function (r) {
            var len = (r[i] || '').length;
            if (len > max) max = len;
          });
          return Math.max(max, 3);
        });
        var pad = function (s, w) { return s + ' '.repeat(Math.max(0, w - s.length)); };
        var text = '| ' + headers.map(function (h, i) { return pad(h, widths[i]); }).join(' | ') + ' |\n';
        text += '|' + widths.map(function (w) { return '-'.repeat(w + 2); }).join('|') + '|\n';
        text += rows.map(function (r) {
          return '| ' + r.map(function (v, i) { return pad(v || '', widths[i]); }).join(' | ') + ' |';
        }).join('\n');
        return text;
      }

      case 'json': {
        var arr = rows.map(function (r) {
          var obj = {};
          headers.forEach(function (h, i) { obj[h || ('col' + i)] = r[i]; });
          return obj;
        });
        return JSON.stringify(arr, null, 2);
      }

      default:
        return '';
    }
  }

  // ---- standard copy menu items ----
  function buildCopyMenuItems(onCopy, extra) {
    var items = [
      { label: 'Copy', onClick: function () { onCopy('tsv'); } },
      { label: 'Copy as One-row (SQL)', onClick: function () { onCopy('onerow-sq'); } },
      { label: 'Copy as One-row (JSON)', onClick: function () { onCopy('onerow-dq'); } },
      { label: 'Copy as CSV', onClick: function () { onCopy('csv'); } },
      { label: 'Copy as TSV (Slack)', onClick: function () { onCopy('tsv-header'); } },
      { label: 'Copy as Markdown', onClick: function () { onCopy('md'); } },
      { label: 'Copy as JSON', onClick: function () { onCopy('json'); } },
    ];
    if (extra && extra.length) {
      items.push({ separator: true });
      for (var i = 0; i < extra.length; i++) items.push(extra[i]);
    }
    return items;
  }

  // ---- cell selection manager ----
  /**
   * createSelectionManager(opts) -> manager
   *
   * opts.cellSelector   CSS selector for selectable cells (required).
   * opts.tableSelector   CSS selector for managed tables (required).
   * opts.getCellIndex(td)   -> { row: number, col: number }
   * opts.getCellText(table, row, col) -> string
   * opts.getHeaders(table, colIdxs)   -> string[]
   * opts.onCopy(table, format)   Optional override for copy (skips default).
   * opts.extraContextItems(table) -> item[]   Appended to context menu.
   * opts.onSelectionChange(table, sel)   Called after selection UI update.
   */
  function createSelectionManager(opts) {
    var cellSelector = opts.cellSelector;
    var tableSelector = opts.tableSelector;
    var getCellIdx = opts.getCellIndex;
    var getCellTxt = opts.getCellText || defaultGetCellText;
    var getHdrs = opts.getHeaders || defaultGetHeaders;
    var onCopyOverride = opts.onCopy || null;
    var extraItems = opts.extraContextItems || null;
    var onSelChange = opts.onSelectionChange || null;

    var selections = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    var activeTable = null;
    var anchorCell = null;
    var isDragging = false;
    var dragTable = null;
    var lastDragCell = null;
    var dragRafId = null;
    var pendingDragPoint = null;

    function getSel(table) {
      if (!selections) return new Set();
      var s = selections.get(table);
      if (!s) { s = new Set(); selections.set(table, s); }
      return s;
    }

    function defaultGetCellText(table, r, c) {
      var tbody = table.tBodies[0];
      if (!tbody) return '';
      var tr = tbody.rows[r];
      if (!tr) return '';
      var td = tr.cells[c];
      if (!td) return '';
      return td.textContent.replace(/^\s+|\s+$/g, '');
    }

    function defaultGetHeaders(table, colIdxs) {
      var thead = table.tHead;
      var headerRow = thead && thead.rows[0];
      return colIdxs.map(function (c) {
        var th = headerRow && headerRow.cells[c];
        return th ? th.textContent.replace(/^\s+|\s+$/g, '') : '';
      });
    }

    function clearTableSel(table) {
      table.querySelectorAll('tbody td.cell-selected').forEach(function (td) {
        td.classList.remove('cell-selected', 'sel-top', 'sel-bottom', 'sel-left', 'sel-right');
      });
    }

    function clearOtherSelections(exceptTable) {
      document.querySelectorAll(tableSelector).forEach(function (t) {
        if (t === exceptTable) return;
        var s = selections ? selections.get(t) : null;
        if (s && s.size > 0) { s.clear(); clearTableSel(t); }
      });
    }

    function updateSelectionUI(table) {
      var sel = getSel(table);
      clearTableSel(table);
      var tbody = table.tBodies[0];
      if (!tbody) return;
      sel.forEach(function (key) {
        var p = parseKey(key);
        var tr = tbody.rows[p.row];
        if (!tr) return;
        var td = tr.cells[p.col];
        if (!td) return;
        td.classList.add('cell-selected');
        if (!sel.has(cellKey(p.row - 1, p.col))) td.classList.add('sel-top');
        if (!sel.has(cellKey(p.row + 1, p.col))) td.classList.add('sel-bottom');
        if (!sel.has(cellKey(p.row, p.col - 1))) td.classList.add('sel-left');
        if (!sel.has(cellKey(p.row, p.col + 1))) td.classList.add('sel-right');
      });
      if (onSelChange) onSelChange(table, sel);
    }

    function selectCellRange(table, r1, c1, r2, c2) {
      var sel = getSel(table);
      sel.clear();
      var minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
      var minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
      for (var r = minR; r <= maxR; r++)
        for (var c = minC; c <= maxC; c++)
          sel.add(cellKey(r, c));
      activeTable = table;
      updateSelectionUI(table);
    }

    function clearAllSelections() {
      document.querySelectorAll(tableSelector).forEach(function (t) {
        var s = selections ? selections.get(t) : null;
        if (s) s.clear();
        clearTableSel(t);
      });
      activeTable = null;
    }

    // --- extract selected data ---
    function extractSelectionData(table) {
      var sel = getSel(table);
      if (sel.size === 0) return null;
      var cells = [];
      sel.forEach(function (k) { cells.push(parseKey(k)); });
      var rowIdxs = [];
      var colIdxs = [];
      var seenR = {};
      var seenC = {};
      cells.forEach(function (p) {
        if (!seenR[p.row]) { seenR[p.row] = true; rowIdxs.push(p.row); }
        if (!seenC[p.col]) { seenC[p.col] = true; colIdxs.push(p.col); }
      });
      rowIdxs.sort(function (a, b) { return a - b; });
      colIdxs.sort(function (a, b) { return a - b; });
      var headers = getHdrs(table, colIdxs);
      var rows = rowIdxs.map(function (r) {
        return colIdxs.map(function (c) {
          return sel.has(cellKey(r, c)) ? getCellTxt(table, r, c) : '';
        });
      });
      return { headers: headers, rows: rows, rowIdxs: rowIdxs, colIdxs: colIdxs };
    }

    function doCopy(table, format) {
      if (onCopyOverride) { onCopyOverride(table, format); return; }
      var data = extractSelectionData(table);
      if (!data) return;
      var text = copyAsText(data.headers, data.rows, format);
      if (text && navigator.clipboard) navigator.clipboard.writeText(text);
    }

    // --- drag select ---
    function flushDrag() {
      dragRafId = null;
      if (!isDragging || !dragTable || !anchorCell || !pendingDragPoint) return;
      var pt = pendingDragPoint;
      pendingDragPoint = null;
      var el = document.elementFromPoint(pt.x, pt.y);
      if (!el) return;
      var td = el.closest ? el.closest('td') : null;
      if (!td || td.closest('table') !== dragTable) return;
      var idx = getCellIdx(td);
      if (lastDragCell && lastDragCell.row === idx.row && lastDragCell.col === idx.col) return;
      lastDragCell = idx;
      selectCellRange(dragTable, anchorCell.row, anchorCell.col, idx.row, idx.col);
    }

    function onMouseDown(e) {
      if (e.button !== 0) return;
      var td = e.target.closest ? e.target.closest(cellSelector) : null;
      if (!td) {
        if (!e.target.closest || !e.target.closest('.viewstor-ctx-menu')) clearAllSelections();
        return;
      }
      e.preventDefault();
      var table = td.closest('table');
      var idx = getCellIdx(td);
      clearOtherSelections(table);
      isDragging = true;
      dragTable = table;
      anchorCell = idx;
      lastDragCell = { row: idx.row, col: idx.col };
      activeTable = table;
      var sel = getSel(table);
      if (e.shiftKey && sel.size > 0) {
        var cells = [];
        sel.forEach(function (k) { cells.push(parseKey(k)); });
        var anchorR = Math.min.apply(null, cells.map(function (p) { return p.row; }));
        var anchorC = Math.min.apply(null, cells.map(function (p) { return p.col; }));
        selectCellRange(table, anchorR, anchorC, idx.row, idx.col);
      } else {
        sel.clear();
        sel.add(cellKey(idx.row, idx.col));
        updateSelectionUI(table);
      }
    }

    function onMouseMove(e) {
      if (!isDragging) return;
      pendingDragPoint = { x: e.clientX, y: e.clientY };
      if (dragRafId === null) dragRafId = requestAnimationFrame(flushDrag);
    }

    function onMouseUp() {
      isDragging = false;
      dragTable = null;
      lastDragCell = null;
      if (dragRafId !== null) { cancelAnimationFrame(dragRafId); dragRafId = null; }
      pendingDragPoint = null;
    }

    function onContextMenu(e) {
      var td = e.target.closest ? e.target.closest(cellSelector) : null;
      if (!td) return;
      var table = td.closest('table');
      var sel = getSel(table);
      if (sel.size === 0) {
        var idx = getCellIdx(td);
        clearOtherSelections(table);
        sel.add(cellKey(idx.row, idx.col));
        activeTable = table;
        updateSelectionUI(table);
      }
      e.preventDefault();
      if (!root.ViewstorContextMenu) return;
      var extra = extraItems ? extraItems(table) : null;
      root.ViewstorContextMenu.open({
        x: e.clientX,
        y: e.clientY,
        items: buildCopyMenuItems(function (fmt) { doCopy(table, fmt); }, extra),
      });
    }

    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyC' || e.key === 'c' || e.key === 'C')) {
        if (!activeTable) return;
        var sel = getSel(activeTable);
        if (sel.size === 0) return;
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        doCopy(activeTable, 'tsv');
      }
    }

    // --- attach ---
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown);

    // --- public API ---
    return {
      getSelection: function (table) { return getSel(table); },
      getActiveTable: function () { return activeTable; },
      clearAll: clearAllSelections,
      extractSelectionData: extractSelectionData,
      doCopy: doCopy,
      updateSelectionUI: updateSelectionUI,
      destroy: function () {
        document.removeEventListener('mousedown', onMouseDown);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('contextmenu', onContextMenu);
        document.removeEventListener('keydown', onKeyDown);
      },
    };
  }

  var api = {
    cellKey: cellKey,
    parseKey: parseKey,
    copyAsText: copyAsText,
    buildCopyMenuItems: buildCopyMenuItems,
    createSelectionManager: createSelectionManager,
  };

  root.ViewstorDataGrid = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : this);
