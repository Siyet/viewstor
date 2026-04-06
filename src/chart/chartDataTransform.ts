/**
 * Pure functions that transform QueryResult + ChartConfig into ECharts option objects.
 * No vscode dependency — fully unit-testable.
 */

import { QueryResult, QueryColumn } from '../types/query';
import {
  ChartConfig,
  ChartDataSource,
  EChartsChartType,
  AggregationFunction,
} from '../types/chart';

/** A resolved additional data source with its cached result */
export interface ResolvedDataSource {
  source: ChartDataSource;
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
}

// ---- public API ----

export function buildEChartsOption(result: QueryResult, config: ChartConfig): Record<string, unknown> {
  const builder = OPTION_BUILDERS[config.chartType];
  if (!builder) {
    return { title: { text: `Unsupported chart type: ${config.chartType}` } };
  }
  return builder(result, config);
}

/**
 * Build ECharts option with additional data sources merged in.
 * Only works for axis-based charts (line, bar, scatter).
 * Each additional source adds extra series to the chart.
 */
export function buildMultiSourceEChartsOption(
  primaryResult: QueryResult,
  additionalSources: ResolvedDataSource[],
  config: ChartConfig,
): Record<string, unknown> {
  // Build the primary chart option first
  const option = buildEChartsOption(primaryResult, config);
  if (!config.axis || additionalSources.length === 0) return option;

  const primarySeries = (option.series || []) as Array<Record<string, unknown>>;
  const isTime = primaryResult.columns.some(
    col => col.name === config.axis!.xColumn && isTimeColumn(col),
  );

  for (const resolved of additionalSources) {
    const { source, rows } = resolved;
    if (source.yColumns.length === 0) continue;

    if (source.mergeMode === 'join' && source.joinColumn && config.axis) {
      // JOIN mode: merge rows by join column, add Y columns as new series
      const joinedRows = joinByColumn(primaryResult.rows, rows, config.axis.xColumn, source.joinColumn);
      for (const yCol of source.yColumns) {
        const data = joinedRows.map(row => {
          const xVal = isTime ? toTimestamp(row[config.axis!.xColumn]) : row[config.axis!.xColumn];
          return [xVal, toNumeric(row[yCol])];
        });
        if (isTime || config.chartType === 'line') {
          data.sort((a, b) => (a[0] as number) - (b[0] as number));
        }
        const seriesItem: Record<string, unknown> = {
          name: `${source.label}: ${yCol}`,
          type: config.chartType,
          data,
        };
        if (config.areaFill && config.chartType === 'line') {
          seriesItem.areaStyle = {};
        }
        primarySeries.push(seriesItem);
      }
    } else {
      // SEPARATE mode: add each Y column as an independent series from the source's own rows
      for (const yCol of source.yColumns) {
        // Try to find a matching X column in the source
        const sourceXCol = resolved.columns.find(col => col.name === config.axis!.xColumn);
        const xColName = sourceXCol ? config.axis.xColumn : resolved.columns[0]?.name || '';
        const sourceIsTime = resolved.columns.some(col => col.name === xColName && isTimeColumn(col));

        const data = rows.map(row => {
          const xVal = sourceIsTime ? toTimestamp(row[xColName]) : row[xColName];
          return [xVal, toNumeric(row[yCol])];
        });
        if (sourceIsTime || config.chartType === 'line') {
          data.sort((a, b) => (a[0] as number) - (b[0] as number));
        }
        const seriesItem: Record<string, unknown> = {
          name: `${source.label}: ${yCol}`,
          type: config.chartType,
          data,
        };
        if (config.areaFill && config.chartType === 'line') {
          seriesItem.areaStyle = {};
        }
        primarySeries.push(seriesItem);
      }
    }
  }

  option.series = primarySeries;

  // Ensure legend is shown when we have multiple series
  if (primarySeries.length > 1) {
    option.legend = { type: 'scroll', bottom: 0 };
    option.grid = { ...(option.grid as Record<string, unknown> || {}), bottom: '20%' };
  }

  return option;
}

