/**
 * Tests for MCP chart integration:
 * - VS Code mcp.visualize command with auto-aggregation
 * - Standalone MCP build_chart with aggregation params
 * - Chat /chart JSON config parsing
 */
import { describe, it, expect, vi } from 'vitest';
import { buildAggregationQuery, buildFullDataQuery, ChartConfig, EChartsChartType } from '../types/chart';
import { buildEChartsOption, suggestChartConfig } from '../chart/chartDataTransform';
import { QueryResult } from '../types/query';

// ============================================================
// mcp.visualize — auto-aggregation SQL generation
// ============================================================

describe('mcp.visualize — auto-aggregation logic', () => {
  // Simulates the logic from src/mcp/server.ts viewstor.mcp.visualize handler:
  // if tableName + xColumn + aggregation provided, buildAggregationQuery is used instead of raw query

  function simulateVisualizeQueryGeneration(
    rawQuery: string,
    chartConfig?: {
      tableName?: string;
      schema?: string;
      xColumn?: string;
      yColumns?: string[];
      groupByColumn?: string;
      aggregation?: string;
      timeBucket?: string;
    },
    databaseType?: string,
  ): string {
    let effectiveQuery = rawQuery;
    if (chartConfig?.tableName && chartConfig?.xColumn && chartConfig?.aggregation && chartConfig.aggregation !== 'none') {
      effectiveQuery = buildAggregationQuery(
        chartConfig.tableName,
        chartConfig.schema,
        chartConfig.xColumn,
        chartConfig.yColumns || ['*'],
        chartConfig.aggregation as ChartConfig['aggregation']['function'],
        chartConfig.groupByColumn,
        {
          function: chartConfig.aggregation as ChartConfig['aggregation']['function'],
          timeBucketPreset: chartConfig.timeBucket as ChartConfig['aggregation']['timeBucketPreset'],
        },
        databaseType,
      );
    }
    return effectiveQuery;
  }

  it('uses raw query when no aggregation config', () => {
    const sql = simulateVisualizeQueryGeneration('SELECT * FROM quotes LIMIT 100');
    expect(sql).toBe('SELECT * FROM quotes LIMIT 100');
  });

  it('uses raw query when aggregation is none', () => {
    const sql = simulateVisualizeQueryGeneration('SELECT * FROM quotes', {
      tableName: 'quotes', xColumn: 'created_at', aggregation: 'none',
    });
    expect(sql).toBe('SELECT * FROM quotes');
  });

  it('generates aggregation SQL for count + month', () => {
    const sql = simulateVisualizeQueryGeneration('ignored', {
      tableName: 'quotes',
      schema: 'public',
      xColumn: 'created_at',
      yColumns: ['id'],
      aggregation: 'count',
      timeBucket: 'month',
    }, 'postgresql');
    expect(sql).toContain('date_trunc(\'month\', "created_at")');
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain('"public"."quotes"');
    expect(sql).not.toBe('ignored');
  });

  it('generates aggregation SQL for avg + hour + groupBy', () => {
    const sql = simulateVisualizeQueryGeneration('ignored', {
      tableName: 'api_logs',
      schema: 'public',
      xColumn: 'timestamp',
      yColumns: ['response_ms'],
      groupByColumn: 'endpoint',
      aggregation: 'avg',
      timeBucket: 'hour',
    }, 'postgresql');
    expect(sql).toContain('AVG("response_ms")');
    expect(sql).toContain('"endpoint"');
    expect(sql).toContain('date_trunc(\'hour\'');
  });

  it('generates ClickHouse aggregation', () => {
    const sql = simulateVisualizeQueryGeneration('ignored', {
      tableName: 'events',
      schema: 'default',
      xColumn: 'event_time',
      yColumns: ['user_id'],
      aggregation: 'count',
      timeBucket: 'day',
    }, 'clickhouse');
    expect(sql).toContain('toStartOfDay');
    expect(sql).toContain('COUNT(*)');
  });

  it('falls back to raw query when tableName missing', () => {
    const sql = simulateVisualizeQueryGeneration('SELECT 1', {
      xColumn: 'ts', aggregation: 'count',
    });
    expect(sql).toBe('SELECT 1');
  });

  it('falls back to raw query when xColumn missing', () => {
    const sql = simulateVisualizeQueryGeneration('SELECT 1', {
      tableName: 'quotes', aggregation: 'count',
    });
    expect(sql).toBe('SELECT 1');
  });
});

