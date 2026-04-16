import * as vscode from 'vscode';
import * as path from 'path';
import { DatabaseStatistics } from '../types/schema';

/**
 * Manages a single Database Statistics webview panel per host/connection/database
 * tuple. Also responds to `refresh` messages from the webview so the caller
 * controls the refresh semantics (settings-aware, respects hidden schemas).
 */
export interface DatabaseStatsShowOptions {
  connectionId: string;
  connectionName: string;
  databaseName?: string;
  /** Initial payload — webview renders as soon as the panel is created. */
  stats: DatabaseStatistics;
  /** Called when the user clicks refresh in the webview. */
  onRefresh: () => Promise<DatabaseStatistics | { error: string }>;
  /** Seconds between auto-refresh ticks; `0` disables auto-refresh. */
  autoRefreshSeconds: number;
}

interface PanelEntry {
  panel: vscode.WebviewPanel;
  timer?: NodeJS.Timeout;
  onRefresh: DatabaseStatsShowOptions['onRefresh'];
  autoRefreshSeconds: number;
}

export class DatabaseStatsPanelManager {
  private panels = new Map<string, PanelEntry>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  show(options: DatabaseStatsShowOptions): void {
    const key = this.keyFor(options.connectionId, options.databaseName);
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      this.postStats(existing.panel, options.stats, options.databaseName);
      this.scheduleAutoRefresh(key, existing, options.autoRefreshSeconds);
      return;
    }

    const title = options.databaseName
      ? `${options.connectionName} / ${options.databaseName} — Stats`
      : `${options.connectionName} — Stats`;

    const panel = vscode.window.createWebviewPanel(
      'viewstor.databaseStats',
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))],
      },
    );
    panel.iconPath = new vscode.ThemeIcon('graph');

    const distRoot = vscode.Uri.file(path.join(this.context.extensionPath, 'dist'));
    const tokensUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'styles', 'tokens.css'));
    const codiconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'styles', 'codicon.css'));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'styles', 'database-stats-panel.css'));
    const shellUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'scripts', 'webview-shell.js'));
    const elementsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'scripts', 'vscode-elements.js'));
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'scripts', 'database-stats-panel.js'));

    panel.webview.html = this.buildHtml(panel.webview, {
      tokensUri, codiconUri, styleUri, shellUri, elementsUri, scriptUri,
      title,
    });

    const entry: PanelEntry = {
      panel,
      onRefresh: options.onRefresh,
      autoRefreshSeconds: options.autoRefreshSeconds,
    };
    this.panels.set(key, entry);

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'refresh') {
        await this.handleRefresh(key, options.databaseName);
      }
    }, undefined, this.context.subscriptions);

    panel.onDidDispose(() => {
      const current = this.panels.get(key);
      if (current?.timer) clearInterval(current.timer);
      this.panels.delete(key);
    });

    // Post initial payload on next tick (after the webview script runs).
    setTimeout(() => this.postStats(panel, options.stats, options.databaseName), 0);
    this.scheduleAutoRefresh(key, entry, options.autoRefreshSeconds);
  }

  private keyFor(connectionId: string, database?: string): string {
    return `${connectionId}:${database ?? ''}`;
  }

  private postStats(panel: vscode.WebviewPanel, stats: DatabaseStatistics, databaseName?: string) {
    panel.webview.postMessage({
      type: 'setStats',
      stats,
      databaseName,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleRefresh(key: string, databaseName?: string): Promise<void> {
    const entry = this.panels.get(key);
    if (!entry) return;
    try {
      const result = await entry.onRefresh();
      if ('error' in result) {
        entry.panel.webview.postMessage({ type: 'error', message: result.error });
        return;
      }
      this.postStats(entry.panel, result, databaseName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.panel.webview.postMessage({ type: 'error', message });
    }
  }

  private scheduleAutoRefresh(key: string, entry: PanelEntry, seconds: number): void {
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
    entry.autoRefreshSeconds = seconds;
    if (seconds <= 0) return;
    entry.timer = setInterval(() => {
      void this.handleRefresh(key);
    }, seconds * 1000);
  }

  private buildHtml(
    webview: vscode.Webview,
    uris: {
      tokensUri: vscode.Uri;
      codiconUri: vscode.Uri;
      styleUri: vscode.Uri;
      shellUri: vscode.Uri;
      elementsUri: vscode.Uri;
      scriptUri: vscode.Uri;
      title: string;
    },
  ): string {
    const cspSource = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src ${cspSource};">
  <link rel="stylesheet" href="${uris.codiconUri}">
  <link rel="stylesheet" href="${uris.tokensUri}">
  <link rel="stylesheet" href="${uris.styleUri}">
  <title>${esc(uris.title)}</title>
  <script src="${uris.shellUri}"></script>
  <script type="module" src="${uris.elementsUri}"></script>
</head>
<body>
  <div class="stats-container">
    <header class="stats-header">
      <h2 id="statsTitle">${esc(uris.title)}</h2>
      <div class="stats-header-meta">
        <span id="statsTimestamp" class="dimmed"></span>
        <vscode-button id="btnRefresh" secondary title="Refresh statistics">
          <vscode-icon slot="content-before" name="refresh"></vscode-icon>
          Refresh
        </vscode-button>
      </div>
    </header>

    <div id="errorBanner" class="error-banner" hidden></div>

    <section class="stats-section">
      <h3>Overview</h3>
      <div id="overviewTiles" class="tiles"></div>
    </section>

    <section class="stats-section">
      <h3>Top tables</h3>
      <table id="topTables" class="stats-table">
        <thead>
          <tr>
            <th data-sort="name">Name</th>
            <th data-sort="rows" class="num">Rows (est.)</th>
            <th data-sort="size" class="num">Size</th>
            <th data-sort="indexes" class="num">Indexes</th>
            <th data-sort="dead" class="num">Dead %</th>
            <th>Last vacuum</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
      <div id="topTablesEmpty" class="empty-state" hidden>No tables reported.</div>
    </section>

    <section class="stats-section">
      <h3>Connection-level metrics</h3>
      <ul id="connectionLevel" class="metrics-list"></ul>
    </section>
  </div>
  <script src="${uris.scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const entry of this.panels.values()) {
      if (entry.timer) clearInterval(entry.timer);
      entry.panel.dispose();
    }
    this.panels.clear();
  }
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