/**
 * Join two row sets by matching a key column.
 * Returns primary rows enriched with columns from the additional rows.
 * If a primary row has no match, additional columns are null.
 */
export function joinByColumn(
  primaryRows: Record<string, unknown>[],
  additionalRows: Record<string, unknown>[],
  primaryKeyCol: string,
  additionalKeyCol: string,
): Record<string, unknown>[] {
  // Build a lookup from additional rows
  const lookup = new Map<string, Record<string, unknown>>();
  for (const row of additionalRows) {
    const key = String(row[additionalKeyCol] ?? '');
    // Last wins for duplicates
    lookup.set(key, row);
  }

  return primaryRows.map(primaryRow => {
    const key = String(primaryRow[primaryKeyCol] ?? '');
    const match = lookup.get(key);
    if (match) {
      return { ...primaryRow, ...match };
    }
    return primaryRow;
  });
}

/** Auto-detect the best initial config for a given result set */
export function suggestChartConfig(result: QueryResult): Partial<ChartConfig> {
  const cols = result.columns;
  if (cols.length === 0) return { chartType: 'bar' };

  const timeCols = cols.filter(isTimeColumn);
  const numCols = cols.filter(isNumericColumn);
  const strCols = cols.filter(col => !isTimeColumn(col) && !isNumericColumn(col));

  // Timeseries: has a time column + at least one numeric
  if (timeCols.length > 0 && numCols.length > 0) {
    return {
      chartType: 'line',
      axis: {
        xColumn: timeCols[0].name,
        yColumns: numCols.slice(0, 3).map(col => col.name),
        groupByColumn: strCols.length > 0 ? strCols[0].name : undefined,
      },
      aggregation: { function: 'none' },
    };
  }

  // Pie: one string + one numeric
  if (strCols.length >= 1 && numCols.length >= 1 && result.rows.length <= 30) {
    return {
      chartType: 'pie',
      category: { nameColumn: strCols[0].name, valueColumn: numCols[0].name },
      aggregation: { function: 'none' },
    };
  }

  // Bar chart fallback
  if (numCols.length >= 1) {
    const xCol = strCols.length > 0 ? strCols[0] : cols[0];
    const yCols = numCols.filter(col => col.name !== xCol.name);
    return {
      chartType: 'bar',
      axis: {
        xColumn: xCol.name,
        yColumns: yCols.length > 0 ? yCols.slice(0, 3).map(col => col.name) : [numCols[0].name],
      },
      aggregation: { function: 'none' },
    };
  }

  return { chartType: 'bar' };
}

// ---- time / type detection ----

const TIME_TYPES = new Set([
  'timestamp', 'timestamptz', 'timestamp without time zone', 'timestamp with time zone',
  'date', 'datetime', 'datetime64', 'DateTime', 'DateTime64',
]);

export function isTimeColumn(col: QueryColumn): boolean {
  const lower = col.dataType.toLowerCase();
  for (const tt of TIME_TYPES) {
    if (lower.startsWith(tt.toLowerCase())) return true;
  }
  return false;
}

export function isNumericColumn(col: QueryColumn): boolean {
  const lower = col.dataType.toLowerCase();
  return /^(int|integer|bigint|smallint|tinyint|float|double|real|numeric|decimal|number|serial|bigserial|money|uint|int\d|uint\d|float\d)/.test(lower);
}

// ---- aggregation helpers ----

function aggregate(values: number[], fn: AggregationFunction): number {
  if (values.length === 0) return 0;
  switch (fn) {
    case 'sum': return values.reduce((a, b) => a + b, 0);
    case 'avg': return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min': return Math.min(...values);
    case 'max': return Math.max(...values);
    case 'count': return values.length;
    case 'none': return values[values.length - 1];
  }
}

