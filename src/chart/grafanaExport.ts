/**
 * Generate Grafana dashboard JSON from ChartConfig.
 * Pure functions — no vscode dependency.
 *
 * Grafana has two slightly different JSON shapes:
 *   - UI import ("Upload JSON file"): flat dashboard object with optional
 *     `__inputs` / `__requires` arrays at the top level.
 *   - API POST /api/dashboards/db: envelope { dashboard, overwrite, message, folderUid? }.
 *
 * We export the flat shape by default (what the user copies / saves) and wrap
 * it with `buildApiPayload()` only when pushing over HTTP.
 */

import {
  ChartConfig,
  GrafanaChartType,
  GRAFANA_TYPE_MAP,
  isGrafanaCompatible,
} from '../types/chart';

export interface GrafanaDashboard {
  title: string;
  panels: GrafanaPanel[];
  time: { from: string; to: string };
  schemaVersion: number;
  editable: boolean;
  tags?: string[];
  /** Optional datasource placeholders for Grafana UI import */
  __inputs?: GrafanaInput[];
  /** Optional plugin/datasource requirements for UI import */
  __requires?: GrafanaRequire[];
}

export interface GrafanaApiPayload {
  dashboard: GrafanaDashboard;
  overwrite: boolean;
  message?: string;
  folderUid?: string;
}

interface GrafanaInput {
  name: string;
  label: string;
  description: string;
  type: 'datasource';
  pluginId: string;
  pluginName: string;
}

interface GrafanaRequire {
  type: 'datasource' | 'panel' | 'grafana';
  id: string;
  name: string;
  version: string;
}

interface GrafanaPanel {
  id: number;
  type: string;
  title: string;
  gridPos: { h: number; w: number; x: number; y: number };
  targets: GrafanaTarget[];
  fieldConfig: Record<string, unknown>;
  options: Record<string, unknown>;
  datasource?: { type: string; uid: string };
}

interface GrafanaTarget {
  refId: string;
  rawSql?: string;
  format?: string;
  datasource?: { type: string; uid: string };
}

const DB_TYPE_TO_GRAFANA_DS: Record<string, { type: string; name: string }> = {
  postgresql: { type: 'grafana-postgresql-datasource', name: 'PostgreSQL' },
  clickhouse: { type: 'grafana-clickhouse-datasource', name: 'ClickHouse' },
  sqlite: { type: 'frser-sqlite-datasource', name: 'SQLite' },
};

const DEFAULT_INPUT_NAME = 'DS_DEFAULT';

/**
 * Build a Grafana dashboard JSON from chart config (flat shape, UI-import ready).
 * Returns null if the chart type is not compatible with Grafana.
 *
 * @param config   Chart config driving the panel.
 * @param datasourceUid  If provided, wires the panel to this datasource UID directly.
 *                       If omitted and `databaseType` is known, adds a `__inputs`
 *                       placeholder (`${DS_DEFAULT}`) so the Grafana UI prompts
 *                       the user to pick a datasource on import.
 */
