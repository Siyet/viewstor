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

export interface TablePickResult {
  connectionId: string;
  tableName: string;
  schema?: string;
  databaseName?: string;
  connectionName: string;
}

export type PickTableFn = (placeholder: string) => Promise<TablePickResult | undefined>;

interface PendingDiffState {
  panel: vscode.WebviewPanel;
  leftPick?: TablePickResult;
  rightPick?: TablePickResult;
  pickTable: PickTableFn;
  disposable: vscode.Disposable;
}

export class DiffPanelManager {
  private readonly diffs = new Map<string, DiffState>();
  private pendingDiff: PendingDiffState | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionManager?: ConnectionManager,
  ) {}

  showPending(pickTable: PickTableFn) {
    if (this.pendingDiff) {
      this.pendingDiff.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'viewstor.diff',
      'Compare Data',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))],
      },
    );

    const state: PendingDiffState = {
      panel,
      pickTable,
      disposable: new vscode.Disposable(() => {}),
    };
    this.pendingDiff = state;

    panel.onDidDispose(() => {
      state.disposable.dispose();
      if (this.pendingDiff === state) this.pendingDiff = undefined;
    });

    panel.webview.html = this.buildPendingHtml(panel.webview, state);
    state.disposable = this.registerPendingMessageHandler(state);
  }

  private registerPendingMessageHandler(state: PendingDiffState): vscode.Disposable {
    return state.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type !== 'pickTable') return;
      const side: 'left' | 'right' = msg.side;

      const placeholder = side === 'left'
        ? vscode.l10n.t('Select LEFT table')
        : vscode.l10n.t('Select RIGHT table');

      const pick = await state.pickTable(placeholder);
      if (!pick) return;
      if (this.pendingDiff !== state) return;

      if (side === 'left') state.leftPick = pick;
      else state.rightPick = pick;

      state.panel.webview.postMessage({
        type: 'tableSelected',
        side,
        label: `${pick.connectionName} → ${pick.tableName}`,
      });

      if (state.leftPick && state.rightPick) {
        await this.transitionPendingToFull(state);
      }
    });
  }

  private async transitionPendingToFull(state: PendingDiffState): Promise<void> {
    const left = state.leftPick!;
    const right = state.rightPick!;
    const cm = this.connectionManager;
    if (!cm) return;

    state.panel.webview.postMessage({ type: 'pendingLoading' });

    const rowLimit = vscode.workspace.getConfiguration('viewstor').get<number>('diffRowLimit', 10000);

    try {
      const getDriver = async (pick: TablePickResult) => {
        if (pick.databaseName) {
          return cm.getDriverForDatabase(pick.connectionId, pick.databaseName);
        }
        return cm.getDriver(pick.connectionId);
      };

      const leftDriver = await getDriver(left);
      const rightDriver = await getDriver(right);
      if (!leftDriver || !rightDriver) {
        vscode.window.showErrorMessage(vscode.l10n.t('Could not get database driver.'));
        this.resetPendingPanel(state);
        return;
      }

      if (this.pendingDiff !== state) return;

      const [leftInfo, rightInfo, leftData, rightData] = await Promise.all([
        leftDriver.getTableInfo(left.tableName, left.schema),
        rightDriver.getTableInfo(right.tableName, right.schema),
        leftDriver.getTableData(left.tableName, left.schema, rowLimit, 0),
        rightDriver.getTableData(right.tableName, right.schema, rowLimit, 0),
      ]);

      if (this.pendingDiff !== state) return;

      let leftObjects, rightObjects;
      try {
        [leftObjects, rightObjects] = await Promise.all([
          leftDriver.getTableObjects ? leftDriver.getTableObjects(left.tableName, left.schema) : undefined,
          rightDriver.getTableObjects ? rightDriver.getTableObjects(right.tableName, right.schema) : undefined,
        ]);
      } catch { /* schema objects unavailable */ }

      let leftStats, rightStats;
      const leftStateCfg = cm.get(left.connectionId);
      const rightStateCfg = cm.get(right.connectionId);
      const sameType = leftStateCfg?.config.type === rightStateCfg?.config.type;
      if (sameType && leftDriver.getTableStatistics && rightDriver.getTableStatistics) {
        try {
          [leftStats, rightStats] = await Promise.all([
            leftDriver.getTableStatistics(left.tableName, left.schema),
            rightDriver.getTableStatistics(right.tableName, right.schema),
          ]);
        } catch { /* statistics unavailable */ }
      }

      const pkColumns = leftInfo.columns.filter(c => c.isPrimaryKey).map(c => c.name);
      let keyColumns = pkColumns;

      if (keyColumns.length === 0) {
        const colPick = await vscode.window.showQuickPick(
          leftInfo.columns.map(c => ({ label: c.name, description: c.dataType, picked: false })),
          { canPickMany: true, placeHolder: vscode.l10n.t('No primary key found. Select key column(s) for matching:') },
        );
        if (!colPick || colPick.length === 0) {
          this.resetPendingPanel(state);
          return;
        }
        keyColumns = colPick.map(c => c.label);
      }

      if (this.pendingDiff !== state) return;

      const leftSource: DiffSource = {
        label: `${left.connectionName} → ${left.tableName}`,
        columns: leftData.columns,
        rows: leftData.rows,
        connectionId: left.connectionId,
        tableName: left.tableName,
        schema: left.schema,
        databaseName: left.databaseName,
      };

      const rightSource: DiffSource = {
        label: `${right.connectionName} → ${right.tableName}`,
        columns: rightData.columns,
        rows: rightData.rows,
        connectionId: right.connectionId,
        tableName: right.tableName,
        schema: right.schema,
        databaseName: right.databaseName,
      };

      const existingPanel = state.panel;
      state.disposable.dispose();
      if (this.pendingDiff === state) this.pendingDiff = undefined;

      this.showInPanel(leftSource, rightSource, { keyColumns, rowLimit },
        { columns: leftInfo.columns },
        { columns: rightInfo.columns },
        leftObjects, rightObjects,
        leftStats, rightStats,
        existingPanel,
      );
    } catch (err) {
      this.resetPendingPanel(state);
      vscode.window.showErrorMessage(vscode.l10n.t('Compare failed: {0}', wrapError(err)));
    }
  }

  private resetPendingPanel(state: PendingDiffState): void {
    if (this.pendingDiff !== state) return;
    state.leftPick = undefined;
    state.rightPick = undefined;
    state.disposable.dispose();
    state.panel.webview.html = this.buildPendingHtml(state.panel.webview, state);
    state.disposable = this.registerPendingMessageHandler(state);
  }

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
    this.showInPanel(left, right, options, leftTableInfo, rightTableInfo,
      leftObjects, rightObjects, leftStats, rightStats, undefined, queryState);
  }

  private showInPanel(
    left: DiffSource,
    right: DiffSource,
    options: DiffOptions,
    leftTableInfo?: { columns: ColumnInfo[] },
    rightTableInfo?: { columns: ColumnInfo[] },
    leftObjects?: TableObjects,
    rightObjects?: TableObjects,
    leftStats?: TableStatistic[],
    rightStats?: TableStatistic[],
    existingPanel?: vscode.WebviewPanel,
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
      state.queryRunId++;
    } else {
      const panel = existingPanel ?? vscode.window.createWebviewPanel(
        'viewstor.diff',
        panelTitle,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))],
        },
      );
      if (existingPanel) panel.title = panelTitle;
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

  private buildPendingHtml(webview: vscode.Webview, state: PendingDiffState): string {
    const distUri = vscode.Uri.file(path.join(this.context.extensionPath, 'dist'));
    const tokensUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'tokens.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'codicon.css'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'diff-panel.css'));
    const shellUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'webview-shell.js'));
    const elementsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'vscode-elements.js'));
    const cspSource = webview.cspSource;

    const leftLabel = state.leftPick
      ? esc(`${state.leftPick.connectionName} → ${state.leftPick.tableName}`)
      : '';
    const rightLabel = state.rightPick
      ? esc(`${state.rightPick.connectionName} → ${state.rightPick.tableName}`)
      : '';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src ${cspSource} 'unsafe-inline';">
