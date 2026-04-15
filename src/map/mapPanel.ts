import * as vscode from 'vscode';
import * as path from 'path';
import { QueryColumn } from '../types/query';
import {
  MapCoordMode,
  MapPoint,
  detectCoordMode,
  extractPoints,
  suggestLabelColumn,
} from './mapDataTransform';

/** Max points rendered in one panel — above this we warn the user. */
export const MAP_DEFAULT_POINT_LIMIT = 10000;

export interface MapShowOptions {
  /** Optional forced coord mode. If omitted, auto-detect runs. */
  mode?: MapCoordMode;
  /** Optional label column. If omitted, auto-suggest runs. */
  labelColumn?: string | null;
  /** Accent border color matching the source connection. */
  color?: string;
  /** Window title override. */
  title?: string;
  /** Max points to render; defaults to MAP_DEFAULT_POINT_LIMIT. */
  pointLimit?: number;
}

interface MapState {
  panel: vscode.WebviewPanel;
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  mode: MapCoordMode;
  labelColumn: string | null;
  disposable: vscode.Disposable;
}

export class MapPanelManager {
  private panels = new Map<string, MapState>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Open (or reveal) a map panel for the given columns/rows. Returns `false`
   * if no usable coordinate columns could be detected — callers should show a
   * message in that case.
   */
  show(
    columns: QueryColumn[],
    rows: Record<string, unknown>[],
    title: string,
    opts?: MapShowOptions,
  ): boolean {
    const mode = opts?.mode ?? detectCoordMode(columns, rows);
    if (!mode) return false;

    const labelColumn = opts?.labelColumn !== undefined
      ? opts.labelColumn
      : suggestLabelColumn(columns, mode);

    const panelTitle = opts?.title ?? title;
    const panelKey = `map:${panelTitle}`;

    let state = this.panels.get(panelKey);
    if (state) {
      state.panel.reveal();
      state.columns = columns;
      state.rows = rows;
      state.mode = mode;
      state.labelColumn = labelColumn;
    } else {
      const panel = vscode.window.createWebviewPanel(
        'viewstor.map',
        panelTitle,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))],
        },
      );
      panel.onDidDispose(() => {
        const s = this.panels.get(panelKey);
        if (s) s.disposable.dispose();
        this.panels.delete(panelKey);
      });

      state = {
        panel,
        columns,
        rows,
        mode,
        labelColumn,
        disposable: new vscode.Disposable(() => {}),
      };
      this.panels.set(panelKey, state);
    }

    state.panel.webview.html = this.buildHtml(state.panel.webview, opts);
    state.disposable.dispose();
    state.disposable = this.registerMessageHandler(state, opts?.pointLimit ?? MAP_DEFAULT_POINT_LIMIT);

    // Webview sends a `ready` message once its listener is attached; that
    // handler triggers the initial `sendData` call. No setTimeout needed —
    // relying on one avoided both a double-send and a
    // post-to-disposed-panel race if the user closed the tab within 100 ms.
    return true;
  }

  private sendData(state: MapState, pointLimit: number) {
    const { points, skipped } = extractPoints(state.rows, state.mode);
    const truncated = points.length > pointLimit;
    const visible: MapPoint[] = truncated ? points.slice(0, pointLimit) : points;

    state.panel.webview.postMessage({
      type: 'setPoints',
      points: visible.map(p => ({
        lat: p.lat,
        lng: p.lng,
        rowIndex: p.rowIndex,
        row: p.row,
      })),
      columns: state.columns.map(c => c.name),
      labelColumn: state.labelColumn,
      mode: state.mode,
      total: points.length,
      skipped,
      truncated,
      pointLimit,
    });
  }

  private registerMessageHandler(state: MapState, pointLimit: number): vscode.Disposable {
    return state.panel.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'changeMode': {
          if (msg.mode && (msg.mode.kind === 'single' || msg.mode.kind === 'pair')) {
            state.mode = msg.mode;
            this.sendData(state, pointLimit);
          }
          break;
        }
        case 'changeLabel': {
          state.labelColumn = typeof msg.column === 'string' ? msg.column : null;
          this.sendData(state, pointLimit);
          break;
        }
        case 'ready': {
          // Webview finished initialising — resend current state
          this.sendData(state, pointLimit);
          break;
        }
      }
    });
  }

  private buildHtml(webview: vscode.Webview, opts?: MapShowOptions): string {
    const distUri = vscode.Uri.file(path.join(this.context.extensionPath, 'dist'));
    const leafletJs = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'leaflet.js'));
    const leafletCss = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'leaflet.css'));
    const markerIcon = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'images', 'marker-icon.png'));
    const markerIcon2x = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'images', 'marker-icon-2x.png'));
    const markerShadow = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'images', 'marker-shadow.png'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'map-panel.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'map-panel.css'));
    const colorBorder = opts?.color ? `border-top: 2px solid ${opts.color};` : '';

    const iconPaths = JSON.stringify({
      iconRetinaUrl: markerIcon2x.toString(),
      iconUrl: markerIcon.toString(),
      shadowUrl: markerShadow.toString(),
    }).replace(/<\//g, '<\\/');

    const csp = [
      'default-src \'none\'',
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'unsafe-inline'`,
      'connect-src https:',
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${leafletCss}">
<link rel="stylesheet" href="${styleUri}">
</head>
<body data-icons='${iconPaths}'>
  <div class="toolbar" style="${esc(colorBorder)}">
    <label>Coords
      <select id="coordSelect"></select>
    </label>
    <label>Label
      <select id="labelSelect"></select>
    </label>
    <span style="flex:1"></span>
    <span id="statusInfo" class="status-info"></span>
  </div>
  <div id="map"></div>
  <div id="emptyState" class="empty-state hidden">No valid coordinates to plot.</div>
  <script src="${leafletJs}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
