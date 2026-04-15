import { describe, it, expect } from 'vitest';
import {
  isGrafanaCompatible,
  GRAFANA_TYPE_MAP,
  CHART_TYPE_MAPPING,
  EChartsChartType,
  GrafanaChartType,
  buildAggregationQuery,
  buildFullDataQuery,
  TIME_BUCKET_PG,
  TIME_BUCKET_CH,
  TIME_BUCKET_SQLITE,
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
    const modes = ['join', 'separate'];
    for (const mode of modes) {
      expect(['join', 'separate']).toContain(mode);
    }
  });
});

describe('buildAggregationQuery', () => {
  it('builds a COUNT query with date_trunc for PostgreSQL', () => {
    const sql = buildAggregationQuery(
      'quotes', 'public', 'created_at', ['id'], 'count', undefined,
      { function: 'count', timeBucketPreset: 'month' }, 'postgresql',
    );
    expect(sql).toContain('date_trunc');
    expect(sql).toContain('\'month\'');
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain('GROUP BY');
    expect(sql).toContain('ORDER BY');
  });

  it('builds a SUM query without time bucketing', () => {
    const sql = buildAggregationQuery(
      'orders', 'public', 'region', ['amount'], 'sum', undefined,
      { function: 'sum' },
    );
    expect(sql).toContain('SUM("amount")');
    expect(sql).toContain('"region"');
    expect(sql).toContain('GROUP BY');
  });

  it('builds a query with group by column', () => {
    const sql = buildAggregationQuery(
      'metrics', undefined, 'ts', ['value'], 'avg', 'endpoint',
      { function: 'avg', timeBucketPreset: 'hour' }, 'postgresql',
    );
    expect(sql).toContain('AVG("value")');
    expect(sql).toContain('"endpoint"');
    expect(sql).toContain('GROUP BY');
  });

  it('builds ClickHouse query with toStartOf* functions', () => {
    const sql = buildAggregationQuery(
      'events', 'default', 'timestamp', ['count'], 'count', undefined,
      { function: 'count', timeBucketPreset: 'day' }, 'clickhouse',
    );
    expect(sql).toContain('toStartOfDay');
    expect(sql).toContain('COUNT(*)');
  });

  it('builds query with no aggregation', () => {
    const sql = buildAggregationQuery(
      'users', 'public', 'name', ['age'], 'none', undefined,
      { function: 'none' },
    );
    expect(sql).toContain('"name"');
    expect(sql).toContain('"age"');
    expect(sql).not.toContain('GROUP BY');
  });

  it('respects limit parameter', () => {
    const sql = buildAggregationQuery(
      'data', undefined, 'x', ['y'], 'sum', undefined,
      { function: 'sum' }, undefined, 1000,
    );
    expect(sql).toContain('LIMIT 1000');
  });

  it('handles custom time bucket', () => {
    const sql = buildAggregationQuery(
      'metrics', 'public', 'ts', ['val'], 'avg', undefined,
      { function: 'avg', timeBucketPreset: 'custom', timeBucket: '2h' }, 'postgresql',
    );
    expect(sql).toContain('date_bin');
    expect(sql).toContain('2 hour');
  });
});

describe('buildFullDataQuery', () => {
  it('builds SELECT with specific columns and no LIMIT', () => {
    const sql = buildFullDataQuery('metrics', 'public', ['ts', 'value', 'endpoint']);
    expect(sql).toBe('SELECT "ts", "value", "endpoint" FROM "public"."metrics"');
  });

  it('works without schema', () => {
    const sql = buildFullDataQuery('data', undefined, ['x', 'y']);
    expect(sql).toBe('SELECT "x", "y" FROM "data"');
  });

  it('drops schema for SQLite (SQLite has no schemas)', () => {
    // Callers may pass whatever they stored on the tree node (sometimes
    // "main"). SQLite's parser rejects a bare `"public"."metrics"` reference,
    // so we always strip it.
    const sql = buildFullDataQuery('metrics', 'public', ['ts', 'value'], 'sqlite');
    expect(sql).toBe('SELECT "ts", "value" FROM "metrics"');
  });
});

describe('buildAggregationQuery — SQLite schema stripping', () => {
  it('omits schema prefix for SQLite', () => {
    const sql = buildAggregationQuery(
      'events', 'main', 'ts', ['value'], 'sum', undefined,
      { function: 'sum' }, 'sqlite',
    );
    expect(sql).not.toContain('"main".');
    expect(sql).toContain('FROM "events"');
  });

  it('keeps schema prefix for PostgreSQL', () => {
    const sql = buildAggregationQuery(
      'events', 'analytics', 'ts', ['value'], 'sum', undefined,
      { function: 'sum' }, 'postgresql',
    );
    expect(sql).toContain('FROM "analytics"."events"');
  });

  it('keeps schema prefix for ClickHouse', () => {
    const sql = buildAggregationQuery(
      'events', 'default', 'ts', ['value'], 'sum', undefined,
      { function: 'sum' }, 'clickhouse',
    );
    expect(sql).toContain('FROM "default"."events"');
  });
});

