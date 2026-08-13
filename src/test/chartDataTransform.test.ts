import { describe, it, expect } from 'vitest';
import { buildEChartsOption, buildMultiSourceEChartsOption, joinByColumn, suggestChartConfig, isTimeColumn, isNumericColumn, adaptConfigToColumns } from '../chart/chartDataTransform';
import { QueryResult, QueryColumn } from '../types/query';
import { ChartConfig, EChartsChartType } from '../types/chart';

function makeResult(columns: QueryColumn[], rows: Record<string, unknown>[]): QueryResult {
  return { columns, rows, rowCount: rows.length, executionTimeMs: 0 };
}

// ============================================================
// isTimeColumn
// ============================================================

describe('isTimeColumn', () => {
  it('detects timestamp types', () => {
    expect(isTimeColumn({ name: 'ts', dataType: 'timestamp' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'timestamptz' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'timestamp with time zone' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'timestamp without time zone' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'DateTime64(3)' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'DateTime' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'date' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'datetime' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'datetime64' })).toBe(true);
  });

  it('rejects non-time types', () => {
    expect(isTimeColumn({ name: 'id', dataType: 'integer' })).toBe(false);
    expect(isTimeColumn({ name: 'name', dataType: 'text' })).toBe(false);
    expect(isTimeColumn({ name: 'flag', dataType: 'boolean' })).toBe(false);
    expect(isTimeColumn({ name: 'data', dataType: 'jsonb' })).toBe(false);
    expect(isTimeColumn({ name: 'uuid', dataType: 'uuid' })).toBe(false);
  });
});

// ============================================================
// isNumericColumn
// ============================================================

describe('isNumericColumn', () => {
  it('detects PostgreSQL numeric types', () => {
    expect(isNumericColumn({ name: 'id', dataType: 'integer' })).toBe(true);
    expect(isNumericColumn({ name: 'val', dataType: 'bigint' })).toBe(true);
    expect(isNumericColumn({ name: 'val', dataType: 'smallint' })).toBe(true);
    expect(isNumericColumn({ name: 'price', dataType: 'numeric(10,2)' })).toBe(true);
    expect(isNumericColumn({ name: 'score', dataType: 'float8' })).toBe(true);
    expect(isNumericColumn({ name: 'val', dataType: 'real' })).toBe(true);
    expect(isNumericColumn({ name: 'val', dataType: 'double precision' })).toBe(true);
    expect(isNumericColumn({ name: 'val', dataType: 'serial' })).toBe(true);
    expect(isNumericColumn({ name: 'val', dataType: 'bigserial' })).toBe(true);
    expect(isNumericColumn({ name: 'val', dataType: 'money' })).toBe(true);
    expect(isNumericColumn({ name: 'val', dataType: 'decimal' })).toBe(true);
  });

  it('detects ClickHouse numeric types', () => {
    expect(isNumericColumn({ name: 'cnt', dataType: 'Int64' })).toBe(true);
    expect(isNumericColumn({ name: 'val', dataType: 'UInt32' })).toBe(true);
    expect(isNumericColumn({ name: 'val', dataType: 'Float64' })).toBe(true);
    expect(isNumericColumn({ name: 'val', dataType: 'Int8' })).toBe(true);
  });

  it('rejects non-numeric types', () => {
    expect(isNumericColumn({ name: 'name', dataType: 'text' })).toBe(false);
    expect(isNumericColumn({ name: 'ts', dataType: 'timestamp' })).toBe(false);
    expect(isNumericColumn({ name: 'flag', dataType: 'boolean' })).toBe(false);
    expect(isNumericColumn({ name: 'data', dataType: 'jsonb' })).toBe(false);
    expect(isNumericColumn({ name: 'val', dataType: 'varchar(255)' })).toBe(false);
    expect(isNumericColumn({ name: 'val', dataType: 'bytea' })).toBe(false);
  });
});

// ============================================================
// suggestChartConfig
// ============================================================

