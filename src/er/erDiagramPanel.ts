import * as path from 'path';
import * as vscode from 'vscode';
import { ErDiagramData } from './erDataTransform';

export interface ErDiagramShowOptions {
  color?: string;
}

interface ErDiagramPanelState {
  panel: vscode.WebviewPanel;
  loadData: () => Promise<ErDiagramData>;
  data?: ErDiagramData;
  loading: boolean;
}

/** Hosts interactive ECharts ER diagrams and keeps their data cached per open scope. */
export class ErDiagramPanelManager {
  private readonly panels = new Map<string, ErDiagramPanelState>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  show(
    key: string,
    title: string,
    loadData: () => Promise<ErDiagramData>,
    options?: ErDiagramShowOptions,
  ): void {
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'viewstor.erDiagram',
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))],
      },
    );
    const state: ErDiagramPanelState = { panel, loadData, loading: false };
    this.panels.set(key, state);
    panel.webview.html = this.buildHtml(panel.webview, options);

    panel.onDidDispose(() => this.panels.delete(key));
    panel.webview.onDidReceiveMessage(async message => {
      if (message.type === 'ready') {
        if (state.data) {
          await panel.webview.postMessage({ type: 'setData', data: state.data });
        } else {
          await this.reload(state);
        }
      } else if (message.type === 'refresh') {
        await this.reload(state);
      }
    });
  }

  private async reload(state: ErDiagramPanelState): Promise<void> {
    if (state.loading) return;
    state.loading = true;
    await state.panel.webview.postMessage({ type: 'loading' });
    try {
      state.data = await state.loadData();
      await state.panel.webview.postMessage({ type: 'setData', data: state.data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await state.panel.webview.postMessage({ type: 'error', message });
    } finally {
      state.loading = false;
    }
  }

  private buildHtml(webview: vscode.Webview, options?: ErDiagramShowOptions): string {
    const distUri = vscode.Uri.file(path.join(this.context.extensionPath, 'dist'));
    const echartsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'echarts.min.js'));
    const layoutUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'er-diagram-layout.js'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'er-diagram-panel.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'er-diagram-panel.css'));
    const tokensUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'tokens.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'codicon.css'));
    const shellUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'webview-shell.js'));
    const elementsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'vscode-elements.js'));
    const accentBorder = options?.color ? `border-top: 2px solid ${options.color};` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src ${webview.cspSource};">
<link id="vscode-codicon-stylesheet" rel="stylesheet" href="${codiconUri}">
<link rel="stylesheet" href="${tokensUri}">
<link rel="stylesheet" href="${styleUri}">
<script src="${shellUri}"></script>
<script type="module" src="${elementsUri}"></script>
</head>
<body>
  <div class="toolbar" style="${esc(accentBorder)}">
    <vscode-button id="refreshBtn" secondary icon="refresh">Refresh</vscode-button>
    <vscode-button id="relationshipsBtn" secondary icon="type-hierarchy" aria-pressed="true">Hide relationships</vscode-button>
    <span class="toolbar-help">Drag empty canvas or hold middle mouse to pan · scroll to zoom · double-click a table to isolate its neighbours · Esc to exit</span>
    <span id="status" class="status"></span>
  </div>
  <main>
    <section class="canvas-wrap">
      <div id="chart"></div>
      <div class="legend" aria-label="ER diagram legend">
        <span><i class="legend-box table"></i>Table</span>
        <span><i class="legend-box view"></i>View</span>
        <span><i class="legend-line"></i>Relationship</span>
        <span><i class="legend-pk">PK</i>Primary key</span>
        <span><i class="legend-required">*</i>Required</span>
      </div>
      <div id="hoverTooltip" class="hover-tooltip hidden" role="tooltip"></div>
      <div id="emptyState" class="empty-state">Loading schema…</div>
    </section>
  </main>
  <script src="${echartsUri}"></script>
  <script src="${layoutUri}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