// ============================================================
// standalone MCP build_chart — aggregation flow
// ============================================================

describe('standalone MCP build_chart — aggregation flow', () => {
  // Simulates the logic from src/mcp-server/index.ts build_chart handler

  function simulateBuildChartQuery(args: {
    connectionId: string;
    query?: string;
    tableName?: string;
    schema?: string;
    xColumn?: string;
    yColumns?: string[];
    groupByColumn?: string;
    aggregation?: string;
    timeBucket?: string;
  }, databaseType?: string): string | { error: string } {
    if (args.tableName && args.xColumn && args.aggregation && args.aggregation !== 'none') {
      return buildAggregationQuery(
        args.tableName, args.schema, args.xColumn,
        args.yColumns || ['*'],
        args.aggregation as ChartConfig['aggregation']['function'],
        args.groupByColumn,
        {
          function: args.aggregation as ChartConfig['aggregation']['function'],
          timeBucketPreset: args.timeBucket as ChartConfig['aggregation']['timeBucketPreset'],
        },
        databaseType,
      );
    } else if (args.query) {
      return args.query;
    } else if (args.tableName) {
      return args.schema
        ? `SELECT * FROM "${args.schema}"."${args.tableName}" LIMIT 1000`
        : `SELECT * FROM "${args.tableName}" LIMIT 1000`;
    }
    return { error: 'Provide either "query" or "tableName" parameter' };
  }

  it('auto-generates count per month query', () => {
    const sql = simulateBuildChartQuery({
      connectionId: 'c1',
      tableName: 'quotes',
      schema: 'public',
      xColumn: 'created_at',
      yColumns: ['id'],
      aggregation: 'count',
      timeBucket: 'month',
    }, 'postgresql');
    expect(typeof sql).toBe('string');
    expect(sql as string).toContain('date_trunc');
    expect(sql as string).toContain('COUNT(*)');
    expect(sql as string).toContain('"public"."quotes"');
  });

  it('uses raw query when provided without aggregation', () => {
    const sql = simulateBuildChartQuery({
      connectionId: 'c1',
      query: 'SELECT ts, value FROM metrics ORDER BY ts',
    });
    expect(sql).toBe('SELECT ts, value FROM metrics ORDER BY ts');
  });

  it('generates SELECT * with LIMIT when only tableName given', () => {
    const sql = simulateBuildChartQuery({
      connectionId: 'c1',
      tableName: 'users',
      schema: 'public',
    });
    expect(sql).toBe('SELECT * FROM "public"."users" LIMIT 1000');
  });

  it('generates SELECT * without schema', () => {
    const sql = simulateBuildChartQuery({
      connectionId: 'c1',
      tableName: 'logs',
    });
    expect(sql).toBe('SELECT * FROM "logs" LIMIT 1000');
  });

  it('returns error when neither query nor tableName provided', () => {
    const result = simulateBuildChartQuery({ connectionId: 'c1' });
    expect(result).toEqual({ error: 'Provide either "query" or "tableName" parameter' });
  });

  it('sum aggregation with day bucket', () => {
    const sql = simulateBuildChartQuery({
      connectionId: 'c1',
      tableName: 'orders',
      xColumn: 'order_date',
      yColumns: ['total'],
      aggregation: 'sum',
      timeBucket: 'day',
    });
    expect(typeof sql).toBe('string');
    expect(sql as string).toContain('SUM("total")');
    expect(sql as string).toContain('date_trunc(\'day\'');
  });

  it('aggregation result can be charted', () => {
    // Simulate: query executed, result fed to buildEChartsOption
    const mockResult: QueryResult = {
      columns: [
        { name: 'created_at', dataType: 'timestamp' },
        { name: 'count', dataType: 'bigint' },
      ],
      rows: [
        { created_at: '2024-01-01', count: 150 },
        { created_at: '2024-02-01', count: 200 },
        { created_at: '2024-03-01', count: 180 },
      ],
      rowCount: 3,
      executionTimeMs: 10,
    };

    const config: ChartConfig = {
      chartType: 'line',
      axis: { xColumn: 'created_at', yColumns: ['count'] },
      aggregation: { function: 'count', timeBucketPreset: 'month' },
    };

    const option = buildEChartsOption(mockResult, config);
    const series = option.series as Array<Record<string, unknown>>;
    expect(series.length).toBe(1);
    expect(series[0].type).toBe('line');
    const data = series[0].data as Array<unknown[]>;
    expect(data.length).toBe(3);
  });

  it('suggestChartConfig detects aggregation result as timeseries', () => {
    const mockResult: QueryResult = {
      columns: [
        { name: 'period', dataType: 'timestamp' },
        { name: 'count', dataType: 'bigint' },
      ],
      rows: [{ period: '2024-01-01', count: 100 }],
      rowCount: 1,
      executionTimeMs: 0,
    };
    const config = suggestChartConfig(mockResult);
    expect(config.chartType).toBe('line');
    expect(config.axis?.xColumn).toBe('period');
    expect(config.axis?.yColumns).toContain('count');
  });
});

