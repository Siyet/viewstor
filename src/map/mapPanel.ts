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
  mode: MapCoordMode | null;
  labelColumn: string | null;
  disposable: vscode.Disposable;
}

export class MapPanelManager {
  private panels = new Map<string, MapState>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Open (or reveal) a map panel for the given columns/rows. Auto-detects
   * coordinate columns; if none match the known patterns the panel still
   * opens with an empty map and the user can pick columns from the toolbar.
   */
  show(
    columns: QueryColumn[],
    rows: Record<string, unknown>[],
    title: string,
    opts?: MapShowOptions,
  ): void {
    const mode = opts?.mode ?? detectCoordMode(columns, rows);

    const labelColumn = opts?.labelColumn !== undefined
      ? opts.labelColumn
      : mode
        ? suggestLabelColumn(columns, mode)
        : null;

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
  }

  private sendData(state: MapState, pointLimit: number) {
    const result = state.mode ? extractPoints(state.rows, state.mode) : { points: [], skipped: 0 };
    const truncated = result.points.length > pointLimit;
    const visible: MapPoint[] = truncated ? result.points.slice(0, pointLimit) : result.points;

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
      total: result.points.length,
      skipped: result.skipped,
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
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'scripts', 'map-panel.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'styles', 'map-panel.css'));
    const colorBorder = opts?.color ? `border-top: 2px solid ${opts.color};` : '';

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
<body>
  <div class="toolbar" style="${esc(colorBorder)}">
    <label title="Coordinate source: a single column with geometry (GeoJSON / WKT / {lat,lng}) or a separate pair of lat + lng columns.">Mode
      <select id="modeSelect">
        <option value="single">Single column</option>
        <option value="pair">Lat + Lng</option>
      </select>
    </label>
    <label id="singleWrap" hidden title="Column holding the geometry value: GeoJSON Point, WKT 'POINT(lng lat)', {lat,lng} object or [lng,lat] array.">Column
      <select id="singleSelect"></select>
    </label>
    <label id="latWrap" hidden title="Latitude column — decimal degrees, -90 to 90.">Lat
      <select id="latSelect"></select>
    </label>
    <label id="lngWrap" hidden title="Longitude column — decimal degrees, -180 to 180.">Lng
      <select id="lngSelect"></select>
    </label>
    <label title="Column shown as a label on each marker. Permanent when there are ≤50 points, otherwise on hover.">Label
      <select id="labelSelect"></select>
    </label>
    <span style="flex:1"></span>
    <span id="statusInfo" class="status-info"></span>
  </div>
  <div id="map"></div>
  <div id="emptyState" class="empty-state hidden">Pick coordinate columns in the toolbar.</div>
  <script src="${leafletJs}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
