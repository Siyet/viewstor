import * as vscode from 'vscode';
import { QueryResult, QueryColumn } from '../types/query';
import { quoteIdentifier } from '../utils/queryHelpers';
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
  /** The SQL query used to fetch this data */
  query?: string;
  /** Database name for multi-DB connections */
  databaseName?: string;
  /** Database type (postgresql, sqlite, clickhouse, redis) — passed to chart for DB-specific SQL */
  databaseType?: string;
  /** Column metadata from getTableInfo — used for inline row insertion (nullable, defaultValue) */
  columnInfo?: Array<{ name: string; nullable: boolean; defaultValue?: string }>;
  /** True when opened from SQL editor (not from tree) — export uses in-memory rows */
  queryMode?: boolean;
  /** Localized loading phrases for the animated loading overlay */
  loadingPhrases?: string[];
}

const PAGE_SIZE_OPTIONS = [50, 100, 500, 1000];
const DEFAULT_PAGE_SIZE = 100;

const LOADING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="112" viewBox="0 0 128 112" fill="none">
  <g stroke="var(--vscode-descriptionForeground)" stroke-width="2.2">
    <ellipse cx="50" cy="24" rx="30" ry="11"/>
    <path d="M20 24v50c0 6 13.4 11 30 11s30-5 30-11V24"/>
    <path d="M20 46c0 6 13.4 11 30 11s30-5 30-11" stroke-width="1.5" opacity="0.35"/>
    <path d="M20 62c0 6 13.4 11 30 11s30-5 30-11" stroke-width="1.5" opacity="0.35"/>
  </g>
  <g class="loading-magnifier" stroke="var(--vscode-focusBorder)" stroke-width="2.8">
    <circle cx="86" cy="60" r="20"/>
    <line x1="100" y1="74" x2="118" y2="92" stroke-width="4" stroke-linecap="round"/>
  </g>
</svg>`;

const LOADING_CSS = `
  @keyframes searchAnim {
    0%, 100% { transform: translate(0, 0) rotate(0deg); }
    25% { transform: translate(-3px, -4px) rotate(-3deg); }
    50% { transform: translate(4px, -2px) rotate(2deg); }
    75% { transform: translate(-2px, 3px) rotate(-1deg); }
  }
  .loading-magnifier { transform-origin: 86px 60px; animation: searchAnim 2.5s ease-in-out infinite; }
  .loading-content { position: relative; z-index: 1; text-align: center; }
  .loading-phrase { font-size: 14px; color: var(--vscode-descriptionForeground); transition: opacity 0.3s ease; margin-top: 16px; min-height: 20px; }
`;

export class ResultPanelManager {
  private panels = new Map<string, vscode.WebviewPanel>();
  private messageDisposables = new Map<string, vscode.Disposable>();
  private _tempFileManager: any = null;
  private _chartNotifier: ((panelKey: string, columns: QueryColumn[], rows: Record<string, unknown>[], query?: string) => void) | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  setTempFileManager(t: any) { this._tempFileManager = t; }

  /** Set callback to notify chart panel of data changes */
  setChartNotifier(fn: (panelKey: string, columns: QueryColumn[], rows: Record<string, unknown>[], query?: string) => void) {
    this._chartNotifier = fn;
  }

  private getOrCreatePanel(title: string): vscode.WebviewPanel {
    const targetColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    let panel = this.panels.get(title);
    if (panel) {
      panel.reveal(targetColumn);
    } else {
      panel = vscode.window.createWebviewPanel(
        'viewstor.results',
        title,
        targetColumn,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))],
        },
      );
      panel.onDidDispose(() => {
        this.panels.delete(title);
        this.messageDisposables.get(title)?.dispose();
        this.messageDisposables.delete(title);
        if (this._tempFileManager) this._tempFileManager.cleanupForPanel(title);
      });
      this.panels.set(title, panel);
      // Move results panel below the editor, then return focus to editor
      vscode.commands.executeCommand('workbench.action.moveEditorToBelowGroup')
        .then(() => vscode.commands.executeCommand('workbench.action.focusPreviousGroup'))
        .then(undefined, () => { /* command may not exist in all configurations */ });
    }
    return panel;
  }

  /** Open panel immediately with animated loading screen (before data is fetched) */
  showLoading(title: string, opts?: { color?: string }) {
    const panel = this.getOrCreatePanel(title);
    panel.webview.html = buildLoadingHtml(getLoadingPhrases(), opts?.color);
  }

  /** Close and dispose a panel by title */
  closePanel(title: string) {
    this.panels.get(title)?.dispose();
  }

  show(result: QueryResult, title?: string, opts?: ShowOptions) {
    const panelTitle = title || 'Query Results';
    const panelKey = panelTitle;
    const isTableMode = !!(opts?.connectionId && opts?.tableName);
    const panel = this.getOrCreatePanel(panelTitle);

    const phrases = getLoadingPhrases();
    panel.webview.html = buildResultHtml(result, { ...opts, loadingPhrases: phrases });

    this.messageDisposables.get(panelKey)?.dispose();

    const ctx = opts || {};
    const tfm = this._tempFileManager;
    const disposable = panel.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'changePage':
          if (isTableMode) {
            if (msg.customQuery) {
              vscode.commands.executeCommand('viewstor._runCustomTableQuery',
                ctx.connectionId, ctx.tableName, ctx.schema, msg.customQuery, msg.pageSize, ctx.databaseName, panelKey, msg.page);
            } else {
              vscode.commands.executeCommand('viewstor._fetchPage',
                ctx.connectionId, ctx.tableName, ctx.schema, msg.page, msg.pageSize, msg.orderBy, ctx.databaseName, panelKey);
            }
          }
          break;
        case 'changePageSize':
          if (isTableMode) {
            if (msg.customQuery) {
              vscode.commands.executeCommand('viewstor._runCustomTableQuery',
                ctx.connectionId, ctx.tableName, ctx.schema, msg.customQuery, msg.pageSize, ctx.databaseName, panelKey, 0);
            } else {
              vscode.commands.executeCommand('viewstor._fetchPage',
                ctx.connectionId, ctx.tableName, ctx.schema, 0, msg.pageSize, msg.orderBy, ctx.databaseName, panelKey);
            }
          }
          break;
        case 'reloadWithSort':
          if (isTableMode) {
            vscode.commands.executeCommand('viewstor._fetchPage',
              ctx.connectionId, ctx.tableName, ctx.schema, 0, msg.pageSize, msg.orderBy, ctx.databaseName, panelKey);
          }
          break;
        case 'refreshCount':
          if (isTableMode) {
            vscode.commands.executeCommand('viewstor._refreshCount',
              ctx.connectionId, ctx.tableName, ctx.schema, panelKey, ctx.databaseName);
          }
          break;
        case 'cancelQuery':
          if (ctx.connectionId) {
            vscode.commands.executeCommand('viewstor._cancelQuery', ctx.connectionId);
          }
          break;
        case 'runCustomQuery':
          if (ctx.connectionId) {
            vscode.commands.executeCommand('viewstor._runCustomTableQuery',
              ctx.connectionId, ctx.tableName, ctx.schema, msg.query, msg.pageSize, ctx.databaseName, panelKey);
          }
          break;
        case 'saveEdits':
          vscode.commands.executeCommand('viewstor._saveEdits',
            ctx.connectionId, ctx.tableName, ctx.schema, ctx.pkColumns, msg.edits, ctx.databaseName, panelKey);
          break;
        case 'saveAll':
          vscode.commands.executeCommand('viewstor._saveAll',
            ctx.connectionId, ctx.tableName, ctx.schema, ctx.pkColumns, msg.inserts, msg.edits, ctx.databaseName, panelKey);
          break;
        case 'editJsonInTab':
          if (tfm) {
            tfm.openJsonEditor(msg.json, {
              panelKey,
              rowIdx: msg.rowIdx,
              colName: msg.colName,
              colDataType: msg.colDataType,
            });
          }
          break;
        case 'exportAllData':
          if (isTableMode) {
            vscode.commands.executeCommand('viewstor._exportAllData',
              ctx.connectionId, ctx.tableName, ctx.schema, msg.format, msg.orderBy, msg.customQuery, ctx.databaseName);
          } else {
            vscode.commands.executeCommand('viewstor.exportResults',
              { columns: msg.columns, rows: msg.rows, format: msg.format });
          }
          break;
        case 'insertRow':
          if (isTableMode) {
            vscode.commands.executeCommand('viewstor._insertRow',
              ctx.connectionId, ctx.tableName, ctx.schema, msg.row, ctx.databaseName, panelKey);
          }
          break;
        case 'insertRows':
          if (isTableMode) {
            vscode.commands.executeCommand('viewstor._insertRows',
              ctx.connectionId, ctx.tableName, ctx.schema, msg.rows, ctx.databaseName, panelKey);
          }
          break;
        case 'deleteRows':
          if (isTableMode) {
            vscode.commands.executeCommand('viewstor._deleteRows',
              ctx.connectionId, ctx.tableName, ctx.schema, ctx.pkColumns, msg.rows, ctx.databaseName, msg.pkTypes, panelKey);
          }
          break;
        case 'rerunLastQuery':
          vscode.commands.executeCommand('viewstor.runQuery');
          break;
        case 'visualize':
          vscode.commands.executeCommand('viewstor.visualizeResults', {
            columns: msg.columns,
            rows: msg.rows,
            query: ctx.query,
            connectionId: ctx.connectionId,
            databaseName: ctx.databaseName,
            databaseType: ctx.databaseType,
            color: ctx.color,
            tableName: ctx.tableName,
            schema: ctx.schema,
            resultPanelKey: panelKey,
          });
          break;
        case 'showOnMap':
          vscode.commands.executeCommand('viewstor.showOnMap', {
            columns: msg.columns,
            rows: msg.rows,
            color: ctx.color,
            tableName: ctx.tableName,
            schema: ctx.schema,
          });
          break;
      }
    });
    this.messageDisposables.set(panelKey, disposable);
  }

  postMessage(panelKey: string, message: unknown) {
    this.panels.get(panelKey)?.webview.postMessage(message);
    // Notify chart panel when result data changes
    const msg = message as Record<string, unknown>;
    if (msg.type === 'updateData' && this._chartNotifier) {
      const columns = msg.columns as QueryColumn[];
      const rows = msg.rows as Record<string, unknown>[];
      this._chartNotifier(panelKey, columns, rows);
    }
  }
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}

function getLoadingPhrases(): string[] {
  return [
    vscode.l10n.t('Searching high and low...'),
    vscode.l10n.t('Looking under every stone...'),
    vscode.l10n.t('Rummaging through the shelves...'),
    vscode.l10n.t('Checking every nook and cranny...'),
    vscode.l10n.t('Shaking the data tree...'),
  ];
}

/** @internal Exported for testing */
export function buildLoadingHtml(phrases: string[], color?: string): string {
  const colorBorder = color ? `border-top: 2px solid ${color}; background: color-mix(in srgb, ${color} 15%, var(--vscode-editor-background));` : '';
  return `<!DOCTYPE html>
