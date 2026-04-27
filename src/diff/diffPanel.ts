import * as vscode from 'vscode';
import * as path from 'path';
import { DiffSource, DiffOptions, RowDiffResult, SchemaDiffResult, ObjectsDiffResult, StatsDiffResult } from './diffTypes';
import { buildDefaultDiffQuery, computeRowDiff, computeSchemaDiff, computeObjectsDiff, computeStatsDiff, exportDiffAsCsv, exportDiffAsJson, isReadOnlyStatement } from './diffEngine';
import { ColumnInfo, TableObjects, TableStatistic } from '../types/schema';
import type { ConnectionManager } from '../connections/connectionManager';
import { wrapError } from '../utils/errors';

interface DiffState {
  panel: vscode.WebviewPanel;
  left: DiffSource;
  right: DiffSource;
  options: DiffOptions;
  rowDiff: RowDiffResult;
  schemaDiff: SchemaDiffResult | null;
  objectsDiff: ObjectsDiffResult | null;
  statsDiff: StatsDiffResult | null;
  leftTableInfo?: { columns: ColumnInfo[] };
  rightTableInfo?: { columns: ColumnInfo[] };
  leftObjects?: TableObjects;
  rightObjects?: TableObjects;
  leftStats?: TableStatistic[];
  rightStats?: TableStatistic[];
  leftQuery: string;
  rightQuery: string;
  syncMode: boolean;
  /** Monotonic token; drops stale `runDiffQuery` results on swap/rerun races. */
  queryRunId: number;
  disposable: vscode.Disposable;
}

export type { DiffState };

