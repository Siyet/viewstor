import * as path from 'path';
import * as vscode from 'vscode';
import { ErDiagramData, ErTable } from './erDataTransform';
import { ConnectionTreeItem } from '../views/connectionTree';
import { findTableContextAction, TABLE_CONTEXT_ACTIONS } from '../views/tableContextActions';

export interface ErDiagramShowOptions {
  connectionId: string;
  databaseName?: string;
  color?: string;
}

interface ErDiagramPanelState {
  panel: vscode.WebviewPanel;
  loadData: () => Promise<ErDiagramData>;
  options: ErDiagramShowOptions;
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
    options: ErDiagramShowOptions,
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
    const state: ErDiagramPanelState = { panel, loadData, options, loading: false };
    this.panels.set(key, state);
    panel.webview.html = this.buildHtml(panel.webview, options);

    panel.onDidDispose(() => this.panels.delete(key));
    panel.webview.onDidReceiveMessage(async message => {
      if (message.type === 'ready') {
        if (state.data) {
          await this.postData(state);
        } else {
          await this.reload(state);
        }
      } else if (message.type === 'refresh') {
        await this.reload(state);
      } else if (message.type === 'tableAction') {
        await this.runTableAction(state, message);
      }
    });
  }

  private async reload(state: ErDiagramPanelState): Promise<void> {
    if (state.loading) return;
    state.loading = true;
    await state.panel.webview.postMessage({ type: 'loading' });
    try {
      state.data = await state.loadData();
      await this.postData(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await state.panel.webview.postMessage({ type: 'error', message });
    } finally {
      state.loading = false;
    }
  }

  private async postData(state: ErDiagramPanelState): Promise<void> {
    await state.panel.webview.postMessage({
      type: 'setData',
      data: state.data,
      tableActions: TABLE_CONTEXT_ACTIONS,
    });
  }

  private async runTableAction(
    state: ErDiagramPanelState,
    message: { command?: unknown; tableId?: unknown },
  ): Promise<void> {
    if (typeof message.command !== 'string' || typeof message.tableId !== 'string') return;
    const table = state.data?.tables.find(candidate => candidate.id === message.tableId);
    if (!table || !findTableContextAction(message.command, table.kind)) return;

    const item = this.tableTreeItem(state.options, table);
    try {
      await vscode.commands.executeCommand(message.command, item);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to run table action: {0}', detail));
    }
  }

  private tableTreeItem(options: ErDiagramShowOptions, table: ErTable): ConnectionTreeItem {
    const item = new ConnectionTreeItem(table.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.connectionId = options.connectionId;
    item.databaseName = options.databaseName;
    item.contextValue = table.kind;
    item.schemaObject = {
      name: table.name,
      type: table.kind,
      schema: table.schema,
      children: table.columns.map(column => ({
        name: column.name,
        type: 'column',
        schema: table.schema,
        detail: column.dataType,
        comment: column.comment,
        indexNames: column.indexNames,
        notNullable: column.notNullable,
      })),
    };
    return item;
  }

  private buildHtml(webview: vscode.Webview, options: ErDiagramShowOptions): string {
    const distUri = vscode.Uri.file(path.join(this.context.extensionPath, 'dist'));
    const echartsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'echarts.min.js'));
    const layoutUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'er-diagram-layout.js'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'er-diagram-panel.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'er-diagram-panel.css'));
    const tokensUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'tokens.css'));
    const contextMenuStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'context-menu.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'codicon.css'));
    const shellUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'webview-shell.js'));
    const contextMenuUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'context-menu.js'));
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
<link rel="stylesheet" href="${contextMenuStyleUri}">
<link rel="stylesheet" href="${styleUri}">
<script src="${shellUri}"></script>
<script type="module" src="${elementsUri}"></script>
</head>
<body>
  <div class="toolbar" style="${esc(accentBorder)}">
    <div class="toolbar-search">
      <div class="search-field">
        <vscode-textfield id="searchInput" placeholder="Search tables or columns…" aria-label="Search tables, views, and columns" autocomplete="off">
          <vscode-icon slot="content-before" name="search"></vscode-icon>
        </vscode-textfield>
      </div>
      <div id="searchResults" class="search-results hidden" role="listbox" aria-label="Search results"></div>
    </div>
    <span class="toolbar-help">Drag empty canvas or hold middle mouse to pan · scroll to zoom · double-click a table to isolate its neighbours · Esc to exit</span>
    <div class="toolbar-actions">
      <span class="toolbar-action">
        <vscode-button id="refreshBtn" class="toolbar-icon-button" secondary icon-only icon="refresh" aria-label="Refresh diagram data" aria-describedby="refreshTooltip"></vscode-button>
        <span id="refreshTooltip" class="toolbar-button-tooltip" role="tooltip">Reload tables, views, columns, and relationships from the database</span>
      </span>
      <span id="relationshipsAction" class="toolbar-action relationships-action">
        <vscode-button id="relationshipsBtn" class="toolbar-icon-button relationships-toggle" secondary icon-only icon="type-hierarchy" aria-label="Hide relationship lines" aria-describedby="relationshipsTooltip" aria-pressed="true"></vscode-button>
        <span class="relationships-slash" aria-hidden="true"></span>
        <span id="relationshipsTooltip" class="toolbar-button-tooltip" role="tooltip">Hide relationship lines between tables</span>
      </span>
    </div>
  </div>
  <main>
    <section class="canvas-wrap">
      <div id="chart"></div>
      <div class="legend" aria-label="ER diagram legend">
        <span><i class="legend-box table"></i>Table</span>
        <span><i class="legend-box view"></i>View</span>
        <span><i class="legend-region"></i>Schema / database</span>
        <span><i class="legend-line"></i>Relationship</span>
        <span><i class="legend-pk">PK</i>Primary key</span>
        <span><i class="legend-fk">FK</i>Foreign key</span>
        <span><i class="legend-indexed">IDX</i>Indexed</span>
        <span><i class="legend-required">*</i>Required</span>
      </div>
      <div id="hoverTooltip" class="hover-tooltip hidden" role="tooltip"></div>
      <div id="emptyState" class="empty-state">Loading schema…</div>
    </section>
  </main>
  <script src="${echartsUri}"></script>
  <script src="${contextMenuUri}"></script>
  <script src="${layoutUri}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