function toNumeric(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const parsed = Number(val);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function toTimestamp(val: unknown): number {
  if (val instanceof Date) return val.getTime();
  if (typeof val === 'number') {
    // Unix seconds vs milliseconds heuristic
    return val < 1e12 ? val * 1000 : val;
  }
  if (typeof val === 'string') {
    const ms = Date.parse(val);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

// ---- option builders per chart type ----

type OptionBuilder = (result: QueryResult, config: ChartConfig) => Record<string, unknown>;

function buildAxisOption(result: QueryResult, config: ChartConfig): Record<string, unknown> {
  const axis = config.axis;
  if (!axis) return { title: { text: 'No axis mapping configured' } };

  const isTime = result.columns.some(col => col.name === axis.xColumn && isTimeColumn(col));
  const groupBy = axis.groupByColumn;

  // Group rows
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of result.rows) {
    const key = groupBy ? String(row[groupBy] ?? '—') : '__all__';
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(row);
  }

  const series: Record<string, unknown>[] = [];
  for (const yCol of axis.yColumns) {
    for (const [groupKey, rows] of groups) {
      const data = rows.map(row => {
        const xVal = isTime ? toTimestamp(row[axis.xColumn]) : row[axis.xColumn];
        const yVal = toNumeric(row[yCol]);
        return [xVal, yVal];
      });

      // Sort by X for line/area
      if (isTime || config.chartType === 'line') {
        data.sort((a, b) => (a[0] as number) - (b[0] as number));
      }

      const seriesName = groupBy && groups.size > 1
        ? `${yCol} (${groupKey})`
        : axis.yColumns.length > 1 ? yCol : (groupBy ? groupKey : yCol);

      const seriesItem: Record<string, unknown> = {
        name: seriesName,
        type: config.chartType === 'heatmap' ? 'heatmap' : config.chartType,
        data,
      };

      if (config.areaFill && config.chartType === 'line') {
        seriesItem.areaStyle = {};
      }

      series.push(seriesItem);
    }
  }

  const option: Record<string, unknown> = {
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: isTime ? 'time' : 'category',
      ...(isTime ? {} : { data: [...new Set(result.rows.map(row => row[axis.xColumn]))] }),
    },
    yAxis: { type: 'value' },
    series,
    grid: { left: '10%', right: '5%', bottom: '15%', top: config.title ? '15%' : '10%' },
    dataZoom: [{ type: 'inside' }, { type: 'slider' }],
  };

  if (config.showLegend !== false && series.length > 1) {
    option.legend = { type: 'scroll', bottom: 0 };
    option.grid = { ...option.grid as Record<string, unknown>, bottom: '20%' };
  }
  if (config.title) {
    option.title = { text: config.title, left: 'center' };
  }

  return option;
}

function buildCategoryOption(result: QueryResult, config: ChartConfig): Record<string, unknown> {
  const cat = config.category;
  if (!cat) return { title: { text: 'No category mapping configured' } };

  const data = result.rows.map(row => ({
    name: String(row[cat.nameColumn] ?? ''),
    value: toNumeric(row[cat.valueColumn]),
  }));

  const seriesItem: Record<string, unknown> = {
    type: config.chartType,
    data,
  };

  if (config.chartType === 'pie') {
    seriesItem.radius = ['40%', '70%'];
    seriesItem.label = { show: true, formatter: '{b}: {d}%' };
  }
  if (config.chartType === 'funnel') {
    seriesItem.left = '10%';
    seriesItem.width = '80%';
  }

  const option: Record<string, unknown> = {
    tooltip: { trigger: 'item' },
    series: [seriesItem],
  };

  if (config.showLegend !== false) {
    option.legend = { type: 'scroll', orient: 'vertical', right: '5%', top: 'middle' };
  }
  if (config.title) {
    option.title = { text: config.title, left: 'center' };
  }

  return option;
}

function buildBoxplotOption(result: QueryResult, config: ChartConfig): Record<string, unknown> {
  const stat = config.stat;
  if (!stat) return { title: { text: 'No stat mapping configured' } };

  const groups = new Map<string, number[]>();
  for (const row of result.rows) {
    const key = stat.groupByColumn ? String(row[stat.groupByColumn] ?? '—') : 'all';
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(toNumeric(row[stat.valueColumn]));
  }

  const categories: string[] = [];
  const boxData: number[][] = [];
  for (const [key, values] of groups) {
    categories.push(key);
    values.sort((a, b) => a - b);
    const q1 = quantile(values, 0.25);
    const median = quantile(values, 0.5);
    const q3 = quantile(values, 0.75);
    boxData.push([values[0], q1, median, q3, values[values.length - 1]]);
  }

  return {
    tooltip: { trigger: 'item' },
    xAxis: { type: 'category', data: categories },
    yAxis: { type: 'value' },
    series: [{ type: 'boxplot', data: boxData }],
    ...(config.title ? { title: { text: config.title, left: 'center' } } : {}),
  };
}

function buildRadarOption(result: QueryResult, config: ChartConfig): Record<string, unknown> {
  const radarConf = config.radar;
  if (!radarConf) return { title: { text: 'No radar mapping configured' } };

  const indicators = radarConf.indicatorColumns.map(col => {
    const maxVal = Math.max(...result.rows.map(row => toNumeric(row[col])));
    return { name: col, max: maxVal || 100 };
  });

  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of result.rows) {
    const key = radarConf.groupByColumn ? String(row[radarConf.groupByColumn] ?? '—') : '__all__';
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(row);
  }

  const seriesData = [...groups.entries()].map(([key, rows]) => ({
    name: key === '__all__' ? 'Values' : key,
    value: radarConf.indicatorColumns.map(col =>
      rows.length === 1
        ? toNumeric(rows[0][col])
        : aggregate(rows.map(row => toNumeric(row[col])), config.aggregation.function || 'avg'),
    ),
  }));

  return {
    tooltip: {},
    radar: { indicator: indicators },
    series: [{ type: 'radar', data: seriesData }],
    ...(config.showLegend !== false ? { legend: { bottom: 0 } } : {}),
    ...(config.title ? { title: { text: config.title, left: 'center' } } : {}),
  };
}