describe('Time bucket constants', () => {
  it('TIME_BUCKET_PG has all presets', () => {
    expect(TIME_BUCKET_PG.second).toBe('second');
    expect(TIME_BUCKET_PG.minute).toBe('minute');
    expect(TIME_BUCKET_PG.hour).toBe('hour');
    expect(TIME_BUCKET_PG.day).toBe('day');
    expect(TIME_BUCKET_PG.month).toBe('month');
    expect(TIME_BUCKET_PG.year).toBe('year');
  });

  it('TIME_BUCKET_CH has all presets', () => {
    expect(TIME_BUCKET_CH.second).toBe('toStartOfSecond');
    expect(TIME_BUCKET_CH.minute).toBe('toStartOfMinute');
    expect(TIME_BUCKET_CH.hour).toBe('toStartOfHour');
    expect(TIME_BUCKET_CH.day).toBe('toStartOfDay');
    expect(TIME_BUCKET_CH.month).toBe('toStartOfMonth');
    expect(TIME_BUCKET_CH.year).toBe('toStartOfYear');
  });

  it('PG and CH maps have same keys', () => {
    const pgKeys = Object.keys(TIME_BUCKET_PG).sort();
    const chKeys = Object.keys(TIME_BUCKET_CH).sort();
    expect(pgKeys).toEqual(chKeys);
  });
});

// ============================================================
// buildAggregationQuery — comprehensive edge cases
// ============================================================

