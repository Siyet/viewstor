import { describe, it, expect } from 'vitest';
import { buildGrafanaDashboard } from '../chart/grafanaExport';
import { ChartConfig, EChartsChartType } from '../types/chart';

// ============================================================
// Compatibility checks
// ============================================================

describe('buildGrafanaDashboard — compatibility', () => {
  const COMPATIBLE: Array<[EChartsChartType, string]> = [
    ['line', 'timeseries'],
    ['bar', 'barchart'],
    ['scatter', 'xychart'],
    ['pie', 'piechart'],
    ['gauge', 'gauge'],
    ['heatmap', 'heatmap'],
  ];

  const INCOMPATIBLE: EChartsChartType[] = [
    'radar', 'funnel', 'boxplot', 'candlestick', 'treemap', 'sunburst',
  ];

  it.each(COMPATIBLE)('%s maps to Grafana panel type %s', (chartType, expectedPanel) => {
    const config: ChartConfig = { chartType, aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result).not.toBeNull();
    expect(result!.dashboard.panels[0].type).toBe(expectedPanel);
  });

  it.each(INCOMPATIBLE)('%s returns null (not compatible)', (chartType) => {
    const config: ChartConfig = { chartType, aggregation: { function: 'none' } };
    expect(buildGrafanaDashboard(config)).toBeNull();
  });
});

// ============================================================
// Dashboard structure
// ============================================================

describe('buildGrafanaDashboard — structure', () => {
  it('uses schemaVersion 39', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.schemaVersion).toBe(39);
  });

  it('sets editable to true', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.editable).toBe(true);
  });

  it('sets overwrite to true', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.overwrite).toBe(true);
  });

  it('uses default time range now-6h to now', () => {
    const config: ChartConfig = { chartType: 'bar', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.time).toEqual({ from: 'now-6h', to: 'now' });
  });

  it('creates exactly one panel', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.panels).toHaveLength(1);
  });

  it('panel spans full width (w=24)', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.panels[0].gridPos.w).toBe(24);
  });
});

// ============================================================
// Title
// ============================================================

describe('buildGrafanaDashboard — title', () => {
  it('uses custom title when provided', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, title: 'My Dashboard',
    };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.title).toBe('My Dashboard');
    expect(result!.dashboard.panels[0].title).toBe('My Dashboard');
  });

  it('uses default title when not provided', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.title).toBe('Viewstor Export');
    expect(result!.dashboard.panels[0].title).toBe('Viewstor Chart');
  });
});

// ============================================================
// SQL query target
// ============================================================

describe('buildGrafanaDashboard — query target', () => {
  it('includes raw SQL in target', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' },
      sourceQuery: 'SELECT ts, value FROM metrics',
    };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.panels[0].targets[0].rawSql).toBe('SELECT ts, value FROM metrics');
  });

  it('uses time_series format for timeseries panel', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.panels[0].targets[0].format).toBe('time_series');
  });

  it('uses table format for non-timeseries panels', () => {
    for (const chartType of ['bar', 'scatter', 'pie', 'gauge', 'heatmap'] as const) {
      const config: ChartConfig = { chartType, aggregation: { function: 'none' } };
      const result = buildGrafanaDashboard(config);
      expect(result!.dashboard.panels[0].targets[0].format).toBe('table');
    }
  });

  it('refId is A', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.panels[0].targets[0].refId).toBe('A');
  });
});

// ============================================================
// Datasource
// ============================================================

describe('buildGrafanaDashboard — datasource', () => {
  it('sets PostgreSQL datasource type', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, databaseType: 'postgresql',
    };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.panels[0].targets[0].datasource?.type).toBe('grafana-postgresql-datasource');
  });

  it('sets ClickHouse datasource type', () => {
    const config: ChartConfig = {
      chartType: 'bar', aggregation: { function: 'none' }, databaseType: 'clickhouse',
    };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.panels[0].targets[0].datasource?.type).toBe('grafana-clickhouse-datasource');
  });

  it('sets SQLite datasource type', () => {
    const config: ChartConfig = {
      chartType: 'bar', aggregation: { function: 'none' }, databaseType: 'sqlite',
    };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.panels[0].targets[0].datasource?.type).toBe('frser-sqlite-datasource');
  });

  it('uses custom datasource UID when provided', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, databaseType: 'postgresql',
    };
    const result = buildGrafanaDashboard(config, 'my-custom-uid');
    expect(result!.dashboard.panels[0].targets[0].datasource?.uid).toBe('my-custom-uid');
  });

  it('uses placeholder UID when datasource not provided', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, databaseType: 'postgresql',
    };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.panels[0].targets[0].datasource?.uid).toBe('${DS_DEFAULT}');
  });

  it('omits datasource when no databaseType and no UID', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.dashboard.panels[0].targets[0].datasource).toBeUndefined();
  });

  it('handles unknown database type gracefully', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, databaseType: 'mysql',
    };
    const result = buildGrafanaDashboard(config);
    // Unknown type with no UID → datasource still created with empty type string
    // dsType resolves to '' which is falsy, so datasource is only created when UID is provided
    expect(result).not.toBeNull();
    // Without explicit UID, empty dsType means no datasource block
    expect(result!.dashboard.panels[0].targets[0].datasource).toBeUndefined();
  });
});

// ============================================================
// Field config (area fill, legend)
// ============================================================

describe('buildGrafanaDashboard — options', () => {
  it('includes area fill in fieldConfig for line charts', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, areaFill: true,
    };
    const result = buildGrafanaDashboard(config);
    const defaults = result!.dashboard.panels[0].fieldConfig.defaults as Record<string, unknown>;
    expect((defaults.custom as Record<string, unknown>).fillOpacity).toBe(20);
    expect((defaults.custom as Record<string, unknown>).lineWidth).toBe(2);
  });

  it('no custom fieldConfig when areaFill is false', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, areaFill: false,
    };
    const result = buildGrafanaDashboard(config);
    const defaults = result!.dashboard.panels[0].fieldConfig.defaults as Record<string, unknown>;
    expect(defaults.custom).toBeUndefined();
  });

  it('shows legend by default', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    const legendOpt = result!.dashboard.panels[0].options.legend as Record<string, unknown>;
    expect(legendOpt.displayMode).toBe('list');
    expect(legendOpt.placement).toBe('bottom');
  });

  it('hides legend when showLegend is false', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, showLegend: false,
    };
    const result = buildGrafanaDashboard(config);
    const legendOpt = result!.dashboard.panels[0].options.legend as Record<string, unknown>;
    expect(legendOpt.displayMode).toBe('hidden');
  });

  it('tooltip mode is multi', () => {
    const config: ChartConfig = { chartType: 'bar', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect((result!.dashboard.panels[0].options.tooltip as Record<string, unknown>).mode).toBe('multi');
  });
});

// ============================================================
// JSON serialization roundtrip
// ============================================================

describe('buildGrafanaDashboard — JSON roundtrip', () => {
  it('produces valid JSON that can be parsed back', () => {
    const config: ChartConfig = {
      chartType: 'line',
      axis: { xColumn: 'ts', yColumns: ['value'] },
      aggregation: { function: 'none' },
      sourceQuery: 'SELECT ts, value FROM metrics WHERE ts > now() - interval \'1 hour\'',
      databaseType: 'postgresql',
      title: 'Test "Dashboard"',
    };
    const result = buildGrafanaDashboard(config, 'my-ds');
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.dashboard.panels[0].targets[0].rawSql).toContain('interval');
    expect(parsed.dashboard.title).toBe('Test "Dashboard"');
  });
});
