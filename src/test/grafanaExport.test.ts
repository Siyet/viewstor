import { describe, it, expect } from 'vitest';
import { buildGrafanaDashboard, buildApiPayload } from '../chart/grafanaExport';
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
    expect(result!.panels[0].type).toBe(expectedPanel);
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
  it('returns a flat dashboard (top-level title, panels)', () => {
    // Flat shape matches Grafana UI import expectation — title at the root
    // populates the Name field on the import wizard.
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result).not.toBeNull();
    expect(typeof result!.title).toBe('string');
    expect(Array.isArray(result!.panels)).toBe(true);
    expect('dashboard' in (result as object)).toBe(false);
    expect('overwrite' in (result as object)).toBe(false);
  });

  it('uses schemaVersion 39', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.schemaVersion).toBe(39);
  });

  it('sets editable to true', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.editable).toBe(true);
  });

  it('uses default time range now-6h to now', () => {
    const config: ChartConfig = { chartType: 'bar', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.time).toEqual({ from: 'now-6h', to: 'now' });
  });

  it('creates exactly one panel', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.panels).toHaveLength(1);
  });

  it('panel spans full width (w=24)', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.panels[0].gridPos.w).toBe(24);
  });

  it('adds a "viewstor" tag so exported dashboards are discoverable', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.tags).toContain('viewstor');
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
    expect(result!.title).toBe('My Dashboard');
    expect(result!.panels[0].title).toBe('My Dashboard');
  });

  it('uses default title when not provided', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.title).toBe('Viewstor Export');
    expect(result!.panels[0].title).toBe('Viewstor Chart');
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
    expect(result!.panels[0].targets[0].rawSql).toBe('SELECT ts, value FROM metrics');
  });

  it('uses time_series format for timeseries panel', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.panels[0].targets[0].format).toBe('time_series');
  });

  it('uses table format for non-timeseries panels', () => {
    for (const chartType of ['bar', 'scatter', 'pie', 'gauge', 'heatmap'] as const) {
      const config: ChartConfig = { chartType, aggregation: { function: 'none' } };
      const result = buildGrafanaDashboard(config);
      expect(result!.panels[0].targets[0].format).toBe('table');
    }
  });

  it('refId is A', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.panels[0].targets[0].refId).toBe('A');
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
    expect(result!.panels[0].targets[0].datasource?.type).toBe('grafana-postgresql-datasource');
  });

  it('sets ClickHouse datasource type', () => {
    const config: ChartConfig = {
      chartType: 'bar', aggregation: { function: 'none' }, databaseType: 'clickhouse',
    };
    const result = buildGrafanaDashboard(config);
    expect(result!.panels[0].targets[0].datasource?.type).toBe('grafana-clickhouse-datasource');
  });

  it('sets SQLite datasource type', () => {
    const config: ChartConfig = {
      chartType: 'bar', aggregation: { function: 'none' }, databaseType: 'sqlite',
    };
    const result = buildGrafanaDashboard(config);
    expect(result!.panels[0].targets[0].datasource?.type).toBe('frser-sqlite-datasource');
  });

  it('uses custom datasource UID when provided', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, databaseType: 'postgresql',
    };
    const result = buildGrafanaDashboard(config, 'my-custom-uid');
    expect(result!.panels[0].targets[0].datasource?.uid).toBe('my-custom-uid');
  });

  it('uses placeholder UID when datasource not provided', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, databaseType: 'postgresql',
    };
    const result = buildGrafanaDashboard(config);
    expect(result!.panels[0].targets[0].datasource?.uid).toBe('${DS_DEFAULT}');
  });

  it('omits datasource when no databaseType and no UID', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect(result!.panels[0].targets[0].datasource).toBeUndefined();
  });

  it('handles unknown database type gracefully', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, databaseType: 'mysql',
    };
    const result = buildGrafanaDashboard(config);
    expect(result).not.toBeNull();
    expect(result!.panels[0].targets[0].datasource).toBeUndefined();
  });

  it('mirrors the datasource ref onto the panel itself', () => {
    // Grafana panels carry their own datasource reference; setting only the
    // target-level ref leaves the panel "unassigned" in the UI.
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, databaseType: 'postgresql',
    };
    const result = buildGrafanaDashboard(config, 'my-uid');
    expect(result!.panels[0].datasource).toEqual({
      type: 'grafana-postgresql-datasource',
      uid: 'my-uid',
    });
  });
});

