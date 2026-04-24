#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ConnectionStore } from './connectionStore';
import { ChartConfig, EChartsChartType, isGrafanaCompatible, buildAggregationQuery } from '../types/chart';
import { buildEChartsOption, suggestChartConfig } from '../chart/chartDataTransform';
import { buildGrafanaDashboard } from '../chart/grafanaExport';
import { wrapError } from '../utils/errors';
import { isReadOnlyQuery } from '../utils/queryHelpers';
import { formatExecuteQuery, formatTableData, formatTableInfo, flattenSchema } from '../mcp/mcpFormatters';

const store = new ConnectionStore();

const server = new Server(
  { name: 'viewstor-mcp', version: '0.1.2' },
  { capabilities: { tools: {} } },
);

// --- Tool definitions ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_connections',
      description: 'List all configured database connections with their status. The "databases" field shows additional databases on the same server that can be queried via the "database" parameter of other tools.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'get_schema',
      description: 'Get database schema (tables, columns, types) for a connection',
      inputSchema: {
        type: 'object' as const,
        properties: {
          connectionId: { type: 'string', description: 'Connection ID' },
          database: { type: 'string', description: 'Optional database name to query (reuses connection credentials). Use this to inspect a different database on the same server without creating a new connection.' },
        },
        required: ['connectionId'],
      },
    },
    {
      name: 'execute_query',
      description: 'Execute a SQL query on a database connection',
      inputSchema: {
        type: 'object' as const,
        properties: {
          connectionId: { type: 'string', description: 'Connection ID' },
          query: { type: 'string', description: 'SQL query to execute' },
          database: { type: 'string', description: 'Optional database name to run the query against (reuses connection credentials). Use this to query a different database on the same server without creating a new connection.' },
        },
        required: ['connectionId', 'query'],
      },
    },
    {
      name: 'get_table_data',
      description: 'Fetch rows from a table with optional limit',
      inputSchema: {
        type: 'object' as const,
        properties: {
          connectionId: { type: 'string', description: 'Connection ID' },
          tableName: { type: 'string', description: 'Table name' },
          schema: { type: 'string', description: 'Schema name (optional)' },
          limit: { type: 'number', description: 'Row limit (default 100)' },
          database: { type: 'string', description: 'Optional database name to query (reuses connection credentials).' },
        },
        required: ['connectionId', 'tableName'],
      },
    },
    {
      name: 'get_table_info',
      description: 'Get column metadata, primary keys, and nullability for a table',
      inputSchema: {
        type: 'object' as const,
        properties: {
          connectionId: { type: 'string', description: 'Connection ID' },
          tableName: { type: 'string', description: 'Table name' },
          schema: { type: 'string', description: 'Schema name (optional)' },
          database: { type: 'string', description: 'Optional database name to query (reuses connection credentials).' },
        },
        required: ['connectionId', 'tableName'],
      },
    },
    {
      name: 'add_connection',
      description: 'Add a new database connection. For SQLite: set type="sqlite", database="/path/to/file.db" (or ":memory:"), host and port are ignored.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Display name' },
          type: { type: 'string', enum: ['postgresql', 'redis', 'clickhouse', 'sqlite'], description: 'Database type' },
          host: { type: 'string', description: 'Host (ignored for SQLite)' },
          port: { type: 'number', description: 'Port (ignored for SQLite)' },
          username: { type: 'string', description: 'Username' },
          password: { type: 'string', description: 'Password' },
          database: { type: 'string', description: 'Database name, or file path for SQLite (e.g. "/tmp/test.db", ":memory:")' },
          ssl: { type: 'boolean', description: 'Use SSL' },
          readonly: { type: 'boolean', description: 'Read-only mode' },
        },
        required: ['name', 'type'],
      },
    },
    {
      name: 'reload_connections',
      description: 'Reload connections from config files (call after adding connections via VS Code or editing config files)',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'build_chart',
      description: 'Build a chart from database data. Can either execute a raw SQL query, or auto-generate an aggregation query from table + columns + aggregation function. Use this when the user asks to "show on a chart", "visualize", "plot" data. Example: to show "quotes per month", pass tableName="quotes", xColumn="created_at", aggregation="count", timeBucket="month".',
      inputSchema: {
        type: 'object' as const,
        properties: {
          connectionId: { type: 'string', description: 'Connection ID' },
          database: { type: 'string', description: 'Optional database name to query (reuses connection credentials).' },
          query: { type: 'string', description: 'Raw SQL query. If tableName + aggregation are provided, this is auto-generated and can be omitted.' },
          tableName: { type: 'string', description: 'Table name for server-side aggregation (e.g. "quotes")' },
          schema: { type: 'string', description: 'Schema name (e.g. "public")' },
          chartType: { type: 'string', description: 'Chart type: line, bar, scatter, pie, radar, heatmap, funnel, gauge, boxplot, candlestick, treemap, sunburst' },
          xColumn: { type: 'string', description: 'X axis column (for time series, use the timestamp column)' },
          yColumns: { type: 'array', items: { type: 'string' }, description: 'Y axis columns (for count aggregation, any column works)' },
          groupByColumn: { type: 'string', description: 'Split into series by this column' },
          aggregation: { type: 'string', enum: ['none', 'count', 'sum', 'avg', 'min', 'max'], description: 'Aggregation function. Use "count" for "how many per period" questions.' },
          timeBucket: { type: 'string', enum: ['second', 'minute', 'hour', 'day', 'month', 'year'], description: 'Time bucket for grouping timestamps (e.g. "month" for monthly aggregation)' },
          nameColumn: { type: 'string', description: 'Name column (for pie/funnel/treemap)' },
          valueColumn: { type: 'string', description: 'Value column (for pie/funnel/gauge)' },
          title: { type: 'string', description: 'Chart title' },
        },
        required: ['connectionId'],
      },
    },
    {
      name: 'export_grafana_dashboard',
      description: 'Generate a Grafana dashboard JSON from a query. Only works for Grafana-compatible chart types: line, bar, scatter, pie, gauge, heatmap.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          connectionId: { type: 'string', description: 'Connection ID' },
          database: { type: 'string', description: 'Optional database name to query (reuses connection credentials).' },
          query: { type: 'string', description: 'SQL query' },
          chartType: { type: 'string', description: 'Chart type: line, bar, scatter, pie, gauge, heatmap' },
          title: { type: 'string', description: 'Dashboard title' },
          xColumn: { type: 'string', description: 'X axis column name' },
          yColumns: { type: 'array', items: { type: 'string' }, description: 'Y axis column names' },
        },
        required: ['connectionId', 'query', 'chartType'],
      },
    },
  ],
}));

