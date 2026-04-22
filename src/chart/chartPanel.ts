import * as vscode from 'vscode';
import * as path from 'path';
import { QueryResult, QueryColumn, QueryHistoryEntry } from '../types/query';
import {
  ChartConfig, ChartDataSource, isGrafanaCompatible,
  buildAggregationQuery, buildFullDataQuery,
} from '../types/chart';
import { buildEChartsOption, buildMultiSourceEChartsOption, ResolvedDataSource, adaptConfigToColumns } from './chartDataTransform';
import { buildGrafanaDashboard, pushToGrafana } from './grafanaExport';
import { ConnectionManager } from '../connections/connectionManager';
import { dbg } from '../utils/debug';
import { wrapError } from '../utils/errors';

let _outputChannel: { info(msg: string): void; error(msg: string): void } | undefined;

/** Bind the output channel for chart query logging */
export function setChartOutputChannel(channel: { info(msg: string): void; error(msg: string): void }) {
  _outputChannel = channel;
}

export interface ChartShowOptions {
  connectionId?: string;
  databaseName?: string;
  databaseType?: string;
  query?: string;
  color?: string;
  tableName?: string;
  schema?: string;
  /** Key of the result panel this chart was opened from */
  resultPanelKey?: string;
}

/** Minimal interface for accessing pinned queries */
export interface PinnedQueryProvider {
  getEntries(): QueryHistoryEntry[];
}

/** Per-chart state tracked by the manager. Exported for the testing API only. */
export interface ChartState {
  panel: vscode.WebviewPanel;
  opts: ChartShowOptions;
  /** Current columns (from last data update) */
  columns: QueryColumn[];
  /** Current rows (from last data update) */
  rows: Record<string, unknown>[];
  /** Whether auto-sync with result panel is active */
  syncEnabled: boolean;
  /** Set once onDidDispose fires — guards against late timers touching the webview */
  disposed: boolean;
  /** Pending init-data timer so we can cancel it on disposal */
  initTimer?: NodeJS.Timeout;
  /** Monotonic token — bumped on every new executeChartQuery; stale results are discarded. */
  queryRunId: number;
  /** True between the moment a chart query is dispatched and the moment its result arrives. */
  queryActive: boolean;
  /**
   * True only while the awaited driver.execute() boundary is open — narrower than
   * `queryActive`, which also covers time spent in the driver's own queue. Used to
   * decide whether `driver.cancelQuery()` will land on our statement vs. a sibling.
   */
  driverActive: boolean;
  /** Disposable for message handler */
  disposable: vscode.Disposable;
}

export class ChartPanelManager {
  private readonly charts = new Map<string, ChartState>();
  private grafanaJson = new Map<string, string>();
  private pinnedQueryProvider: PinnedQueryProvider | null = null;
  private connectionManager: ConnectionManager | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // --- Read-only query API (production + tests) ---

  /** Number of currently-open chart panels. */
  getChartCount(): number {
    return this.charts.size;
  }

  /** Whether a chart panel exists for the given key (`chart:<title>`). */
  hasChart(panelKey: string): boolean {
    return this.charts.has(panelKey);
  }

  /**
   * Read-only snapshot of all open chart states.
   * @internal — exposed for e2e tests only. Mutating returned objects is undefined behaviour.
   */
  getChartStatesForTesting(): readonly ChartState[] {
    return [...this.charts.values()];
  }

  setPinnedQueryProvider(provider: PinnedQueryProvider) {
    this.pinnedQueryProvider = provider;
  }

  setConnectionManager(mgr: ConnectionManager) {
    this.connectionManager = mgr;
  }

