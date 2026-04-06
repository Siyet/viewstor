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

export interface AggregationConfig {
  function: AggregationFunction;
  /** Time bucket size for timeseries, e.g. '1m', '5m', '1h', '1d' */
  timeBucket?: string;
}

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
  /** Source SQL query (for Grafana export) */
  sourceQuery?: string;
  connectionId?: string;
  databaseName?: string;
  /** Database type for Grafana datasource reference */
  databaseType?: string;
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
