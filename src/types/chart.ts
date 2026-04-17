/**
 * Chart visualization types.
 *
 * EChartsChartType — all ECharts series types available in the UI.
 * GrafanaChartType — subset that maps to Grafana panel types.
 */

export type EChartsChartType =
  | 'line'
  | 'bar'
  | 'scatter'
  | 'pie'
  | 'radar'
  | 'heatmap'
  | 'funnel'
  | 'gauge'
  | 'boxplot'
  | 'candlestick'
  | 'treemap'
  | 'sunburst';

/** ECharts types that have a Grafana panel equivalent */
export type GrafanaChartType = 'line' | 'bar' | 'scatter' | 'pie' | 'gauge' | 'heatmap';

export const GRAFANA_TYPE_MAP: Record<GrafanaChartType, string> = {
  line: 'timeseries',
  bar: 'barchart',
  scatter: 'xychart',
  pie: 'piechart',
  gauge: 'gauge',
  heatmap: 'heatmap',
};

export function isGrafanaCompatible(chartType: EChartsChartType): chartType is GrafanaChartType {
  return chartType in GRAFANA_TYPE_MAP;
}

/** Axis mapping for cartesian charts (line, bar, scatter, heatmap) */
export interface AxisMapping {
  xColumn: string;
  yColumns: string[];
  groupByColumn?: string;
}

/** Mapping for categorical charts (pie, funnel, treemap, sunburst) */
export interface CategoryMapping {
  nameColumn: string;
  valueColumn: string;
}

/** Mapping for statistical charts (boxplot, candlestick) */
export interface StatMapping {
  /** Column containing numeric values to aggregate (boxplot) */
  valueColumn: string;
  groupByColumn?: string;
}

/** Mapping for radar charts */
export interface RadarMapping {
  indicatorColumns: string[];
  groupByColumn?: string;
}

/** Mapping for gauge charts */
export interface GaugeMapping {
  valueColumn: string;
  minValue?: number;
  maxValue?: number;
}

export type AggregationFunction = 'none' | 'sum' | 'avg' | 'min' | 'max' | 'count';

/** Preset time bucket sizes */
export type TimeBucketPreset = 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year' | 'custom';

export interface AggregationConfig {
  function: AggregationFunction;
  /** Time bucket preset or 'custom' */
  timeBucketPreset?: TimeBucketPreset;
  /** Custom time bucket expression (e.g. '2h', '15m', '3d') — used when preset is 'custom' */
  timeBucket?: string;
}

/**
 * Map time bucket preset to PostgreSQL date_trunc argument.
 * For 'custom', use EXTRACT or generate_series with interval.
 */
export const TIME_BUCKET_PG: Record<Exclude<TimeBucketPreset, 'custom'>, string> = {
  second: 'second',
  minute: 'minute',
  hour: 'hour',
  day: 'day',
  month: 'month',
  year: 'year',
};

/**
 * Map time bucket preset to ClickHouse toStartOf* function.
 */
export const TIME_BUCKET_CH: Record<Exclude<TimeBucketPreset, 'custom'>, string> = {
  second: 'toStartOfSecond',
  minute: 'toStartOfMinute',
  hour: 'toStartOfHour',
  day: 'toStartOfDay',
  month: 'toStartOfMonth',
  year: 'toStartOfYear',
};

/**
 * Map time bucket preset to SQLite strftime() format.
 * SQLite has no date_trunc — use strftime() to truncate timestamps.
 */
export const TIME_BUCKET_SQLITE: Record<Exclude<TimeBucketPreset, 'custom'>, string> = {
  second: '%Y-%m-%d %H:%M:%S',
  minute: '%Y-%m-%d %H:%M:00',
  hour: '%Y-%m-%d %H:00:00',
  day: '%Y-%m-%d',
  month: '%Y-%m',
  year: '%Y',
};

/** How an additional data source is merged into the chart */
export type DataSourceMergeMode = 'join' | 'separate';

/** Additional data source for multi-source charts */
export interface ChartDataSource {
  /** Pinned query history entry ID */
  id: string;
  /** Display label (pinned query name or custom) */
  label: string;
  /** Column names to include as Y series */
  yColumns: string[];
  /** How to combine with the primary data: join by a key column, or display as separate series */
  mergeMode: DataSourceMergeMode;
  /** Column to join on (required when mergeMode is 'join') */
  joinColumn?: string;
}

export interface ChartConfig {
  chartType: EChartsChartType;
  axis?: AxisMapping;
  category?: CategoryMapping;
  stat?: StatMapping;
  radar?: RadarMapping;
  gauge?: GaugeMapping;
  aggregation: AggregationConfig;
  title?: string;
  areaFill?: boolean;
  showLegend?: boolean;
  /** Additional data sources from pinned queries */
  dataSources?: ChartDataSource[];
  /** Whether chart is synced with the result panel (auto-updates on page/query change) */
  syncEnabled?: boolean;
  /** Fetch full data (no LIMIT) but only the columns needed for the chart */
  fullData?: boolean;
  /** Source SQL query (for Grafana export) */
  sourceQuery?: string;
  connectionId?: string;
  databaseName?: string;
  /** Database type for Grafana datasource reference */
  databaseType?: string;
  /** Table name (for building server-side queries) */
  tableName?: string;
  /** Schema name (for building server-side queries) */
  schemaName?: string;
}

