import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { ChartConfig, isGrafanaCompatible, buildAggregationQuery } from '../types/chart';
import { buildGrafanaDashboard } from '../chart/grafanaExport';

/**
 * MCP-compatible tool definitions exposed via VS Code commands.
 * AI agents (Claude Code, Cursor, etc.) can call these via the
 * VS Code command palette or programmatically.
 *
 * Tools:
 * - viewstor.mcp.listConnections
 * - viewstor.mcp.getSchema
 * - viewstor.mcp.executeQuery
 * - viewstor.mcp.getTableData
 * - viewstor.mcp.getTableInfo
 * - viewstor.mcp.openQuery      (UI: opens SQL editor with query text)
 * - viewstor.mcp.openTableData  (UI: opens table data view, optionally with custom query)
 */
export function registerMcpCommands(context: vscode.ExtensionContext, connectionManager: ConnectionManager) {
  context.subscriptions.push(
    vscode.commands.registerCommand('viewstor.mcp.listConnections', () => {
      return connectionManager.getAll().map(s => ({
        id: s.config.id,
        name: s.config.name,
        type: s.config.type,
        host: s.config.host,
        port: s.config.port,
        database: s.config.database,
        databases: s.config.databases,
        connected: s.connected,
        readonly: s.config.readonly,
      }));
    }),

    vscode.commands.registerCommand('viewstor.mcp.getSchema', async (connectionId: string) => {
      const driver = connectionManager.getDriver(connectionId);
      if (!driver) {
        // Auto-connect if needed
        try {
          await connectionManager.connect(connectionId);
        } catch (err) {
          return { error: `Connection failed: ${err instanceof Error ? err.message : err}` };
        }
      }
      const d = connectionManager.getDriver(connectionId);
      if (!d) return { error: 'Driver not available' };
      try {
        const schema = await d.getSchema();
        return flattenSchema(schema);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }),

    vscode.commands.registerCommand('viewstor.mcp.executeQuery', async (connectionId: string, query: string) => {
      const state = connectionManager.get(connectionId);
      if (state?.config.readonly) {
        // In readonly mode, only allow SELECT/EXPLAIN/SHOW
        const trimmed = query.trim().toUpperCase();
        if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('EXPLAIN') && !trimmed.startsWith('SHOW') && !trimmed.startsWith('WITH')) {
          return { error: 'Connection is read-only. Only SELECT, EXPLAIN, SHOW, and WITH queries are allowed.' };
        }
      }

      let driver = connectionManager.getDriver(connectionId);
      if (!driver) {
        try {
          await connectionManager.connect(connectionId);
          driver = connectionManager.getDriver(connectionId);
        } catch (err) {
          return { error: `Connection failed: ${err instanceof Error ? err.message : err}` };
        }
      }
      if (!driver) return { error: 'Driver not available' };

      try {
        const result = await driver.execute(query);
        return {
          columns: result.columns.map(c => c.name),
          columnTypes: result.columns.map(c => c.dataType),
          rows: result.rows,
          rowCount: result.rowCount,
          executionTimeMs: result.executionTimeMs,
          error: result.error,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }),

    vscode.commands.registerCommand('viewstor.mcp.getTableData', async (connectionId: string, tableName: string, schema?: string, limit?: number) => {
      let driver = connectionManager.getDriver(connectionId);
      if (!driver) {
        try {
          await connectionManager.connect(connectionId);
          driver = connectionManager.getDriver(connectionId);
        } catch (err) {
          return { error: `Connection failed: ${err instanceof Error ? err.message : err}` };
        }
      }
      if (!driver) return { error: 'Driver not available' };

      try {
        const result = await driver.getTableData(tableName, schema, limit || 100);
        return {
          columns: result.columns.map(c => ({ name: c.name, type: c.dataType })),
          rows: result.rows,
          rowCount: result.rowCount,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }),

    vscode.commands.registerCommand('viewstor.mcp.getTableInfo', async (connectionId: string, tableName: string, schema?: string) => {
      let driver = connectionManager.getDriver(connectionId);
      if (!driver) {
        try {
          await connectionManager.connect(connectionId);
          driver = connectionManager.getDriver(connectionId);
        } catch (err) {
          return { error: `Connection failed: ${err instanceof Error ? err.message : err}` };
        }
      }
      if (!driver) return { error: 'Driver not available' };

      try {
        const info = await driver.getTableInfo(tableName, schema);
        return {
          name: info.name,
          schema: info.schema,
          columns: info.columns.map(c => ({
            name: c.name,
            type: c.dataType,
            nullable: c.nullable,
            isPrimaryKey: c.isPrimaryKey,
            defaultValue: c.defaultValue,
          })),
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }),
    vscode.commands.registerCommand('viewstor.mcp.visualize', async (
      connectionId: string,
      query: string,
      chartConfig?: {
        chartType?: string;
        xColumn?: string;
        yColumns?: string[];
        groupByColumn?: string;
        aggregation?: string;
        timeBucket?: string;
        tableName?: string;
        schema?: string;
        title?: string;
        areaFill?: boolean;
      },
    ) => {
      let driver = connectionManager.getDriver(connectionId);
      if (!driver) {
        try {
          await connectionManager.connect(connectionId);
          driver = connectionManager.getDriver(connectionId);
        } catch (err) {
          return { error: `Connection failed: ${err instanceof Error ? err.message : err}` };
        }
      }
      if (!driver) return { error: 'Driver not available' };

      try {
        // If aggregation or timeBucket specified and tableName available, build server-side query
        let effectiveQuery = query;
        if (chartConfig?.tableName && chartConfig?.xColumn && chartConfig?.aggregation && chartConfig.aggregation !== 'none') {
          const state = connectionManager.get(connectionId);
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
            state?.config.type,
          );
        }

        const result = await driver.execute(effectiveQuery);
        if (result.error) return { error: result.error };

        const state = connectionManager.get(connectionId);
        vscode.commands.executeCommand('viewstor.visualizeResults', {
          columns: result.columns,
          rows: result.rows,
          query: effectiveQuery,
          connectionId,
          databaseName: state?.config.database,
          databaseType: state?.config.type,
          tableName: chartConfig?.tableName,
          schema: chartConfig?.schema,
        });

        return {
          rowCount: result.rowCount,
          sql: effectiveQuery,
          message: 'Chart panel opened',
          columns: result.columns.map(c => ({ name: c.name, type: c.dataType })),
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }),

    // --- UI commands: open editors and result panels from AI agents ---

    vscode.commands.registerCommand('viewstor.mcp.openQuery', async (
      connectionId: string,
      query: string,
      options?: { databaseName?: string; execute?: boolean },
    ) => {
      if (!connectionId || !query) return { error: 'connectionId and query are required' };
      const state = connectionManager.get(connectionId);
      if (!state) return { error: `Connection "${connectionId}" not found` };

      // Auto-connect
      if (!state.connected) {
        try { await connectionManager.connect(connectionId); }
        catch (err) { return { error: `Connection failed: ${err instanceof Error ? err.message : err}` }; }
      }

      // Open SQL editor with query text
      await vscode.commands.executeCommand('viewstor._openQueryFromMcp', connectionId, query, options?.databaseName);

      // Optionally execute immediately
      if (options?.execute) {
        // Wait for editor to open, then trigger run
        await new Promise(resolve => setTimeout(resolve, 300));
        await vscode.commands.executeCommand('viewstor.runQuery');
      }

      return { success: true, message: options?.execute ? 'Query editor opened and executed' : 'Query editor opened' };
    }),

    vscode.commands.registerCommand('viewstor.mcp.openTableData', async (
      connectionId: string,
      tableName: string,
      options?: { schema?: string; databaseName?: string; query?: string; execute?: boolean },
    ) => {
      if (!connectionId || !tableName) return { error: 'connectionId and tableName are required' };
      const state = connectionManager.get(connectionId);
      if (!state) return { error: `Connection "${connectionId}" not found` };

      // Auto-connect
      if (!state.connected) {
        try { await connectionManager.connect(connectionId); }
        catch (err) { return { error: `Connection failed: ${err instanceof Error ? err.message : err}` }; }
      }

      // Open table data view
      await vscode.commands.executeCommand(
        'viewstor._openTableDataFromMcp',
        connectionId, tableName, options?.schema, options?.databaseName, options?.query, options?.execute,
      );

      return {
        success: true,
        message: options?.query
          ? `Table "${tableName}" opened with custom query`
          : `Table "${tableName}" opened`,
      };
    }),

    vscode.commands.registerCommand('viewstor.mcp.exportGrafana', async (connectionId: string, query: string, chartConfig: ChartConfig) => {
      const state = connectionManager.get(connectionId);
      if (!isGrafanaCompatible(chartConfig.chartType)) {
        return { error: `Chart type "${chartConfig.chartType}" is not compatible with Grafana` };
      }
      const config: ChartConfig = {
        ...chartConfig,
        sourceQuery: query,
        connectionId,
        databaseName: state?.config.database,
        databaseType: state?.config.type,
      };
      const dashboard = buildGrafanaDashboard(config);
      if (!dashboard) return { error: 'Failed to build Grafana dashboard' };
      return dashboard;
    }),
  );
}

/** Flatten nested schema tree into a simple array of objects */
function flattenSchema(objects: { name: string; type: string; children?: unknown[]; detail?: string; schema?: string }[], parentPath = ''): unknown[] {
  const result: unknown[] = [];
  for (const obj of objects) {
    const path = parentPath ? `${parentPath}.${obj.name}` : obj.name;
    result.push({
      name: obj.name,
      type: obj.type,
      path,
      detail: obj.detail,
      schema: obj.schema,
    });
    if (obj.children && Array.isArray(obj.children)) {
      result.push(...flattenSchema(obj.children as typeof objects, path));
    }
  }
  return result;
}
