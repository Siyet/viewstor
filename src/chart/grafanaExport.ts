/**
 * Generate Grafana dashboard JSON from ChartConfig.
 * Pure functions — no vscode dependency.
 */

import {
  ChartConfig,
  GrafanaChartType,
  GRAFANA_TYPE_MAP,
  isGrafanaCompatible,
} from '../types/chart';

export interface GrafanaDashboard {
  dashboard: {
    title: string;
    panels: GrafanaPanel[];
    time: { from: string; to: string };
    schemaVersion: number;
    editable: boolean;
  };
  overwrite: boolean;
}

interface GrafanaPanel {
  id: number;
  type: string;
  title: string;
  gridPos: { h: number; w: number; x: number; y: number };
  targets: GrafanaTarget[];
  fieldConfig: Record<string, unknown>;
  options: Record<string, unknown>;
}

interface GrafanaTarget {
  refId: string;
  rawSql?: string;
  format?: string;
  datasource?: { type: string; uid: string };
}

const DB_TYPE_TO_GRAFANA_DS: Record<string, string> = {
  postgresql: 'grafana-postgresql-datasource',
  clickhouse: 'grafana-clickhouse-datasource',
  sqlite: 'frser-sqlite-datasource',
  mssql: 'grafana-mssql-datasource',
};

/**
 * Build a Grafana dashboard JSON from chart config.
 * Returns null if the chart type is not compatible with Grafana.
 */
export function buildGrafanaDashboard(config: ChartConfig, datasourceUid?: string): GrafanaDashboard | null {
  if (!isGrafanaCompatible(config.chartType)) {
    return null;
  }

  const grafanaType = GRAFANA_TYPE_MAP[config.chartType as GrafanaChartType];
  const dsType = config.databaseType ? DB_TYPE_TO_GRAFANA_DS[config.databaseType] || '' : '';

  const target: GrafanaTarget = {
    refId: 'A',
    rawSql: config.sourceQuery || '',
    format: grafanaType === 'timeseries' ? 'time_series' : 'table',
  };

  if (dsType || datasourceUid) {
    target.datasource = {
      type: dsType,
      uid: datasourceUid || '${DS_DEFAULT}',
    };
  }

  const panel: GrafanaPanel = {
    id: 1,
    type: grafanaType,
    title: config.title || 'Viewstor Chart',
    gridPos: { h: 9, w: 24, x: 0, y: 0 },
    targets: [target],
    fieldConfig: buildFieldConfig(config),
    options: buildPanelOptions(config),
  };

  return {
    dashboard: {
      title: config.title || 'Viewstor Export',
      panels: [panel],
      time: { from: 'now-6h', to: 'now' },
      schemaVersion: 39,
      editable: true,
    },
    overwrite: true,
  };
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
 */
export async function pushToGrafana(
  grafanaUrl: string,
  apiKey: string,
  dashboard: GrafanaDashboard,
): Promise<string> {
  const url = `${grafanaUrl.replace(/\/+$/, '')}/api/dashboards/db`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(dashboard),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Grafana API error ${response.status}: ${body}`);
  }

  const result = await response.json() as { url?: string };
  return result.url ? `${grafanaUrl.replace(/\/+$/, '')}${result.url}` : grafanaUrl;
}