<html>
<head>
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); padding:0; margin:0; display:flex; align-items:center; justify-content:center; height:100vh; background:var(--vscode-editor-background); ${colorBorder} }
  ${LOADING_CSS}
</style>
</head>
<body>
  <div class="loading-content">
    ${LOADING_SVG}
    <div id="loadingPhrase" class="loading-phrase">${esc(phrases[0] || '')}</div>
  </div>
<script>
(function() {
  var phrases = ${safeJsonForScript(phrases)};
  var idx = 0;
  if (phrases.length > 1) {
    setInterval(function() {
      var el = document.getElementById('loadingPhrase');
      if (!el) return;
      el.style.opacity = '0';
      setTimeout(function() {
        idx = (idx + 1) % phrases.length;
        el.textContent = phrases[idx];
        el.style.opacity = '1';
      }, 300);
    }, 5000);
  }
})();
</script>
</body>
</html>`;
}

/** @internal Exported for testing */
export function buildResultHtml(result: QueryResult, opts?: ShowOptions): string {

  const colorBg = opts?.color ? `background: color-mix(in srgb, ${opts.color} 15%, var(--vscode-editor-background));` : '';
  const colorBorder = opts?.color ? `border-top: 2px solid ${opts.color}; ${colorBg}` : '';
  const colorBorderBottom = opts?.color ? `border-bottom: 2px solid ${opts.color}; ${colorBg}` : '';
  const activePageSize = opts?.pageSize || DEFAULT_PAGE_SIZE;
  const currentPage = opts?.currentPage || 0;
  const totalRowCount = opts?.totalRowCount ?? result.rows.length;
  const isEstimatedCount = !!opts?.isEstimatedCount;
  const isTableMode = !!(opts?.connectionId && opts?.tableName);
  const defaultQuery = opts?.query || (isTableMode
    ? `SELECT * FROM ${opts?.schema ? quoteIdentifier(opts.schema) + '.' : ''}${quoteIdentifier(opts?.tableName || '')}`
    : '');

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
  table { border-collapse:collapse; table-layout:auto; }
  th, td { padding:4px 8px; border:1px solid var(--vscode-panel-border); text-align:left; white-space:nowrap; max-width:400px; overflow:hidden; text-overflow:ellipsis; user-select:none; }
  th { position:sticky; top:0; background:var(--vscode-editor-background); font-weight:600; z-index:1; cursor:pointer; position:relative; }
  th .col-resize-handle { position:absolute; top:0; right:-2px; width:5px; height:100%; cursor:col-resize; z-index:4; }
  th .col-resize-handle:hover { background:var(--vscode-focusBorder); }
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
  td.editable { cursor:text; }
  td.search-hit { background:color-mix(in srgb, var(--vscode-editor-findMatchHighlightBackground, #ea5c0055) 60%, transparent) !important; }
  td.search-focus { outline:2px solid var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder)) !important; background:color-mix(in srgb, var(--vscode-editor-findMatchBackground, #515c6a) 70%, transparent) !important; }
  .search-input { padding:2px 6px; font-size:12px; border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border-radius:2px; width:160px; outline:none; }
  .search-input:focus { border-color:var(--vscode-focusBorder); }
  .search-count { font-size:11px; min-width:30px; }
  td.editing { padding:0; }
  .loading-overlay { position:absolute; inset:0; z-index:10; display:flex; align-items:center; justify-content:center; font-size:14px; color:var(--vscode-descriptionForeground); }
  .loading-overlay::before { content:''; position:absolute; inset:0; background:var(--vscode-editor-background); opacity:0.75; }
  ${LOADING_CSS}
  td.editing input, td.editing select { width:100%; padding:4px 8px; border:2px solid var(--vscode-focusBorder); background:var(--vscode-input-background); color:var(--vscode-input-foreground); font-family:inherit; font-size:inherit; outline:none; }
  td.modified { border-left:3px solid var(--vscode-inputValidation-warningBorder); }
  tr.new-row { background:var(--vscode-diffEditor-insertedLineBackground, rgba(0,180,0,0.08)); }
  tr.out-of-query-row { opacity:0.4; }
  td.invalid-cell { border-left:3px solid var(--vscode-inputValidation-errorBorder, #f44); background:var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1)); }
  .default-val { color:var(--vscode-descriptionForeground); font-style:italic; }
  .popup { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:60vw; max-height:70vh; background:var(--vscode-editor-background); border:1px solid var(--vscode-panel-border); border-radius:4px; box-shadow:0 4px 20px rgba(0,0,0,0.4); z-index:100; display:flex; flex-direction:column; }
  .popup-header { padding:8px 12px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--vscode-panel-border); }
  .popup-body { flex:1; overflow:auto; padding:12px; }
  .json-editor { width:100%; min-height:200px; max-height:50vh; font-family:var(--vscode-editor-font-family); font-size:var(--vscode-editor-font-size); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding:8px; white-space:pre; tab-size:2; outline:none; resize:vertical; }
  .json-editor:focus { border-color:var(--vscode-focusBorder); }
  .export-form label { display:block; margin-bottom:4px; font-size:12px; color:var(--vscode-descriptionForeground); }
  .export-form select { width:100%; margin-bottom:12px; }
  .export-form p { font-size:12px; color:var(--vscode-descriptionForeground); margin:0 0 12px; }
  .query-bar { padding:4px 12px; border-bottom:1px solid var(--vscode-panel-border); flex-shrink:0; display:flex; gap:6px; align-items:center; }
  .query-bar button { font-size:11px; }
  .query-editor-wrap { flex:1; position:relative; font-family:var(--vscode-editor-font-family); font-size:12px; line-height:1.4; }
  .query-editor-highlight { position:absolute; top:0; left:0; right:0; bottom:0; padding:4px 8px; white-space:pre; overflow:hidden; pointer-events:none; color:transparent; border:1px solid transparent; border-radius:2px; }
  .query-editor-textarea { display:block; width:100%; padding:4px 8px; font:inherit; line-height:inherit; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; outline:none; resize:none; overflow:hidden; caret-color:var(--vscode-input-foreground); }
  .query-editor-textarea:focus { border-color:var(--vscode-focusBorder); }
  .query-editor-textarea.has-highlight { color:transparent; background:var(--vscode-input-background); }
  .tk-op { color:var(--vscode-descriptionForeground); }
  .code-preview { padding:8px; font-family:var(--vscode-editor-font-family); font-size:var(--vscode-editor-font-size); white-space:pre-wrap; word-break:break-word; line-height:1.5; }
  .tk-kw { color:var(--vscode-debugTokenExpression-name, #569cd6); font-weight:600; }
  .tk-str { color:var(--vscode-debugTokenExpression-string, #ce9178); }
  .tk-num { color:var(--vscode-debugTokenExpression-number, #b5cea8); }
  .tk-id { color:var(--vscode-debugTokenExpression-value, #9cdcfe); }
  .tk-cmt { color:var(--vscode-descriptionForeground); font-style:italic; }
  .tk-bool { color:var(--vscode-debugTokenExpression-boolean, #569cd6); }
  .tk-null { color:var(--vscode-descriptionForeground); }
  .tk-key { color:var(--vscode-debugTokenExpression-name, #9cdcfe); }
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
    <button id="visualizeBtn" title="Visualize as chart">📊</button>
    <button id="mapBtn" title="Show on map">🗺</button>
    <button id="addRowBtn" class="hidden">+ Row</button>
    <button id="deleteRowBtn" class="hidden" disabled>− Row</button>
    <button id="saveBtn" class="btn-primary hidden">Save Changes</button>
    <button id="refreshBtn" title="Refresh">↻</button>
    <button id="discardBtn" class="hidden">Discard</button>
    <button id="prevPage" disabled>&lt;</button>
    <span id="pageInfo"></span>
    <button id="nextPage">&gt;</button>
    <label>Rows per page: <select id="pageSize">
      ${PAGE_SIZE_OPTIONS.map(n => `<option value="${n}"${n === activePageSize ? ' selected' : ''}>${n}</option>`).join('')}
    </select></label>
  </div>
  ${isTableMode ? `<div class="query-bar">
    <div class="query-editor-wrap">
      <div class="query-editor-highlight" id="queryHighlight" aria-hidden="true"></div>
      <textarea class="query-editor-textarea has-highlight" id="queryInput" rows="1" spellcheck="false">${esc(defaultQuery)}</textarea>
    </div>
    <button id="queryRun" class="btn-primary" title="Run query (Enter)">▶</button>
  </div>` : ''}
  <div class="container">
    <div id="loadingOverlay" class="loading-overlay hidden">
      <div class="loading-content">
        ${LOADING_SVG}
        <div id="loadingPhrase" class="loading-phrase">${esc((opts?.loadingPhrases || [])[0] || '')}</div>
        <button id="cancelQuery" style="margin-top:12px;" class="btn-primary">Cancel</button>
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
    <button id="footerRefreshBtn" title="Refresh">↻</button>
    <button id="footerExportBtn">Export</button>
    <button id="footerAddRowBtn" class="hidden">+ Row</button>
    <button id="footerDeleteRowBtn" class="hidden" disabled>− Row</button>
    <button id="footerSaveBtn" class="btn-primary hidden">Save Changes</button>
    <button id="footerDiscardBtn" class="hidden">Discard</button>
    <button id="footerPrev" disabled>&lt;</button>
    <span id="footerPageInfo"></span>
    <button id="footerNext">&gt;</button>
  </div>
  <div id="overlay" class="overlay hidden"></div>
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
  let columns = ${safeJsonForScript(result.columns)};
  let pageRows = ${safeJsonForScript(result.rows)};
  const pkColumns = ${safeJsonForScript(opts?.pkColumns || [])};
  const columnInfo = ${safeJsonForScript(opts?.columnInfo || [])};
  const IS_READONLY = ${!!opts?.readonly};
  const IS_TABLE_MODE = ${isTableMode};
  const IS_QUERY_MODE = ${!!opts?.queryMode};
  let TOTAL_ROW_COUNT = ${totalRowCount};
  let IS_ESTIMATED_COUNT = ${isEstimatedCount};
  let currentPage = ${currentPage};
  let pageSize = ${activePageSize};
  let totalPages = Math.max(1, Math.ceil(TOTAL_ROW_COUNT / pageSize));

  let sortColumns = ${safeJsonForScript(opts?.orderBy || [])};
  var _loadingPhrases = ${safeJsonForScript(opts?.loadingPhrases || [])};
  var _phraseIdx = 0;
  var _phraseInterval = null;

  let selectedCells = new Set();
  let anchorCell = null;

  // --- Lightweight JSON syntax highlighting ---
  function highlightJson(text) {
    var h = escHtml(text);
    h = h.replace(/"[^"]*"(?=[ ]*:)/g, function(m) { return '<span class="tk-key">' + m + '</span>'; });
    h = h.replace(/:[ ]*"[^"]*"/g, function(m) { var i = m.indexOf('"'); return m.slice(0,i) + '<span class="tk-str">' + m.slice(i) + '</span>'; });
    h = h.replace(/(:[ ]*)(true|false)/g, '$1<span class="tk-bool">$2</span>');
    h = h.replace(/(:[ ]*)(null)/g, '$1<span class="tk-null">$2</span>');
    h = h.replace(/(:[ ]*)(-?[0-9.]+)/g, '$1<span class="tk-num">$2</span>');
    return h;
  }

  // --- Lightweight SQL syntax highlighting ---
  var SQL_KEYWORDS = /\\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|AS|ON|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|DISTINCT|BETWEEN|LIKE|ILIKE|EXISTS|CASE|WHEN|THEN|ELSE|END|UNION|ALL|ASC|DESC|WITH|DEFAULT|CASCADE|PRIMARY|KEY|REFERENCES|FOREIGN|CONSTRAINT|RETURNING|EXPLAIN|ANALYZE|COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|TRUE|FALSE|BOOLEAN|INTEGER|TEXT|VARCHAR|NUMERIC|SERIAL|BIGSERIAL|TIMESTAMP|TIMESTAMPTZ|DATE|TIME|INTERVAL|JSONB?|UUID|ARRAY|BIGINT|SMALLINT|REAL|DOUBLE|PRECISION|CHAR|DECIMAL|FLOAT)\\b/i;
  function highlightSql(text) {
    var tokens = [];
    var remaining = text;
    var pos = 0;
    while (remaining.length > 0) {
      // String literal
      var strMatch = remaining.match(/^'(?:[^'\\\\]|\\\\.)*'|^'(?:[^']|'')*'/);
      if (strMatch) {
        tokens.push('<span class="tk-str">' + escHtml(strMatch[0]) + '</span>');
        remaining = remaining.substring(strMatch[0].length);
        continue;
      }
      // Quoted identifier ("table_name")
      var qidMatch = remaining.match(/^"[^"]*"/);
      if (qidMatch) {
        tokens.push('<span class="tk-id">' + escHtml(qidMatch[0]) + '</span>');
        remaining = remaining.substring(qidMatch[0].length);
        continue;
      }
      // Comment
      var cmtMatch = remaining.match(/^--[^\\n]*/);
      if (cmtMatch) {
        tokens.push('<span class="tk-cmt">' + escHtml(cmtMatch[0]) + '</span>');
        remaining = remaining.substring(cmtMatch[0].length);
        continue;
      }
      // Number
      var numMatch = remaining.match(/^-?\\d+(?:\\.\\d+)?(?![a-zA-Z_])/);
      if (numMatch) {
        tokens.push('<span class="tk-num">' + escHtml(numMatch[0]) + '</span>');
        remaining = remaining.substring(numMatch[0].length);
        continue;
      }
      // Word (keyword or identifier)
      var wordMatch = remaining.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
      if (wordMatch) {
        var w = wordMatch[0];
        if (SQL_KEYWORDS.test(w)) {
          tokens.push('<span class="tk-kw">' + escHtml(w) + '</span>');
        } else {
          tokens.push('<span class="tk-id">' + escHtml(w) + '</span>');
        }
        remaining = remaining.substring(w.length);
        continue;
      }
      // Operators
      var opMatch = remaining.match(/^[<>=!]+|^[;,()*.]/);
      if (opMatch) {
        tokens.push('<span class="tk-op">' + escHtml(opMatch[0]) + '</span>');
        remaining = remaining.substring(opMatch[0].length);
        continue;
      }
      // Other (whitespace, etc.)
      tokens.push(escHtml(remaining[0]));
      remaining = remaining.substring(1);
    }
    return tokens.join('');
  }

  function updateQueryHighlight() {
    var textarea = document.getElementById('queryInput');
    var highlight = document.getElementById('queryHighlight');
    if (!textarea || !highlight) return;
    highlight.innerHTML = highlightSql(textarea.value) + '\\n';
  }

  let pendingEdits = new Map();
  let pendingNewRows = new Map(); // rowIdx → { values: {col: val}, editedCols: Set }
  var _lastInsertedRows = [];   // rows from RETURNING * — set before rerunQuery
  var _outOfQueryRows = [];     // inserted rows not found in requeried data
  var _outOfQueryPkSet = new Set(); // PK keys for O(1) lookup
  let originalRows = JSON.parse(JSON.stringify(pageRows));
  const undoStack = []; // { type: 'edit', rowIdx, colName, oldVal } | { type: 'addRow', rowIdx } | { type: 'deleteRow', rowIdx, row, originalRow, newRowEntry? }

  // Build columnInfo lookup: { colName → { nullable, defaultValue } }
  var colInfoMap = {};
  columnInfo.forEach(function(ci) { colInfoMap[ci.name] = ci; });

  const jsonTypes = new Set(['json','jsonb','Object']);
  const boolTypes = new Set(['boolean','Bool']);

  function escHtml(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

  function isComplexValue(value) {
    return value !== null && value !== undefined && (typeof value === 'object' || Array.isArray(value));
  }

  function formatCell(value, col) {
    if (value === '__DEFAULT__') return '<span class="default-val">DEFAULT</span>';
    if (value === null || value === undefined) return '<span class="null-val">NULL</span>';
    // Complex types (arrays, objects, JSON) — show truncated string
    if (isComplexValue(value)) {
      const str = Array.isArray(value) ? pgArrayToString(value) : JSON.stringify(value);
      return escHtml(str.length > 60 ? str.substring(0, 60) + '...' : str);
    }
    const str = String(value);
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
      if (typeof v === 'object') return JSON.stringify(v);
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
      return '<th data-col="' + i + '">' + escHtml(c.name) + icon + '<br><small>' + escHtml(c.dataType) + '</small><div class="col-resize-handle"></div></th>';
    }).join('');
    headerRow.querySelectorAll('th[data-col]').forEach(th => {
      th.addEventListener('click', (e) => { if (e.target.classList && e.target.classList.contains('col-resize-handle')) return; handleSortClick(Number(th.dataset.col), e.shiftKey); });
      th.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        closeContextMenu();
        const ci = Number(th.dataset.col);
        ctxMenuEl = document.createElement('div');
        ctxMenuEl.className = 'ctx-menu';
        ctxMenuEl.style.left = e.clientX + 'px';
        ctxMenuEl.style.top = e.clientY + 'px';
        const selectBtn = document.createElement('button');
        selectBtn.textContent = 'Select Column';
        selectBtn.addEventListener('click', () => {
          selectedCells.clear();
          for (let r = 0; r < pageRows.length; r++) selectedCells.add(cellKey(r, ci));
          anchorCell = { row: 0, col: ci };
          updateSelectionUI();
          closeContextMenu();
        });
        ctxMenuEl.appendChild(selectBtn);
        document.body.appendChild(ctxMenuEl);
      });
      // Column resize handle
      var handle = th.querySelector('.col-resize-handle');
      if (handle) {
        handle.addEventListener('mousedown', function(e) {
          e.preventDefault();
          e.stopPropagation();
          var startX = e.clientX;
          var startWidth = th.offsetWidth;
          var colIdx = Number(th.dataset.col);
          function onMove(ev) {
            var newWidth = Math.max(40, startWidth + ev.clientX - startX);
            th.style.width = newWidth + 'px';
            th.style.minWidth = newWidth + 'px';
            th.style.maxWidth = newWidth + 'px';
            // Apply to all td in same column
            document.querySelectorAll('#dataBody tr').forEach(function(row) {
              var td = row.children[colIdx + 1]; // +1 for row-num column
              if (td) { td.style.width = newWidth + 'px'; td.style.minWidth = newWidth + 'px'; td.style.maxWidth = newWidth + 'px'; }
            });
          }
          function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
      }
    });
  }

  function renderPage() {
    const offset = currentPage * pageSize;
    const body = document.getElementById('dataBody');
    body.innerHTML = pageRows.map((row, ri) => {
      const globalRi = offset + ri;
      const isNewRow = pendingNewRows.has(ri.toString());
      const isOutOfQuery = !isNewRow && _outOfQueryPkSet.size > 0 && pkColumns.length > 0 &&
        _outOfQueryPkSet.has(pkColumns.map(function(pk) { return String(row[pk]); }).join('\\0'));
      const rowNum = '<td class="row-num" data-rownum="' + ri + '">' + (isNewRow ? '+' : (globalRi + 1)) + '</td>';
      const cells = columns.map((c, ci) => {
        const key = ri + ':' + c.name;
        const modClass = pendingEdits.has(key) ? ' modified' : '';
        const isComplex = row[c.name] !== null && row[c.name] !== undefined && row[c.name] !== '__DEFAULT__' && (jsonTypes.has(c.dataType) || isComplexValue(row[c.name]));
        const jsonClass = isComplex ? ' json-cell' : '';
        const editClass = !IS_READONLY && !isComplex && (pkColumns.length > 0 || isNewRow) ? ' editable' : '';
        return '<td data-row="' + ri + '" data-col="' + ci + '" class="' + modClass + jsonClass + editClass + '">' + formatCell(row[c.name], c) + '</td>';
      }).join('');
      var trClass = isNewRow ? ' class="new-row"' : isOutOfQuery ? ' class="out-of-query-row"' : '';
      return '<tr' + trClass + '>' + rowNum + cells + '</tr>';
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
        const val = pageRows[ri][col.name];
        if (val !== null && val !== undefined && val !== '__DEFAULT__' && (jsonTypes.has(col.dataType) || isComplexValue(val))) {
          const str = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
          openJsonInTab(str, ri, col);
          return;
        }
        // Allow editing: existing rows need PK, new rows always editable
        if (IS_READONLY) return;
        if (pkColumns.length > 0 || pendingNewRows.has(ri.toString())) {
          startEdit(td, ci, ri);
        } else {
          console.warn('[viewstor] Editing blocked: table has no primary key columns. pkColumns=', pkColumns, 'readonly=', IS_READONLY);
        }
      });
    });
    // Row number: click selects row, right-click opens copy menu
    document.getElementById('dataBody').querySelectorAll('td[data-rownum]').forEach(td => {
      td.addEventListener('click', () => {
        const ri = Number(td.dataset.rownum);
        selectedCells.clear();
        for (let c = 0; c < columns.length; c++) selectedCells.add(cellKey(ri, c));
        anchorCell = { row: ri, col: 0 };
        updateSelectionUI();
      });
      td.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const ri = Number(td.dataset.rownum);
        // Select row first
        selectedCells.clear();
        for (let c = 0; c < columns.length; c++) selectedCells.add(cellKey(ri, c));
        anchorCell = { row: ri, col: 0 };
        updateSelectionUI();
        showContextMenu(e);
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
    // Toggle delete row buttons
    var noSel = selectedCells.size === 0;
    var delBtn = document.getElementById('deleteRowBtn');
    if (delBtn) delBtn.disabled = noSel;
    var fDelBtn = document.getElementById('footerDeleteRowBtn');
    if (fDelBtn) fDelBtn.disabled = noSel;
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
      { label: 'Copy as One-row (SQL)', fmt: 'onerow-sq' },
      { label: 'Copy as One-row (JSON)', fmt: 'onerow-dq' },
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
    // Delete row option (only in table mode, not readonly, with PKs)
    if (!IS_READONLY && IS_TABLE_MODE && pkColumns.length > 0) {
      var sep = document.createElement('div');
      sep.style.cssText = 'height:1px;background:var(--vscode-menu-separatorBackground, var(--vscode-panel-border));margin:4px 0;';
      ctxMenuEl.appendChild(sep);
      var delBtn = document.createElement('button');
      delBtn.textContent = 'Delete Row(s)';
      delBtn.style.color = 'var(--vscode-errorForeground)';
      delBtn.addEventListener('click', function() {
        closeContextMenu();
        sendDeleteRows();
      });
      ctxMenuEl.appendChild(delBtn);
    }
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

  var numericTypeRe = /^(int|integer|bigint|smallint|serial|bigserial|numeric|decimal|real|float|double|money|oid|Int8|Int16|Int32|Int64|UInt8|UInt16|UInt32|UInt64|Float32|Float64)/i;

  function isNumericCol(colIdx) {
    var dt = columns[colIdx].dataType;
    return numericTypeRe.test(dt) || boolTypes.has(dt);
  }

  function formatOneRow(rows, colIdxs, quote) {
    var vals = [];
    rows.forEach(function(r) {
      r.forEach(function(v, i) {
        if (v === '' || v === 'null' || v === 'NULL') { vals.push('NULL'); }
        else if (isNumericCol(colIdxs[i])) { vals.push(v); }
        else { vals.push(quote + v.replace(new RegExp(quote === "'" ? "'" : '"', 'g'), quote + quote) + quote); }
      });
    });
    return vals.join(', ');
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
      case 'onerow-sq': text = formatOneRow(rows, colIdxs, "'"); break;
      case 'onerow-dq': text = formatOneRow(rows, colIdxs, '"'); break;
      case 'md': {
        var widths = headers.map(function(h, i) {
          var max = h.length;
          rows.forEach(function(r) { if (r[i].length > max) max = r[i].length; });
          return Math.max(max, 3);
        });
        function mdPad(s, w) { return s + ' '.repeat(Math.max(0, w - s.length)); }
        text = '| ' + headers.map(function(h, i) { return mdPad(h, widths[i]); }).join(' | ') + ' |\\n';
        text += '|' + widths.map(function(w) { return '-'.repeat(w + 2); }).join('|') + '|\\n';
        text += rows.map(function(r) { return '| ' + r.map(function(v, i) { return mdPad(v, widths[i]); }).join(' | ') + ' |'; }).join('\\n');
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
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey) {
      // Skip undo when editing a cell or typing in query input
      var active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
      e.preventDefault();
      performUndo();
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV' && !e.shiftKey) {
      var active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
      if (IS_READONLY || selectedCells.size === 0) return;
      e.preventDefault();
      navigator.clipboard.readText().then(function(text) {
        if (!text) return;
        performPaste(text);
      }).catch(function() {});
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

    // If custom query is active, apply sort to it instead of the default table query
    var customQ = queryInput ? queryInput.value.trim() : '';
    if (customQ) {
      var sorted = applySortToQuery(customQ, sortColumns);
      queryInput.value = sorted;
      updateQueryHighlight();
      vscode.postMessage({ type: 'runCustomQuery', query: sorted, pageSize: pageSize });
    } else {
      vscode.postMessage({ type: 'reloadWithSort', orderBy: sortColumns, pageSize });
    }
  }

  var SQL_RESERVED_SET = new Set(['select','from','where','and','or','not','in','is','null','as','on','join','left','right','inner','outer','full','cross','order','by','group','having','limit','offset','insert','into','values','update','set','delete','create','alter','drop','table','index','view','distinct','between','like','ilike','exists','case','when','then','else','end','union','all','asc','desc','with','default','cascade','primary','key','references','foreign','constraint','returning','explain','analyze','true','false','boolean','integer','text','varchar','numeric','serial','bigserial','timestamp','timestamptz','date','time','interval','json','jsonb','uuid','array','bigint','smallint','real','double','precision','char','decimal','float','check','unique','grant','revoke','role','user','type','enum','schema','database','sequence','trigger','function','procedure','begin','commit','rollback','abort','do','for','if','loop','return','raise','exception']);
  function quoteId(name) {
    if (/^[a-z_][a-z0-9_]*$/.test(name) && !SQL_RESERVED_SET.has(name)) return name;
    return '"' + name.replace(/"/g, '""') + '"';
  }

  function findOuterKw(sql, kw) {
    var depth = 0, idx = 0;
    while (idx < sql.length) {
      var ch = sql[idx];
      if (ch === '(') { depth++; idx++; continue; }
      if (ch === ')') { depth--; idx++; continue; }
      if (ch === "'") { idx++; while (idx < sql.length) { if (sql[idx] === "'" && sql[idx+1] === "'") { idx += 2; continue; } if (sql[idx] === "'") { idx++; break; } idx++; } continue; }
      if (depth === 0 && kw.test(sql.substring(idx))) return idx;
      idx++;
    }
    return -1;
  }

  function parseOrderByFromQuery(query) {
    var q = query.replace(/;+\\s*$/, '');
    var orderPos = findOuterKw(q, /^\\s*ORDER\\s+BY\\b/i);
    if (orderPos < 0) return [];
    var afterOrder = q.substring(orderPos);
    var kwMatch = afterOrder.match(/^\\s*ORDER\\s+BY\\s+/i);
    if (!kwMatch) return [];
    var rest = afterOrder.substring(kwMatch[0].length);
    var limitPos = findOuterKw(rest, /^\\s*(LIMIT|OFFSET)\\b/i);
    var clause = limitPos >= 0 ? rest.substring(0, limitPos) : rest;
    var parts = clause.split(',');
    var result = [];
    for (var pi = 0; pi < parts.length; pi++) {
      var raw = parts[pi].trim();
      if (!raw) continue;
      // Skip expressions / positional / qualified names — only simple "col [ASC|DESC]"
      var m = raw.match(/^(?:"([^"]+)"|\`([^\`]+)\`|([A-Za-z_][A-Za-z0-9_]*))(?:\\s+(ASC|DESC))?\\s*$/i);
      if (!m) continue;
      var name = m[1] || m[2] || m[3];
      var dir = (m[4] || 'ASC').toLowerCase();
      result.push({ column: name, direction: dir });
    }
    return result;
  }

  function syncSortFromCustomQuery() {
    var q = queryInput ? queryInput.value.trim() : '';
    if (!q) return;
    sortColumns = parseOrderByFromQuery(q);
  }

  function applySortToQuery(query, sorts) {
    var q = query.replace(/;+\\s*$/, '');
    // Remove outermost ORDER BY (skip subqueries)
    var orderPos = findOuterKw(q, /^\\s*ORDER\\s+BY\\b/i);
    if (orderPos >= 0) {
      var afterOrder = q.substring(orderPos);
      var endMatch = afterOrder.match(/\\s+ORDER\\s+BY\\b/i);
      var orderLen = endMatch ? endMatch[0].length : 0;
      var rest = q.substring(orderPos + orderLen);
      var limitPos = findOuterKw(rest, /^\\s*(LIMIT|OFFSET)\\b/i);
      if (limitPos >= 0) { q = q.substring(0, orderPos) + rest.substring(limitPos); }
      else { q = q.substring(0, orderPos); }
    }
    if (sorts.length > 0) {
      var orderClause = ' ORDER BY ' + sorts.map(function(s) {
        return quoteId(s.column) + ' ' + s.direction.toUpperCase();
      }).join(', ');
      var lp = findOuterKw(q, /^\\s*(LIMIT|OFFSET)\\b/i);
      if (lp >= 0) {
        q = q.substring(0, lp) + orderClause + q.substring(lp);
      } else {
        q += orderClause;
      }
    }
    return q;
  }

  // --- Editing ---
  function startEdit(td, colIdx, rowIdx) {
    if (td.classList.contains('editing')) return;
    const col = columns[colIdx];
    const currentVal = pageRows[rowIdx][col.name];
    const valStr = currentVal === null || currentVal === undefined || currentVal === '__DEFAULT__' ? '' : (typeof currentVal === 'object' ? JSON.stringify(currentVal) : String(currentVal));
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
    var isNew = pendingNewRows.has(rowIdx.toString());
    var ci = colInfoMap[col.name];
    if (isNew && ci && ci.defaultValue != null) input.placeholder = 'DEFAULT';
    function resolveVal() {
      if (input.value === '') {
        // For new rows with DEFAULT, empty means keep DEFAULT
        if (isNew && ci && ci.defaultValue != null) return '__DEFAULT__';
        return null;
      }
      return input.value;
    }
    input.addEventListener('blur', () => finishEdit(td, col, rowIdx, resolveVal()));
    input.addEventListener('keydown', e => { if(e.key==='Enter') finishEdit(td,col,rowIdx,resolveVal()); if(e.key==='Escape') cancelEdit(td,col,rowIdx); });
    td.textContent=''; td.appendChild(input); input.focus(); input.select();
  }

  function finishEdit(td, col, rowIdx, newVal) {
    td.classList.remove('editing');
    td.classList.remove('invalid-cell');
    const oldVal = originalRows[rowIdx][col.name];
    const prevVal = pageRows[rowIdx][col.name];
    if (jsonTypes.has(col.dataType) && typeof newVal === 'string') { try { newVal = JSON.parse(newVal); } catch {} }
    const newStr = typeof newVal === 'object' && newVal !== null ? JSON.stringify(newVal) : String(newVal);
    const prevStr = typeof prevVal === 'object' && prevVal !== null ? JSON.stringify(prevVal) : String(prevVal);
    if (newStr !== prevStr) {
      undoStack.push({ type: 'edit', rowIdx, colName: col.name, oldVal: prevVal });
    }
    pageRows[rowIdx][col.name] = newVal;

    // Track edits for new rows separately
    if (pendingNewRows.has(rowIdx.toString())) {
      var nr = pendingNewRows.get(rowIdx.toString());
      nr.values[col.name] = newVal;
      nr.editedCols.add(col.name);
      td.classList.add('modified');
      td.innerHTML = formatCell(newVal, col);
      reattachCell(td, columns.indexOf(col), rowIdx);
      updateSaveButtons();
      return;
    }

    const valStr = typeof newVal === 'object' && newVal !== null ? JSON.stringify(newVal) : String(newVal);
    const oldStr = typeof oldVal === 'object' && oldVal !== null ? JSON.stringify(oldVal) : String(oldVal);
    if (valStr !== oldStr) {
      const pkValues = {};
      const pkTypes = {};
      pkColumns.forEach(pk => {
        pkValues[pk] = originalRows[rowIdx][pk];
        var pkCol = columns.find(function(c) { return c.name === pk; });
        if (pkCol) pkTypes[pk] = pkCol.dataType;
      });
      if (!pendingEdits.has(rowIdx.toString())) pendingEdits.set(rowIdx.toString(), { rowIdx, changes: {}, columnTypes: {}, pkValues, pkTypes });
      pendingEdits.get(rowIdx.toString()).changes[col.name] = newVal;
      pendingEdits.get(rowIdx.toString()).columnTypes[col.name] = col.dataType;
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

  function performUndo() {
    if (undoStack.length === 0) return;
    var action = undoStack.pop();

    if (action.type === 'edit') {
      var ri = action.rowIdx;
      var colName = action.colName;
      pageRows[ri][colName] = action.oldVal;

      // Update pendingEdits / pendingNewRows
      if (pendingNewRows.has(ri.toString())) {
        var nr = pendingNewRows.get(ri.toString());
        nr.values[colName] = action.oldVal;
        nr.editedCols.delete(colName);
      } else {
        var origVal = originalRows[ri][colName];
        var origStr = typeof origVal === 'object' && origVal !== null ? JSON.stringify(origVal) : String(origVal);
        var restoredStr = typeof action.oldVal === 'object' && action.oldVal !== null ? JSON.stringify(action.oldVal) : String(action.oldVal);
        if (origStr === restoredStr) {
          // Back to original — remove from pendingEdits
          var edit = pendingEdits.get(ri.toString());
          if (edit) { delete edit.changes[colName]; delete edit.columnTypes[colName]; if (Object.keys(edit.changes).length === 0) pendingEdits.delete(ri.toString()); }
        } else {
          // Still differs from original — update pendingEdits
          if (pendingEdits.has(ri.toString())) {
            pendingEdits.get(ri.toString()).changes[colName] = action.oldVal;
          }
        }
      }
      renderPage();
      updateSaveButtons();
    } else if (action.type === 'addRow') {
      var ri = action.rowIdx;
      pendingNewRows.delete(ri.toString());
      pageRows.splice(ri, 1);
      originalRows.splice(ri, 1);
      renderPage();
      updateSaveButtons();
    }
  }

  function performPaste(text) {
    var lines = text.replace(/\\r\\n$/, '').replace(/\\n$/, '').split(/\\r?\\n/);
    var grid = lines.map(function(line) { return line.split('\\t'); });
    if (grid.length === 0) return;

    var cells = [...selectedCells].map(function(k) { var parts = k.split(':').map(Number); return { r: parts[0], c: parts[1] }; });
    var rowIdxs = [...new Set(cells.map(function(c) { return c.r; }))].sort(function(a, b) { return a - b; });
    var colIdxs = [...new Set(cells.map(function(c) { return c.c; }))].sort(function(a, b) { return a - b; });
    var isSingle = grid.length === 1 && grid[0].length === 1;

    for (var ri = 0; ri < rowIdxs.length; ri++) {
      var rowIdx = rowIdxs[ri];
      if (pkColumns.length === 0 && !pendingNewRows.has(rowIdx.toString())) continue;
      for (var ci = 0; ci < colIdxs.length; ci++) {
        var colIdx = colIdxs[ci];
        if (!selectedCells.has(cellKey(rowIdx, colIdx))) continue;
        if (colIdx >= columns.length) continue;

        var clipRow = isSingle ? 0 : ri % grid.length;
        var clipCol = isSingle ? 0 : ci % (grid[clipRow] ? grid[clipRow].length : 1);
        var rawVal = grid[clipRow] && grid[clipRow][clipCol] != null ? grid[clipRow][clipCol] : '';
        var newVal = (rawVal === '' || rawVal.toUpperCase() === 'NULL') ? null : rawVal;

        var col = columns[colIdx];
        var prevVal = pageRows[rowIdx][col.name];
        var prevStr = typeof prevVal === 'object' && prevVal !== null ? JSON.stringify(prevVal) : String(prevVal);
        var newStr = newVal === null ? 'null' : String(newVal);
        if (prevStr !== newStr) {
          undoStack.push({ type: 'edit', rowIdx: rowIdx, colName: col.name, oldVal: prevVal });
        }
        pageRows[rowIdx][col.name] = newVal;

        // Update tracking structures
        if (pendingNewRows.has(rowIdx.toString())) {
          var nr = pendingNewRows.get(rowIdx.toString());
          nr.values[col.name] = newVal;
          nr.editedCols.add(col.name);
        } else {
          var origVal = originalRows[rowIdx][col.name];
          var origStr = typeof origVal === 'object' && origVal !== null ? JSON.stringify(origVal) : String(origVal);
          if (newStr !== origStr) {
            var pkValues = {};
            var pkTypes = {};
            pkColumns.forEach(function(pk) {
              pkValues[pk] = originalRows[rowIdx][pk];
              var pkCol = columns.find(function(c) { return c.name === pk; });
              if (pkCol) pkTypes[pk] = pkCol.dataType;
            });
            if (!pendingEdits.has(rowIdx.toString())) pendingEdits.set(rowIdx.toString(), { rowIdx: rowIdx, changes: {}, columnTypes: {}, pkValues: pkValues, pkTypes: pkTypes });
            pendingEdits.get(rowIdx.toString()).changes[col.name] = newVal;
            pendingEdits.get(rowIdx.toString()).columnTypes[col.name] = col.dataType;
          } else {
            var edit = pendingEdits.get(rowIdx.toString());
            if (edit) { delete edit.changes[col.name]; if (Object.keys(edit.changes).length === 0) pendingEdits.delete(rowIdx.toString()); }
          }
        }
      }
    }
    renderPage();
    updateSaveButtons();
  }

  function reattachCell(td, colIdx, rowIdx) {
    td.addEventListener('click', (e) => handleCellClick(td, e));
    td.addEventListener('dblclick', () => {
      const col = columns[colIdx];
      const val = pageRows[rowIdx][col.name];
      if (val !== null && val !== undefined && val !== '__DEFAULT__' && (jsonTypes.has(col.dataType) || isComplexValue(val))) {
        openJsonInTab(typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val), rowIdx, col);
        return;
      }
      if (IS_READONLY) return;
      if (pkColumns.length > 0 || pendingNewRows.has(rowIdx.toString())) {
        startEdit(td, colIdx, rowIdx);
      } else {
        console.warn('[viewstor] Editing blocked: table has no primary key columns. pkColumns=', pkColumns, 'readonly=', IS_READONLY);
      }
    });
  }

  function updateSaveButtons() {
    const hasChanges = pendingEdits.size > 0 || pendingNewRows.size > 0;
    document.getElementById('saveBtn').classList.toggle('hidden', !hasChanges);
    document.getElementById('discardBtn').classList.toggle('hidden', !hasChanges);
    document.getElementById('footerSaveBtn').classList.toggle('hidden', !hasChanges);
    document.getElementById('footerDiscardBtn').classList.toggle('hidden', !hasChanges);
  }

  // Validate new rows: return array of { rowIdx, missingCols } for rows with unfilled required columns
  function validateNewRows() {
    var errors = [];
    pendingNewRows.forEach(function(nr, key) {
      var missing = [];
      columns.forEach(function(col) {
        var ci = colInfoMap[col.name];
        var val = nr.values[col.name];
        // Required = not nullable AND no default value
        var isRequired = ci && !ci.nullable && ci.defaultValue == null;
        if (isRequired && (val === null || val === undefined)) {
          missing.push(col.name);
        }
      });
      if (missing.length > 0) errors.push({ rowIdx: parseInt(key), missingCols: missing });
    });
    return errors;
  }

  // Highlight invalid cells and return true if valid
  function highlightInvalidCells(errors) {
    // Clear previous highlights
    document.querySelectorAll('td.invalid-cell').forEach(function(td) { td.classList.remove('invalid-cell'); });
    if (errors.length === 0) return true;
    errors.forEach(function(err) {
      err.missingCols.forEach(function(colName) {
        var ci = columns.findIndex(function(c) { return c.name === colName; });
        if (ci >= 0) {
          var td = document.querySelector('td[data-row="' + err.rowIdx + '"][data-col="' + ci + '"]');
          if (td) td.classList.add('invalid-cell');
        }
      });
    });
    return false;
  }

  document.getElementById('saveBtn').addEventListener('click', () => {
    // Validate new rows first
    var validationErrors = validateNewRows();
    if (validationErrors.length > 0) {
      highlightInvalidCells(validationErrors);
      var allMissing = [];
      validationErrors.forEach(function(err) { allMissing = allMissing.concat(err.missingCols); });
      var unique = allMissing.filter(function(v, i, a) { return a.indexOf(v) === i; });
      alert('Required columns not filled: ' + unique.join(', '));
      return;
    }
    highlightInvalidCells([]);

    // Collect all changes and send as a single atomic message
    var newRowInserts = [];
    if (pendingNewRows.size > 0) {
      pendingNewRows.forEach(function(nr) {
        var colValues = {};
        var colTypes = {};
        columns.forEach(function(col) {
          colValues[col.name] = nr.values[col.name];
          colTypes[col.name] = col.dataType;
        });
        newRowInserts.push({ values: colValues, columnTypes: colTypes });
      });
    }
    var editsList = pendingEdits.size > 0 ? [...pendingEdits.values()] : [];
    vscode.postMessage({ type: 'saveAll', inserts: newRowInserts, edits: editsList });
    pendingNewRows.clear();
    pendingEdits.clear();
    undoStack.length = 0;
    for (let i = 0; i < pageRows.length; i++) originalRows[i] = JSON.parse(JSON.stringify(pageRows[i]));
    document.querySelectorAll('td.modified').forEach(td => td.classList.remove('modified'));
    renderPage();
    updateSaveButtons();
  });

  document.getElementById('discardBtn').addEventListener('click', () => {
    // Remove new rows from pageRows
    var newRowIndices = [];
    pendingNewRows.forEach(function(nr, key) { newRowIndices.push(parseInt(key)); });
    newRowIndices.sort(function(a, b) { return b - a; }); // reverse order for safe splice
    newRowIndices.forEach(function(idx) { pageRows.splice(idx, 1); originalRows.splice(idx, 1); });
    pendingNewRows.clear();
    pendingEdits.clear();
    undoStack.length = 0;
    document.querySelectorAll('td.invalid-cell').forEach(function(td) { td.classList.remove('invalid-cell'); });
    for (let i = 0; i < pageRows.length; i++) pageRows[i] = JSON.parse(JSON.stringify(originalRows[i]));
    renderPage();
    updateSaveButtons();
  });

  // --- Add / Delete Rows ---
  if (!IS_READONLY && IS_TABLE_MODE) {
    document.getElementById('addRowBtn').classList.remove('hidden');
    document.getElementById('footerAddRowBtn').classList.remove('hidden');
  }
  if (!IS_READONLY && IS_TABLE_MODE && pkColumns.length > 0) {
    document.getElementById('deleteRowBtn').classList.remove('hidden');
    document.getElementById('footerDeleteRowBtn').classList.remove('hidden');
  }

  document.getElementById('addRowBtn').addEventListener('click', () => {
    var newRow = {};
    columns.forEach(function(c) {
      var ci = colInfoMap[c.name];
      newRow[c.name] = (ci && ci.defaultValue != null) ? '__DEFAULT__' : null;
    });
    pageRows.push(newRow);
    originalRows.push(JSON.parse(JSON.stringify(newRow)));
    var rowIdx = pageRows.length - 1;
    pendingNewRows.set(rowIdx.toString(), { values: newRow, editedCols: new Set() });
    undoStack.push({ type: 'addRow', rowIdx });
    renderPage();
    updateSaveButtons();
    // Scroll to the new row
    var body = document.getElementById('dataBody');
    if (body && body.lastElementChild) body.lastElementChild.scrollIntoView({ block: 'nearest' });
  });

  function sendDeleteRows() {
    var rowSet = new Set();
    selectedCells.forEach(function(key) { rowSet.add(parseInt(key.split(':')[0])); });
    if (rowSet.size === 0) return;
    var rowsToDelete = [];
    var pTypes = {};
    pkColumns.forEach(function(pk) {
      var c = columns.find(function(col) { return col.name === pk; });
      if (c) pTypes[pk] = c.dataType;
    });
    rowSet.forEach(function(ri) {
      var pkVals = {};
      pkColumns.forEach(function(pk) { pkVals[pk] = pageRows[ri][pk]; });
      rowsToDelete.push(pkVals);
    });
    vscode.postMessage({ type: 'deleteRows', rows: rowsToDelete, pkTypes: pTypes });
  }

  document.getElementById('deleteRowBtn').addEventListener('click', sendDeleteRows);

  // --- JSON: open in native VS Code tab ---
  function openJsonInTab(jsonStr, rowIdx, col) {
    vscode.postMessage({ type: 'editJsonInTab', json: jsonStr, rowIdx: rowIdx, colName: col.name, colDataType: col.dataType });
  }

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
  document.getElementById('refreshBtn').addEventListener('click', () => {
    if (IS_TABLE_MODE) {
      if (queryInput && !queryInput.value.trim()) {
        // User cleared the SQL bar — restore the default table query so they can keep editing from baseline
        queryInput.value = ${safeJsonForScript(defaultQuery)};
        updateQueryHighlight();
      }
      if (queryInput && queryInput.value.trim()) {
        runCustomQuery();
      } else {
        vscode.postMessage({ type: 'changePage', page: currentPage, pageSize: pageSize, orderBy: sortColumns });
      }
    } else {
      vscode.postMessage({ type: 'rerunLastQuery' });
    }
  });
  document.getElementById('exportBtn').addEventListener('click', showExportPopup);
  document.getElementById('visualizeBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'visualize', columns, rows: pageRows });
  });
  document.getElementById('mapBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'showOnMap', columns, rows: pageRows });
  });
  document.getElementById('exportClose').addEventListener('click', closeExportPopup);
  document.getElementById('exportConfirm').addEventListener('click', () => {
    const fmt = document.getElementById('exportFormat').value;
    if (IS_TABLE_MODE && !IS_QUERY_MODE) {
      vscode.postMessage({ type: 'exportAllData', format: fmt, orderBy: sortColumns, customQuery: customExportQuery || undefined });
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
  function activeCustomQuery() {
    var q = queryInput ? queryInput.value.trim() : '';
    return q || undefined;
  }
  function goPage(delta) {
    const np = currentPage + delta;
    if (np < 0 || np >= totalPages) return;
    if (pendingEdits.size > 0) { if (!confirm('Unsaved changes will be lost. Continue?')) return; }
    if (IS_TABLE_MODE) {
      showLoading();
      vscode.postMessage({ type: 'changePage', page: np, pageSize, orderBy: sortColumns, customQuery: activeCustomQuery() });
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
      vscode.postMessage({ type: 'changePageSize', pageSize, orderBy: sortColumns, customQuery: activeCustomQuery() });
    }
  });

  // Footer button delegates
  document.getElementById('footerRefreshBtn').addEventListener('click', () => document.getElementById('refreshBtn').click());
  document.getElementById('footerExportBtn').addEventListener('click', () => document.getElementById('exportBtn').click());
  document.getElementById('footerAddRowBtn').addEventListener('click', () => document.getElementById('addRowBtn').click());
  document.getElementById('footerDeleteRowBtn').addEventListener('click', () => document.getElementById('deleteRowBtn').click());
  document.getElementById('footerSaveBtn').addEventListener('click', () => document.getElementById('saveBtn').click());
  document.getElementById('footerDiscardBtn').addEventListener('click', () => document.getElementById('discardBtn').click());

  function showLoading() {
    _phraseIdx = 0;
    var el = document.getElementById('loadingPhrase');
    if (el && _loadingPhrases.length > 0) el.textContent = _loadingPhrases[0];
    document.getElementById('loadingOverlay').classList.remove('hidden');
    if (_loadingPhrases.length > 1 && !_phraseInterval) {
      _phraseInterval = setInterval(function() {
        var pe = document.getElementById('loadingPhrase');
        if (!pe) return;
        pe.style.opacity = '0';
        setTimeout(function() {
          _phraseIdx = (_phraseIdx + 1) % _loadingPhrases.length;
          pe.textContent = _loadingPhrases[_phraseIdx];
          pe.style.opacity = '1';
        }, 300);
      }, 5000);
    }
  }
  function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
    if (_phraseInterval) { clearInterval(_phraseInterval); _phraseInterval = null; }
  }

  // Query bar — run custom query
  var customExportQuery = '';
  var queryInput = document.getElementById('queryInput');
  var queryRunBtn = document.getElementById('queryRun');
  if (queryInput) {
    queryInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); runCustomQuery(); }
    });
    queryInput.addEventListener('input', updateQueryHighlight);
    queryInput.addEventListener('scroll', function() {
      var highlight = document.getElementById('queryHighlight');
      if (highlight) { highlight.scrollLeft = queryInput.scrollLeft; }
    });
    queryRunBtn.addEventListener('click', runCustomQuery);
    updateQueryHighlight();
  }
  function runCustomQuery() {
    if (!queryInput) return;
    var q = queryInput.value.trim();
    if (!q) return;
    // Parse LIMIT from query to remember for export
    var limitMatch = q.toUpperCase().indexOf('LIMIT') >= 0 ? q.match(/limit[^0-9]*([0-9]+)/i) : null;
    var userLimit = limitMatch ? parseInt(limitMatch[1], 10) : 0;
    if (userLimit > pageSize) {
      customExportQuery = q;
    }
    // Mirror ORDER BY from user's SQL into header sort icons
    sortColumns = parseOrderByFromQuery(q);
    showLoading();
    vscode.postMessage({ type: 'runCustomQuery', query: q, pageSize: pageSize });
  }

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
    if (msg.type === 'hideLoading') { hideLoading(); }
    if (msg.type === 'insertedRows') {
      // Store inserted rows — will be checked after rerun to highlight out-of-query rows
      _lastInsertedRows = msg.rows;
    }
    if (msg.type === 'rerunQuery') {
      if (queryInput && queryInput.value.trim()) {
        runCustomQuery();
      } else {
        vscode.postMessage({ type: 'changePage', page: currentPage, pageSize: pageSize, orderBy: sortColumns });
      }
    }
    if (msg.type === 'applyJsonEdit') {
      var colIdx = columns.findIndex(function(c) { return c.name === msg.colName; });
      if (colIdx >= 0) {
        var col = columns[colIdx];
        var td = document.querySelector('td[data-row="' + msg.rowIdx + '"][data-col="' + colIdx + '"]');
        if (td) finishEdit(td, col, msg.rowIdx, msg.newValue);
      }
    }
    if (msg.type === 'updateData') {
      columns = msg.columns;
      pageRows = msg.rows;
      TOTAL_ROW_COUNT = msg.rowCount;
      if (msg.currentPage !== undefined) currentPage = msg.currentPage;
      if (msg.totalPages !== undefined) totalPages = msg.totalPages;
      if (msg.isEstimatedCount !== undefined) IS_ESTIMATED_COUNT = msg.isEstimatedCount;
      pendingEdits.clear();
      pendingNewRows.clear();

      // Check if recently inserted rows are in the refreshed data
      _outOfQueryRows = [];
      _outOfQueryPkSet = new Set();
      if (_lastInsertedRows.length > 0 && pkColumns.length > 0) {
        var existingPks = new Set();
        pageRows.forEach(function(pRow) {
          existingPks.add(pkColumns.map(function(pk) { return String(pRow[pk]); }).join('\\0'));
        });
        _lastInsertedRows.forEach(function(iRow) {
          var key = pkColumns.map(function(pk) { return String(iRow[pk]); }).join('\\0');
          if (!existingPks.has(key)) {
            _outOfQueryRows.push(iRow);
            _outOfQueryPkSet.add(key);
          }
        });
        // Append out-of-query rows to display
        _outOfQueryRows.forEach(function(r) { pageRows.push(r); });
        _lastInsertedRows = [];
      }

      originalRows = JSON.parse(JSON.stringify(pageRows));
      document.getElementById('statsInfo').textContent = msg.executionTimeMs + 'ms';
      renderHeader();
      renderPage();
      updateSaveButtons();
      hideLoading();
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

  // If initial query already has ORDER BY (e.g. via MCP customQuery), sync sort icons
  if (queryInput && queryInput.value.trim() && sortColumns.length === 0) {
    sortColumns = parseOrderByFromQuery(queryInput.value.trim());
  }
  renderHeader();
  renderPage();
  if (!IS_READONLY) updateSaveButtons();
})();
</script>
</body>
</html>`;
}
