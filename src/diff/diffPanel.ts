import * as vscode from 'vscode';
import * as path from 'path';
import { DiffSource, DiffOptions, RowDiffResult, SchemaDiffResult, ObjectsDiffResult, StatsDiffResult } from './diffTypes';
import { buildDefaultDiffQuery, computeRowDiff, computeSchemaDiff, computeObjectsDiff, computeStatsDiff, exportDiffAsCsv, exportDiffAsJson, isReadOnlyStatement } from './diffEngine';
import { ColumnInfo, TableObjects, TableStatistic } from '../types/schema';
import type { ConnectionManager } from '../connections/connectionManager';

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

export class DiffPanelManager {
  private diffs = new Map<string, DiffState>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionManager?: ConnectionManager,
  ) {}

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
    // reject any statement that isn't SELECT / WITH / EXPLAIN — same
    // whitelist the MCP server uses. Prevents `DELETE FROM users` pasted
    // into the textarea from executing on a readonly connection.
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
          leftError = err instanceof Error ? err.message : String(err);
          return undefined;
        }
      })(),
      (async () => {
        try {
          const driver = await getDriver(state.right);
          if (!driver) throw new Error('right driver unavailable');
          return await driver.execute(state.rightQuery);
        } catch (err) {
          rightError = err instanceof Error ? err.message : String(err);
          return undefined;
        }
      })(),
    ]);

    // Drop stale results if the user swapped sides (or triggered another run)
    // while we were awaiting driver.execute.
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

    // Verify both result sets carry the key columns — otherwise matching is meaningless
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

    // Swap in the new rows/columns and recompute
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
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'diff-panel.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'diff-panel.js'));
    const echartsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'echarts.min.js'));
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

    // Counts for Schema Diff tab: "differs" bundles type/nullable/pk/comment diffs + added/removed columns + non-same objects
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

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'unsafe-inline' ${cspSource};">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div class="diff-tab-bar">
    <button class="diff-tab active" data-tab="rows">Row Diff</button>
    <button class="diff-tab" data-tab="schema">Schema Diff</button>
    ${hasStats ? '<button class="diff-tab" data-tab="stats">Statistics</button>' : ''}
  </div>

  <div class="diff-summary">
    <div class="diff-summary-filters" data-for="rows">
      <span class="diff-badge-filter unchanged active" data-filter="unchanged">${esc(String(summary.unchanged))} unchanged</span>
      <span class="diff-badge-filter changed active" data-filter="changed">${esc(String(summary.changed))} changed</span>
      <span class="diff-badge-filter added active" data-filter="added">${esc(String(summary.added))} added</span>
      <span class="diff-badge-filter removed active" data-filter="removed">${esc(String(summary.removed))} removed</span>
    </div>
    ${hasSchema ? `
    <div class="diff-summary-filters hidden" data-for="schema">
      <span class="diff-badge-filter differs active" data-filter="differs">${esc(String(schemaDiffers))} differs</span>
      <span class="diff-badge-filter same active" data-filter="same">${esc(String(schemaSame))} same</span>
    </div>
    ` : ''}
    ${hasStats ? `
    <div class="diff-summary-filters hidden" data-for="stats">
      <span class="diff-badge-filter differs active" data-filter="differs">${esc(String(statsDiffers))} differs</span>
      <span class="diff-badge-filter same active" data-filter="same">${esc(String(statsSame))} same</span>
    </div>
    ` : ''}
    <span class="diff-filter-hint" title="Shift+click a badge to toggle multiple at once">Click to filter · Shift+click for multi-select</span>
    <span class="diff-summary-spacer"></span>
    <button id="swapSides" title="Swap left and right sides">\u21C4 Swap</button>
    <button id="exportCsv">Export CSV</button>
    <button id="exportJson">Export JSON</button>
  </div>

  ${state.rowDiff.truncated ? '<div class="diff-truncated" id="diff-truncated-banner">Results truncated to row limit. Increase the limit to see all differences.</div>' : '<div class="diff-truncated" id="diff-truncated-banner" style="display:none;">Results truncated to row limit. Increase the limit to see all differences.</div>'}

  <div id="panel-rows" class="diff-tab-panel active">
    ${canEditQueries ? `
    <details class="diff-query-editor" id="diffQueryEditor">
      <summary class="diff-query-editor-summary">
        <span class="diff-query-editor-chevron">\u25B8</span>
        <span>Edit Queries</span>
        <span class="diff-query-editor-hint">Customize the SQL that feeds this diff</span>
      </summary>
      <div class="diff-query-editor-body">
        <div class="diff-query-editor-toolbar">
          <label class="diff-query-editor-sync">
            <input type="checkbox" id="diffQuerySync" ${state.syncMode ? 'checked' : ''}>
            <span class="diff-query-editor-sync-label">\u{1F517} Synced</span>
          </label>
          <span class="diff-query-editor-sync-hint">When on, edits to either side are mirrored to the other.</span>
          <span class="diff-query-editor-spacer"></span>
          <span class="diff-query-editor-status" id="diffQueryStatus"></span>
          <button id="diffRunQuery" class="diff-query-editor-run">\u25B6 Run Diff</button>
        </div>
        <div class="diff-query-editor-panes${state.syncMode ? ' synced' : ''}" id="diffQueryPanes">
          <div class="diff-query-editor-pane" data-side="left">
            <div class="diff-query-editor-label" data-role="side-label">${esc(state.left.label)}</div>
            <div class="diff-query-editor-wrap">
              <div class="diff-query-editor-highlight" id="diffQueryLeftHighlight" aria-hidden="true"></div>
              <textarea class="diff-query-editor-textarea has-highlight" id="diffQueryLeft" rows="1" spellcheck="false">${esc(state.leftQuery)}</textarea>
            </div>
            <div class="diff-query-editor-error" id="diffQueryLeftError"></div>
          </div>
          <div class="diff-query-editor-pane" data-side="right">
            <div class="diff-query-editor-label" data-role="side-label">${esc(state.right.label)}</div>
            <div class="diff-query-editor-wrap">
              <div class="diff-query-editor-highlight" id="diffQueryRightHighlight" aria-hidden="true"></div>
              <textarea class="diff-query-editor-textarea has-highlight" id="diffQueryRight" rows="1" spellcheck="false">${esc(state.rightQuery)}</textarea>
            </div>
            <div class="diff-query-editor-error" id="diffQueryRightError"></div>
          </div>
        </div>
      </div>
    </details>
    ` : ''}
    <div class="diff-tables-container">
      <div class="diff-table-pane" id="leftPane">
        <div class="diff-table-pane-header" id="leftHeader">${esc(state.left.label)}</div>
        <table class="diff-table">
          <thead id="leftTableHead"></thead>
          <tbody id="leftTableBody"></tbody>
        </table>
      </div>
      <div class="diff-table-pane" id="rightPane">
        <div class="diff-table-pane-header" id="rightHeader">${esc(state.right.label)}</div>
        <table class="diff-table">
          <thead id="rightTableHead"></thead>
          <tbody id="rightTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div id="panel-schema" class="diff-tab-panel">
    ${hasSchema ? `
    <div class="diff-schema-layout">
      <div class="diff-schema-block diff-schema-columns-block">
        <h3 class="diff-section-title">Columns</h3>
        <div class="diff-schema-block-scroll">
          <table class="diff-schema-table">
            <thead>
              <tr>
                <th>Column</th>
                <th>Type<span class="diff-th-sub">${esc(state.left.label)} / ${esc(state.right.label)}</span></th>
                <th>Nullable<span class="diff-th-sub">${esc(state.left.label)} / ${esc(state.right.label)}</span></th>
                <th>PK<span class="diff-th-sub">${esc(state.left.label)} / ${esc(state.right.label)}</span></th>
                <th>Comment<span class="diff-th-sub">${esc(state.left.label)} / ${esc(state.right.label)}</span></th>
                <th>Indexed by<span class="diff-th-sub">${esc(state.left.label)} / ${esc(state.right.label)}</span></th>
              </tr>
            </thead>
            <tbody id="schemaTableBody"></tbody>
          </table>
        </div>
      </div>
      <div id="objectsDiffContainer"></div>
    </div>
    ` : '<div class="diff-no-schema">Schema diff not available (table info not provided)</div>'}
  </div>

  ${hasStats ? `
  <div id="panel-stats" class="diff-tab-panel">
    <div class="diff-stats-container">
      <div class="diff-stats-legend">
        <span class="diff-stats-legend-item"><span class="diff-stats-swatch diff-stats-swatch-left"></span>${esc(state.left.label)}</span>
        <span class="diff-stats-legend-item"><span class="diff-stats-swatch diff-stats-swatch-right"></span>${esc(state.right.label)}</span>
      </div>
      <div id="statsChart"></div>
      <div id="statsNonNumeric"></div>
    </div>
  </div>
  ` : ''}

  <script>window.diffData = ${safeJsonForScript(diffData)};</script>
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
