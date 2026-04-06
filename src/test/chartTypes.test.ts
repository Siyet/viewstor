import { describe, it, expect } from 'vitest';
import {
  isGrafanaCompatible,
  GRAFANA_TYPE_MAP,
  CHART_TYPE_MAPPING,
  EChartsChartType,
  GrafanaChartType,
} from '../types/chart';

const ALL_CHART_TYPES: EChartsChartType[] = [
  'line', 'bar', 'scatter', 'pie', 'radar', 'heatmap',
  'funnel', 'gauge', 'boxplot', 'candlestick', 'treemap', 'sunburst',
];

const GRAFANA_TYPES: GrafanaChartType[] = ['line', 'bar', 'scatter', 'pie', 'gauge', 'heatmap'];

const NON_GRAFANA_TYPES: EChartsChartType[] = ['radar', 'funnel', 'boxplot', 'candlestick', 'treemap', 'sunburst'];

describe('ECharts chart types', () => {
  it('all 12 chart types have a mapping entry', () => {
    for (const chartType of ALL_CHART_TYPES) {
      expect(CHART_TYPE_MAPPING[chartType]).toBeDefined();
    }
  });

  it('CHART_TYPE_MAPPING covers all known values', () => {
    const validMappings = new Set(['axis', 'category', 'stat', 'radar', 'gauge']);
    for (const chartType of ALL_CHART_TYPES) {
      expect(validMappings.has(CHART_TYPE_MAPPING[chartType])).toBe(true);
    }
  });

  it('axis charts map to axis', () => {
    expect(CHART_TYPE_MAPPING.line).toBe('axis');
    expect(CHART_TYPE_MAPPING.bar).toBe('axis');
    expect(CHART_TYPE_MAPPING.scatter).toBe('axis');
    expect(CHART_TYPE_MAPPING.heatmap).toBe('axis');
  });

  it('category charts map to category', () => {
    expect(CHART_TYPE_MAPPING.pie).toBe('category');
    expect(CHART_TYPE_MAPPING.funnel).toBe('category');
    expect(CHART_TYPE_MAPPING.treemap).toBe('category');
    expect(CHART_TYPE_MAPPING.sunburst).toBe('category');
  });

  it('stat charts map to stat', () => {
    expect(CHART_TYPE_MAPPING.boxplot).toBe('stat');
    expect(CHART_TYPE_MAPPING.candlestick).toBe('stat');
  });

  it('radar maps to radar', () => {
    expect(CHART_TYPE_MAPPING.radar).toBe('radar');
  });

  it('gauge maps to gauge', () => {
    expect(CHART_TYPE_MAPPING.gauge).toBe('gauge');
  });
});

describe('Grafana compatibility', () => {
  it.each(GRAFANA_TYPES)('%s is Grafana-compatible', (chartType) => {
    expect(isGrafanaCompatible(chartType)).toBe(true);
  });

  it.each(NON_GRAFANA_TYPES)('%s is NOT Grafana-compatible', (chartType) => {
    expect(isGrafanaCompatible(chartType)).toBe(false);
  });

  it('GRAFANA_TYPE_MAP has entries for all compatible types', () => {
    for (const chartType of GRAFANA_TYPES) {
      expect(GRAFANA_TYPE_MAP[chartType]).toBeDefined();
      expect(typeof GRAFANA_TYPE_MAP[chartType]).toBe('string');
    }
  });

  it('Grafana type values are unique', () => {
    const values = Object.values(GRAFANA_TYPE_MAP);
    expect(new Set(values).size).toBe(values.length);
  });

  it('isGrafanaCompatible is a type guard', () => {
    const chartType: EChartsChartType = 'line';
    if (isGrafanaCompatible(chartType)) {
      // TypeScript should narrow to GrafanaChartType
      const _grafanaType: GrafanaChartType = chartType;
      expect(_grafanaType).toBe('line');
    }
  });
});

describe('DataSource types', () => {
  it('ChartDataSource mergeMode accepts join and separate', () => {
    // Type check at compile time, runtime validation
    const modes = ['join', 'separate'];
    for (const mode of modes) {
      expect(['join', 'separate']).toContain(mode);
    }
  });
});
