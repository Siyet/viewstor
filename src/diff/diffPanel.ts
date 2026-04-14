import * as vscode from 'vscode';
import * as path from 'path';
import { DiffSource, DiffOptions, RowDiffResult, SchemaDiffResult, ObjectsDiffResult, StatsDiffResult } from './diffTypes';
import { computeRowDiff, computeSchemaDiff, computeObjectsDiff, computeStatsDiff, exportDiffAsCsv, exportDiffAsJson } from './diffEngine';
import { ColumnInfo, TableObjects, TableStatistic } from '../types/schema';

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
    leftObjects?: TableObjects,
    rightObjects?: TableObjects,
    leftStats?: TableStatistic[],
    rightStats?: TableStatistic[],
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
          );
          break;
        }
      }
    });
  }

  private buildHtml(webview: vscode.Webview, state: DiffState): string {
    const distUri = vscode.Uri.file(path.join(this.context.extensionPath, 'dist'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'diff-panel.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'diff-panel.js'));
    const echartsUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'echarts.min.js'));
    const cspSource = webview.cspSource;

    const diffData = {
      rowDiff: state.rowDiff,
      schemaDiff: state.schemaDiff,
      objectsDiff: state.objectsDiff,
      statsDiff: state.statsDiff,
      leftLabel: state.left.label,
      rightLabel: state.right.label,
      keyColumns: state.options.keyColumns,
    };

    const summary = state.rowDiff.summary;
    const hasSchema = !!state.schemaDiff;
    const hasStats = !!state.statsDiff;

    // Counts for Schema Diff tab: "differs" bundles type/nullable/pk diffs + added/removed columns + non-same objects
    let schemaDiffers = 0, schemaSame = 0;
    if (state.schemaDiff) {
      for (const col of state.schemaDiff.commonColumns) {
        if (col.typeDiffers || col.nullableDiffers || col.pkDiffers) schemaDiffers++;
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
    <span class="diff-summary-spacer"></span>
    <button id="swapSides" title="Swap left and right sides">\u21C4 Swap</button>
    <button id="exportCsv">Export CSV</button>
    <button id="exportJson">Export JSON</button>
  </div>

  ${state.rowDiff.truncated ? '<div class="diff-truncated">Results truncated to row limit. Increase the limit to see all differences.</div>' : ''}

  <div id="panel-rows" class="diff-tab-panel active">
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
            <th>Type (${esc(state.left.label)} / ${esc(state.right.label)})</th>
            <th>Nullable (${esc(state.left.label)} / ${esc(state.right.label)})</th>
            <th>PK (${esc(state.left.label)} / ${esc(state.right.label)})</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="schemaTableBody"></tbody>
      </table>
    </div>
    ` : '<div class="diff-no-schema">Schema diff not available (table info not provided)</div>'}
    <div id="objectsDiffContainer"></div>
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

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}