/**
 * Build a server-side aggregation SQL query.
 * Used when chart needs COUNT/SUM/AVG with GROUP BY + time bucketing — executed on DB, not in frontend.
 */
export function buildAggregationQuery(
  tableName: string,
  schema: string | undefined,
  xColumn: string,
  yColumns: string[],
  aggFunction: AggregationFunction,
  groupByColumn: string | undefined,
  timeBucket: AggregationConfig,
  databaseType?: string,
  limit?: number,
): string {
  const table = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;

  // Build X expression with time bucketing
  let xExpr = `"${xColumn}"`;
  if (timeBucket.timeBucketPreset && timeBucket.timeBucketPreset !== 'custom') {
    if (databaseType === 'clickhouse') {
      const chFunc = TIME_BUCKET_CH[timeBucket.timeBucketPreset];
      xExpr = `${chFunc}("${xColumn}")`;
    } else if (databaseType === 'sqlite') {
      const fmt = TIME_BUCKET_SQLITE[timeBucket.timeBucketPreset];
      xExpr = `strftime('${fmt}', "${xColumn}")`;
    } else {
      // PostgreSQL (default)
      const pgTrunc = TIME_BUCKET_PG[timeBucket.timeBucketPreset];
      xExpr = `date_trunc('${pgTrunc}', "${xColumn}")`;
    }
  } else if (timeBucket.timeBucketPreset === 'custom' && timeBucket.timeBucket) {
    // Custom bucket: parse '2h' → interval '2 hours'
    const interval = parseCustomBucket(timeBucket.timeBucket);
    if (databaseType === 'clickhouse') {
      xExpr = `toStartOfInterval("${xColumn}", INTERVAL ${interval})`;
    } else if (databaseType === 'sqlite') {
      xExpr = buildSqliteCustomBucket(xColumn, timeBucket.timeBucket);
    } else {
      // PostgreSQL (date_bin requires PG >= 14)
      xExpr = `date_bin('${interval}', "${xColumn}", '2000-01-01')`;
    }
  }

  // Build Y expressions with aggregation.
  // Aliases preserve original column names so the chart axis mapping stays valid.
  // COUNT produces a single column regardless of how many yColumns are specified
  const yExprs = aggFunction === 'count'
    ? ['COUNT(*) AS "count"']
    : yColumns.map(col => {
      if (aggFunction === 'none') return `"${col}"`;
      return `${aggFunction.toUpperCase()}("${col}") AS "${col}"`;
    });

  const selectParts = [`${xExpr} AS "${xColumn}"`];
  yExprs.forEach((expr) => selectParts.push(expr));
  if (groupByColumn) selectParts.push(`"${groupByColumn}"`);

  let sql = `SELECT ${selectParts.join(', ')} FROM ${table}`;

  // GROUP BY when aggregating
  if (aggFunction !== 'none') {
    const groupParts = [`${xExpr}`];
    if (groupByColumn) groupParts.push(`"${groupByColumn}"`);
    sql += ` GROUP BY ${groupParts.join(', ')}`;
  }

  sql += ` ORDER BY ${xExpr}`;
  if (limit) sql += ` LIMIT ${limit}`;

  return sql;
}

/**
 * Build a "full data" query for the chart panel — no LIMIT.
 * Empty `columns` array maps to `SELECT *`, so the user can still switch
 * X / Y columns in the sidebar after enabling Full Data.
 */
export function buildFullDataQuery(
  tableName: string,
  schema: string | undefined,
  columns: string[],
): string {
  const table = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
  const cols = columns.length > 0 ? columns.map(c => `"${c}"`).join(', ') : '*';
  return `SELECT ${cols} FROM ${table}`;
}

/**
 * Build a SQLite-compatible expression for custom time buckets.
 * SQLite lacks date_bin/date_trunc, so we round via integer arithmetic on unixepoch.
 */
function buildSqliteCustomBucket(column: string, bucket: string): string {
  const seconds = parseCustomBucketSeconds(bucket);
  // Round unix timestamp down to nearest bucket, then convert back to ISO string
  return `strftime('%Y-%m-%d %H:%M:%S', (unixepoch("${column}") / ${seconds}) * ${seconds}, 'unixepoch')`;
}

function parseCustomBucketSeconds(bucket: string): number {
  const match = bucket.match(/^(\d+)\s*([smhdwMy])$/);
  if (!match) return 3600;
  const num = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1, m: 60, h: 3600, d: 86400, w: 604800, M: 2592000, y: 31536000,
  };
  return num * (multipliers[unit] || 3600);
}

function parseCustomBucket(bucket: string): string {
  const match = bucket.match(/^(\d+)\s*([smhdwMy])$/);
  if (!match) return '1 hour';
  const num = match[1];
  const unit = match[2];
  const unitMap: Record<string, string> = {
    s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week', M: 'month', y: 'year',
  };
  return `${num} ${unitMap[unit] || 'hour'}`;
}


/** Which mapping fields are required per chart type */
export const CHART_TYPE_MAPPING: Record<EChartsChartType, 'axis' | 'category' | 'stat' | 'radar' | 'gauge'> = {
  line: 'axis',
  bar: 'axis',
  scatter: 'axis',
  heatmap: 'axis',
  pie: 'category',
  funnel: 'category',
  treemap: 'category',
  sunburst: 'category',
  boxplot: 'stat',
  candlestick: 'stat',
  radar: 'radar',
  gauge: 'gauge',
};