export class DiffPanelManager {
  private readonly diffs = new Map<string, DiffState>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionManager?: ConnectionManager,
  ) {}

  // --- Read-only query API (production + tests) ---

  /** Number of currently-open diff panels. */
  getDiffCount(): number {
    return this.diffs.size;
  }

  /** Whether a diff panel exists for the given key (`diff:<title>`). */
  hasDiff(panelKey: string): boolean {
    return this.diffs.has(panelKey);
  }

  /**
   * Read-only snapshot of all open diff states.
   * @internal — exposed for e2e tests only. Mutating returned objects is undefined behaviour.
   */
  getDiffStatesForTesting(): readonly DiffState[] {
    return [...this.diffs.values()];
  }

  show(
    left: DiffSource,
    right: DiffSource,
    options: DiffOptions,
    leftTableInfo?: { columns: ColumnInfo[] },
    rightTableInfo?: { columns: ColumnInfo[] },
    leftObjects?: TableObjects,
    rightObjects?: TableObjects,
    leftStats?: TableStatistic[],
    rightStats?: TableStatistic[],
    queryState?: { leftQuery?: string; rightQuery?: string; syncMode?: boolean },
  ) {
    const rowDiff = computeRowDiff(left, right, options);
    const schemaDiff = leftTableInfo && rightTableInfo
      ? computeSchemaDiff(leftTableInfo.columns, rightTableInfo.columns)
      : null;
    const objectsDiff = (leftObjects || rightObjects)
      ? computeObjectsDiff(leftObjects, rightObjects)
      : null;
    const statsDiff = (leftStats || rightStats)
      ? computeStatsDiff(leftStats, rightStats)
      : null;

    const panelTitle = `Diff \u2014 ${left.label} \u2194 ${right.label}`;
    const panelKey = `diff:${panelTitle}`;

    const defaultLeftQuery = left.tableName ? buildDefaultDiffQuery(left.tableName, left.schema, options.rowLimit) : '';
    const defaultRightQuery = right.tableName ? buildDefaultDiffQuery(right.tableName, right.schema, options.rowLimit) : '';
    const leftQuery = queryState?.leftQuery ?? defaultLeftQuery;
    const rightQuery = queryState?.rightQuery ?? defaultRightQuery;
    const leftType = left.connectionId ? this.connectionManager?.get(left.connectionId)?.config.type : undefined;
    const rightType = right.connectionId ? this.connectionManager?.get(right.connectionId)?.config.type : undefined;
    const syncMode = queryState?.syncMode ?? !!(leftType && rightType && leftType === rightType);

    let state = this.diffs.get(panelKey);
    if (state) {
      state.panel.reveal();
      state.left = left;
      state.right = right;
      state.options = options;
      state.rowDiff = rowDiff;
      state.schemaDiff = schemaDiff;
      state.objectsDiff = objectsDiff;
      state.statsDiff = statsDiff;
      state.leftTableInfo = leftTableInfo;
      state.rightTableInfo = rightTableInfo;
      state.leftObjects = leftObjects;
      state.rightObjects = rightObjects;
      state.leftStats = leftStats;
      state.rightStats = rightStats;
      state.leftQuery = leftQuery;
      state.rightQuery = rightQuery;
      state.syncMode = syncMode;
      // Bump the run id so any in-flight `runDiffQuery` resolved after swap
      // is treated as stale and its result is dropped.
      state.queryRunId++;
    } else {
      const panel = vscode.window.createWebviewPanel(
        'viewstor.diff',
        panelTitle,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))],
        },
      );
      panel.onDidDispose(() => {
        const diffState = this.diffs.get(panelKey);
        if (diffState) diffState.disposable.dispose();
        this.diffs.delete(panelKey);
      });

      state = {
        panel,
        left,
        right,
        options,
        rowDiff,
        schemaDiff,
        objectsDiff,
        statsDiff,
        leftTableInfo,
        rightTableInfo,
        leftObjects,
        rightObjects,
        leftStats,
        rightStats,
        leftQuery,
        rightQuery,
        syncMode,
        queryRunId: 0,
        disposable: new vscode.Disposable(() => {}),
      };
      this.diffs.set(panelKey, state);
    }

    state.panel.webview.html = this.buildHtml(state.panel.webview, state);
    state.disposable.dispose();
    state.disposable = this.registerMessageHandler(state);
  }

  private registerMessageHandler(state: DiffState): vscode.Disposable {
    return state.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'exportDiff': {
          const content = msg.format === 'csv'
            ? exportDiffAsCsv(state.rowDiff, state.options.keyColumns)
            : exportDiffAsJson(state.rowDiff);
          const ext = msg.format === 'csv' ? 'csv' : 'json';
          const filters: Record<string, string[]> = msg.format === 'csv'
            ? { CSV: ['csv'] }
            : { JSON: ['json'] };
          const uri = await vscode.window.showSaveDialog({
            filters,
            defaultUri: vscode.Uri.file(`diff-export.${ext}`),
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
            vscode.window.showInformationMessage(
              vscode.l10n.t('Diff exported to {0}', uri.fsPath),
            );
          }
          break;
        }

        case 'swapSides': {
          // Swap left and right sources + any edited queries, then recompute.
          const swappedLeftQuery = state.rightQuery;
          const swappedRightQuery = state.leftQuery;
          this.show(
            state.right,
            state.left,
            state.options,
            state.rightTableInfo,
            state.leftTableInfo,
            state.rightObjects,
            state.leftObjects,
            state.rightStats,
            state.leftStats,
            { leftQuery: swappedLeftQuery, rightQuery: swappedRightQuery, syncMode: state.syncMode },
          );
          break;
        }

        case 'runDiffQuery': {
          // Persist editor state so swap/refresh preserves it
          if (typeof msg.leftQuery === 'string') state.leftQuery = msg.leftQuery;
          if (typeof msg.rightQuery === 'string') state.rightQuery = msg.rightQuery;
          if (typeof msg.syncMode === 'boolean') state.syncMode = msg.syncMode;
          await this.runDiffQuery(state);
          break;
        }

        case 'updateQueries': {
          if (typeof msg.leftQuery === 'string') state.leftQuery = msg.leftQuery;
          if (typeof msg.rightQuery === 'string') state.rightQuery = msg.rightQuery;
          if (typeof msg.syncMode === 'boolean') state.syncMode = msg.syncMode;
          break;
        }
      }
    });
  }

  /**
   * Execute the current leftQuery/rightQuery against their respective drivers,
   * recompute the row diff, and push the result to the webview.
   * Schema / objects / stats diffs are unaffected because they describe the
   * underlying table definition, not the arbitrary query result.
   */
  private async runDiffQuery(state: DiffState): Promise<void> {
    // `canEditQueries` (buildHtml) gates the editor UI on a non-null
    // `connectionManager`, so this method is unreachable without one.
    const cm = this.connectionManager!;

    // Readonly gate: the diff editor runs arbitrary user SQL. When the
    // connection is marked readonly (own setting or inherited from folder),
    // reject any statement that isn't SELECT / WITH / EXPLAIN.
    const leftReadonlyErr = readonlyError(cm, state.left, state.leftQuery);
    const rightReadonlyErr = readonlyError(cm, state.right, state.rightQuery);
    if (leftReadonlyErr || rightReadonlyErr) {
      state.panel.webview.postMessage({
        type: 'diffQueryError',
        leftError: leftReadonlyErr,
        rightError: rightReadonlyErr,
      });
      return;
    }

    const getDriver = async (source: DiffSource) => {
      if (!source.connectionId) return undefined;
      if (source.databaseName) {
        return cm.getDriverForDatabase(source.connectionId, source.databaseName);
      }
      return cm.getDriver(source.connectionId);
    };

    // Snapshot identity markers so a swap-while-running drops the result.
    const runId = state.queryRunId;
    const leftSnapshot = state.left;
    const rightSnapshot = state.right;

    state.panel.webview.postMessage({ type: 'diffQueryRunning' });

    let leftError: string | undefined;
    let rightError: string | undefined;

    const [leftResult, rightResult] = await Promise.all([
      (async () => {
        try {
          const driver = await getDriver(state.left);
          if (!driver) throw new Error('left driver unavailable');
          return await driver.execute(state.leftQuery);
        } catch (err) {
          leftError = wrapError(err);
          return undefined;
        }
      })(),
      (async () => {
        try {
          const driver = await getDriver(state.right);
          if (!driver) throw new Error('right driver unavailable');
          return await driver.execute(state.rightQuery);
        } catch (err) {
          rightError = wrapError(err);
          return undefined;
        }
      })(),
    ]);

    if (state.queryRunId !== runId || state.left !== leftSnapshot || state.right !== rightSnapshot) {
      return;
    }

    if (leftError || rightError) {
      state.panel.webview.postMessage({
        type: 'diffQueryError',
        leftError,
        rightError,
      });
      return;
    }

    const keyColumns = state.options.keyColumns;
    const missingLeftKeys = keyColumns.filter(k => !leftResult!.columns.some(c => c.name === k));
    const missingRightKeys = keyColumns.filter(k => !rightResult!.columns.some(c => c.name === k));
    if (missingLeftKeys.length > 0 || missingRightKeys.length > 0) {
      state.panel.webview.postMessage({
        type: 'diffQueryError',
        leftError: missingLeftKeys.length > 0 ? `Query results must include key column(s): ${missingLeftKeys.join(', ')}` : undefined,
        rightError: missingRightKeys.length > 0 ? `Query results must include key column(s): ${missingRightKeys.join(', ')}` : undefined,
      });
      return;
    }

    state.left = { ...state.left, columns: leftResult!.columns, rows: leftResult!.rows };
    state.right = { ...state.right, columns: rightResult!.columns, rows: rightResult!.rows };
    state.rowDiff = computeRowDiff(state.left, state.right, state.options);

    state.panel.webview.postMessage({
      type: 'updateDiff',
      rowDiff: state.rowDiff,
      truncated: state.rowDiff.truncated,
    });
  }

  private buildHtml(webview: vscode.Webview, state: DiffState): string {
    const distUri = vscode.Uri.file(path.join(this.context.extensionPath, 'dist'));
    const tokensUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'tokens.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'codicon.css'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'diff-panel.css'));
    const ctxMenuCssUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'context-menu.css'));
    const shellUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'webview-shell.js'));
    const elementsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'vscode-elements.js'));
    const ctxMenuJsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'context-menu.js'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'diff-panel.js'));
    const echartsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'echarts.min.js'));
    const sqlEditorUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'sql-editor.js'));
    const cspSource = webview.cspSource;

    const canEditQueries = !!(state.left.connectionId && state.right.connectionId && this.connectionManager);

    const diffData = {
      rowDiff: state.rowDiff,
      schemaDiff: state.schemaDiff,
      objectsDiff: state.objectsDiff,
      statsDiff: state.statsDiff,
      leftLabel: state.left.label,
      rightLabel: state.right.label,
      keyColumns: state.options.keyColumns,
      leftQuery: state.leftQuery,
      rightQuery: state.rightQuery,
      syncMode: state.syncMode,
      canEditQueries,
    };

    const summary = state.rowDiff.summary;
    const hasSchema = !!state.schemaDiff;
    const hasStats = !!state.statsDiff;

    // Counts for Schema Diff tab badge
    let schemaDiffers = 0, schemaSame = 0;
    if (state.schemaDiff) {
      for (const col of state.schemaDiff.commonColumns) {
        if (col.typeDiffers || col.nullableDiffers || col.pkDiffers || col.commentDiffers) schemaDiffers++;
        else schemaSame++;
      }
      schemaDiffers += state.schemaDiff.leftOnlyColumns.length + state.schemaDiff.rightOnlyColumns.length;
    }
    if (state.objectsDiff) {
      for (const group of [state.objectsDiff.indexes, state.objectsDiff.constraints, state.objectsDiff.triggers, state.objectsDiff.sequences]) {
        for (const item of group) {
          if (item.status === 'same') schemaSame++;
          else schemaDiffers++;
        }
      }
    }

    // Counts for Statistics tab
    let statsDiffers = 0, statsSame = 0;
    if (state.statsDiff) {
      for (const item of state.statsDiff.items) {
        if (item.status === 'same' || item.status === 'missing') statsSame++;
        else statsDiffers++;
      }
    }

    // Row diff "total changes" count drives the Row Diff tab badge color intensity
    const rowDiffers = summary.changed + summary.added + summary.removed;

    const rowTabBadgeClass = rowDiffers > 0 ? 'tab-badge warn' : 'tab-badge ok';
    const schemaTabBadgeClass = schemaDiffers > 0 ? 'tab-badge warn' : 'tab-badge ok';
    const statsTabBadgeClass = statsDiffers > 0 ? 'tab-badge warn' : 'tab-badge ok';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src ${cspSource} 'unsafe-inline';">