// ============================================================
// UI import placeholders (__inputs, __requires)
// ============================================================

describe('buildGrafanaDashboard — UI import placeholders', () => {
  it('emits __inputs and __requires when databaseType is known and no UID bound', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, databaseType: 'postgresql',
    };
    const result = buildGrafanaDashboard(config);
    expect(result!.__inputs).toBeDefined();
    expect(result!.__inputs).toHaveLength(1);
    expect(result!.__inputs![0].name).toBe('DS_DEFAULT');
    expect(result!.__inputs![0].pluginId).toBe('grafana-postgresql-datasource');
    expect(result!.__requires).toBeDefined();
    expect(result!.__requires![0].id).toBe('grafana-postgresql-datasource');
  });

  it('skips __inputs when a concrete datasource UID is provided', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, databaseType: 'postgresql',
    };
    const result = buildGrafanaDashboard(config, 'prod-pg-uid');
    expect(result!.__inputs).toBeUndefined();
    expect(result!.__requires).toBeUndefined();
  });

  it('skips __inputs when databaseType is unknown (cannot declare plugin)', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, databaseType: 'mysql',
    };
    const result = buildGrafanaDashboard(config);
    expect(result!.__inputs).toBeUndefined();
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
    const defaults = result!.panels[0].fieldConfig.defaults as Record<string, unknown>;
    expect((defaults.custom as Record<string, unknown>).fillOpacity).toBe(20);
    expect((defaults.custom as Record<string, unknown>).lineWidth).toBe(2);
  });

  it('no custom fieldConfig when areaFill is false', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, areaFill: false,
    };
    const result = buildGrafanaDashboard(config);
    const defaults = result!.panels[0].fieldConfig.defaults as Record<string, unknown>;
    expect(defaults.custom).toBeUndefined();
  });

  it('shows legend by default', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    const legendOpt = result!.panels[0].options.legend as Record<string, unknown>;
    expect(legendOpt.displayMode).toBe('list');
    expect(legendOpt.placement).toBe('bottom');
  });

  it('hides legend when showLegend is false', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, showLegend: false,
    };
    const result = buildGrafanaDashboard(config);
    const legendOpt = result!.panels[0].options.legend as Record<string, unknown>;
    expect(legendOpt.displayMode).toBe('hidden');
  });

  it('tooltip mode is multi', () => {
    const config: ChartConfig = { chartType: 'bar', aggregation: { function: 'none' } };
    const result = buildGrafanaDashboard(config);
    expect((result!.panels[0].options.tooltip as Record<string, unknown>).mode).toBe('multi');
  });
});

// ============================================================
// buildApiPayload — envelope for POST /api/dashboards/db
// ============================================================

describe('buildApiPayload', () => {
  it('wraps the dashboard in { dashboard, overwrite: true }', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const dashboard = buildGrafanaDashboard(config)!;
    const payload = buildApiPayload(dashboard);
    expect(payload.dashboard).toBeDefined();
    expect(payload.overwrite).toBe(true);
  });

  it('strips __inputs and __requires (API does not accept them)', () => {
    const config: ChartConfig = {
      chartType: 'line', aggregation: { function: 'none' }, databaseType: 'postgresql',
    };
    const dashboard = buildGrafanaDashboard(config)!;
    expect(dashboard.__inputs).toBeDefined(); // sanity check
    const payload = buildApiPayload(dashboard);
    expect(payload.dashboard.__inputs).toBeUndefined();
    expect(payload.dashboard.__requires).toBeUndefined();
  });

  it('respects overwrite=false', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const dashboard = buildGrafanaDashboard(config)!;
    const payload = buildApiPayload(dashboard, { overwrite: false });
    expect(payload.overwrite).toBe(false);
  });

  it('passes through message and folderUid', () => {
    const config: ChartConfig = { chartType: 'line', aggregation: { function: 'none' } };
    const dashboard = buildGrafanaDashboard(config)!;
    const payload = buildApiPayload(dashboard, { message: 'initial import', folderUid: 'team-a' });
    expect(payload.message).toBe('initial import');
    expect(payload.folderUid).toBe('team-a');
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
    expect(parsed.panels[0].targets[0].rawSql).toContain('interval');
    expect(parsed.title).toBe('Test "Dashboard"');
  });
});
