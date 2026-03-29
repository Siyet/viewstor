import * as vscode from 'vscode';
import { QueryResult } from '../types/query';
import path from 'path';

export interface ShowOptions {
  connectionId?: string;
  tableName?: string;
  schema?: string;
  pkColumns?: string[];
  color?: string;
  readonly?: boolean;
  pageSize?: number;
  currentPage?: number;
  totalRowCount?: number;
  isEstimatedCount?: boolean;
  orderBy?: Array<{ column: string; direction: 'asc' | 'desc' }>;
}

const PAGE_SIZE_OPTIONS = [50, 100, 500, 1000];
const DEFAULT_PAGE_SIZE = 100;

export class ResultPanelManager {
  private panels = new Map<string, vscode.WebviewPanel>();
  private messageDisposables = new Map<string, vscode.Disposable>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  show(result: QueryResult, title?: string, opts?: ShowOptions) {
    const panelTitle = title || 'Query Results';
    const panelKey = panelTitle;
    const isTableMode = !!(opts?.connectionId && opts?.tableName);

    let panel = this.panels.get(panelKey);
    if (panel) {
      // Reveal in its current position (wherever the user moved it)
      panel.reveal();
    } else {
      // Table data → same column; query results → beside (user can drag to bottom)
      const viewColumn = isTableMode ? vscode.ViewColumn.One : vscode.ViewColumn.Beside;
      panel = vscode.window.createWebviewPanel(
        'viewstor.results',
        panelTitle,
        viewColumn,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))],
        },
      );
      panel.onDidDispose(() => {
        this.panels.delete(panelKey);
        this.messageDisposables.get(panelKey)?.dispose();
        this.messageDisposables.delete(panelKey);
      });
      this.panels.set(panelKey, panel);
    }

    panel.webview.html = buildResultHtml(result, opts);

    this.messageDisposables.get(panelKey)?.dispose();

    const ctx = opts || {};
    const disposable = panel.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'changePage':
          if (isTableMode) {
            vscode.commands.executeCommand('viewstor._fetchPage',
              ctx.connectionId, ctx.tableName, ctx.schema, msg.page, msg.pageSize, msg.orderBy);
          }
          break;
        case 'changePageSize':
          if (isTableMode) {
            vscode.commands.executeCommand('viewstor._fetchPage',
              ctx.connectionId, ctx.tableName, ctx.schema, 0, msg.pageSize, msg.orderBy);
          }
          break;
        case 'reloadWithSort':
          if (isTableMode) {
            vscode.commands.executeCommand('viewstor._fetchPage',
              ctx.connectionId, ctx.tableName, ctx.schema, 0, msg.pageSize, msg.orderBy);
          }
          break;
        case 'refreshCount':
          if (isTableMode) {
            vscode.commands.executeCommand('viewstor._refreshCount',
              ctx.connectionId, ctx.tableName, ctx.schema, panelKey);
          }
          break;
        case 'cancelQuery':
          if (ctx.connectionId) {
            vscode.commands.executeCommand('viewstor._cancelQuery', ctx.connectionId);
          }
          break;
        case 'saveEdits':
          vscode.commands.executeCommand('viewstor._saveEdits',
            ctx.connectionId, ctx.tableName, ctx.schema, ctx.pkColumns, msg.edits);
          break;
        case 'openJsonInTab':
          vscode.commands.executeCommand('viewstor._openJsonInTab', msg.json);
          break;
        case 'exportAllData':
          if (isTableMode) {
            vscode.commands.executeCommand('viewstor._exportAllData',
              ctx.connectionId, ctx.tableName, ctx.schema, msg.format, msg.orderBy);
          } else {
            vscode.commands.executeCommand('viewstor.exportResults',
              { columns: msg.columns, rows: msg.rows, format: msg.format });
          }
          break;
      }
    });
    this.messageDisposables.set(panelKey, disposable);
  }

  postMessage(panelKey: string, message: unknown) {
    this.panels.get(panelKey)?.webview.postMessage(message);
  }
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}