export function buildGrafanaDashboard(
  config: ChartConfig,
  datasourceUid?: string,
): GrafanaDashboard | null {
  if (!isGrafanaCompatible(config.chartType)) {
    return null;
  }

  const grafanaType = GRAFANA_TYPE_MAP[config.chartType as GrafanaChartType];
  const dsMapping = config.databaseType ? DB_TYPE_TO_GRAFANA_DS[config.databaseType] : undefined;
  const dsType = dsMapping?.type || '';

  const dsRef = (dsType || datasourceUid)
    ? { type: dsType, uid: datasourceUid || `\${${DEFAULT_INPUT_NAME}}` }
    : undefined;

  const target: GrafanaTarget = {
    refId: 'A',
    rawSql: config.sourceQuery || '',
    format: grafanaType === 'timeseries' ? 'time_series' : 'table',
  };

  if (dsRef) target.datasource = dsRef;

  const panel: GrafanaPanel = {
    id: 1,
    type: grafanaType,
    title: config.title || 'Viewstor Chart',
    gridPos: { h: 9, w: 24, x: 0, y: 0 },
    targets: [target],
    fieldConfig: buildFieldConfig(config),
    options: buildPanelOptions(config),
  };

  // Panels in Grafana carry their own datasource reference as well; setting it
  // here makes the dashboard render correctly even when the target-level ref is
  // dropped by older Grafana versions.
  if (dsRef) panel.datasource = dsRef;

  const dashboard: GrafanaDashboard = {
    title: config.title || 'Viewstor Export',
    panels: [panel],
    time: { from: 'now-6h', to: 'now' },
    schemaVersion: 39,
    editable: true,
    tags: ['viewstor'],
  };

  // When importing via the Grafana UI without a pre-bound UID, declare the
  // datasource placeholder so the import wizard shows a picker and the panel
  // wires up correctly post-import.
  if (dsMapping && !datasourceUid) {
    dashboard.__inputs = [{
      name: DEFAULT_INPUT_NAME,
      label: dsMapping.name,
      description: '',
      type: 'datasource',
      pluginId: dsMapping.type,
      pluginName: dsMapping.name,
    }];
    dashboard.__requires = [{
      type: 'datasource',
      id: dsMapping.type,
      name: dsMapping.name,
      version: '1.0.0',
    }];
  }

  return dashboard;
}

/**
 * Wrap a dashboard in the envelope expected by `POST /api/dashboards/db`.
 * The UI-import `__inputs` / `__requires` fields are stripped — the API does
 * not accept them and they cause a 400.
 */
export function buildApiPayload(
  dashboard: GrafanaDashboard,
  opts: { overwrite?: boolean; message?: string; folderUid?: string } = {},
): GrafanaApiPayload {
  // Strip UI-only fields and force id/uid to be absent so Grafana assigns new
  // ones (prevents "Dashboard not found" errors when re-pushing).
  const { __inputs: _i, __requires: _r, ...rest } = dashboard;
  void _i; void _r;

  const payload: GrafanaApiPayload = {
    dashboard: rest,
    overwrite: opts.overwrite !== false,
  };
  if (opts.message) payload.message = opts.message;
  if (opts.folderUid) payload.folderUid = opts.folderUid;
  return payload;
}

function buildFieldConfig(config: ChartConfig): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};

  if (config.chartType === 'line' && config.areaFill) {
    defaults.custom = { fillOpacity: 20, lineWidth: 2 };
  }

  return { defaults, overrides: [] };
}

function buildPanelOptions(config: ChartConfig): Record<string, unknown> {
  const options: Record<string, unknown> = {};

  if (config.showLegend !== false) {
    options.legend = { displayMode: 'list', placement: 'bottom' };
  } else {
    options.legend = { displayMode: 'hidden' };
  }

  options.tooltip = { mode: 'multi' };

  return options;
}

/**
 * Push a dashboard to Grafana via HTTP API.
 * Returns the dashboard URL on success, or throws on failure.
 *
 * Accepts either a flat dashboard (preferred) or a pre-built API payload for
 * backwards compatibility with callers that used to build the envelope
 * themselves.
 */
export async function pushToGrafana(
  grafanaUrl: string,
  apiKey: string,
  dashboardOrPayload: GrafanaDashboard | GrafanaApiPayload,
  opts: { message?: string; folderUid?: string; overwrite?: boolean } = {},
): Promise<string> {
  const payload: GrafanaApiPayload = isApiPayload(dashboardOrPayload)
    ? dashboardOrPayload
    : buildApiPayload(dashboardOrPayload, {
      overwrite: opts.overwrite,
      message: opts.message,
      folderUid: opts.folderUid,
    });

  const base = grafanaUrl.replace(/\/+$/, '');
  const response = await fetch(`${base}/api/dashboards/db`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Grafana API error ${response.status}: ${body}`);
  }

  const result = await response.json() as { url?: string };
  return result.url ? `${base}${result.url}` : base;
}

function isApiPayload(value: GrafanaDashboard | GrafanaApiPayload): value is GrafanaApiPayload {
  return typeof (value as GrafanaApiPayload).dashboard === 'object'
    && (value as GrafanaApiPayload).dashboard !== null
    && 'panels' in (value as GrafanaApiPayload).dashboard;
}
