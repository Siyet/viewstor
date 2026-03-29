import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';

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