  show(result: QueryResult, title?: string, opts?: ChartShowOptions) {
    const panelTitle = title || 'Chart';
    const panelKey = `chart:${panelTitle}`;

    let state = this.charts.get(panelKey);
    if (state) {
      state.panel.reveal();
      state.opts = opts || {};
      state.columns = result.columns;
      state.rows = result.rows;
    } else {
      const panel = vscode.window.createWebviewPanel(
        'viewstor.chart',
        panelTitle,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))],
        },
      );
      panel.onDidDispose(() => {
        const chartState = this.charts.get(panelKey);
        if (chartState) {
          chartState.disposed = true;
          if (chartState.initTimer) clearTimeout(chartState.initTimer);
          chartState.disposable.dispose();
        }
        this.charts.delete(panelKey);
        this.grafanaJson.delete(panelKey);
      });

      state = {
        panel,
        opts: opts || {},
        columns: result.columns,
        rows: result.rows,
        syncEnabled: true,
        disposed: false,
        queryRunId: 0,
        queryActive: false,
        driverActive: false,
        disposable: new vscode.Disposable(() => {}),
      };
      this.charts.set(panelKey, state);
    }

    state.panel.webview.html = this.buildHtml(state.panel.webview, opts);
    state.disposable.dispose();
    state.disposable = this.registerMessageHandler(state, panelKey);

    // Send initial data after webview initializes. Guard + cancel the timer on disposal so tests
    // that dispose panels quickly don't see a late "Webview is disposed" error leak into the next test.
    const sendState = state;
    if (sendState.initTimer) clearTimeout(sendState.initTimer);
    sendState.initTimer = setTimeout(() => {
      sendState.initTimer = undefined;
      if (sendState.disposed) return;
      try {
        sendState.panel.webview.postMessage({
          type: 'setData',
          columns: sendState.columns,
          rows: sendState.rows,
          syncEnabled: sendState.syncEnabled,
          tableName: sendState.opts.tableName,
          schema: sendState.opts.schema,
          databaseType: sendState.opts.databaseType,
          connectionId: sendState.opts.connectionId,
        });
      } catch {
        // panel was disposed between the guard and the postMessage — safe to ignore
      }
    }, 100);
  }

  /**
   * Called by result panel when its data changes (page navigation, custom query, etc.)
   * Only updates charts that are synced to this result panel.
   */
  notifyDataChanged(resultPanelKey: string, columns: QueryColumn[], rows: Record<string, unknown>[], query?: string) {
    for (const [, state] of this.charts) {
      if (!state.syncEnabled) continue;
      if (state.opts.resultPanelKey !== resultPanelKey) continue;

      state.columns = columns;
      state.rows = rows;
      if (query) state.opts.query = query;

      state.panel.webview.postMessage({
        type: 'syncData',
        columns,
        rows,
      });
    }
  }

  private registerMessageHandler(state: ChartState, panelKey: string): vscode.Disposable {
    return state.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'buildOption': {
          const rawConfig: ChartConfig = {
            ...msg.config,
            sourceQuery: state.opts.query,
            connectionId: state.opts.connectionId,
            databaseName: state.opts.databaseName,
            databaseType: state.opts.databaseType,
          };
          const primaryResult: QueryResult = {
            columns: msg.columns,
            rows: msg.rows,
            rowCount: msg.rows.length,
            executionTimeMs: 0,
          };
          // Rewrite stale column refs (e.g. Y=`id` after a count-by-month aggregation
          // returned `count` instead). Without this the chart paints empty axes whenever
          // the user fires "Show full DB data" with an aggregation function selected.
          const config = adaptConfigToColumns(rawConfig, primaryResult.columns);
          const additionalSources = this.resolveDataSources(config.dataSources || []);
          const option = additionalSources.length > 0
            ? buildMultiSourceEChartsOption(primaryResult, additionalSources, config)
            : buildEChartsOption(primaryResult, config);
          state.panel.webview.postMessage({ type: 'setOption', option });
          break;
        }

        case 'toggleSync': {
          state.syncEnabled = !!msg.enabled;
          break;
        }

        case 'refreshChart': {
          // Manual refresh: re-fetch data from result panel's current state
          state.panel.webview.postMessage({
            type: 'syncData',
            columns: state.columns,
            rows: state.rows,
          });
          break;
        }

        case 'executeChartQuery': {
          // Server-side aggregation or full data query
          await this.executeChartQuery(state, panelKey, msg);
          break;
        }

        case 'requestPinnedQueries': {
          const pinned = this.getPinnedQueriesForWebview();
          state.panel.webview.postMessage({ type: 'pinnedQueries', entries: pinned });
          break;
        }

        case 'requestDataSourceColumns': {
          const entry = this.findPinnedEntry(msg.entryId);
          if (entry?.cachedResult) {
            state.panel.webview.postMessage({
              type: 'dataSourceColumns',
              entryId: msg.entryId,
              columns: entry.cachedResult.columns,
            });
          }
          break;
        }

        case 'exportGrafana': {
          // Rebuild aggregation SQL with current databaseType to ensure correct dialect
          let exportQuery = state.opts.query || '';
          const exportAxis = msg.config.axis;
          if (state.opts.tableName && exportAxis && msg.config.aggregation?.function !== 'none') {
            exportQuery = buildAggregationQuery(
              state.opts.tableName,
              state.opts.schema,
              exportAxis.xColumn,
              exportAxis.yColumns,
              msg.config.aggregation.function,
              exportAxis.groupByColumn,
              msg.config.aggregation,
              state.opts.databaseType,
            );
          }
          const config: ChartConfig = {
            ...msg.config,
            sourceQuery: exportQuery,
            connectionId: state.opts.connectionId,
            databaseName: state.opts.databaseName,
            databaseType: state.opts.databaseType,
          };
          if (!isGrafanaCompatible(config.chartType)) {
            vscode.window.showWarningMessage(vscode.l10n.t('This chart type cannot be exported to Grafana.'));
            return;
          }
          const dashboard = buildGrafanaDashboard(config);
          if (!dashboard) return;
          const json = JSON.stringify(dashboard, null, 2);
          this.grafanaJson.set(panelKey, json);
          state.panel.webview.postMessage({ type: 'showGrafanaJson', json });
          break;
        }

        case 'copyGrafanaJson': {
          const json = this.grafanaJson.get(panelKey);
          if (json) {
            await vscode.env.clipboard.writeText(json);
            vscode.window.showInformationMessage(vscode.l10n.t('Grafana dashboard JSON copied to clipboard.'));
          }
          break;
        }

        case 'saveGrafanaJson': {
          const json = this.grafanaJson.get(panelKey);
          if (!json) return;
          const uri = await vscode.window.showSaveDialog({
            filters: { JSON: ['json'] },
            defaultUri: vscode.Uri.file('grafana-dashboard.json'),
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf-8'));
            vscode.window.showInformationMessage(vscode.l10n.t('Grafana dashboard saved to {0}', uri.fsPath));
          }
          break;
        }

        case 'pushToGrafana': {
          const json = this.grafanaJson.get(panelKey);
          if (!json) return;
          const grafanaUrl = vscode.workspace.getConfiguration('viewstor').get<string>('grafanaUrl', '');
          const apiKey = vscode.workspace.getConfiguration('viewstor').get<string>('grafanaApiKey', '');
          if (!grafanaUrl || !apiKey) {
            vscode.window.showWarningMessage(
              vscode.l10n.t('Set viewstor.grafanaUrl and viewstor.grafanaApiKey in settings to push dashboards.'),
            );
            return;
          }
          try {
            const dashboard = JSON.parse(json);
            const url = await pushToGrafana(grafanaUrl, apiKey, dashboard);
            vscode.window.showInformationMessage(vscode.l10n.t('Dashboard pushed to Grafana: {0}', url));
          } catch (err) {
            vscode.window.showErrorMessage(
              vscode.l10n.t('Grafana push failed: {0}', wrapError(err)),
            );
          }
          break;
        }
      }
    });
  }

  /**
   * Execute a server-side query for the chart (aggregation or full data).
   * Sends the result back to the webview only (does not update result panel).
   *
   * Concurrency:
   * - `queryRunId` is bumped on every dispatch; a stale result is dropped before
   *   it touches the chart.
   * - When the previous chart query was actively executing on the driver (not
   *   merely sitting in the node-postgres queue), we ask the driver to cancel
   *   it before launching the new one — otherwise a "Show full DB data" re-click
   *   would leak a long SELECT * on the server.
   *
   * Known limitation (review item #3): the chart shares its driver with result
   * panels and query history. PG's `cancelQuery` maps to `pg_cancel_backend(pid)`,
   * which interrupts whichever statement is currently running on that connection
   * — and node-postgres serializes queries, so a chart re-click that fires while
   * an unrelated long SELECT is in flight on the same driver will cancel that
   * unrelated query. We gate on `state.driverActive` (set only between the
   * actual await driver.execute() boundaries) so we don't fire cancel just
   * because we have a queued chart query of our own. A full fix requires a
   * dedicated per-chart driver instance and is tracked separately.
   *
   * Public for e2e tests — production callers route through the webview message handler.
   */
  async executeChartQuery(
    state: ChartState,
    _panelKey: string,
    msg: { queryType: string; config: ChartConfig },
  ) {
    if (!this.connectionManager || !state.opts.connectionId) {
      state.panel.webview.postMessage({ type: 'chartQueryError', error: 'No connection available' });
      return;
    }

    const driver = state.opts.databaseName
      ? await this.connectionManager.getDriverForDatabase(state.opts.connectionId, state.opts.databaseName)
      : this.connectionManager.getDriver(state.opts.connectionId);
    if (!driver) {
      state.panel.webview.postMessage({ type: 'chartQueryError', error: 'Driver not available' });
      return;
    }

    // Cancel only when our previous chart query is *actually executing* on the driver.
    // queryActive=true alone covers the in-queue case too, where cancelling would hit
    // an unrelated statement on the same shared driver.
    if (state.driverActive && driver.cancelQuery) {
      try { await driver.cancelQuery(); } catch { /* best effort */ }
    }
    const runId = ++state.queryRunId;
    state.queryActive = true;

    try {
      let sql: string;
      if (msg.queryType === 'fullData') {
        // Full data mode: SELECT * (no column filter) so the sidebar keeps all dropdown options —
        // otherwise narrowing to the current axis cols would trap the user on their initial choice
        // (regression guard: see "Full Data preserves all columns" e2e test).
        sql = buildFullDataQuery(state.opts.tableName || '', state.opts.schema, [], state.opts.databaseType);
      } else {
        // Server-side aggregation
        const axis = msg.config.axis;
        if (!axis) {
          state.panel.webview.postMessage({ type: 'chartQueryError', error: 'No axis mapping for aggregation' });
          // queryActive reset is handled by the finally block.
          return;
        }
        sql = buildAggregationQuery(
          state.opts.tableName || '',
          state.opts.schema,
          axis.xColumn,
          axis.yColumns,
          msg.config.aggregation.function,
          axis.groupByColumn,
          msg.config.aggregation,
          state.opts.databaseType,
        );
      }

      state.opts.query = sql;
      dbg('chartQuery', 'SQL:', sql);
      if (_outputChannel) _outputChannel.info(`[chart] ${sql}`);

      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Running chart query...') },
        async () => {
          state.driverActive = true;
          try {
            return await driver.execute(sql);
          } finally {
            state.driverActive = false;
          }
        },
      );

      // Drop stale results: a newer click has superseded this run.
      if (runId !== state.queryRunId || state.disposed) return;

      if (result.error) {
        dbg('chartQuery', 'error:', result.error);
        if (_outputChannel) _outputChannel.error(`[chart] ${result.error}`);
        vscode.window.showErrorMessage(vscode.l10n.t('Chart query failed: {0}', result.error));
        state.panel.webview.postMessage({ type: 'chartQueryError', error: result.error });
        return;
      }

      state.columns = result.columns;
      state.rows = result.rows;

      state.panel.webview.postMessage({
        type: 'chartQueryResult',
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        executionTimeMs: result.executionTimeMs,
        sql,
      });
    } catch (err) {
      const message = wrapError(err);
      dbg('chartQuery', 'exception:', message);
      if (_outputChannel) _outputChannel.error(`[chart] ${message}`);
      if (runId === state.queryRunId && !state.disposed) {
        vscode.window.showErrorMessage(vscode.l10n.t('Chart query failed: {0}', message));
        state.panel.webview.postMessage({
          type: 'chartQueryError',
          error: message,
        });
      }
    } finally {
      if (runId === state.queryRunId) state.queryActive = false;
    }
  }

  private getPinnedQueriesForWebview(): Array<{ id: string; label: string; query: string; rowCount: number; columns: QueryColumn[] }> {
    if (!this.pinnedQueryProvider) return [];
    return this.pinnedQueryProvider.getEntries()
      .filter(entry => entry.pinned && entry.cachedResult && entry.cachedResult.columns.length > 0)
      .map(entry => ({
        id: entry.id,
        label: entry.connectionName ? `${entry.connectionName}: ${entry.query.substring(0, 60)}` : entry.query.substring(0, 80),
        query: entry.query,
        rowCount: entry.cachedResult!.rows.length,
        columns: entry.cachedResult!.columns,
      }));
  }

  private findPinnedEntry(entryId: string): QueryHistoryEntry | undefined {
    if (!this.pinnedQueryProvider) return undefined;
    return this.pinnedQueryProvider.getEntries().find(entry => entry.id === entryId);
  }

  private resolveDataSources(dataSources: ChartDataSource[]): ResolvedDataSource[] {
    if (!this.pinnedQueryProvider || dataSources.length === 0) return [];
    const entries = this.pinnedQueryProvider.getEntries();
    const resolved: ResolvedDataSource[] = [];
    for (const source of dataSources) {
      const entry = entries.find(e => e.id === source.id);
      if (entry?.cachedResult) {
        resolved.push({ source, columns: entry.cachedResult.columns, rows: entry.cachedResult.rows });
      }
    }
    return resolved;
  }

  private buildHtml(webview: vscode.Webview, opts?: ChartShowOptions): string {
    const distUri = vscode.Uri.file(path.join(this.context.extensionPath, 'dist'));
    const echartsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'echarts.min.js'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'chart-panel.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'chart-panel.css'));
    const tokensUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'tokens.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'codicon.css'));
    const shellUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'webview-shell.js'));
    const elementsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'vscode-elements.js'));
    const cspSource = webview.cspSource;
    const colorBorder = opts?.color ? `border-top: 2px solid ${opts.color};` : '';

    const tooltips = JSON.stringify({
      xAxis: vscode.l10n.t('Column for horizontal axis. For timeseries charts, use a timestamp column.'),
      yAxis: vscode.l10n.t('Numeric columns for vertical axis — the values to plot.'),
      groupBy: vscode.l10n.t('Split data into separate series by this column (e.g. by region or status).'),
      aggFunction: vscode.l10n.t('How to aggregate Y values: count rows, sum/avg/min/max of a column. Use with "Show full DB data" to execute server-side.'),
      timeBucket: vscode.l10n.t('Group timestamps into intervals. Requires a time-type X axis.'),
      customBucket: vscode.l10n.t('Custom interval: 2h = 2 hours, 15m = 15 minutes, 3d = 3 days.'),
      nameCol: vscode.l10n.t('Column with labels for chart segments (pie slices, funnel stages).'),
      valueCol: vscode.l10n.t('Numeric column with values for each segment.'),
      statValueCol: vscode.l10n.t('Numeric column to compute statistics from (boxplot quartiles, candlestick OHLC).'),
      indicatorCols: vscode.l10n.t('Dimensions to compare — each becomes a radar axis.'),
      gaugeValueCol: vscode.l10n.t('Single numeric metric to display on the gauge.'),
      gaugeMin: vscode.l10n.t('Minimum value on the gauge scale.'),
      gaugeMax: vscode.l10n.t('Maximum value on the gauge scale.'),
      showFullDbData: vscode.l10n.t('Run the chart query directly against the database — uses aggregation when a function or time bucket is set, otherwise pulls all rows (no LIMIT). Clicking again while a query is running cancels the previous one.'),
      sync: vscode.l10n.t('Auto-update chart when the linked table changes page, sort, or query.'),
    }).replace(/<\//g, '<\\/');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src ${cspSource};">
<link id="vscode-codicon-stylesheet" rel="stylesheet" href="${codiconUri}">
<link rel="stylesheet" href="${tokensUri}">
<link rel="stylesheet" href="${styleUri}">
<script src="${shellUri}"></script>
<script type="module" src="${elementsUri}"></script>
</head>
<body data-tooltips='${tooltips}'>
  <div class="toolbar" style="${esc(colorBorder)}">
    <label>Chart
      <vscode-single-select id="chartType">
        <vscode-option value="line" selected>Line</vscode-option>
        <vscode-option value="bar">Bar</vscode-option>
        <vscode-option value="scatter">Scatter</vscode-option>
        <vscode-option value="pie">Pie</vscode-option>
        <vscode-option value="heatmap">Heatmap</vscode-option>
        <vscode-option value="radar">Radar</vscode-option>
        <vscode-option value="funnel">Funnel</vscode-option>
        <vscode-option value="gauge">Gauge</vscode-option>
        <vscode-option value="boxplot">Boxplot</vscode-option>
        <vscode-option value="candlestick">Candlestick</vscode-option>
        <vscode-option value="treemap">Treemap</vscode-option>
        <vscode-option value="sunburst">Sunburst</vscode-option>
      </vscode-single-select>
    </label>

    <div class="separator"></div>

    <vscode-checkbox id="syncToggle" checked label="Sync"></vscode-checkbox>
    <vscode-button id="refreshBtn" class="hidden" secondary icon="refresh" title="Refresh data from table" aria-label="Refresh data from table"></vscode-button>

    <div class="separator"></div>

    <vscode-checkbox id="areaFill" label="Area Fill"></vscode-checkbox>
    <vscode-checkbox id="showLegend" checked label="Legend"></vscode-checkbox>

    <div class="separator"></div>

    <label>Title
      <vscode-textfield id="chartTitle" placeholder="Chart title..." style="width:120px"></vscode-textfield>
    </label>

    <div class="separator"></div>

    <vscode-button id="addDataSourceBtn" secondary icon="add">Source</vscode-button>
    <vscode-button id="exportGrafanaBtn" style="display:none">Export to Grafana</vscode-button>
  </div>

  <div class="main">
    <div class="config-sidebar" id="configSidebar"></div>
    <div class="chart-container">
      <div id="chart"></div>
      <div id="chartStatus" class="chart-status"></div>
    </div>
  </div>

  <!-- Pinned query picker popup -->
  <div class="popup-overlay" id="pinnedPickerOverlay">
    <div class="popup" style="width:50vw">
      <div class="popup-header">
        <span>Add Data Source from Pinned Queries</span>
        <vscode-button id="closePinnedPicker" secondary class="popup-close-btn" icon="close" aria-label="Close"></vscode-button>
      </div>
      <div class="popup-body">
        <div id="pinnedQueryList" class="pinned-query-list"></div>
        <div id="pinnedEmpty" class="no-data" style="display:none">No pinned queries with cached results.</div>
      </div>
    </div>
  </div>

  <!-- Data source config popup -->
  <div class="popup-overlay" id="dsConfigOverlay">
    <div class="popup" style="width:40vw">
      <div class="popup-header">
        <span>Configure Data Source</span>
        <vscode-button id="closeDsConfig" secondary class="popup-close-btn" icon="close" aria-label="Close"></vscode-button>
      </div>
      <div class="popup-body" id="dsConfigBody"></div>
      <div class="popup-footer">
        <vscode-button id="dsConfigCancel" secondary>Cancel</vscode-button>
        <vscode-button id="dsConfigConfirm">Add</vscode-button>
      </div>
    </div>
  </div>

  <!-- Grafana export popup -->
  <div class="popup-overlay" id="popupOverlay">
    <div class="popup">
      <div class="popup-header">
        <span>Grafana Dashboard JSON</span>
        <vscode-button id="closePopup" secondary class="popup-close-btn" icon="close" aria-label="Close"></vscode-button>
      </div>
      <div class="popup-body">
        <pre></pre>
      </div>
      <div class="popup-footer">
        <vscode-button id="copyJsonBtn" secondary icon="copy">Copy JSON</vscode-button>
        <vscode-button id="saveJsonBtn" secondary icon="save">Save as File</vscode-button>
        <vscode-button id="pushGrafanaBtn" icon="cloud-upload">Push to Grafana</vscode-button>
      </div>
    </div>
  </div>

  <script src="${echartsUri}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