function buildResultHtml(result: QueryResult, opts?: ShowOptions): string {
  if (result.error) {
    return `<!DOCTYPE html><html><body>
      <h3 style="color:var(--vscode-errorForeground)">Query Error</h3>
      <pre>${esc(result.error)}</pre>
    </body></html>`;
  }

  const colorBorder = opts?.color ? `border-top: 3px solid ${opts.color};` : '';
  const colorBorderBottom = opts?.color ? `border-bottom: 3px solid ${opts.color};` : '';
  const activePageSize = opts?.pageSize || DEFAULT_PAGE_SIZE;
  const currentPage = opts?.currentPage || 0;
  const totalRowCount = opts?.totalRowCount ?? result.rows.length;
  const isEstimatedCount = !!opts?.isEstimatedCount;
  const isTableMode = !!(opts?.connectionId && opts?.tableName);

  return `<!DOCTYPE html>
<html>
<head>
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); padding:0; margin:0; font-size:13px; display:flex; flex-direction:column; height:100vh; }
  .toolbar { padding:6px 12px; font-size:12px; color:var(--vscode-descriptionForeground); display:flex; align-items:center; gap:12px; border-bottom:1px solid var(--vscode-panel-border); flex-shrink:0; ${colorBorder} }
  .footer { padding:6px 12px; font-size:12px; color:var(--vscode-descriptionForeground); display:flex; align-items:center; gap:12px; border-top:1px solid var(--vscode-panel-border); flex-shrink:0; ${colorBorderBottom} }
  .toolbar select, .footer select { background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); padding:2px 6px; font-size:12px; border-radius:2px; }
  .toolbar button, .footer button { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); border:none; padding:2px 8px; font-size:12px; cursor:pointer; border-radius:2px; }
  .toolbar button:hover, .footer button:hover { background:var(--vscode-button-secondaryHoverBackground); }
  .toolbar button:disabled, .footer button:disabled { opacity:0.5; cursor:default; }
  .btn-primary { background:var(--vscode-button-background) !important; color:var(--vscode-button-foreground) !important; }
  .btn-primary:hover { background:var(--vscode-button-hoverBackground) !important; }
  .container { overflow:auto; flex:1; position:relative; }
  table { border-collapse:collapse; }
  th, td { padding:4px 8px; border:1px solid var(--vscode-panel-border); text-align:left; white-space:nowrap; max-width:400px; overflow:hidden; text-overflow:ellipsis; user-select:none; }
  th { position:sticky; top:0; background:var(--vscode-editor-background); font-weight:600; z-index:1; cursor:pointer; }
  .row-num, .row-num-header { position:sticky; left:0; z-index:2; background:var(--vscode-editor-background); color:var(--vscode-descriptionForeground); text-align:right; padding:4px 8px; border-right:2px solid var(--vscode-panel-border); min-width:40px; max-width:none; font-size:11px; cursor:default; user-select:none; }
  .row-num-header { z-index:3; top:0; font-weight:600; cursor:default; }
  th:hover { background:var(--vscode-list-hoverBackground); }
  th small { color:var(--vscode-descriptionForeground); font-weight:normal; }
  th .sort-icon { margin-left:4px; font-size:10px; opacity:0.7; }
  tr:hover { background:var(--vscode-list-hoverBackground); }
  td.selected { background:color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 30%, transparent) !important; }
  td.sel-top { border-top:2px solid var(--vscode-focusBorder) !important; }
  td.sel-bottom { border-bottom:2px solid var(--vscode-focusBorder) !important; }
  td.sel-left { border-left:2px solid var(--vscode-focusBorder) !important; }
  td.sel-right { border-right:2px solid var(--vscode-focusBorder) !important; }
  .ctx-menu { position:fixed; background:var(--vscode-menu-background, var(--vscode-dropdown-background)); border:1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius:4px; box-shadow:0 2px 8px rgba(0,0,0,0.3); z-index:50; padding:4px 0; min-width:160px; }
  .ctx-menu button { display:block; width:100%; text-align:left; padding:6px 12px; background:none; border:none; color:var(--vscode-menu-foreground, var(--vscode-foreground)); font-size:12px; cursor:pointer; }
  .ctx-menu button:hover { background:var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
  td.has-handle { overflow:visible !important; }
  .resize-handle { position:absolute; bottom:-5px; right:-5px; width:8px; height:8px; background:var(--vscode-focusBorder); cursor:crosshair; z-index:5; border:2px solid var(--vscode-editor-background); border-radius:1px; }
  .null-val { color:var(--vscode-descriptionForeground); font-style:italic; }
  td.json-cell { cursor:pointer; }
  td.search-hit { background:color-mix(in srgb, var(--vscode-editor-findMatchHighlightBackground, #ea5c0055) 60%, transparent) !important; }
  td.search-focus { outline:2px solid var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder)) !important; background:color-mix(in srgb, var(--vscode-editor-findMatchBackground, #515c6a) 70%, transparent) !important; }
  .search-input { padding:2px 6px; font-size:12px; border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border-radius:2px; width:160px; outline:none; }
  .search-input:focus { border-color:var(--vscode-focusBorder); }
  .search-count { font-size:11px; min-width:30px; }
  td.editing { padding:0; }
  .loading-overlay { position:absolute; inset:0; background:var(--vscode-editor-background); opacity:0.7; z-index:10; display:flex; align-items:center; justify-content:center; font-size:14px; color:var(--vscode-descriptionForeground); }
  td.editing input, td.editing select { width:100%; padding:4px 8px; border:2px solid var(--vscode-focusBorder); background:var(--vscode-input-background); color:var(--vscode-input-foreground); font-family:inherit; font-size:inherit; outline:none; }
  td.modified { border-left:3px solid var(--vscode-inputValidation-warningBorder); }
  .popup { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:60vw; max-height:70vh; background:var(--vscode-editor-background); border:1px solid var(--vscode-panel-border); border-radius:4px; box-shadow:0 4px 20px rgba(0,0,0,0.4); z-index:100; display:flex; flex-direction:column; }
  .popup-header { padding:8px 12px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--vscode-panel-border); }
  .popup-body { flex:1; overflow:auto; padding:12px; }
  .json-editor { width:100%; min-height:200px; max-height:50vh; font-family:var(--vscode-editor-font-family); font-size:var(--vscode-editor-font-size); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding:8px; white-space:pre; tab-size:2; outline:none; resize:vertical; }
  .json-editor:focus { border-color:var(--vscode-focusBorder); }
  .export-form label { display:block; margin-bottom:4px; font-size:12px; color:var(--vscode-descriptionForeground); }
  .export-form select { width:100%; margin-bottom:12px; }
  .export-form p { font-size:12px; color:var(--vscode-descriptionForeground); margin:0 0 12px; }
  .overlay { position:fixed; inset:0; background:rgba(0,0,0,0.3); z-index:99; }
  .hidden { display:none; }
</style>
</head>
<body>
  <div class="toolbar">
    <span id="statsInfo">${result.executionTimeMs}ms${result.truncated ? ' · truncated' : ''}${result.affectedRows !== undefined ? ' · ' + result.affectedRows + ' affected' : ''}</span>
    <input type="text" id="searchInput" class="search-input" placeholder="Search..." />
    <span id="searchCount" class="search-count"></span>
    <span style="flex:1"></span>
    <button id="exportBtn">Export</button>
    <button id="saveBtn" class="btn-primary hidden">Save Changes</button>
    <button id="discardBtn" class="hidden">Discard</button>
    <label>Rows/page: <select id="pageSize">
      ${PAGE_SIZE_OPTIONS.map(n => `<option value="${n}"${n === activePageSize ? ' selected' : ''}>${n}</option>`).join('')}
    </select></label>
    <button id="prevPage" disabled>&lt;</button>
    <span id="pageInfo"></span>
    <button id="nextPage">&gt;</button>
  </div>
  <div class="container">
    <div id="loadingOverlay" class="loading-overlay hidden">
      <div style="text-align:center;">
        <div>Loading...</div>
        <button id="cancelQuery" style="margin-top:8px;" class="btn-primary">Cancel</button>
      </div>
    </div>
    <table>
      <thead><tr id="headerRow"></tr></thead>
      <tbody id="dataBody"></tbody>
    </table>
  </div>
  <div class="footer">
    <span id="footerRowCount"></span>
    <button id="refreshCount" title="Get exact row count" style="font-size:11px;padding:1px 5px;">⟳</button>
    <span style="flex:1"></span>
    <button id="footerPrev" disabled>&lt;</button>
    <span id="footerPageInfo"></span>
    <button id="footerNext">&gt;</button>
  </div>
  <div id="overlay" class="overlay hidden"></div>
  <div id="jsonPopup" class="popup hidden">
    <div class="popup-header">
      <span>JSON Viewer</span>
      <div style="display:flex;gap:6px;">
        <button id="jsonOpenTab" class="btn-primary">Open in Tab</button>
        <button id="jsonClose">Close</button>
      </div>
    </div>
    <div class="popup-body">
      <textarea id="jsonEditor" class="json-editor"></textarea>
    </div>
  </div>
  <div id="exportPopup" class="popup hidden" style="width:360px;">
    <div class="popup-header">
      <span>Export Data</span>
      <button id="exportClose">Close</button>
    </div>
    <div class="popup-body export-form">
      <label for="exportFormat">Format</label>
      <select id="exportFormat">
        <option value="csv">CSV</option>
        <option value="tsv">TSV</option>
        <option value="csv-semicolon">CSV (semicolon)</option>
        <option value="json">JSON</option>
        <option value="markdown">Markdown Table</option>
      </select>
      <p id="exportInfo"></p>
      <button id="exportConfirm" class="btn-primary">Export</button>
    </div>
  </div>
<script>
(function() {
  const vscode = acquireVsCodeApi();
  const columns = ${safeJsonForScript(result.columns)};
  const pageRows = ${safeJsonForScript(result.rows)};
  const pkColumns = ${safeJsonForScript(opts?.pkColumns || [])};
  const IS_READONLY = ${!!opts?.readonly};
  const IS_TABLE_MODE = ${isTableMode};
  const TOTAL_ROW_COUNT = ${totalRowCount};
  const IS_ESTIMATED_COUNT = ${isEstimatedCount};
  let currentPage = ${currentPage};
  let pageSize = ${activePageSize};
  let totalPages = Math.max(1, Math.ceil(TOTAL_ROW_COUNT / pageSize));

  let sortColumns = ${safeJsonForScript(opts?.orderBy || [])};

  let selectedCells = new Set();
  let anchorCell = null;

  let pendingEdits = new Map();
  const originalRows = JSON.parse(JSON.stringify(pageRows));

  const jsonTypes = new Set(['json','jsonb','Object']);
  const boolTypes = new Set(['boolean','Bool']);

  function escHtml(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

  function formatCell(value, col) {
    if (value === null || value === undefined) return '<span class="null-val">NULL</span>';
    // PostgreSQL arrays: display with {curly braces} instead of [square brackets]
    if (Array.isArray(value)) {
      const str = pgArrayToString(value);
      return escHtml(str.length > 60 ? str.substring(0, 60) + '...' : str);
    }
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (jsonTypes.has(col.dataType)) {
      const short = str.length > 60 ? str.substring(0, 60) + '...' : str;
      return escHtml(short);
    }
    return escHtml(str);
  }

  function pgArrayToString(arr) {
    return '{' + arr.map(function(v) {
      if (v === null || v === undefined) return 'NULL';
      if (Array.isArray(v)) return pgArrayToString(v);
      var s = String(v);
      if (s === '' || s.includes(',') || s.includes('"') || s.includes('{') || s.includes('}') || s.includes(' ')) return '"' + s.replace(/"/g, '\\\\"') + '"';
      return s;
    }).join(',') + '}';
  }

  // --- Rendering ---
  function renderHeader() {
    const headerRow = document.getElementById('headerRow');
    headerRow.innerHTML = '<th class="row-num-header">#</th>' + columns.map((c, i) => {
      const sortIdx = sortColumns.findIndex(s => s.column === c.name);
      let icon = '';
      if (sortIdx >= 0) {
        const dir = sortColumns[sortIdx].direction;
        icon = '<span class="sort-icon">' + (dir === 'asc' ? '▲' : '▼');
        if (sortColumns.length > 1) icon += '<sup>' + (sortIdx+1) + '</sup>';
        icon += '</span>';
      }
      return '<th data-col="' + i + '">' + escHtml(c.name) + icon + '<br><small>' + escHtml(c.dataType) + '</small></th>';
    }).join('');
    headerRow.querySelectorAll('th[data-col]').forEach(th => {
      th.addEventListener('click', (e) => handleSortClick(Number(th.dataset.col), e.shiftKey));
    });
  }

  function renderPage() {
    const offset = currentPage * pageSize;
    const body = document.getElementById('dataBody');
    body.innerHTML = pageRows.map((row, ri) => {
      const globalRi = offset + ri;
      const rowNum = '<td class="row-num">' + (globalRi + 1) + '</td>';
      const cells = columns.map((c, ci) => {
        const key = ri + ':' + c.name;
        const modClass = pendingEdits.has(key) ? ' modified' : '';
        const jsonClass = jsonTypes.has(c.dataType) && row[c.name] !== null && row[c.name] !== undefined ? ' json-cell' : '';
        return '<td data-row="' + ri + '" data-col="' + ci + '" class="' + modClass + jsonClass + '">' + formatCell(row[c.name], c) + '</td>';
      }).join('');
      return '<tr>' + rowNum + cells + '</tr>';
    }).join('');

    totalPages = Math.max(1, Math.ceil(TOTAL_ROW_COUNT / pageSize));
    const info = 'Page ' + (currentPage+1) + '/' + totalPages;
    document.getElementById('pageInfo').textContent = info;
    document.getElementById('footerPageInfo').textContent = info;
    const prefix = IS_ESTIMATED_COUNT ? '~' : '';
    document.getElementById('footerRowCount').textContent = prefix + TOTAL_ROW_COUNT + ' row' + (TOTAL_ROW_COUNT !== 1 ? 's' : '');
    document.getElementById('prevPage').disabled = currentPage === 0;
    document.getElementById('nextPage').disabled = currentPage >= totalPages - 1;
    document.getElementById('footerPrev').disabled = currentPage === 0;
    document.getElementById('footerNext').disabled = currentPage >= totalPages - 1;

    attachCellHandlers();
  }

  function attachCellHandlers() {
    document.getElementById('dataBody').querySelectorAll('td[data-row]').forEach(td => {
      td.addEventListener('click', (e) => handleCellClick(td, e));
      td.addEventListener('dblclick', () => {
        const ri = Number(td.dataset.row);
        const ci = Number(td.dataset.col);
        const col = columns[ci];
        if (jsonTypes.has(col.dataType)) {
          const val = pageRows[ri][col.name];
          if (val !== null && val !== undefined) {
            const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
            showJsonPopup(str, ri, col);
          }
          return;
        }
        if (!IS_READONLY) startEdit(td, ci, ri);
      });
    });
  }

  // --- Selection (drag-select + resize handle + unified border) ---
  function cellKey(r, c) { return r + ':' + c; }
  let isDragging = false;
  let isResizing = false;
  let didDrag = false;

  function handleCellClick(td, e) {
    closeContextMenu();
    if (didDrag) { didDrag = false; return; } // Don't reset after drag
    const row = Number(td.dataset.row);
    const col = Number(td.dataset.col);
    if (e.shiftKey && anchorCell) {
      selectRange(anchorCell.row, anchorCell.col, row, col, e.ctrlKey || e.metaKey);
    } else if (e.ctrlKey || e.metaKey) {
      const k = cellKey(row, col);
      if (selectedCells.has(k)) selectedCells.delete(k); else selectedCells.add(k);
      anchorCell = { row, col };
    } else {
      selectedCells.clear();
      selectedCells.add(cellKey(row, col));
      anchorCell = { row, col };
    }
    updateSelectionUI();
  }

  function selectRange(r1, c1, r2, c2, additive) {
    if (!additive) selectedCells.clear();
    const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
    const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    for (let r = minR; r <= maxR; r++)
      for (let c = minC; c <= maxC; c++)
        selectedCells.add(cellKey(r, c));
  }

  // Drag-select with mouse
  document.getElementById('dataBody').addEventListener('mousedown', (e) => {
    closeContextMenu();
    // Check if clicking the resize handle
    if (e.target.classList && e.target.classList.contains('resize-handle')) {
      isResizing = true;
      e.preventDefault();
      return;
    }
    const td = e.target.closest('td[data-row]');
    if (!td || e.button !== 0) return;
    isDragging = true;
    didDrag = false;
    const row = Number(td.dataset.row);
    const col = Number(td.dataset.col);
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
      selectedCells.clear();
      anchorCell = { row, col };
      selectedCells.add(cellKey(row, col));
      updateSelectionUI();
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (isResizing && anchorCell) {
      const td = document.elementFromPoint(e.clientX, e.clientY)?.closest('td[data-row]');
      if (!td) return;
      // Resize: keep anchor, extend to new cell
      const cells = [...selectedCells].map(k => { const [r,c] = k.split(':').map(Number); return {r,c}; });
      const minR = Math.min(...cells.map(c => c.r));
      const minC = Math.min(...cells.map(c => c.c));
      selectRange(minR, minC, Number(td.dataset.row), Number(td.dataset.col), false);
      updateSelectionUI();
      didDrag = true;
      return;
    }
    if (!isDragging || !anchorCell) return;
    const td = document.elementFromPoint(e.clientX, e.clientY)?.closest('td[data-row]');
    if (!td) return;
    selectRange(anchorCell.row, anchorCell.col, Number(td.dataset.row), Number(td.dataset.col), false);
    updateSelectionUI();
    didDrag = true;
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    isResizing = false;
  });

  function updateSelectionUI() {
    // Remove old resize handles
    document.querySelectorAll('.resize-handle').forEach(el => el.remove());
    document.querySelectorAll('td.has-handle').forEach(td => { td.classList.remove('has-handle'); td.style.position = ''; });
    let maxR = -1, maxC = -1;
    document.querySelectorAll('#dataBody td[data-row]').forEach(td => {
      td.classList.remove('selected', 'sel-top', 'sel-bottom', 'sel-left', 'sel-right');
      const r = Number(td.dataset.row), c = Number(td.dataset.col);
      if (selectedCells.has(cellKey(r, c))) {
        td.classList.add('selected');
        if (!selectedCells.has(cellKey(r - 1, c))) td.classList.add('sel-top');
        if (!selectedCells.has(cellKey(r + 1, c))) td.classList.add('sel-bottom');
        if (!selectedCells.has(cellKey(r, c - 1))) td.classList.add('sel-left');
        if (!selectedCells.has(cellKey(r, c + 1))) td.classList.add('sel-right');
        if (r > maxR || (r === maxR && c > maxC)) { maxR = r; maxC = c; }
      }
    });
    // Add resize handle to bottom-right selected cell
    if (selectedCells.size > 0) {
      const brTd = document.querySelector('td[data-row="' + maxR + '"][data-col="' + maxC + '"]');
      if (brTd) {
        brTd.style.position = 'relative';
        brTd.classList.add('has-handle');
        const handle = document.createElement('div');
        handle.className = 'resize-handle';
        brTd.appendChild(handle);
      }
    }
  }

  // --- Context menu ---
  let ctxMenuEl = null;
  function showContextMenu(e) {
    e.preventDefault();
    closeContextMenu();
    if (selectedCells.size === 0) return;
    ctxMenuEl = document.createElement('div');
    ctxMenuEl.className = 'ctx-menu';
    ctxMenuEl.style.left = e.clientX + 'px';
    ctxMenuEl.style.top = e.clientY + 'px';
    const formats = [
      { label: 'Copy', fmt: 'tsv' },
      { label: 'Copy as CSV', fmt: 'csv' },
      { label: 'Copy as TSV', fmt: 'tsv-explicit' },
      { label: 'Copy as Markdown', fmt: 'md' },
      { label: 'Copy as JSON', fmt: 'json' },
    ];
    formats.forEach(f => {
      const btn = document.createElement('button');
      btn.textContent = f.label;
      btn.addEventListener('click', () => { copySelection(f.fmt); closeContextMenu(); });
      ctxMenuEl.appendChild(btn);
    });
    document.body.appendChild(ctxMenuEl);
  }
  function closeContextMenu() { if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; } }
  document.getElementById('dataBody').addEventListener('contextmenu', showContextMenu);
  document.addEventListener('click', closeContextMenu);

  function getSelectionData() {
    const cells = [...selectedCells].map(k => { const [r,c] = k.split(':').map(Number); return {r,c}; });
    const rowIdxs = [...new Set(cells.map(c => c.r))].sort((a,b) => a-b);
    const colIdxs = [...new Set(cells.map(c => c.c))].sort((a,b) => a-b);
    return { rowIdxs, colIdxs };
  }

  function getSelectedValues() {
    const { rowIdxs, colIdxs } = getSelectionData();
    return rowIdxs.map(r => colIdxs.map(c => {
      if (!selectedCells.has(cellKey(r, c))) return '';
      const val = pageRows[r][columns[c].name];
      return val === null || val === undefined ? '' : (typeof val === 'object' ? JSON.stringify(val) : String(val));
    }));
  }

  function copySelection(fmt) {
    const { colIdxs } = getSelectionData();
    const headers = colIdxs.map(c => columns[c].name);
    const rows = getSelectedValues();
    let text = '';
    switch (fmt) {
      case 'tsv': text = rows.map(r => r.join('\\t')).join('\\n'); break;
      case 'tsv-explicit': text = headers.join('\\t') + '\\n' + rows.map(r => r.join('\\t')).join('\\n'); break;
      case 'csv': text = headers.join(',') + '\\n' + rows.map(r => r.map(v => v.includes(',') || v.includes('"') ? '"' + v.replace(/"/g, '""') + '"' : v).join(',')).join('\\n'); break;
      case 'md': {
        text = '| ' + headers.join(' | ') + ' |\\n';
        text += '|' + headers.map(() => '---').join('|') + '|\\n';
        text += rows.map(r => '| ' + r.join(' | ') + ' |').join('\\n');
        break;
      }
      case 'json': {
        const arr = rows.map(r => { const obj = {}; colIdxs.forEach((c, i) => { obj[columns[c].name] = r[i]; }); return obj; });
        text = JSON.stringify(arr, null, 2);
        break;
      }
    }
    navigator.clipboard.writeText(text);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeAllPopups(); closeContextMenu(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC' && selectedCells.size > 0) {
      e.preventDefault();
      copySelection('tsv');
    }
  });

  // --- Sorting ---
  function handleSortClick(colIdx, shiftKey) {
    if (pendingEdits.size > 0) { if (!confirm('Unsaved changes will be lost. Continue?')) return; }
    const colName = columns[colIdx].name;
    const existing = sortColumns.findIndex(s => s.column === colName);
    if (shiftKey) {
      if (existing >= 0) {
        if (sortColumns[existing].direction === 'asc') sortColumns[existing].direction = 'desc';
        else sortColumns.splice(existing, 1);
      } else { sortColumns.push({ column: colName, direction: 'asc' }); }
    } else {
      if (existing >= 0 && sortColumns.length === 1) {
        if (sortColumns[0].direction === 'asc') sortColumns[0].direction = 'desc';
        else sortColumns = [];
      } else { sortColumns = [{ column: colName, direction: 'asc' }]; }
    }
    showLoading();
    vscode.postMessage({ type: 'reloadWithSort', orderBy: sortColumns, pageSize });
  }

  // --- Editing ---
  function startEdit(td, colIdx, rowIdx) {
    if (td.classList.contains('editing')) return;
    const col = columns[colIdx];
    const currentVal = pageRows[rowIdx][col.name];
    const valStr = currentVal === null || currentVal === undefined ? '' : (typeof currentVal === 'object' ? JSON.stringify(currentVal) : String(currentVal));
    td.classList.add('editing');
    if (col.enumValues && col.enumValues.length > 0) {
      makeSelect(td, col, rowIdx, valStr, currentVal, col.enumValues);
    } else if (boolTypes.has(col.dataType)) {
      const opts = ['true', 'false'];
      if (col.nullable) opts.push('__NULL__');
      makeSelectBool(td, col, rowIdx, currentVal, opts);
    } else {
      makeInput(td, col, rowIdx, valStr);
    }
  }

  function makeSelect(td, col, rowIdx, valStr, currentVal, options) {
    const select = document.createElement('select');
    if (col.nullable) { const o = document.createElement('option'); o.value='__NULL__'; o.textContent='(NULL)'; if(currentVal===null||currentVal===undefined) o.selected=true; select.appendChild(o); }
    options.forEach(v => { const o = document.createElement('option'); o.value=v; o.textContent=v; if(v===valStr) o.selected=true; select.appendChild(o); });
    select.addEventListener('change', () => finishEdit(td, col, rowIdx, select.value==='__NULL__'?null:select.value));
    select.addEventListener('blur', () => finishEdit(td, col, rowIdx, select.value==='__NULL__'?null:select.value));
    select.addEventListener('keydown', e => { if(e.key==='Escape') cancelEdit(td,col,rowIdx); });
    td.textContent=''; td.appendChild(select); select.focus();
  }

  function makeSelectBool(td, col, rowIdx, currentVal, options) {
    const select = document.createElement('select');
    options.forEach(v => { const o = document.createElement('option'); if(v==='__NULL__'){o.value='__NULL__';o.textContent='(NULL)';if(currentVal===null||currentVal===undefined)o.selected=true;}else{o.value=v;o.textContent=v;if(String(currentVal)===v)o.selected=true;} select.appendChild(o); });
    select.addEventListener('change', () => { let val=select.value==='__NULL__'?null:select.value==='true'; finishEdit(td,col,rowIdx,val); });
    select.addEventListener('blur', () => { let val=select.value==='__NULL__'?null:select.value==='true'; finishEdit(td,col,rowIdx,val); });
    select.addEventListener('keydown', e => { if(e.key==='Escape') cancelEdit(td,col,rowIdx); });
    td.textContent=''; td.appendChild(select); select.focus();
  }

  function makeInput(td, col, rowIdx, valStr) {
    const input = document.createElement('input');
    input.type='text'; input.value=valStr;
    input.addEventListener('blur', () => finishEdit(td, col, rowIdx, input.value===''?null:input.value));
    input.addEventListener('keydown', e => { if(e.key==='Enter') finishEdit(td,col,rowIdx,input.value===''?null:input.value); if(e.key==='Escape') cancelEdit(td,col,rowIdx); });
    td.textContent=''; td.appendChild(input); input.focus(); input.select();
  }

  function finishEdit(td, col, rowIdx, newVal) {
    td.classList.remove('editing');
    const oldVal = originalRows[rowIdx][col.name];
    if (jsonTypes.has(col.dataType) && typeof newVal === 'string') { try { newVal = JSON.parse(newVal); } catch {} }
    pageRows[rowIdx][col.name] = newVal;
    const newStr = typeof newVal === 'object' && newVal !== null ? JSON.stringify(newVal) : String(newVal);
    const oldStr = typeof oldVal === 'object' && oldVal !== null ? JSON.stringify(oldVal) : String(oldVal);
    if (newStr !== oldStr) {
      const pkValues = {};
      pkColumns.forEach(pk => { pkValues[pk] = originalRows[rowIdx][pk]; });
      if (!pendingEdits.has(rowIdx.toString())) pendingEdits.set(rowIdx.toString(), { rowIdx, changes: {}, pkValues });
      pendingEdits.get(rowIdx.toString()).changes[col.name] = newVal;
      td.classList.add('modified');
    } else {
      const edit = pendingEdits.get(rowIdx.toString());
      if (edit) { delete edit.changes[col.name]; if (Object.keys(edit.changes).length === 0) pendingEdits.delete(rowIdx.toString()); }
      td.classList.remove('modified');
    }
    td.innerHTML = formatCell(pageRows[rowIdx][col.name], col);
    updateSaveButtons();
    reattachCell(td, columns.indexOf(col), rowIdx);
  }

  function cancelEdit(td, col, rowIdx) {
    td.classList.remove('editing');
    td.innerHTML = formatCell(pageRows[rowIdx][col.name], col);
    reattachCell(td, columns.indexOf(col), rowIdx);
  }

  function reattachCell(td, colIdx, rowIdx) {
    td.addEventListener('click', (e) => handleCellClick(td, e));
    td.addEventListener('dblclick', () => {
      const col = columns[colIdx];
      if (jsonTypes.has(col.dataType)) {
        const val = pageRows[rowIdx][col.name];
        if (val !== null && val !== undefined) showJsonPopup(typeof val === 'object' ? JSON.stringify(val) : String(val), rowIdx, col);
        return;
      }
      if (!IS_READONLY) startEdit(td, colIdx, rowIdx);
    });
  }

  function updateSaveButtons() {
    const hasEdits = pendingEdits.size > 0;
    document.getElementById('saveBtn').classList.toggle('hidden', !hasEdits);
    document.getElementById('discardBtn').classList.toggle('hidden', !hasEdits);
  }

  document.getElementById('saveBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'saveEdits', edits: [...pendingEdits.values()] });
    pendingEdits.clear();
    for (let i = 0; i < pageRows.length; i++) originalRows[i] = JSON.parse(JSON.stringify(pageRows[i]));
    document.querySelectorAll('td.modified').forEach(td => td.classList.remove('modified'));
    updateSaveButtons();
  });

  document.getElementById('discardBtn').addEventListener('click', () => {
    for (let i = 0; i < pageRows.length; i++) pageRows[i] = JSON.parse(JSON.stringify(originalRows[i]));
    pendingEdits.clear();
    renderPage();
    updateSaveButtons();
  });

  // --- JSON Popup (editable) ---
  let jsonEditContext = null;
  function showJsonPopup(jsonStr, rowIdx, col) {
    jsonEditContext = { rowIdx, col };
    const editor = document.getElementById('jsonEditor');
    try { editor.value = JSON.stringify(JSON.parse(jsonStr), null, 2); } catch { editor.value = jsonStr; }
    document.getElementById('jsonPopup').classList.remove('hidden');
    document.getElementById('overlay').classList.remove('hidden');
    editor.focus();
  }
  function closeJsonPopup(save) {
    if (save && jsonEditContext && !IS_READONLY) {
      const editor = document.getElementById('jsonEditor');
      const { rowIdx, col } = jsonEditContext;
      const td = document.querySelector('td[data-row="' + rowIdx + '"][data-col="' + columns.indexOf(col) + '"]');
      if (td) finishEdit(td, col, rowIdx, editor.value);
    }
    jsonEditContext = null;
    document.getElementById('jsonPopup').classList.add('hidden');
    document.getElementById('overlay').classList.add('hidden');
  }
  document.getElementById('jsonClose').addEventListener('click', () => closeJsonPopup(false));
  document.getElementById('jsonOpenTab').addEventListener('click', () => {
    const editor = document.getElementById('jsonEditor');
    try { const pretty = JSON.stringify(JSON.parse(editor.value), null, 2); vscode.postMessage({ type: 'openJsonInTab', json: pretty }); }
    catch { vscode.postMessage({ type: 'openJsonInTab', json: editor.value }); }
    closeJsonPopup(false);
  });

  // --- Export Popup ---
  function showExportPopup() {
    document.getElementById('exportInfo').textContent = IS_TABLE_MODE
      ? 'Exports all ' + TOTAL_ROW_COUNT + ' rows (not just the current page).'
      : 'Exports ' + pageRows.length + ' rows from the current result.';
    document.getElementById('exportPopup').classList.remove('hidden');
    document.getElementById('overlay').classList.remove('hidden');
  }
  function closeExportPopup() {
    document.getElementById('exportPopup').classList.add('hidden');
    document.getElementById('overlay').classList.add('hidden');
  }
  document.getElementById('exportBtn').addEventListener('click', showExportPopup);
  document.getElementById('exportClose').addEventListener('click', closeExportPopup);
  document.getElementById('exportConfirm').addEventListener('click', () => {
    const fmt = document.getElementById('exportFormat').value;
    if (IS_TABLE_MODE) {
      vscode.postMessage({ type: 'exportAllData', format: fmt, orderBy: sortColumns });
    } else {
      vscode.postMessage({ type: 'exportAllData', format: fmt, columns, rows: pageRows });
    }
    closeExportPopup();
  });

  // --- Close all popups ---
  function closeAllPopups() {
    closeJsonPopup(false);
    closeExportPopup();
    document.getElementById('overlay').classList.add('hidden');
  }
  document.getElementById('overlay').addEventListener('click', closeAllPopups);

  // --- Pagination (server-side for table mode) ---
  function goPage(delta) {
    const np = currentPage + delta;
    if (np < 0 || np >= totalPages) return;
    if (pendingEdits.size > 0) { if (!confirm('Unsaved changes will be lost. Continue?')) return; }
    if (IS_TABLE_MODE) {
      showLoading();
      vscode.postMessage({ type: 'changePage', page: np, pageSize, orderBy: sortColumns });
    }
  }
  document.getElementById('prevPage').addEventListener('click', () => goPage(-1));
  document.getElementById('nextPage').addEventListener('click', () => goPage(1));
  document.getElementById('footerPrev').addEventListener('click', () => goPage(-1));
  document.getElementById('footerNext').addEventListener('click', () => goPage(1));

  document.getElementById('pageSize').addEventListener('change', (e) => {
    if (pendingEdits.size > 0) { if (!confirm('Unsaved changes will be lost. Continue?')) return; }
    pageSize = Number(e.target.value);
    if (IS_TABLE_MODE) {
      showLoading();
      vscode.postMessage({ type: 'changePageSize', pageSize, orderBy: sortColumns });
    }
  });

  function showLoading() { document.getElementById('loadingOverlay').classList.remove('hidden'); }
  function hideLoading() { document.getElementById('loadingOverlay').classList.add('hidden'); }

  document.getElementById('cancelQuery').addEventListener('click', () => {
    vscode.postMessage({ type: 'cancelQuery' });
    hideLoading();
  });

  document.getElementById('refreshCount').addEventListener('click', () => {
    if (IS_TABLE_MODE) {
      document.getElementById('refreshCount').disabled = true;
      vscode.postMessage({ type: 'refreshCount' });
    }
  });

  // Handle messages from extension
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'updateRowCount') {
      const btn = document.getElementById('refreshCount');
      btn.disabled = false;
      document.getElementById('footerRowCount').textContent = msg.count + ' row' + (msg.count !== 1 ? 's' : '');
    }
  });

  // --- Search ---
  let searchTerm = '';
  let searchHits = [];
  let searchIdx = -1;
  const searchInput = document.getElementById('searchInput');
  const searchCount = document.getElementById('searchCount');

  searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value.toLowerCase();
    searchIdx = -1;
    highlightSearch();
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && searchHits.length > 0) {
      e.preventDefault();
      searchIdx = (searchIdx + 1) % searchHits.length;
      focusSearchHit();
    }
  });

  function highlightSearch() {
    document.querySelectorAll('td.search-hit, td.search-focus').forEach(td => {
      td.classList.remove('search-hit');
      td.classList.remove('search-focus');
    });
    searchHits = [];
    if (!searchTerm) { searchCount.textContent = ''; return; }
    document.querySelectorAll('#dataBody td[data-row]').forEach(td => {
      const ri = Number(td.dataset.row);
      const ci = Number(td.dataset.col);
      const val = pageRows[ri][columns[ci].name];
      const str = val === null || val === undefined ? '' : (typeof val === 'object' ? JSON.stringify(val) : String(val));
      if (str.toLowerCase().includes(searchTerm)) {
        td.classList.add('search-hit');
        searchHits.push(td);
      }
    });
    searchCount.textContent = searchHits.length > 0 ? searchHits.length + ' found' : 'no match';
  }

  function focusSearchHit() {
    document.querySelectorAll('td.search-focus').forEach(td => td.classList.remove('search-focus'));
    if (searchIdx >= 0 && searchIdx < searchHits.length) {
      const td = searchHits[searchIdx];
      td.classList.add('search-focus');
      td.scrollIntoView({ block: 'center', inline: 'center' });
      searchCount.textContent = (searchIdx + 1) + ' / ' + searchHits.length;
    }
  }

  renderHeader();
  renderPage();
  if (!IS_READONLY) updateSaveButtons();
})();
</script>
</body>
</html>`;
}