describe('suggestChartConfig', () => {
  it('suggests line chart for timeseries data', () => {
    const result = makeResult(
      [{ name: 'ts', dataType: 'timestamp' }, { name: 'value', dataType: 'float8' }],
      [{ ts: '2024-01-01', value: 10 }],
    );
    const config = suggestChartConfig(result);
    expect(config.chartType).toBe('line');
    expect(config.axis?.xColumn).toBe('ts');
    expect(config.axis?.yColumns).toEqual(['value']);
  });

  it('includes group by when string column present with timeseries', () => {
    const result = makeResult(
      [
        { name: 'ts', dataType: 'timestamp' },
        { name: 'region', dataType: 'text' },
        { name: 'value', dataType: 'float8' },
      ],
      [{ ts: '2024-01-01', region: 'US', value: 10 }],
    );
    const config = suggestChartConfig(result);
    expect(config.chartType).toBe('line');
    expect(config.axis?.groupByColumn).toBe('region');
  });

  it('limits Y columns to 3 for timeseries', () => {
    const result = makeResult(
      [
        { name: 'ts', dataType: 'timestamp' },
        { name: 'a', dataType: 'integer' },
        { name: 'b', dataType: 'integer' },
        { name: 'c', dataType: 'integer' },
        { name: 'd', dataType: 'integer' },
      ],
      [{ ts: '2024-01-01', a: 1, b: 2, c: 3, d: 4 }],
    );
    const config = suggestChartConfig(result);
    expect(config.axis?.yColumns).toHaveLength(3);
  });

  it('suggests pie chart for small categorical data', () => {
    const result = makeResult(
      [{ name: 'category', dataType: 'text' }, { name: 'count', dataType: 'integer' }],
      [{ category: 'A', count: 10 }, { category: 'B', count: 20 }],
    );
    const config = suggestChartConfig(result);
    expect(config.chartType).toBe('pie');
    expect(config.category?.nameColumn).toBe('category');
    expect(config.category?.valueColumn).toBe('count');
  });

  it('does not suggest pie for large datasets (>30 rows)', () => {
    const rows = Array.from({ length: 31 }, (_, idx) => ({ cat: `C${idx}`, val: idx }));
    const result = makeResult(
      [{ name: 'cat', dataType: 'text' }, { name: 'val', dataType: 'integer' }],
      rows,
    );
    const config = suggestChartConfig(result);
    expect(config.chartType).toBe('bar');
  });

  it('suggests bar chart as fallback for numeric-only data', () => {
    const result = makeResult(
      [{ name: 'id', dataType: 'integer' }, { name: 'value', dataType: 'integer' }],
      [{ id: 1, value: 100 }],
    );
    const config = suggestChartConfig(result);
    expect(config.chartType).toBe('bar');
  });

  it('returns bar for empty columns', () => {
    const result = makeResult([], []);
    const config = suggestChartConfig(result);
    expect(config.chartType).toBe('bar');
  });
});

// ============================================================
// buildEChartsOption — all chart types
// ============================================================

