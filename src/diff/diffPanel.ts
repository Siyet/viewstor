import * as vscode from 'vscode';
import * as path from 'path';
import { DiffSource, DiffOptions, RowDiffResult, SchemaDiffResult } from './diffTypes';
import { computeRowDiff, computeSchemaDiff, exportDiffAsCsv, exportDiffAsJson } from './diffEngine';
import { ColumnInfo } from '../types/schema';

interface DiffState {
  panel: vscode.WebviewPanel;
  left: DiffSource;
  right: DiffSource;
  options: DiffOptions;
  rowDiff: RowDiffResult;
  schemaDiff: SchemaDiffResult | null;
  leftTableInfo?: { columns: ColumnInfo[] };
  rightTableInfo?: { columns: ColumnInfo[] };
  disposable: vscode.Disposable;
}

export class DiffPanelManager {
  private diffs = new Map<string, DiffState>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  show(
    left: DiffSource,
    right: DiffSource,
    options: DiffOptions,
    leftTableInfo?: { columns: ColumnInfo[] },
    rightTableInfo?: { columns: ColumnInfo[] },
  ) {
    const rowDiff = computeRowDiff(left, right, options);
    const schemaDiff = leftTableInfo && rightTableInfo
      ? computeSchemaDiff(leftTableInfo.columns, rightTableInfo.columns)
      : null;

    const panelTitle = `Diff \u2014 ${left.label} \u2194 ${right.label}`;
    const panelKey = `diff:${panelTitle}`;

    let state = this.diffs.get(panelKey);
    if (state) {
      state.panel.reveal();
      state.left = left;
      state.right = right;
      state.options = options;
      state.rowDiff = rowDiff;
      state.schemaDiff = schemaDiff;
      state.leftTableInfo = leftTableInfo;
      state.rightTableInfo = rightTableInfo;
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
        leftTableInfo,
        rightTableInfo,
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
          // Swap left and right sources and re-compute
          const swappedLeft = state.right;
          const swappedRight = state.left;
          const swappedLeftInfo = state.rightTableInfo;
          const swappedRightInfo = state.leftTableInfo;
          this.show(swappedLeft, swappedRight, state.options, swappedLeftInfo, swappedRightInfo);
          break;
        }
      }
    });
  }

  private buildHtml(webview: vscode.Webview, state: DiffState): string {
    const distUri = vscode.Uri.file(path.join(this.context.extensionPath, 'dist'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'diff-panel.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'diff-panel.js'));
    const cspSource = webview.cspSource;

    const diffData = {
      rowDiff: state.rowDiff,
      schemaDiff: state.schemaDiff,
      leftLabel: state.left.label,
      rightLabel: state.right.label,
      keyColumns: state.options.keyColumns,
    };

    const summary = state.rowDiff.summary;
    const hasSchema = !!state.schemaDiff;

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
  </div>

  <div class="diff-summary">
    <span class="diff-badge unchanged">${esc(String(summary.unchanged))} unchanged</span>
    <span class="diff-badge changed">${esc(String(summary.changed))} changed</span>
    <span class="diff-badge added">${esc(String(summary.added))} added</span>
    <span class="diff-badge removed">${esc(String(summary.removed))} removed</span>
    <span class="diff-summary-spacer"></span>
    <button id="swapSides" title="Swap left and right sides">\u21C4 Swap</button>
    <button id="exportCsv">Export CSV</button>
    <button id="exportJson">Export JSON</button>
  </div>

  ${state.rowDiff.truncated ? '<div class="diff-truncated">Results truncated to row limit. Increase the limit to see all differences.</div>' : ''}

  <div id="panel-rows" class="diff-tab-panel active">
    <div class="diff-filter-bar">
      <span class="diff-filter-label">Filter:</span>
      <button class="diff-filter-btn active" data-filter="all">All</button>
      <button class="diff-filter-btn" data-filter="changed">Changed</button>
      <button class="diff-filter-btn" data-filter="unchanged">Unchanged</button>
      <button class="diff-filter-btn" data-filter="added">Added</button>
      <button class="diff-filter-btn" data-filter="removed">Removed</button>
    </div>
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
    <div class="diff-schema-container">
      <table class="diff-schema-table">
        <thead>
          <tr>
            <th>Column</th>
            <th>Left Type</th>
            <th>Right Type</th>
            <th>Left Nullable</th>
            <th>Right Nullable</th>
            <th>Left PK</th>
            <th>Right PK</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="schemaTableBody"></tbody>
      </table>
    </div>
    ` : '<div class="diff-no-schema">Schema diff not available (table info not provided)</div>'}
  </div>

  <script>window.diffData = ${safeJsonForScript(diffData)};</script>
  <script src="${jsUri}"></script>
</body>
</html>`;
  }
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}