<link id="vscode-codicon-stylesheet" rel="stylesheet" href="${codiconUri}">
<link rel="stylesheet" href="${tokensUri}">
<link rel="stylesheet" href="${cssUri}">
<script src="${shellUri}"></script>
<script type="module" src="${elementsUri}"></script>
</head>
<body>
  <div class="diff-pending-container">
    <div class="diff-pending-pane" id="pendingLeft" data-side="left">
      ${state.leftPick
        ? `<div class="diff-pending-filled"><vscode-icon name="check"></vscode-icon> <span>${leftLabel}</span></div>`
        : `<button type="button" class="diff-pending-pick" data-side="left">
            <i class="codicon codicon-add"></i>
            <span>Pick a table</span>
          </button>`
      }
    </div>
    <div class="diff-pending-divider">
      <i class="codicon codicon-arrow-both"></i>
    </div>
    <div class="diff-pending-pane" id="pendingRight" data-side="right">
      ${state.rightPick
        ? `<div class="diff-pending-filled"><vscode-icon name="check"></vscode-icon> <span>${rightLabel}</span></div>`
        : `<button type="button" class="diff-pending-pick" data-side="right">
            <i class="codicon codicon-add"></i>
            <span>Pick a table</span>
          </button>`
      }
    </div>
  </div>
  <div class="diff-pending-loading" id="pendingLoading" hidden>
    <vscode-icon name="sync" spin></vscode-icon> Loading comparison data…
  </div>
  <script>
  (function() {
    var vscode = acquireVsCodeApi();
    document.querySelectorAll('.diff-pending-pick').forEach(function(btn) {
      btn.addEventListener('click', function() {
        vscode.postMessage({ type: 'pickTable', side: btn.dataset.side });
      });
    });
    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg.type === 'tableSelected') {
        var pane = document.getElementById(msg.side === 'left' ? 'pendingLeft' : 'pendingRight');
        if (pane) {
          pane.innerHTML = '<div class="diff-pending-filled"><vscode-icon name="check"></vscode-icon> <span>' +
            msg.label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span></div>';
        }
      }
      if (msg.type === 'pendingLoading') {
        var el = document.getElementById('pendingLoading');
        if (el) el.hidden = false;
      }
    });
  })();
  </script>
</body>
</html>`;
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
              <div class="diff-query-editor-wrap">
                <div class="diff-query-editor-highlight" id="diffQueryLeftHighlight" aria-hidden="true"></div>
                <textarea class="diff-query-editor-textarea has-highlight" id="diffQueryLeft" rows="1" spellcheck="false">${esc(state.leftQuery)}</textarea>
              </div>
              <div class="diff-query-editor-error" id="diffQueryLeftError" hidden></div>
            </div>
            <div class="diff-query-editor-pane" data-side="right">
              <div class="diff-query-editor-label" data-role="side-label">${esc(state.right.label)}</div>
              <div class="diff-query-editor-wrap">
                <div class="diff-query-editor-highlight" id="diffQueryRightHighlight" aria-hidden="true"></div>
                <textarea class="diff-query-editor-textarea has-highlight" id="diffQueryRight" rows="1" spellcheck="false">${esc(state.rightQuery)}</textarea>
              </div>
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