function buildGaugeOption(result: QueryResult, config: ChartConfig): Record<string, unknown> {
  const gaugeConf = config.gauge;
  if (!gaugeConf) return { title: { text: 'No gauge mapping configured' } };

  const values = result.rows.map(row => toNumeric(row[gaugeConf.valueColumn]));
  const value = values.length > 0 ? aggregate(values, config.aggregation.function || 'avg') : 0;

  return {
    tooltip: { formatter: '{b}: {c}' },
    series: [{
      type: 'gauge',
      data: [{ value: Math.round(value * 100) / 100, name: gaugeConf.valueColumn }],
      min: gaugeConf.minValue ?? 0,
      max: gaugeConf.maxValue ?? Math.max(value * 1.5, 100),
    }],
    ...(config.title ? { title: { text: config.title, left: 'center' } } : {}),
  };
}

function buildCandlestickOption(result: QueryResult, config: ChartConfig): Record<string, unknown> {
  // Candlestick expects columns: open, close, low, high + optional time
  const stat = config.stat;
  if (!stat) return { title: { text: 'No stat mapping configured' } };

  // Try to find OHLC columns
  const colNames = result.columns.map(col => col.name.toLowerCase());
  const openIdx = colNames.findIndex(name => name.includes('open'));
  const closeIdx = colNames.findIndex(name => name.includes('close'));
  const lowIdx = colNames.findIndex(name => name.includes('low'));
  const highIdx = colNames.findIndex(name => name.includes('high'));

  if (openIdx === -1 || closeIdx === -1 || lowIdx === -1 || highIdx === -1) {
    return { title: { text: 'Candlestick requires columns: open, close, low, high' } };
  }

  const openCol = result.columns[openIdx].name;
  const closeCol = result.columns[closeIdx].name;
  const lowCol = result.columns[lowIdx].name;
  const highCol = result.columns[highIdx].name;

  const timeCol = result.columns.find(isTimeColumn);
  const categories = timeCol
    ? result.rows.map(row => String(row[timeCol.name]))
    : result.rows.map((_, idx) => String(idx));

  const data = result.rows.map(row => [
    toNumeric(row[openCol]),
    toNumeric(row[closeCol]),
    toNumeric(row[lowCol]),
    toNumeric(row[highCol]),
  ]);

  return {
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: categories },
    yAxis: { type: 'value' },
    series: [{ type: 'candlestick', data }],
    dataZoom: [{ type: 'inside' }, { type: 'slider' }],
    ...(config.title ? { title: { text: config.title, left: 'center' } } : {}),
  };
}

