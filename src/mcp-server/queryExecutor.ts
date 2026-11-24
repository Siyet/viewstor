import { buildEChartsOption, suggestChartConfig } from '../chart/chartDataTransform';
import { anonymizeRows, scrubErrorMessage, type AnonymizationPolicy } from '../mcp/anonymizer';
import { formatExecuteQuery } from '../mcp/mcpFormatters';
import { buildAggregationQuery, type ChartConfig, type EChartsChartType } from '../types/chart';
import type { QueryResult } from '../types/query';
import { isReadOnlyQuery } from '../utils/queryHelpers';
import type { ConnectionStore } from './connectionStore';

export interface ExecuteQueryInput {
  connectionId: string;
  query: string;
  database?: string;
}

export interface BuildChartInput {
  connectionId: string;
  database?: string;
  query?: string;
  tableName?: string;
  schema?: string;
  chartType?: string;
  xColumn?: string;
  yColumns?: string[];
  groupByColumn?: string;
  nameColumn?: string;
  valueColumn?: string;
  aggregation?: string;
  timeBucket?: string;
  title?: string;
}

type GuardedExecution =
  | { ok: true; result: QueryResult; policy: AnonymizationPolicy }
  | { ok: false; response: ReturnType<typeof errorResponse> };

/** The single SQL execution path for standalone MCP tools that accept raw SQL. */
async function executeGuardedQuery(
  store: ConnectionStore,
  connectionId: string,
  query: string,
  database?: string,
): Promise<GuardedExecution> {
  const config = store.get(connectionId);
  if (config?.readonly && !isReadOnlyQuery(query)) {
    return { ok: false, response: errorResponse('Connection is read-only. Only SELECT, EXPLAIN, SHOW, and WITH queries are allowed.') };
  }
  const policy = store.getAnonymizationPolicy(connectionId);
  const driver = database
    ? await store.ensureDriverForDatabase(connectionId, database)
    : await store.ensureDriver(connectionId);
  return { ok: true, result: await driver.execute(query), policy };
}

export async function handleExecuteQuery(store: ConnectionStore, args: ExecuteQueryInput) {
  const executed = await executeGuardedQuery(store, args.connectionId, args.query, args.database);
  if (!executed.ok) return executed.response;

  const payload = formatExecuteQuery(executed.result);
  payload.rows = anonymizeRows(executed.result.columns, executed.result.rows, executed.policy);
  if (payload.error) payload.error = scrubErrorMessage(payload.error, executed.policy);
  return jsonResponse(payload);
}

export async function handleBuildChart(store: ConnectionStore, args: BuildChartInput) {
  const {
    connectionId, database, query, tableName, schema, chartType,
    xColumn, yColumns, groupByColumn, nameColumn, valueColumn,
    aggregation: aggFunc, timeBucket, title,
  } = args;

  let effectiveQuery: string;
  if (tableName && xColumn && aggFunc && aggFunc !== 'none') {
    const conn = store.get(connectionId);
    effectiveQuery = buildAggregationQuery(
      tableName, schema, xColumn, yColumns || ['*'],
      aggFunc as ChartConfig['aggregation']['function'],
      groupByColumn,
      {
        function: aggFunc as ChartConfig['aggregation']['function'],
        timeBucketPreset: timeBucket as ChartConfig['aggregation']['timeBucketPreset'],
      },
      conn?.type,
    );
  } else if (query) {
    effectiveQuery = query;
  } else if (tableName) {
    effectiveQuery = schema
      ? `SELECT * FROM "${schema}"."${tableName}" LIMIT 1000`
      : `SELECT * FROM "${tableName}" LIMIT 1000`;
  } else {
    return errorResponse('Provide either "query" or "tableName" parameter');
  }

  const executed = await executeGuardedQuery(store, connectionId, effectiveQuery, database);
  if (!executed.ok) return executed.response;
  const { result, policy } = executed;
  if (result.error) return errorResponse(scrubErrorMessage(result.error, policy));
  result.rows = anonymizeRows(result.columns, result.rows, policy);

  const suggested = suggestChartConfig(result);
  const config: ChartConfig = {
    chartType: (chartType as EChartsChartType) || suggested.chartType || 'bar',
    aggregation: {
      function: (aggFunc as ChartConfig['aggregation']['function']) || suggested.aggregation?.function || 'none',
      timeBucketPreset: timeBucket as ChartConfig['aggregation']['timeBucketPreset'],
    },
    sourceQuery: effectiveQuery,
    connectionId,
    title,
  };

  if (xColumn && yColumns) {
    config.axis = { xColumn, yColumns, groupByColumn };
  } else if (nameColumn && valueColumn) {
    config.category = { nameColumn, valueColumn };
  } else if (suggested.axis) {
    config.axis = suggested.axis;
  } else if (suggested.category) {
    config.category = suggested.category;
  }

  const option = buildEChartsOption(result, config);
  return jsonResponse({ config, option, sql: effectiveQuery, rowCount: result.rowCount });
}

function jsonResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResponse(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}
