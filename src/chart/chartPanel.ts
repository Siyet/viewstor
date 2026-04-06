import * as vscode from 'vscode';
import * as path from 'path';
import { QueryResult, QueryColumn, QueryHistoryEntry } from '../types/query';
import { ChartConfig, ChartDataSource, isGrafanaCompatible } from '../types/chart';
import { buildEChartsOption, buildMultiSourceEChartsOption, ResolvedDataSource } from './chartDataTransform';
import { buildGrafanaDashboard, pushToGrafana } from './grafanaExport';

export interface ChartShowOptions {
  connectionId?: string;
  databaseName?: string;
  databaseType?: string;
  query?: string;
  color?: string;
}

/** Minimal interface for accessing pinned queries — avoids importing full QueryHistoryProvider */
export interface PinnedQueryProvider {
  getEntries(): QueryHistoryEntry[];
}

export class ChartPanelManager {
  private panels = new Map<string, vscode.WebviewPanel>();
  private grafanaJson = new Map<string, string>();
  private pinnedQueryProvider: PinnedQueryProvider | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  setPinnedQueryProvider(provider: PinnedQueryProvider) {
    this.pinnedQueryProvider = provider;
  }

  show(result: QueryResult, title?: string, opts?: ChartShowOptions) {
    const panelTitle = title || 'Chart';
    const panelKey = `chart:${panelTitle}`;

    let panel = this.panels.get(panelKey);
    if (panel) {
      panel.reveal();
    } else {
      panel = vscode.window.createWebviewPanel(
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
        this.panels.delete(panelKey);
        this.grafanaJson.delete(panelKey);
      });
      this.panels.set(panelKey, panel);
    }

    panel.webview.html = this.buildHtml(panel.webview, opts);

    this.registerMessageHandler(panel, panelKey, result, opts);

    // Send data after a tick so webview has time to initialize
    setTimeout(() => {
      panel!.webview.postMessage({
        type: 'setData',
        columns: result.columns,
        rows: result.rows,
      });
    }, 100);
  }

  private registerMessageHandler(
    panel: vscode.WebviewPanel,
    panelKey: string,
    _result: QueryResult,
    opts?: ChartShowOptions,
  ) {
    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'buildOption': {
          const config: ChartConfig = {
            ...msg.config,
            sourceQuery: opts?.query,
            connectionId: opts?.connectionId,
            databaseName: opts?.databaseName,
            databaseType: opts?.databaseType,
          };
          const primaryResult: QueryResult = {
            columns: msg.columns,
            rows: msg.rows,
            rowCount: msg.rows.length,
            executionTimeMs: 0,
          };

          // Resolve additional data sources
          const additionalSources = this.resolveDataSources(config.dataSources || []);

          const option = additionalSources.length > 0
            ? buildMultiSourceEChartsOption(primaryResult, additionalSources, config)
            : buildEChartsOption(primaryResult, config);

          panel.webview.postMessage({ type: 'setOption', option });
          break;
        }

        case 'requestPinnedQueries': {
          const pinned = this.getPinnedQueriesForWebview();
          panel.webview.postMessage({ type: 'pinnedQueries', entries: pinned });
          break;
        }

        case 'requestDataSourceColumns': {
          // Return columns + sample for a specific pinned query
          const entry = this.findPinnedEntry(msg.entryId);
          if (entry?.cachedResult) {
            panel.webview.postMessage({
              type: 'dataSourceColumns',
              entryId: msg.entryId,
              columns: entry.cachedResult.columns,
            });
          }
          break;
        }

        case 'exportGrafana': {
          const config: ChartConfig = {
            ...msg.config,
            sourceQuery: opts?.query,
            connectionId: opts?.connectionId,
            databaseName: opts?.databaseName,
            databaseType: opts?.databaseType,
          };
          if (!isGrafanaCompatible(config.chartType)) {
            vscode.window.showWarningMessage(
              vscode.l10n.t('This chart type cannot be exported to Grafana.'),
            );
            return;
          }
          const grafanaUrl = vscode.workspace.getConfiguration('viewstor').get<string>('grafanaUrl', '');
          const datasourceUid = grafanaUrl ? undefined : undefined;
          const dashboard = buildGrafanaDashboard(config, datasourceUid);
          if (!dashboard) return;
          const json = JSON.stringify(dashboard, null, 2);
          this.grafanaJson.set(panelKey, json);
          panel.webview.postMessage({ type: 'showGrafanaJson', json });
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
              vscode.l10n.t('Grafana push failed: {0}', err instanceof Error ? err.message : String(err)),
            );
          }
          break;
        }
      }
    });
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
        resolved.push({
          source,
          columns: entry.cachedResult.columns,
          rows: entry.cachedResult.rows,
        });
      }
    }
    return resolved;
  }

  private buildHtml(webview: vscode.Webview, opts?: ChartShowOptions): string {
    const distUri = vscode.Uri.file(path.join(this.context.extensionPath, 'dist'));
    const echartsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'echarts.min.js'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'chart-panel.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'chart-panel.css'));

    const colorBorder = opts?.color ? `border-top: 2px solid ${opts.color};` : '';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div class="toolbar" style="${esc(colorBorder)}">
    <label>Chart
      <select id="chartType">
        <option value="line">Line</option>
        <option value="bar">Bar</option>
        <option value="scatter">Scatter</option>
        <option value="pie">Pie</option>
        <option value="heatmap">Heatmap</option>
        <option value="radar">Radar</option>
        <option value="funnel">Funnel</option>
        <option value="gauge">Gauge</option>
        <option value="boxplot">Boxplot</option>
        <option value="candlestick">Candlestick</option>
        <option value="treemap">Treemap</option>
        <option value="sunburst">Sunburst</option>
      </select>
    </label>

    <div class="separator"></div>

    <label>
      <input type="checkbox" id="areaFill"> Area Fill
    </label>
    <label>
      <input type="checkbox" id="showLegend" checked> Legend
    </label>

    <div class="separator"></div>

    <label>Title
      <input type="text" id="chartTitle" placeholder="Chart title..." style="width:160px">
    </label>

    <div class="separator"></div>

    <button id="addDataSourceBtn">+ Data Source</button>
    <button id="exportGrafanaBtn" class="btn-primary">Export to Grafana</button>
  </div>

  <div class="main">
    <div class="config-sidebar" id="configSidebar"></div>
    <div class="chart-container">
      <div id="chart"></div>
    </div>
  </div>

  <!-- Pinned query picker popup -->
  <div class="popup-overlay" id="pinnedPickerOverlay">
    <div class="popup" style="width:50vw">
      <div class="popup-header">
        <span>Add Data Source from Pinned Queries</span>
        <button id="closePinnedPicker">&times;</button>
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
        <button id="closeDsConfig">&times;</button>
      </div>
      <div class="popup-body" id="dsConfigBody"></div>
      <div class="popup-footer">
        <button id="dsConfigCancel">Cancel</button>
        <button id="dsConfigConfirm" class="btn-primary">Add</button>
      </div>
    </div>
  </div>

  <!-- Grafana export popup -->
  <div class="popup-overlay" id="popupOverlay">
    <div class="popup">
      <div class="popup-header">
        <span>Grafana Dashboard JSON</span>
        <button id="closePopup">&times;</button>
      </div>
      <div class="popup-body">
        <pre></pre>
      </div>
      <div class="popup-footer">
        <button id="copyJsonBtn">Copy JSON</button>
        <button id="saveJsonBtn">Save as File</button>
        <button id="pushGrafanaBtn" class="btn-primary">Push to Grafana</button>
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