function buildTreemapOption(result: QueryResult, config: ChartConfig): Record<string, unknown> {
  const cat = config.category;
  if (!cat) return { title: { text: 'No category mapping configured' } };

  const data = result.rows.map(row => ({
    name: String(row[cat.nameColumn] ?? ''),
    value: toNumeric(row[cat.valueColumn]),
  }));

  return {
    tooltip: {},
    series: [{ type: 'treemap', data }],
    ...(config.title ? { title: { text: config.title, left: 'center' } } : {}),
  };
}

function buildSunburstOption(result: QueryResult, config: ChartConfig): Record<string, unknown> {
  const cat = config.category;
  if (!cat) return { title: { text: 'No category mapping configured' } };

  const data = result.rows.map(row => ({
    name: String(row[cat.nameColumn] ?? ''),
    value: toNumeric(row[cat.valueColumn]),
  }));

  return {
    tooltip: {},
    series: [{ type: 'sunburst', data, radius: ['20%', '90%'] }],
    ...(config.title ? { title: { text: config.title, left: 'center' } } : {}),
  };
}

function buildHeatmapOption(result: QueryResult, config: ChartConfig): Record<string, unknown> {
  const axis = config.axis;
  if (!axis || axis.yColumns.length === 0) return { title: { text: 'No axis mapping configured' } };

  const xValues = [...new Set(result.rows.map(row => String(row[axis.xColumn])))];
  const yCol = axis.yColumns[0];
  const groupBy = axis.groupByColumn;

  if (!groupBy) {
    // Without groupBy, use row index as Y
    const data = result.rows.map((row, idx) => [
      xValues.indexOf(String(row[axis.xColumn])),
      idx,
      toNumeric(row[yCol]),
    ]);
    return {
      tooltip: {},
      xAxis: { type: 'category', data: xValues },
      yAxis: { type: 'category' },
      visualMap: { min: 0, max: Math.max(...data.map(d => d[2] as number), 1), calculable: true },
      series: [{ type: 'heatmap', data }],
      ...(config.title ? { title: { text: config.title, left: 'center' } } : {}),
    };
  }

  const yValues = [...new Set(result.rows.map(row => String(row[groupBy])))];
  const data = result.rows.map(row => [
    xValues.indexOf(String(row[axis.xColumn])),
    yValues.indexOf(String(row[groupBy])),
    toNumeric(row[yCol]),
  ]);

  return {
    tooltip: {},
    xAxis: { type: 'category', data: xValues },
    yAxis: { type: 'category', data: yValues },
    visualMap: { min: 0, max: Math.max(...data.map(d => d[2] as number), 1), calculable: true },
    series: [{ type: 'heatmap', data }],
    ...(config.title ? { title: { text: config.title, left: 'center' } } : {}),
  };
}

// ---- helpers ----

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

// ---- builder registry ----

const OPTION_BUILDERS: Record<EChartsChartType, OptionBuilder> = {
  line: buildAxisOption,
  bar: buildAxisOption,
  scatter: buildAxisOption,
  heatmap: buildHeatmapOption,
  pie: buildCategoryOption,
  funnel: buildCategoryOption,
  treemap: buildTreemapOption,
  sunburst: buildSunburstOption,
  boxplot: buildBoxplotOption,
  candlestick: buildCandlestickOption,
  radar: buildRadarOption,
  gauge: buildGaugeOption,
};