<link id="vscode-codicon-stylesheet" rel="stylesheet" href="${codiconUri}">
<link rel="stylesheet" href="${tokensUri}">
<link rel="stylesheet" href="${ctxMenuCssUri}">
<link rel="stylesheet" href="${cssUri}">
<script src="${shellUri}"></script>
<script src="${ctxMenuJsUri}"></script>
<script type="module" src="${elementsUri}"></script>
</head>
<body>
  <vscode-tabs id="diffTabs" panel>
    <vscode-tab-header slot="header" id="tabHeader-rows">
      <span>Row Diff</span>
      <span class="${rowTabBadgeClass}" id="tabBadge-rows" aria-hidden="true">${esc(String(rowDiffers))}</span>
    </vscode-tab-header>
    <vscode-tab-panel>
      <div class="diff-toolbar" data-tab="rows">
        <div class="diff-summary-filters" data-for="rows">
          <button type="button" class="diff-chip unchanged active" data-filter="unchanged" aria-pressed="true">
            <span class="diff-chip-count" id="chip-unchanged">${esc(String(summary.unchanged))}</span> unchanged
          </button>
          <button type="button" class="diff-chip changed active" data-filter="changed" aria-pressed="true">
            <span class="diff-chip-count" id="chip-changed">${esc(String(summary.changed))}</span> changed
          </button>
          <button type="button" class="diff-chip added active" data-filter="added" aria-pressed="true">
            <span class="diff-chip-count" id="chip-added">${esc(String(summary.added))}</span> added
          </button>
          <button type="button" class="diff-chip removed active" data-filter="removed" aria-pressed="true">
            <span class="diff-chip-count" id="chip-removed">${esc(String(summary.removed))}</span> removed
          </button>
          <span class="diff-filter-hint" title="Shift+click to toggle multiple at once">Click to solo \u00B7 Shift+click to toggle</span>
        </div>
        <span class="diff-toolbar-spacer"></span>
        <vscode-button id="swapSides" secondary title="Swap left and right sides">
          <vscode-icon slot="content-before" name="arrow-swap"></vscode-icon>
          Swap
        </vscode-button>
        <vscode-button id="exportCsv" secondary title="Export row diff as CSV">
          <vscode-icon slot="content-before" name="export"></vscode-icon>
          CSV
        </vscode-button>
        <vscode-button id="exportJson" secondary title="Export row diff as JSON">
          <vscode-icon slot="content-before" name="export"></vscode-icon>
          JSON
        </vscode-button>
      </div>

      <div class="diff-source-bar" aria-label="Diff sources">
        <div class="diff-source-item" title="Left source"><span class="diff-source-label">Left</span> <span id="leftSourceLabel">${esc(state.left.label)}</span></div>
        <div class="diff-source-sep"><vscode-icon name="arrow-both"></vscode-icon></div>
        <div class="diff-source-item" title="Right source"><span class="diff-source-label">Right</span> <span id="rightSourceLabel">${esc(state.right.label)}</span></div>
      </div>

      ${state.rowDiff.truncated
        ? '<div class="diff-truncated" id="diff-truncated-banner"><vscode-icon name="warning"></vscode-icon> Results truncated to row limit. Increase the limit to see all differences.</div>'
        : '<div class="diff-truncated" id="diff-truncated-banner" hidden><vscode-icon name="warning"></vscode-icon> Results truncated to row limit. Increase the limit to see all differences.</div>'}

      ${canEditQueries ? `
      <vscode-collapsible id="diffQueryEditor" heading="SQL" description="Custom queries for this diff">
        <vscode-icon slot="decorations" name="info" title="Customize the SQL that feeds this diff. Results must include the key column(s). Ctrl/Cmd+Enter runs the diff."></vscode-icon>
        <div class="diff-query-editor-body">
          <div class="diff-query-editor-toolbar">
            <vscode-checkbox id="diffQuerySync" ${state.syncMode ? 'checked' : ''}>Synced</vscode-checkbox>
            <span class="diff-sync-indicator" id="diffSyncIndicator" aria-hidden="true" ${state.syncMode ? '' : 'hidden'}>
              <vscode-icon name="lock"></vscode-icon>
            </span>
            <span class="diff-query-editor-spacer"></span>
            <span class="diff-query-editor-status" id="diffQueryStatus" aria-live="polite"></span>
            <vscode-button id="diffRunQuery" title="Run diff (Ctrl/Cmd+Enter)">
              <vscode-icon slot="content-before" name="play"></vscode-icon>
              Run Diff
            </vscode-button>
          </div>
          <div class="diff-query-editor-panes${state.syncMode ? ' synced' : ''}" id="diffQueryPanes">
            <div class="diff-query-editor-pane" data-side="left">
              <div class="diff-query-editor-label" data-role="side-label">${esc(state.left.label)}</div>
              <div class="diff-query-editor-wrap" id="diffQueryLeftWrap" data-default-query="${esc(state.leftQuery)}"></div>
              <div class="diff-query-editor-error" id="diffQueryLeftError" hidden></div>
            </div>
            <div class="diff-query-editor-pane" data-side="right">
              <div class="diff-query-editor-label" data-role="side-label">${esc(state.right.label)}</div>
              <div class="diff-query-editor-wrap" id="diffQueryRightWrap" data-default-query="${esc(state.rightQuery)}"></div>
              <div class="diff-query-editor-error" id="diffQueryRightError" hidden></div>
            </div>
          </div>
        </div>
      </vscode-collapsible>
      ` : ''}

      <div class="diff-tables-container">
        <div class="diff-table-pane" id="leftPane">
          <table class="diff-table">
            <thead id="leftTableHead"></thead>
            <tbody id="leftTableBody"></tbody>
          </table>
        </div>
        <div class="diff-table-pane" id="rightPane">
          <table class="diff-table">
            <thead id="rightTableHead"></thead>
            <tbody id="rightTableBody"></tbody>
          </table>
        </div>
      </div>
    </vscode-tab-panel>

    <vscode-tab-header slot="header" id="tabHeader-schema">
      <span>Schema Diff</span>
      <span class="${schemaTabBadgeClass}" id="tabBadge-schema" aria-hidden="true">${esc(String(schemaDiffers))}</span>
    </vscode-tab-header>
    <vscode-tab-panel>
      ${hasSchema ? `
      <div class="diff-toolbar" data-tab="schema">
        <div class="diff-summary-filters" data-for="schema">
          <button type="button" class="diff-chip differs active" data-filter="differs" aria-pressed="true">
            <span class="diff-chip-count" id="chip-schema-differs">${esc(String(schemaDiffers))}</span> differs
          </button>
          <button type="button" class="diff-chip same active" data-filter="same" aria-pressed="true">
            <span class="diff-chip-count" id="chip-schema-same">${esc(String(schemaSame))}</span> same
          </button>
          <span class="diff-filter-hint" title="Shift+click to toggle multiple at once">Click to solo \u00B7 Shift+click to toggle</span>
        </div>
        <span class="diff-toolbar-spacer"></span>
      </div>

      <div class="diff-source-bar">
        <div class="diff-source-item"><span class="diff-source-label">Left</span> <span>${esc(state.left.label)}</span></div>
        <div class="diff-source-sep"><vscode-icon name="arrow-both"></vscode-icon></div>
        <div class="diff-source-item"><span class="diff-source-label">Right</span> <span>${esc(state.right.label)}</span></div>
      </div>

      <div class="diff-schema-layout">
        <div class="diff-schema-block diff-schema-columns-block">
          <h3 class="diff-section-title">Columns</h3>
          <div class="diff-schema-block-scroll">
            <table class="diff-schema-table">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Type</th>
                  <th>Nullable</th>
                  <th>PK</th>
                  <th>Comment</th>
                  <th>Indexed by</th>
                </tr>
              </thead>
              <tbody id="schemaTableBody"></tbody>
            </table>
          </div>
        </div>
        <div id="objectsDiffContainer"></div>
      </div>
      ` : '<div class="diff-no-schema"><vscode-icon name="info"></vscode-icon> Schema diff not available (table info not provided)</div>'}
    </vscode-tab-panel>

    ${hasStats ? `
    <vscode-tab-header slot="header" id="tabHeader-stats">
      <span>Statistics</span>
      <span class="${statsTabBadgeClass}" id="tabBadge-stats" aria-hidden="true">${esc(String(statsDiffers))}</span>
    </vscode-tab-header>
    <vscode-tab-panel>
      <div class="diff-toolbar" data-tab="stats">
        <div class="diff-summary-filters" data-for="stats">
          <button type="button" class="diff-chip differs active" data-filter="differs" aria-pressed="true">
            <span class="diff-chip-count" id="chip-stats-differs">${esc(String(statsDiffers))}</span> differs
          </button>
          <button type="button" class="diff-chip same active" data-filter="same" aria-pressed="true">
            <span class="diff-chip-count" id="chip-stats-same">${esc(String(statsSame))}</span> same
          </button>
          <span class="diff-filter-hint" title="Shift+click to toggle multiple at once">Click to solo \u00B7 Shift+click to toggle</span>
        </div>
        <span class="diff-toolbar-spacer"></span>
      </div>

      <div class="diff-source-bar">
        <div class="diff-source-item">
          <span class="diff-stats-swatch diff-stats-swatch-left"></span>
          <span class="diff-source-label">Left</span> <span>${esc(state.left.label)}</span>
        </div>
        <div class="diff-source-sep"><vscode-icon name="arrow-both"></vscode-icon></div>
        <div class="diff-source-item">
          <span class="diff-stats-swatch diff-stats-swatch-right"></span>
          <span class="diff-source-label">Right</span> <span>${esc(state.right.label)}</span>
        </div>
      </div>

      <div class="diff-stats-container">
        <div id="statsZeroSummary" class="diff-stats-zero-summary" hidden></div>
        <div id="statsChart"></div>
        <div id="statsNonNumeric"></div>
      </div>
    </vscode-tab-panel>
    ` : ''}
  </vscode-tabs>

  <script>window.diffData = ${safeJsonForScript(diffData)};</script>
  ${canEditQueries ? `<script src="${sqlEditorUri}"></script>` : ''}
  ${hasStats ? `<script src="${echartsUri}"></script>` : ''}
  <script src="${jsUri}"></script>
</body>
</html>`;
  }
}

/**
 * Return an error message iff `source.connectionId` is readonly and `query` is
 * not a read-only statement.
 */
function readonlyError(cm: Pick<ConnectionManager, 'isConnectionReadonly'>, source: DiffSource, query: string): string | undefined {
  if (!source.connectionId) return undefined;
  if (!cm.isConnectionReadonly(source.connectionId)) return undefined;
  if (isReadOnlyStatement(query)) return undefined;
  return 'Connection is read-only. Only SELECT, EXPLAIN, SHOW, and WITH queries are allowed.';
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}