describe('buildEChartsOption', () => {
  // -- Axis charts --

  it('builds a line chart with time axis', () => {
    const result = makeResult(
      [{ name: 'ts', dataType: 'timestamp' }, { name: 'value', dataType: 'float8' }],
      [
        { ts: '2024-01-01T00:00:00Z', value: 10 },
        { ts: '2024-01-02T00:00:00Z', value: 20 },
      ],
    );
    const option = buildEChartsOption(result, {
      chartType: 'line', axis: { xColumn: 'ts', yColumns: ['value'] }, aggregation: { function: 'none' },
    });
    expect(option.series).toBeDefined();
    expect((option.series as unknown[]).length).toBe(1);
    expect((option.xAxis as Record<string, unknown>).type).toBe('time');
    expect(option.dataZoom).toBeDefined();
  });

  it('builds a line chart with category axis', () => {
    const result = makeResult(
      [{ name: 'name', dataType: 'text' }, { name: 'val', dataType: 'integer' }],
      [{ name: 'A', val: 1 }, { name: 'B', val: 2 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'line', axis: { xColumn: 'name', yColumns: ['val'] }, aggregation: { function: 'none' },
    });
    expect((option.xAxis as Record<string, unknown>).type).toBe('category');
  });

  it('builds a bar chart', () => {
    const result = makeResult(
      [{ name: 'name', dataType: 'text' }, { name: 'count', dataType: 'integer' }],
      [{ name: 'Alice', count: 5 }, { name: 'Bob', count: 8 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'bar', axis: { xColumn: 'name', yColumns: ['count'] }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].type).toBe('bar');
  });

  it('builds a scatter chart', () => {
    const result = makeResult(
      [{ name: 'x', dataType: 'float8' }, { name: 'y', dataType: 'float8' }],
      [{ x: 1.5, y: 2.5 }, { x: 3.0, y: 4.0 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'scatter', axis: { xColumn: 'x', yColumns: ['y'] }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].type).toBe('scatter');
  });

  it('builds multiple Y series for axis charts', () => {
    const result = makeResult(
      [{ name: 'ts', dataType: 'date' }, { name: 'a', dataType: 'integer' }, { name: 'b', dataType: 'integer' }],
      [{ ts: '2024-01-01', a: 10, b: 20 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'line', axis: { xColumn: 'ts', yColumns: ['a', 'b'] }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series.length).toBe(2);
  });

  it('handles area fill for line charts', () => {
    const result = makeResult(
      [{ name: 'ts', dataType: 'timestamp' }, { name: 'val', dataType: 'integer' }],
      [{ ts: '2024-01-01', val: 10 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'line', axis: { xColumn: 'ts', yColumns: ['val'] }, aggregation: { function: 'none' }, areaFill: true,
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].areaStyle).toBeDefined();
  });

  it('does not add areaStyle for non-line charts', () => {
    const result = makeResult(
      [{ name: 'x', dataType: 'text' }, { name: 'y', dataType: 'integer' }],
      [{ x: 'A', y: 10 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'bar', axis: { xColumn: 'x', yColumns: ['y'] }, aggregation: { function: 'none' }, areaFill: true,
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].areaStyle).toBeUndefined();
  });

  it('supports group by for axis charts', () => {
    const result = makeResult(
      [{ name: 'date', dataType: 'date' }, { name: 'region', dataType: 'text' }, { name: 'sales', dataType: 'integer' }],
      [
        { date: '2024-01-01', region: 'US', sales: 100 },
        { date: '2024-01-01', region: 'EU', sales: 80 },
        { date: '2024-01-02', region: 'US', sales: 120 },
        { date: '2024-01-02', region: 'EU', sales: 90 },
      ],
    );
    const option = buildEChartsOption(result, {
      chartType: 'line', axis: { xColumn: 'date', yColumns: ['sales'], groupByColumn: 'region' }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series.length).toBe(2);
  });

  it('adds legend when multiple series exist', () => {
    const result = makeResult(
      [{ name: 'x', dataType: 'text' }, { name: 'a', dataType: 'integer' }, { name: 'b', dataType: 'integer' }],
      [{ x: 'A', a: 1, b: 2 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'bar', axis: { xColumn: 'x', yColumns: ['a', 'b'] }, aggregation: { function: 'none' },
    });
    expect(option.legend).toBeDefined();
  });

  it('adds title when specified', () => {
    const result = makeResult([{ name: 'x', dataType: 'text' }, { name: 'y', dataType: 'integer' }], [{ x: 'A', y: 1 }]);
    const option = buildEChartsOption(result, {
      chartType: 'bar', axis: { xColumn: 'x', yColumns: ['y'] }, aggregation: { function: 'none' }, title: 'My Chart',
    });
    expect((option.title as Record<string, unknown>).text).toBe('My Chart');
  });

  it('returns error message when axis mapping is missing', () => {
    const result = makeResult([{ name: 'x', dataType: 'text' }], [{ x: 'A' }]);
    const option = buildEChartsOption(result, { chartType: 'line', aggregation: { function: 'none' } });
    expect((option.title as Record<string, unknown>).text).toContain('No axis mapping');
  });

  // -- Category charts --

  it('builds a pie chart with donut hole', () => {
    const result = makeResult(
      [{ name: 'lang', dataType: 'text' }, { name: 'count', dataType: 'integer' }],
      [{ lang: 'JS', count: 100 }, { lang: 'Python', count: 80 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'pie', category: { nameColumn: 'lang', valueColumn: 'count' }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].type).toBe('pie');
    expect(series[0].radius).toBeDefined();
    expect((series[0].data as unknown[]).length).toBe(2);
  });

  it('builds a funnel chart', () => {
    const result = makeResult(
      [{ name: 'stage', dataType: 'text' }, { name: 'count', dataType: 'integer' }],
      [{ stage: 'Visit', count: 1000 }, { stage: 'Lead', count: 300 }, { stage: 'Sale', count: 50 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'funnel', category: { nameColumn: 'stage', valueColumn: 'count' }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].type).toBe('funnel');
  });

  it('builds a treemap chart', () => {
    const result = makeResult(
      [{ name: 'name', dataType: 'text' }, { name: 'size', dataType: 'integer' }],
      [{ name: 'A', size: 50 }, { name: 'B', size: 30 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'treemap', category: { nameColumn: 'name', valueColumn: 'size' }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].type).toBe('treemap');
  });

  it('builds a sunburst chart', () => {
    const result = makeResult(
      [{ name: 'name', dataType: 'text' }, { name: 'value', dataType: 'integer' }],
      [{ name: 'Root', value: 100 }, { name: 'Child', value: 50 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'sunburst', category: { nameColumn: 'name', valueColumn: 'value' }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].type).toBe('sunburst');
  });

  it('returns error when category mapping is missing', () => {
    const result = makeResult([{ name: 'x', dataType: 'text' }], [{ x: 'A' }]);
    const option = buildEChartsOption(result, { chartType: 'pie', aggregation: { function: 'none' } });
    expect((option.title as Record<string, unknown>).text).toContain('No category mapping');
  });

  // -- Gauge --

  it('builds a gauge chart with avg aggregation', () => {
    const result = makeResult(
      [{ name: 'cpu', dataType: 'float8' }],
      [{ cpu: 75.5 }, { cpu: 80.2 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'gauge', gauge: { valueColumn: 'cpu', minValue: 0, maxValue: 100 }, aggregation: { function: 'avg' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].type).toBe('gauge');
    const gaugeData = (series[0].data as Array<Record<string, unknown>>)[0];
    expect(gaugeData.value).toBeCloseTo(77.85, 1);
  });

  it('gauge respects min/max', () => {
    const result = makeResult([{ name: 'v', dataType: 'integer' }], [{ v: 50 }]);
    const option = buildEChartsOption(result, {
      chartType: 'gauge', gauge: { valueColumn: 'v', minValue: 10, maxValue: 200 }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].min).toBe(10);
    expect(series[0].max).toBe(200);
  });

  it('gauge auto-calculates max when not specified', () => {
    const result = makeResult([{ name: 'v', dataType: 'integer' }], [{ v: 50 }]);
    const option = buildEChartsOption(result, {
      chartType: 'gauge', gauge: { valueColumn: 'v' }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].max).toBeGreaterThanOrEqual(50);
  });

  // -- Boxplot --

  it('builds a boxplot with groups', () => {
    const result = makeResult(
      [{ name: 'group', dataType: 'text' }, { name: 'value', dataType: 'float8' }],
      [
        { group: 'A', value: 1 }, { group: 'A', value: 2 }, { group: 'A', value: 3 }, { group: 'A', value: 4 }, { group: 'A', value: 5 },
        { group: 'B', value: 10 }, { group: 'B', value: 20 }, { group: 'B', value: 30 },
      ],
    );
    const option = buildEChartsOption(result, {
      chartType: 'boxplot', stat: { valueColumn: 'value', groupByColumn: 'group' }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].type).toBe('boxplot');
    expect((series[0].data as unknown[]).length).toBe(2);
    expect((option.xAxis as Record<string, unknown>).data).toEqual(['A', 'B']);
  });

  it('boxplot computes correct quartiles', () => {
    const result = makeResult(
      [{ name: 'g', dataType: 'text' }, { name: 'v', dataType: 'float8' }],
      [{ g: 'X', v: 1 }, { g: 'X', v: 2 }, { g: 'X', v: 3 }, { g: 'X', v: 4 }, { g: 'X', v: 5 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'boxplot', stat: { valueColumn: 'v', groupByColumn: 'g' }, aggregation: { function: 'none' },
    });
    const boxData = ((option.series as Array<Record<string, unknown>>)[0].data as number[][])[0];
    expect(boxData[0]).toBe(1);  // min
    expect(boxData[2]).toBe(3);  // median
    expect(boxData[4]).toBe(5);  // max
  });

  // -- Radar --

  it('builds a radar chart', () => {
    const result = makeResult(
      [{ name: 'a', dataType: 'integer' }, { name: 'b', dataType: 'integer' }, { name: 'c', dataType: 'integer' }],
      [{ a: 10, b: 20, c: 30 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'radar', radar: { indicatorColumns: ['a', 'b', 'c'] }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].type).toBe('radar');
    expect(option.radar).toBeDefined();
  });

  it('radar with group by produces multiple data entries', () => {
    const result = makeResult(
      [{ name: 'team', dataType: 'text' }, { name: 'speed', dataType: 'integer' }, { name: 'power', dataType: 'integer' }],
      [
        { team: 'A', speed: 80, power: 90 },
        { team: 'B', speed: 70, power: 85 },
      ],
    );
    const option = buildEChartsOption(result, {
      chartType: 'radar', radar: { indicatorColumns: ['speed', 'power'], groupByColumn: 'team' }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    const data = series[0].data as Array<Record<string, unknown>>;
    expect(data.length).toBe(2);
  });

  // -- Heatmap --

  it('builds a heatmap with groupBy', () => {
    const result = makeResult(
      [{ name: 'hour', dataType: 'text' }, { name: 'day', dataType: 'text' }, { name: 'count', dataType: 'integer' }],
      [
        { hour: '9', day: 'Mon', count: 5 },
        { hour: '10', day: 'Mon', count: 8 },
        { hour: '9', day: 'Tue', count: 3 },
      ],
    );
    const option = buildEChartsOption(result, {
      chartType: 'heatmap', axis: { xColumn: 'hour', yColumns: ['count'], groupByColumn: 'day' }, aggregation: { function: 'none' },
    });
    expect(option.visualMap).toBeDefined();
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].type).toBe('heatmap');
  });

  // -- Candlestick --

  it('builds a candlestick chart when OHLC columns exist', () => {
    const result = makeResult(
      [
        { name: 'ts', dataType: 'date' },
        { name: 'open', dataType: 'float8' },
        { name: 'close', dataType: 'float8' },
        { name: 'low', dataType: 'float8' },
        { name: 'high', dataType: 'float8' },
      ],
      [{ ts: '2024-01-01', open: 100, close: 110, low: 95, high: 115 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'candlestick', stat: { valueColumn: 'open' }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0].type).toBe('candlestick');
  });

  it('candlestick shows error when OHLC columns missing', () => {
    const result = makeResult(
      [{ name: 'x', dataType: 'integer' }, { name: 'y', dataType: 'integer' }],
      [{ x: 1, y: 2 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'candlestick', stat: { valueColumn: 'x' }, aggregation: { function: 'none' },
    });
    expect((option.title as Record<string, unknown>).text).toContain('open, close, low, high');
  });

  // -- Edge cases --

  it('handles empty rows gracefully', () => {
    const result = makeResult(
      [{ name: 'x', dataType: 'text' }, { name: 'y', dataType: 'integer' }],
      [],
    );
    // Should not throw
    const option = buildEChartsOption(result, {
      chartType: 'bar', axis: { xColumn: 'x', yColumns: ['y'] }, aggregation: { function: 'none' },
    });
    expect(option).toBeDefined();
    expect(option.series).toBeDefined();
  });

  it('handles null values in rows', () => {
    const result = makeResult(
      [{ name: 'x', dataType: 'text' }, { name: 'y', dataType: 'integer' }],
      [{ x: 'A', y: null }, { x: 'B', y: 10 }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'bar', axis: { xColumn: 'x', yColumns: ['y'] }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    const data = series[0].data as Array<unknown[]>;
    expect(data[0][1]).toBe(0); // null → 0
    expect(data[1][1]).toBe(10);
  });

  it('handles string numeric values', () => {
    const result = makeResult(
      [{ name: 'x', dataType: 'text' }, { name: 'y', dataType: 'integer' }],
      [{ x: 'A', y: '42' }],
    );
    const option = buildEChartsOption(result, {
      chartType: 'bar', axis: { xColumn: 'x', yColumns: ['y'] }, aggregation: { function: 'none' },
    });
    const series = option.series as Array<Record<string, unknown>>;
    const data = series[0].data as Array<unknown[]>;
    expect(data[0][1]).toBe(42);
  });

  it('returns unsupported message for unknown chart type', () => {
    const result = makeResult([{ name: 'x', dataType: 'text' }], [{ x: 'A' }]);
    const option = buildEChartsOption(result, {
      chartType: 'unknown' as EChartsChartType, aggregation: { function: 'none' },
    });
    expect((option.title as Record<string, unknown>).text).toContain('Unsupported');
  });
});

// ============================================================
// joinByColumn
// ============================================================

describe('joinByColumn', () => {
  it('joins two row sets by matching key columns', () => {
    const primary = [
      { date: '2024-01-01', value: 10 },
      { date: '2024-01-02', value: 20 },
      { date: '2024-01-03', value: 30 },
    ];
    const additional = [
      { ts: '2024-01-01', extra: 100 },
      { ts: '2024-01-02', extra: 200 },
    ];
    const result = joinByColumn(primary, additional, 'date', 'ts');
    expect(result).toHaveLength(3);
    expect(result[0].extra).toBe(100);
    expect(result[1].extra).toBe(200);
    expect(result[2].extra).toBeUndefined();
  });

  it('handles no matches gracefully', () => {
    const primary = [{ id: 'a', val: 1 }];
    const additional = [{ id: 'b', other: 2 }];
    const result = joinByColumn(primary, additional, 'id', 'id');
    expect(result).toHaveLength(1);
    expect(result[0].other).toBeUndefined();
  });

  it('preserves all primary columns', () => {
    const primary = [{ key: 'x', col1: 1, col2: 2 }];
    const additional = [{ key: 'x', col3: 3 }];
    const result = joinByColumn(primary, additional, 'key', 'key');
    expect(result[0].col1).toBe(1);
    expect(result[0].col2).toBe(2);
    expect(result[0].col3).toBe(3);
  });

  it('last wins for duplicate keys in additional', () => {
    const primary = [{ id: '1', val: 'a' }];
    const additional = [{ id: '1', extra: 'first' }, { id: '1', extra: 'second' }];
    const result = joinByColumn(primary, additional, 'id', 'id');
    expect(result[0].extra).toBe('second');
  });

  it('handles empty primary', () => {
    const result = joinByColumn([], [{ id: '1', val: 1 }], 'id', 'id');
    expect(result).toHaveLength(0);
  });

  it('handles empty additional', () => {
    const primary = [{ id: '1', val: 1 }];
    const result = joinByColumn(primary, [], 'id', 'id');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: '1', val: 1 });
  });

  it('handles null key values', () => {
    const primary = [{ id: null, val: 1 }];
    const additional = [{ id: null, extra: 2 }];
    const result = joinByColumn(primary, additional, 'id', 'id');
    // Both null → stringified as '' → should match
    expect(result[0].extra).toBe(2);
  });

  it('handles numeric key matching', () => {
    const primary = [{ id: 1, val: 'a' }, { id: 2, val: 'b' }];
    const additional = [{ num: 1, extra: 'x' }, { num: 2, extra: 'y' }];
    const result = joinByColumn(primary, additional, 'id', 'num');
    expect(result[0].extra).toBe('x');
    expect(result[1].extra).toBe('y');
  });
});

// ============================================================
// buildMultiSourceEChartsOption
// ============================================================

describe('buildMultiSourceEChartsOption', () => {
  it('adds separate series from additional source', () => {
    const primary = makeResult(
      [{ name: 'ts', dataType: 'timestamp' }, { name: 'cpu', dataType: 'float8' }],
      [{ ts: '2024-01-01', cpu: 50 }, { ts: '2024-01-02', cpu: 60 }],
    );
    const config: ChartConfig = {
      chartType: 'line', axis: { xColumn: 'ts', yColumns: ['cpu'] }, aggregation: { function: 'none' },
    };
    const additional = [{
      source: { id: '1', label: 'Memory', yColumns: ['mem'], mergeMode: 'separate' as const },
      columns: [{ name: 'ts', dataType: 'timestamp' }, { name: 'mem', dataType: 'float8' }],
      rows: [{ ts: '2024-01-01', mem: 70 }, { ts: '2024-01-02', mem: 80 }],
    }];
    const option = buildMultiSourceEChartsOption(primary, additional, config);
    const series = option.series as Array<Record<string, unknown>>;
    expect(series).toHaveLength(2);
    expect(series[0].name).toBe('cpu');
    expect(series[1].name).toBe('Memory: mem');
  });

  it('joins additional source by column', () => {
    const primary = makeResult(
      [{ name: 'date', dataType: 'date' }, { name: 'sales', dataType: 'integer' }],
      [{ date: '2024-01-01', sales: 100 }, { date: '2024-01-02', sales: 200 }],
    );
    const config: ChartConfig = {
      chartType: 'bar', axis: { xColumn: 'date', yColumns: ['sales'] }, aggregation: { function: 'none' },
    };
    const additional = [{
      source: { id: '2', label: 'Returns', yColumns: ['returns'], mergeMode: 'join' as const, joinColumn: 'dt' },
      columns: [{ name: 'dt', dataType: 'date' }, { name: 'returns', dataType: 'integer' }],
      rows: [{ dt: '2024-01-01', returns: 5 }, { dt: '2024-01-02', returns: 10 }],
    }];
    const option = buildMultiSourceEChartsOption(primary, additional, config);
    const series = option.series as Array<Record<string, unknown>>;
    expect(series).toHaveLength(2);
    expect(series[1].name).toBe('Returns: returns');
    const joinedData = series[1].data as Array<unknown[]>;
    expect(joinedData[0][1]).toBe(5);
    expect(joinedData[1][1]).toBe(10);
  });

  it('returns normal option when no additional sources', () => {
    const primary = makeResult(
      [{ name: 'x', dataType: 'integer' }, { name: 'y', dataType: 'integer' }],
      [{ x: 1, y: 2 }],
    );
    const config: ChartConfig = {
      chartType: 'bar', axis: { xColumn: 'x', yColumns: ['y'] }, aggregation: { function: 'none' },
    };
    const option = buildMultiSourceEChartsOption(primary, [], config);
    const series = option.series as Array<Record<string, unknown>>;
    expect(series).toHaveLength(1);
  });

  it('handles multiple additional sources', () => {
    const primary = makeResult(
      [{ name: 'ts', dataType: 'date' }, { name: 'a', dataType: 'integer' }],
      [{ ts: '2024-01-01', a: 1 }],
    );
    const config: ChartConfig = {
      chartType: 'line', axis: { xColumn: 'ts', yColumns: ['a'] }, aggregation: { function: 'none' },
    };
    const sources = [
      {
        source: { id: '1', label: 'B', yColumns: ['b'], mergeMode: 'separate' as const },
        columns: [{ name: 'ts', dataType: 'date' }, { name: 'b', dataType: 'integer' }],
        rows: [{ ts: '2024-01-01', b: 2 }],
      },
      {
        source: { id: '2', label: 'C', yColumns: ['c'], mergeMode: 'separate' as const },
        columns: [{ name: 'ts', dataType: 'date' }, { name: 'c', dataType: 'integer' }],
        rows: [{ ts: '2024-01-01', c: 3 }],
      },
    ];
    const option = buildMultiSourceEChartsOption(primary, sources, config);
    const series = option.series as Array<Record<string, unknown>>;
    expect(series).toHaveLength(3);
    expect(series[1].name).toBe('B: b');
    expect(series[2].name).toBe('C: c');
  });

  it('adds legend when multiple series from sources', () => {
    const primary = makeResult(
      [{ name: 'x', dataType: 'text' }, { name: 'y', dataType: 'integer' }],
      [{ x: 'A', y: 1 }],
    );
    const config: ChartConfig = {
      chartType: 'bar', axis: { xColumn: 'x', yColumns: ['y'] }, aggregation: { function: 'none' },
    };
    const additional = [{
      source: { id: '1', label: 'Extra', yColumns: ['z'], mergeMode: 'separate' as const },
      columns: [{ name: 'x', dataType: 'text' }, { name: 'z', dataType: 'integer' }],
      rows: [{ x: 'A', z: 2 }],
    }];
    const option = buildMultiSourceEChartsOption(primary, additional, config);
    expect(option.legend).toBeDefined();
  });

  it('skips sources with empty yColumns', () => {
    const primary = makeResult(
      [{ name: 'x', dataType: 'text' }, { name: 'y', dataType: 'integer' }],
      [{ x: 'A', y: 1 }],
    );
    const config: ChartConfig = {
      chartType: 'bar', axis: { xColumn: 'x', yColumns: ['y'] }, aggregation: { function: 'none' },
    };
    const additional = [{
      source: { id: '1', label: 'Empty', yColumns: [], mergeMode: 'separate' as const },
      columns: [{ name: 'x', dataType: 'text' }],
      rows: [{ x: 'A' }],
    }];
    const option = buildMultiSourceEChartsOption(primary, additional, config);
    const series = option.series as Array<Record<string, unknown>>;
    expect(series).toHaveLength(1);
  });

  it('falls back to primary option for non-axis charts', () => {
    const primary = makeResult(
      [{ name: 'name', dataType: 'text' }, { name: 'val', dataType: 'integer' }],
      [{ name: 'A', val: 1 }],
    );
    const config: ChartConfig = {
      chartType: 'pie', category: { nameColumn: 'name', valueColumn: 'val' }, aggregation: { function: 'none' },
    };
    const additional = [{
      source: { id: '1', label: 'X', yColumns: ['y'], mergeMode: 'separate' as const },
      columns: [{ name: 'y', dataType: 'integer' }],
      rows: [{ y: 2 }],
    }];
    const option = buildMultiSourceEChartsOption(primary, additional, config);
    const series = option.series as Array<Record<string, unknown>>;
    // Pie chart ignores additional sources
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('pie');
  });

  it('applies areaFill to additional source series', () => {
    const primary = makeResult(
      [{ name: 'ts', dataType: 'timestamp' }, { name: 'a', dataType: 'integer' }],
      [{ ts: '2024-01-01', a: 1 }],
    );
    const config: ChartConfig = {
      chartType: 'line', axis: { xColumn: 'ts', yColumns: ['a'] }, aggregation: { function: 'none' }, areaFill: true,
    };
    const additional = [{
      source: { id: '1', label: 'B', yColumns: ['b'], mergeMode: 'separate' as const },
      columns: [{ name: 'ts', dataType: 'timestamp' }, { name: 'b', dataType: 'integer' }],
      rows: [{ ts: '2024-01-01', b: 2 }],
    }];
    const option = buildMultiSourceEChartsOption(primary, additional, config);
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[1].areaStyle).toBeDefined();
  });
});

// ============================================================
// adaptConfigToColumns — handles aggregation column rename (regression: "Show full DB
// data" with COUNT by month produced empty chart because Y axis still pointed at the
// pre-aggregation column `id`, which the result didn't carry)
// ============================================================

describe('adaptConfigToColumns', () => {
  it('keeps config unchanged when every referenced column exists', () => {
    const config: ChartConfig = {
      chartType: 'bar',
      axis: { xColumn: 'created_at', yColumns: ['id'], groupByColumn: 'status' },
      aggregation: { function: 'none' },
    };
    const cols = [
      { name: 'created_at', dataType: 'timestamp' },
      { name: 'id', dataType: 'integer' },
      { name: 'status', dataType: 'text' },
    ];
    const adapted = adaptConfigToColumns(config, cols);
    expect(adapted.axis).toEqual({ xColumn: 'created_at', yColumns: ['id'], groupByColumn: 'status' });
  });

  it('replaces missing yColumns with available numeric columns (count-by-month case)', () => {
    // Regression: user opened the chart over `emails`, picked X=created_at, Y=id, then
    // hit "Show full DB data" with Function=count + TimeBucket=month. The aggregation
    // SQL renamed the value column to `count` — `id` was no longer present, so the
    // chart rendered empty Y series. Expectation: yColumns falls back to `count`.
    const preAggConfig: ChartConfig = {
      chartType: 'bar',
      axis: { xColumn: 'created_at', yColumns: ['id'] },
      aggregation: { function: 'count', timeBucketPreset: 'month' },
    };
    const aggResultCols = [
      { name: 'created_at', dataType: 'timestamp' },
      { name: 'count', dataType: 'bigint' },
    ];
    const adapted = adaptConfigToColumns(preAggConfig, aggResultCols);
    expect(adapted.axis?.xColumn).toBe('created_at');
    expect(adapted.axis?.yColumns).toEqual(['count']);
  });

  it('drops groupBy when the column is not in result', () => {
    const config: ChartConfig = {
      chartType: 'line',
      axis: { xColumn: 'ts', yColumns: ['v'], groupByColumn: 'region' },
      aggregation: { function: 'sum' },
    };
    const cols = [{ name: 'ts', dataType: 'timestamp' }, { name: 'v', dataType: 'real' }];
    const adapted = adaptConfigToColumns(config, cols);
    expect(adapted.axis?.groupByColumn).toBeUndefined();
  });

  it('falls back X axis to first time column when original X is gone', () => {
    const config: ChartConfig = {
      chartType: 'line',
      axis: { xColumn: 'old_ts', yColumns: ['v'] },
      aggregation: { function: 'avg' },
    };
    const cols = [{ name: 'bucket', dataType: 'timestamptz' }, { name: 'v', dataType: 'real' }];
    const adapted = adaptConfigToColumns(config, cols);
    expect(adapted.axis?.xColumn).toBe('bucket');
  });

  it('keeps a partial subset of yColumns that still exist', () => {
    const config: ChartConfig = {
      chartType: 'bar',
      axis: { xColumn: 'x', yColumns: ['a', 'gone', 'b'] },
      aggregation: { function: 'none' },
    };
    const cols = [
      { name: 'x', dataType: 'text' },
      { name: 'a', dataType: 'integer' },
      { name: 'b', dataType: 'integer' },
    ];
    const adapted = adaptConfigToColumns(config, cols);
    expect(adapted.axis?.yColumns).toEqual(['a', 'b']);
  });

  it('rewrites category/value columns when they are missing', () => {
    const config: ChartConfig = {
      chartType: 'pie',
      category: { nameColumn: 'gone_label', valueColumn: 'gone_value' },
      aggregation: { function: 'none' },
    };
    const cols = [
      { name: 'label', dataType: 'text' },
      { name: 'amount', dataType: 'numeric' },
    ];
    const adapted = adaptConfigToColumns(config, cols);
    expect(adapted.category?.nameColumn).toBe('label');
    expect(adapted.category?.valueColumn).toBe('amount');
  });

  it('rewrites gauge value column to first numeric when missing', () => {
    const config: ChartConfig = {
      chartType: 'gauge',
      gauge: { valueColumn: 'gone', minValue: 0, maxValue: 100 },
      aggregation: { function: 'none' },
    };
    const cols = [{ name: 'pct', dataType: 'real' }];
    const adapted = adaptConfigToColumns(config, cols);
    expect(adapted.gauge?.valueColumn).toBe('pct');
    expect(adapted.gauge?.minValue).toBe(0);
    expect(adapted.gauge?.maxValue).toBe(100);
  });

  it('does not mutate the input config', () => {
    const config: ChartConfig = {
      chartType: 'bar',
      axis: { xColumn: 'gone', yColumns: ['gone_y'] },
      aggregation: { function: 'count' },
    };
    const cols = [{ name: 'x', dataType: 'text' }, { name: 'y', dataType: 'integer' }];
    adaptConfigToColumns(config, cols);
    expect(config.axis?.xColumn).toBe('gone');
    expect(config.axis?.yColumns).toEqual(['gone_y']);
  });
});

// ============================================================
// buildEChartsOption + adaptConfigToColumns — count-by-month integration
// (drives the integration of the aggregation rename fix)
// ============================================================

describe('count-by-month aggregation rename — integration', () => {
  it('produces non-empty series after aggregation column rename', () => {
    const preAggConfig: ChartConfig = {
      chartType: 'bar',
      axis: { xColumn: 'created_at', yColumns: ['id'] },
      aggregation: { function: 'count', timeBucketPreset: 'month' },
    };
    const aggResult = makeResult(
      [{ name: 'created_at', dataType: 'timestamp' }, { name: 'count', dataType: 'bigint' }],
      [
        { created_at: '2024-01-01T00:00:00Z', count: 10 },
        { created_at: '2024-02-01T00:00:00Z', count: 22 },
        { created_at: '2024-03-01T00:00:00Z', count: 17 },
      ],
    );

    const adapted = adaptConfigToColumns(preAggConfig, aggResult.columns);
    const option = buildEChartsOption(aggResult, adapted);
    const series = option.series as Array<{ data: Array<[number, number]> }>;
    expect(series.length).toBeGreaterThan(0);
    const ys = series[0].data.map(d => d[1]);
    expect(ys).toEqual([10, 22, 17]);
  });

  it('without adaptConfigToColumns the same call produces NaN ys (proves the bug)', () => {
    // Regression sanity: the fix lives in the adapter, not buildEChartsOption.
    // Skipping the adapter MUST reproduce the empty-chart bug.
    const preAggConfig: ChartConfig = {
      chartType: 'bar',
      axis: { xColumn: 'created_at', yColumns: ['id'] },
      aggregation: { function: 'count', timeBucketPreset: 'month' },
    };
    const aggResult = makeResult(
      [{ name: 'created_at', dataType: 'timestamp' }, { name: 'count', dataType: 'bigint' }],
      [{ created_at: '2024-01-01T00:00:00Z', count: 10 }],
    );
    const option = buildEChartsOption(aggResult, preAggConfig);
    const series = option.series as Array<{ data: Array<[number, number]> }>;
    const ys = series[0].data.map(d => d[1]);
    expect(ys[0]).not.toBe(10);
  });
});