// ============================================================
// Chat /chart — JSON config parsing
// ============================================================

describe('Chat /chart — JSON config parsing from LLM response', () => {
  function parseLlmResponse(response: string): {
    sql: string | null;
    config: { chartType?: string; xColumn?: string; yColumns?: string[] } | null;
  } {
    const sqlMatch = response.match(/```sql\n([\s\S]*?)\n```/);
    const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);

    let config = null;
    if (jsonMatch) {
      try { config = JSON.parse(jsonMatch[1]); } catch { /* ignore */ }
    }

    return {
      sql: sqlMatch ? sqlMatch[1].trim() : null,
      config,
    };
  }

  it('parses SQL and JSON config from well-formed response', () => {
    const response = `Here's the query:

\`\`\`sql
SELECT date_trunc('month', created_at) AS period, COUNT(*) AS count
FROM quotes GROUP BY 1 ORDER BY 1
\`\`\`

\`\`\`json
{ "chartType": "line", "xColumn": "period", "yColumns": ["count"] }
\`\`\``;

    const { sql, config } = parseLlmResponse(response);
    expect(sql).toContain('date_trunc');
    expect(sql).toContain('COUNT(*)');
    expect(config).not.toBeNull();
    expect(config!.chartType).toBe('line');
    expect(config!.xColumn).toBe('period');
    expect(config!.yColumns).toEqual(['count']);
  });

  it('parses SQL only when no JSON block', () => {
    const response = `\`\`\`sql
SELECT * FROM users
\`\`\`

This would work as a bar chart.`;

    const { sql, config } = parseLlmResponse(response);
    expect(sql).toBe('SELECT * FROM users');
    expect(config).toBeNull();
  });

  it('returns null sql when no SQL block', () => {
    const response = 'I cannot generate a query for that.';
    const { sql, config } = parseLlmResponse(response);
    expect(sql).toBeNull();
    expect(config).toBeNull();
  });

  it('handles malformed JSON gracefully', () => {
    const response = `\`\`\`sql
SELECT 1
\`\`\`

\`\`\`json
{ broken json
\`\`\``;

    const { sql, config } = parseLlmResponse(response);
    expect(sql).toBe('SELECT 1');
    expect(config).toBeNull();
  });

  it('parses multi-column yColumns', () => {
    const response = `\`\`\`sql
SELECT ts, cpu, mem FROM metrics
\`\`\`

\`\`\`json
{ "chartType": "line", "xColumn": "ts", "yColumns": ["cpu", "mem"] }
\`\`\``;

    const { config } = parseLlmResponse(response);
    expect(config!.yColumns).toEqual(['cpu', 'mem']);
  });

  it('parses bar chart config', () => {
    const response = `\`\`\`sql
SELECT status, COUNT(*) as cnt FROM orders GROUP BY status
\`\`\`

\`\`\`json
{ "chartType": "bar", "xColumn": "status", "yColumns": ["cnt"] }
\`\`\``;

    const { config } = parseLlmResponse(response);
    expect(config!.chartType).toBe('bar');
  });

  it('parses pie chart config', () => {
    const response = `\`\`\`sql
SELECT region, SUM(sales) as total FROM orders GROUP BY region
\`\`\`

\`\`\`json
{ "chartType": "pie", "xColumn": "region", "yColumns": ["total"] }
\`\`\``;

    const { config } = parseLlmResponse(response);
    expect(config!.chartType).toBe('pie');
  });
});