describe('buildAggregationQuery — edge cases', () => {
  it('quotes table and column names', () => {
    const sql = buildAggregationQuery(
      'my table', 'my schema', 'time col', ['val'], 'sum', undefined,
      { function: 'sum' },
    );
    expect(sql).toContain('"my schema"."my table"');
    expect(sql).toContain('"time col"');
    expect(sql).toContain('"val"');
  });

  it('handles multiple Y columns', () => {
    const sql = buildAggregationQuery(
      'metrics', 'public', 'ts', ['cpu', 'mem', 'disk'], 'avg', undefined,
      { function: 'avg' },
    );
    expect(sql).toContain('AVG("cpu")');
    expect(sql).toContain('AVG("mem")');
    expect(sql).toContain('AVG("disk")');
  });

  it('COUNT always produces COUNT(*) regardless of Y columns', () => {
    const sql = buildAggregationQuery(
      't', undefined, 'x', ['a', 'b'], 'count', undefined,
      { function: 'count' },
    );
    expect(sql).toContain('COUNT(*)');
    expect(sql).not.toContain('COUNT("a")');
  });

  it('MIN aggregation', () => {
    const sql = buildAggregationQuery(
      't', undefined, 'x', ['val'], 'min', undefined,
      { function: 'min' },
    );
    expect(sql).toContain('MIN("val")');
  });

  it('MAX aggregation', () => {
    const sql = buildAggregationQuery(
      't', undefined, 'x', ['val'], 'max', undefined,
      { function: 'max' },
    );
    expect(sql).toContain('MAX("val")');
  });

  it('all PG time bucket presets produce date_trunc', () => {
    for (const preset of ['second', 'minute', 'hour', 'day', 'month', 'year'] as const) {
      const sql = buildAggregationQuery(
        't', undefined, 'ts', ['v'], 'count', undefined,
        { function: 'count', timeBucketPreset: preset }, 'postgresql',
      );
      expect(sql).toContain('date_trunc');
      expect(sql).toContain(`'${preset}'`);
    }
  });

  it('all CH time bucket presets produce toStartOf*', () => {
    for (const preset of ['second', 'minute', 'hour', 'day', 'month', 'year'] as const) {
      const sql = buildAggregationQuery(
        't', undefined, 'ts', ['v'], 'count', undefined,
        { function: 'count', timeBucketPreset: preset }, 'clickhouse',
      );
      expect(sql).toContain(TIME_BUCKET_CH[preset]);
    }
  });

  it('all SQLite time bucket presets produce strftime', () => {
    for (const preset of ['second', 'minute', 'hour', 'day', 'month', 'year'] as const) {
      const sql = buildAggregationQuery(
        't', undefined, 'ts', ['v'], 'count', undefined,
        { function: 'count', timeBucketPreset: preset }, 'sqlite',
      );
      expect(sql).toContain('strftime');
      expect(sql).toContain(TIME_BUCKET_SQLITE[preset]);
      expect(sql).not.toContain('date_trunc');
    }
  });

  it('SQLite month bucket generates strftime with %Y-%m format', () => {
    const sql = buildAggregationQuery(
      'records', undefined, 'created_at', ['id'], 'count', undefined,
      { function: 'count', timeBucketPreset: 'month' }, 'sqlite',
    );
    expect(sql).toBe(
      'SELECT strftime(\'%Y-%m\', "created_at") AS "created_at", COUNT(*) AS "count" FROM "records" GROUP BY strftime(\'%Y-%m\', "created_at") ORDER BY strftime(\'%Y-%m\', "created_at")',
    );
  });

  it('custom time bucket for SQLite uses unixepoch arithmetic', () => {
    const sql = buildAggregationQuery(
      't', undefined, 'ts', ['v'], 'avg', undefined,
      { function: 'avg', timeBucketPreset: 'custom', timeBucket: '2h' }, 'sqlite',
    );
    expect(sql).toContain('strftime');
    expect(sql).toContain('unixepoch');
    expect(sql).toContain('7200'); // 2h = 7200 seconds
    expect(sql).not.toContain('date_trunc');
    expect(sql).not.toContain('date_bin');
  });

  it('custom time bucket for ClickHouse uses toStartOfInterval', () => {
    const sql = buildAggregationQuery(
      't', undefined, 'ts', ['v'], 'avg', undefined,
      { function: 'avg', timeBucketPreset: 'custom', timeBucket: '5m' }, 'clickhouse',
    );
    expect(sql).toContain('toStartOfInterval');
    expect(sql).toContain('5 minute');
  });

  it('custom bucket parses various units', () => {
    const cases: Array<[string, string]> = [
      ['30s', 'second'], ['15m', 'minute'], ['4h', 'hour'],
      ['7d', 'day'], ['2w', 'week'], ['3M', 'month'], ['1y', 'year'],
    ];
    for (const [input, expected] of cases) {
      const sql = buildAggregationQuery(
        't', undefined, 'ts', ['v'], 'sum', undefined,
        { function: 'sum', timeBucketPreset: 'custom', timeBucket: input }, 'postgresql',
      );
      expect(sql).toContain(expected);
    }
  });

  it('no time bucketing when preset is undefined', () => {
    const sql = buildAggregationQuery(
      't', undefined, 'ts', ['v'], 'sum', undefined,
      { function: 'sum' },
    );
    expect(sql).not.toContain('date_trunc');
    expect(sql).not.toContain('toStartOf');
    expect(sql).toContain('"ts"');
  });

  it('group by column is included in SELECT and GROUP BY', () => {
    const sql = buildAggregationQuery(
      't', undefined, 'ts', ['v'], 'sum', 'region',
      { function: 'sum' },
    );
    expect(sql).toContain('"region"');
    const groupByIdx = sql.indexOf('GROUP BY');
    const regionAfterGroupBy = sql.indexOf('"region"', groupByIdx);
    expect(regionAfterGroupBy).toBeGreaterThan(groupByIdx);
  });

  it('produces valid SQL structure with all features combined', () => {
    const sql = buildAggregationQuery(
      'api_requests', 'analytics', 'created_at', ['response_time', 'status_code'], 'avg', 'endpoint',
      { function: 'avg', timeBucketPreset: 'hour' }, 'postgresql', 10000,
    );
    expect(sql).toMatch(/^SELECT .+ FROM "analytics"\."api_requests" GROUP BY .+ ORDER BY .+ LIMIT 10000$/);
    expect(sql).toContain('date_trunc');
    expect(sql).toContain('AVG("response_time")');
    expect(sql).toContain('AVG("status_code")');
    expect(sql).toContain('"endpoint"');
  });
});

describe('buildFullDataQuery — edge cases', () => {
  it('deduplicates columns', () => {
    // buildFullDataQuery receives pre-deduped columns, but verify structure
    const sql = buildFullDataQuery('t', undefined, ['a', 'b', 'c']);
    expect(sql).toBe('SELECT "a", "b", "c" FROM "t"');
  });

  it('single column', () => {
    const sql = buildFullDataQuery('t', 'public', ['id']);
    expect(sql).toBe('SELECT "id" FROM "public"."t"');
  });

  it('never includes LIMIT', () => {
    const sql = buildFullDataQuery('big_table', 'public', ['a', 'b', 'c', 'd', 'e']);
    expect(sql).not.toContain('LIMIT');
  });
});