// --- Tool handlers ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'list_connections': {
        const all = store.getAll();
        const result = all.map(c => ({
          id: c.id,
          name: c.name,
          type: c.type,
          host: c.host,
          port: c.port,
          database: c.database,
          databases: c.databases,
          connected: !!store.getDriver(c.id),
          readonly: c.readonly,
        }));
        return jsonResponse(result);
      }

      case 'get_schema': {
        const { connectionId, database } = args as { connectionId: string; database?: string };
        const driver = await resolveDriver(connectionId, database);
        return jsonResponse(flattenSchema(await driver.getSchema()));
      }

      case 'execute_query': {
        const { connectionId, query, database } = args as { connectionId: string; query: string; database?: string };
        const config = store.get(connectionId);
        if (config?.readonly && !isReadOnlyQuery(query)) {
          return errorResponse('Connection is read-only. Only SELECT, EXPLAIN, SHOW, and WITH queries are allowed.');
        }
        const driver = await resolveDriver(connectionId, database);
        return jsonResponse(formatExecuteQuery(await driver.execute(query)));
      }

      case 'get_table_data': {
        const { connectionId, tableName, schema, limit, database } = args as {
          connectionId: string; tableName: string; schema?: string; limit?: number; database?: string;
        };
        const driver = await resolveDriver(connectionId, database);
        return jsonResponse(formatTableData(await driver.getTableData(tableName, schema, limit || 100)));
      }

      case 'get_table_info': {
        const { connectionId, tableName, schema, database } = args as {
          connectionId: string; tableName: string; schema?: string; database?: string;
        };
        const driver = await resolveDriver(connectionId, database);
        return jsonResponse(formatTableInfo(await driver.getTableInfo(tableName, schema)));
      }

      case 'add_connection': {
        const { name: connName, type, host, port, username, password, database, ssl, readonly } = args as {
          name: string; type: 'postgresql' | 'redis' | 'clickhouse';
          host: string; port: number;
          username?: string; password?: string; database?: string;
          ssl?: boolean; readonly?: boolean;
        };

        const { isAdapterInstalled, installAdapter } = await import('../adapters/adapterManager');
        const installed: string[] = [];
        if (!isAdapterInstalled(type)) {
          await installAdapter(type);
          installed.push(type);
        }

        const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
        const config = { id, name: connName, type, host, port, username, password, database, ssl, readonly };
        await store.add(config);
        return jsonResponse({
          id, name: connName, type, host, port, database,
          message: 'Connection added',
          ...(installed.length > 0 ? { installed } : {}),
        });
      }

      case 'reload_connections': {
        await store.disconnectAll();
        store.reload();
        const all = store.getAll();
        return jsonResponse({ message: `Reloaded ${all.length} connection(s)`, connections: all.map(c => c.name) });
      }

      case 'build_chart': {
        const { connectionId, database: chartDatabase, query, tableName: chartTable, schema: chartSchema, chartType,
          xColumn, yColumns, groupByColumn, nameColumn, valueColumn,
          aggregation: aggFunc, timeBucket, title: chartTitle } = args as {
          connectionId: string; database?: string; query?: string; tableName?: string; schema?: string;
          chartType?: string; xColumn?: string; yColumns?: string[];
          groupByColumn?: string; nameColumn?: string; valueColumn?: string;
          aggregation?: string; timeBucket?: string; title?: string;
        };

        // Build SQL: either from raw query, or auto-generate from table + aggregation
        let effectiveQuery: string;
        if (chartTable && xColumn && aggFunc && aggFunc !== 'none') {
          const conn = store.get(connectionId);
          effectiveQuery = buildAggregationQuery(
            chartTable, chartSchema, xColumn, yColumns || ['*'],
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
        } else if (chartTable) {
          // No aggregation, no query — just SELECT from table
          effectiveQuery = chartSchema
            ? `SELECT * FROM "${chartSchema}"."${chartTable}" LIMIT 1000`
            : `SELECT * FROM "${chartTable}" LIMIT 1000`;
        } else {
          return errorResponse('Provide either "query" or "tableName" parameter');
        }

        const chartDriver = await resolveDriver(connectionId, chartDatabase);
        const chartResult = await chartDriver.execute(effectiveQuery);
        if (chartResult.error) return errorResponse(chartResult.error);

        const suggested = suggestChartConfig(chartResult);
        const config: ChartConfig = {
          chartType: (chartType as EChartsChartType) || suggested.chartType || 'bar',
          aggregation: {
            function: (aggFunc as ChartConfig['aggregation']['function']) || suggested.aggregation?.function || 'none',
            timeBucketPreset: timeBucket as ChartConfig['aggregation']['timeBucketPreset'],
          },
          sourceQuery: effectiveQuery,
          connectionId,
          title: chartTitle,
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

        const option = buildEChartsOption(chartResult, config);
        return jsonResponse({ config, option, sql: effectiveQuery, rowCount: chartResult.rowCount });
      }

      case 'export_grafana_dashboard': {
        const { connectionId: grafConnId, query: grafQuery, chartType: grafChartType, title: grafTitle, xColumn: grafX, yColumns: grafY } = args as {
          connectionId: string; query: string; chartType: string;
          title?: string; xColumn?: string; yColumns?: string[];
        };
        if (!isGrafanaCompatible(grafChartType as EChartsChartType)) {
          return errorResponse(`Chart type "${grafChartType}" is not compatible with Grafana. Use: line, bar, scatter, pie, gauge, heatmap.`);
        }
        const grafConn = store.get(grafConnId);
        const grafConfig: ChartConfig = {
          chartType: grafChartType as EChartsChartType,
          aggregation: { function: 'none' },
          sourceQuery: grafQuery,
          connectionId: grafConnId,
          databaseType: grafConn?.type,
          title: grafTitle,
        };
        if (grafX && grafY) {
          grafConfig.axis = { xColumn: grafX, yColumns: grafY };
        }
        const dashboard = buildGrafanaDashboard(grafConfig);
        if (!dashboard) return errorResponse('Failed to build Grafana dashboard');
        return jsonResponse(dashboard);
      }

      default:
        return errorResponse(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResponse(wrapError(err));
  }
});

async function resolveDriver(connectionId: string, database?: string) {
  if (database) return store.ensureDriverForDatabase(connectionId, database);
  return store.ensureDriver(connectionId);
}

function jsonResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResponse(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', async () => {
    await store.disconnectAll();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await store.disconnectAll();
    process.exit(0);
  });
}

main().catch(err => {
  process.stderr.write(`Failed to start MCP server: ${err}\n`);
  process.exit(1);
});
