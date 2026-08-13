import * as vscode from 'vscode';
import { CommandContext, logQueryToOutput, logAndShowError, getRequiredDriver, wrapError, customQueryCountCache } from './shared';
import { SortColumn } from '../types/query';
import { enhanceColumnError, buildUpdateSql, buildDeleteSql, buildInsertDefaultSql, buildInsertRowSql, splitCustomQueryLimit, isReadOnlyQuery, RowEdit } from '../utils/queryHelpers';
import { dbg } from '../utils/debug';

export function registerTableCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  const { connectionManager, resultPanelManager, tempFileManager } = ctx;

  context.subscriptions.push(
    vscode.commands.registerCommand('viewstor.showTableData', async (item?: import('../views/connectionTree').ConnectionTreeItem) => {
      if (!item?.connectionId || !item.schemaObject) return;

      const state = connectionManager.get(item.connectionId);
      const title = `${item.schemaObject.name} — ${state?.config.name}`;
      const color = connectionManager.getConnectionColor(item.connectionId);
      resultPanelManager.showLoading(title, { color });

      const driver = await getRequiredDriver(connectionManager, item.connectionId, item.databaseName);
      if (!driver) { resultPanelManager.closePanel(title); return; }

      const pageSize = 100;

      try {
        const tableInfo = await driver.getTableInfo(item.schemaObject.name, item.schemaObject.schema);
        const pkColumns = tableInfo.columns.filter(c => c.isPrimaryKey).map(c => c.name);

        let totalRowCount: number | undefined;
        let isEstimatedCount = false;
        if (driver.getEstimatedRowCount) {
          totalRowCount = await driver.getEstimatedRowCount(item.schemaObject.name, item.schemaObject.schema);
          if (totalRowCount !== undefined && totalRowCount < 10000 && driver.getTableRowCount) {
            totalRowCount = await driver.getTableRowCount(item.schemaObject.name, item.schemaObject.schema);
            isEstimatedCount = false;
          } else {
            isEstimatedCount = true;
          }
        }

        const result = await driver.getTableData(item.schemaObject!.name, item.schemaObject!.schema, pageSize, 0);
        if (result.error) {
          if (result.query) logQueryToOutput(result.query, `Error: ${result.error.split('\n')[0]}`, true);
          resultPanelManager.closePanel(title);
          logAndShowError(vscode.l10n.t('Failed to load data: {0}', result.error));
          return;
        }
        if (result.query) logQueryToOutput(result.query, `${result.rowCount} rows, ${result.executionTimeMs} ms`, false);
        const readonly = connectionManager.isConnectionReadonly(item.connectionId);
        const columnInfoForWebview = tableInfo.columns.map(c => ({
          name: c.name, nullable: c.nullable, defaultValue: c.defaultValue,
        }));
        resultPanelManager.show(result, title, {
          connectionId: item.connectionId,
          tableName: item.schemaObject.name,
          schema: item.schemaObject.schema,
          pkColumns, color, readonly, pageSize, currentPage: 0, totalRowCount, isEstimatedCount,
          databaseName: item.databaseName,
          databaseType: state?.config.type,
          columnInfo: columnInfoForWebview,
        });
      } catch (err) {
        resultPanelManager.closePanel(title);
        logAndShowError(vscode.l10n.t('Failed to load data: {0}', wrapError(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor._fetchPage', async (connectionId: string, tableName: string, schema: string | undefined, page: number, pageSize: number, orderBy?: SortColumn[], databaseName?: string, explicitPanelKey?: string) => {
      const driver = await getRequiredDriver(connectionManager, connectionId, databaseName);
      if (!driver) return;

      try {
        let totalRowCount: number | undefined;
        let isEstimatedCount = false;
        if (driver.getEstimatedRowCount) {
          totalRowCount = await driver.getEstimatedRowCount(tableName, schema);
          if (totalRowCount !== undefined && totalRowCount < 10000 && driver.getTableRowCount) {
            totalRowCount = await driver.getTableRowCount(tableName, schema);
            isEstimatedCount = false;
          } else {
            isEstimatedCount = true;
          }
        }
        const offset = page * pageSize;

        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Loading {0}...', tableName) },
          () => driver.getTableData(tableName, schema, pageSize, offset, orderBy),
        );
        if (result.error) {
          if (result.query) logQueryToOutput(result.query, `Error: ${result.error.split('\n')[0]}`, true);
          logAndShowError(vscode.l10n.t('Failed to load data: {0}', result.error));
          resultPanelManager.postMessage(explicitPanelKey || `${tableName} — ${connectionManager.get(connectionId)?.config.name}`, { type: 'hideLoading' });
          return;
        }
        if (result.query) logQueryToOutput(result.query, `${result.rowCount} rows, ${result.executionTimeMs} ms`, false);
        const state = connectionManager.get(connectionId);
        const panelKey = explicitPanelKey || `${tableName} — ${state?.config.name}`;
        resultPanelManager.postMessage(panelKey, {
          type: 'updateData',
          columns: result.columns,
          rows: result.rows,
          rowCount: totalRowCount ?? result.rowCount,
          executionTimeMs: result.executionTimeMs,
          currentPage: page,
          totalPages: totalRowCount ? Math.max(1, Math.ceil(totalRowCount / pageSize)) : 1,
          isEstimatedCount,
        });
      } catch (err) {
        logAndShowError(vscode.l10n.t('Failed to load data: {0}', wrapError(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor._saveEdits', async (connectionId: string, tableName: string, schema: string | undefined, pkColumns: string[], edits: RowEdit[], databaseName?: string, explicitPanelKey?: string) => {
      dbg('saveEdits', 'connectionId:', connectionId, 'table:', tableName, 'schema:', schema, 'pkColumns:', pkColumns, 'edits:', edits.length, 'db:', databaseName, 'panelKey:', explicitPanelKey);
      const driver = await getRequiredDriver(connectionManager, connectionId, databaseName);
      if (!driver) { dbg('saveEdits', 'no driver found'); return; }

      const state = connectionManager.get(connectionId);
      const panelKey = explicitPanelKey || `${tableName} — ${state?.config.name}`;

      const statements = edits.map(edit => buildUpdateSql(tableName, schema, pkColumns, edit) + ';');

      const confirmEdits = vscode.workspace.getConfiguration('viewstor').get<boolean>('confirmEdits', true);

      if (confirmEdits) {
        const fullSql = statements.join('\n');
        await tempFileManager.openSqlEditor(fullSql, {
          panelKey, connectionId, tableName, databaseName, context: 'saveEdits',
        });
        return;
      } else {
        const errors: string[] = [];
        for (const sql of statements) {
          const result = await driver.execute(sql.replace(/;+\s*$/, ''));
          if (result.error) errors.push(result.error);
        }

        if (errors.length > 0) {
          logAndShowError(vscode.l10n.t('Save errors: {0}', errors.join('; ')));
        } else {
          vscode.window.showInformationMessage(vscode.l10n.t('{0} row(s) saved.', statements.length));
        }
      }
    }),

    vscode.commands.registerCommand('viewstor._insertRow', async (connectionId: string, tableName: string, schema: string | undefined, _row: Record<string, unknown>, databaseName?: string, explicitPanelKey?: string) => {
      const driver = await getRequiredDriver(connectionManager, connectionId, databaseName);
      if (!driver) return;

      const state = connectionManager.get(connectionId);
      const panelKey = explicitPanelKey || `${tableName} — ${state?.config.name}`;

      const tableInfo = await driver.getTableInfo(tableName, schema);
      const colNames = tableInfo.columns.map(c => c.name);
      const sql = buildInsertDefaultSql(tableName, schema, colNames) + ';';

      const confirmEdits = vscode.workspace.getConfiguration('viewstor').get<boolean>('confirmEdits', true);
      if (confirmEdits) {
        await tempFileManager.openSqlEditor(sql, {
          panelKey, connectionId, tableName, databaseName, context: 'insertRow',
        });
        return;
      }

      const result = await driver.execute(sql.replace(/;+\s*$/, ''));
      if (result.error) {
        logAndShowError(vscode.l10n.t('Insert failed: {0}', result.error));
      } else {
        vscode.window.showInformationMessage(vscode.l10n.t('Row inserted.'));
        resultPanelManager.postMessage(panelKey, { type: 'rerunQuery' });
      }
    }),

    vscode.commands.registerCommand('viewstor._insertRows', async (connectionId: string, tableName: string, schema: string | undefined, rows: Array<{ values: Record<string, unknown>; columnTypes: Record<string, string> }>, databaseName?: string, explicitPanelKey?: string) => {
      dbg('insertRows', 'table:', tableName, 'rowCount:', rows.length);
      const driver = await getRequiredDriver(connectionManager, connectionId, databaseName);
      if (!driver) return;

      const statements = rows.map(row => buildInsertRowSql(tableName, schema, row.values, row.columnTypes) + ';');
      const confirmEdits = vscode.workspace.getConfiguration('viewstor').get<boolean>('confirmEdits', true);

      const state = connectionManager.get(connectionId);
      const panelKey = explicitPanelKey || `${tableName} — ${state?.config.name}`;

      if (confirmEdits) {
        const fullSql = statements.join('\n');
        await tempFileManager.openSqlEditor(fullSql, {
          panelKey, connectionId, tableName, databaseName, context: 'insertRow',
        });
      } else {
        const errors: string[] = [];
        const insertedRows: Record<string, unknown>[] = [];
        for (const sql of statements) {
          const result = await driver.execute(sql.replace(/;+\s*$/, ''));
          if (result.error) errors.push(result.error);
          else if (result.rows.length > 0) insertedRows.push(...result.rows);
        }
        if (errors.length > 0) {
          logAndShowError(vscode.l10n.t('Insert errors: {0}', errors.join('; ')));
        } else {
          vscode.window.showInformationMessage(vscode.l10n.t('{0} row(s) inserted.', statements.length));
          if (insertedRows.length > 0) {
            resultPanelManager.postMessage(panelKey, { type: 'insertedRows', rows: insertedRows });
          }
          resultPanelManager.postMessage(panelKey, { type: 'rerunQuery' });
        }
      }
    }),

    vscode.commands.registerCommand('viewstor._saveAll', async (connectionId: string, tableName: string, schema: string | undefined, pkColumns: string[], inserts: Array<{ values: Record<string, unknown>; columnTypes: Record<string, string> }>, edits: RowEdit[], databaseName?: string, explicitPanelKey?: string) => {
      dbg('saveAll', 'table:', tableName, 'inserts:', inserts.length, 'edits:', edits.length);
      const driver = await getRequiredDriver(connectionManager, connectionId, databaseName);
      if (!driver) return;

      const state = connectionManager.get(connectionId);
      const panelKey = explicitPanelKey || `${tableName} — ${state?.config.name}`;

      const insertStatements = inserts.map(row => buildInsertRowSql(tableName, schema, row.values, row.columnTypes) + ';');
      const editStatements = edits.map(edit => buildUpdateSql(tableName, schema, pkColumns, edit) + ';');
      const allStatements = [...insertStatements, ...editStatements];
      if (allStatements.length === 0) return;

      const confirmEdits = vscode.workspace.getConfiguration('viewstor').get<boolean>('confirmEdits', true);
      if (confirmEdits) {
        const fullSql = allStatements.join('\n');
        const sqlContext = inserts.length > 0 && edits.length > 0 ? 'saveEdits' : inserts.length > 0 ? 'insertRow' : 'saveEdits';
        await tempFileManager.openSqlEditor(fullSql, {
          panelKey, connectionId, tableName, databaseName, context: sqlContext,
        });
      } else {
        const errors: string[] = [];
        const insertedRows: Record<string, unknown>[] = [];
        for (const sql of insertStatements) {
          const result = await driver.execute(sql.replace(/;+\s*$/, ''));
          if (result.error) errors.push(result.error);
          else if (result.rows.length > 0) insertedRows.push(...result.rows);
        }
        if (errors.length > 0) {
          logAndShowError(vscode.l10n.t('Insert errors: {0}', errors.join('; ')));
          return;
        }
        for (const sql of editStatements) {
          const result = await driver.execute(sql.replace(/;+\s*$/, ''));
          if (result.error) errors.push(result.error);
        }
        if (errors.length > 0) {
          logAndShowError(vscode.l10n.t('Save errors: {0}', errors.join('; ')));
        } else {
          vscode.window.showInformationMessage(vscode.l10n.t('{0} row(s) saved.', allStatements.length));
          if (insertedRows.length > 0) {
            resultPanelManager.postMessage(panelKey, { type: 'insertedRows', rows: insertedRows });
          }
          resultPanelManager.postMessage(panelKey, { type: 'rerunQuery' });
        }
      }
    }),

    vscode.commands.registerCommand('viewstor._deleteRows', async (connectionId: string, tableName: string, schema: string | undefined, pkColumns: string[], rows: Record<string, unknown>[], databaseName?: string, pkTypes?: Record<string, string>, explicitPanelKey?: string) => {
      const driver = await getRequiredDriver(connectionManager, connectionId, databaseName);
      if (!driver) return;

      const statements = rows.map(pkValues => buildDeleteSql(tableName, schema, pkColumns, pkValues, pkTypes) + ';');

      const state = connectionManager.get(connectionId);
      const panelKey = explicitPanelKey || `${tableName} — ${state?.config.name}`;
      await tempFileManager.openSqlEditor(statements.join('\n'), {
        panelKey, connectionId, tableName, databaseName, context: 'deleteRows',
      });
    }),

    vscode.commands.registerCommand('viewstor._runCustomTableQuery', async (connectionId: string, tableName: string, _schema: string | undefined, query: string, pageSize: number, databaseName?: string, explicitPanelKey?: string, page: number = 0) => {
      const driver = await getRequiredDriver(connectionManager, connectionId, databaseName);
      if (!driver) return;
      const state = connectionManager.get(connectionId);
      const panelKey = explicitPanelKey || `${tableName} — ${state?.config.name}`;
      try {
        const cleaned = query.trim().replace(/;+\s*$/, '');

        // Block anything that mutates data — the table view SQL is for exploration, not DDL/DML
        if (!isReadOnlyQuery(cleaned)) {
          logAndShowError(vscode.l10n.t('Only read-only queries (SELECT / WITH / EXPLAIN / SHOW / VALUES) are allowed in the table SQL bar.'));
          resultPanelManager.postMessage(panelKey, { type: 'hideLoading' });
          return;
        }

        const { baseQuery, userLimit, userOffset } = splitCustomQueryLimit(cleaned);

        let paginatedQuery: string;
        let totalCount: number | undefined;
        let isEstimatedCount = false;

        // Disable auto-pagination when the user pinned an explicit OFFSET — combining their
        // starting point with our page offset would silently shift the window.
        const userControlsWindow =
          userOffset !== undefined ||
          (userLimit !== undefined && userLimit <= pageSize);

        if (userControlsWindow) {
          paginatedQuery = cleaned;
        } else {
          const offset = page * pageSize;
          // Cap pageLimit to what user asked for, so LIMIT 250 / pageSize 100 yields 100+100+50
          let pageLimit = pageSize;
          if (userLimit !== undefined) {
            pageLimit = Math.max(0, Math.min(pageSize, userLimit - offset));
          }
          paginatedQuery = `${baseQuery} LIMIT ${pageLimit} OFFSET ${offset}`;

          // Reuse the previously-computed COUNT for the same base query — page flips on a
          // 50M-row scan should not re-execute the full COUNT(*).
          const cached = customQueryCountCache.get(panelKey);
          if (cached && cached.baseQuery === baseQuery) {
            totalCount = cached.count;
          } else {
            try {
              const countResult = await driver.execute(`SELECT COUNT(*) AS cnt FROM (${baseQuery}) _viewstor_cnt`);
              if (!countResult.error && countResult.rows.length > 0) {
                const row = countResult.rows[0] as Record<string, unknown>;
                const raw = row.cnt ?? Object.values(row)[0];
                const parsed = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
                if (Number.isFinite(parsed)) {
                  totalCount = parsed;
                  customQueryCountCache.set(panelKey, { baseQuery, count: parsed });
                }
              }
            } catch {
              // count failed — fall through to heuristic below
            }
          }
          if (userLimit !== undefined && totalCount !== undefined) {
            totalCount = Math.min(totalCount, userLimit);
          }
        }

        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Running query...') },
          () => driver.execute(paginatedQuery),
        );
        if (result.error) {
          const shortQ = paginatedQuery.length > 255 ? paginatedQuery.substring(0, 255) + '...' : paginatedQuery;
          const enhanced = await enhanceColumnError(result.error, paginatedQuery, driver);
          logAndShowError(`${enhanced}\n\n---\n${shortQ}`);
          logQueryToOutput(paginatedQuery, `Error: ${result.error.split('\n')[0]}`, true);
          resultPanelManager.postMessage(panelKey, { type: 'hideLoading' });
          return;
        }
        logQueryToOutput(paginatedQuery, `${result.rowCount} rows, ${result.executionTimeMs} ms`, false);

        if (totalCount === undefined) {
          // Count unknown — base total on what we see: assume at least one more page if page was full
          const seen = page * pageSize + result.rowCount;
          totalCount = result.rowCount === pageSize ? seen + 1 : seen;
          isEstimatedCount = result.rowCount === pageSize;
        }

        resultPanelManager.postMessage(panelKey, {
          type: 'updateData',
          columns: result.columns,
          rows: result.rows,
          rowCount: totalCount,
          executionTimeMs: result.executionTimeMs,
          currentPage: page,
          totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
          isEstimatedCount,
        });
      } catch (err) {
        const shortQ = query.length > 255 ? query.substring(0, 255) + '...' : query;
        const errorMsg = wrapError(err);
        logAndShowError(`${errorMsg}\n\n---\n${shortQ}`);
        resultPanelManager.postMessage(panelKey, { type: 'hideLoading' });
      }
    }),

    vscode.commands.registerCommand('viewstor._refreshCount', async (connectionId: string, tableName: string, schema: string | undefined, panelKey: string, databaseName?: string) => {
      const driver = await getRequiredDriver(connectionManager, connectionId, databaseName);
      if (!driver || !driver.getTableRowCount) return;
      try {
        const count = await driver.getTableRowCount(tableName, schema);
        resultPanelManager.postMessage(panelKey, { type: 'updateRowCount', count });
      } catch (err) {
        logAndShowError(vscode.l10n.t('Failed to count rows: {0}', wrapError(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor._openJsonInTab', async (jsonStr: string) => {
      const doc = await vscode.workspace.openTextDocument({
        content: jsonStr,
        language: 'json',
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    // MCP: open table data view with optional custom query
    vscode.commands.registerCommand('viewstor._openTableDataFromMcp', async (
      connectionId: string, tableName: string, schema?: string,
      databaseName?: string, customQuery?: string, execute?: boolean,
    ) => {
      const driver = await getRequiredDriver(connectionManager, connectionId, databaseName);
      if (!driver) return;

      const state = connectionManager.get(connectionId);
      const title = `${tableName} — ${state?.config.name}`;
      const color = connectionManager.getConnectionColor(connectionId);
      const readonly = connectionManager.isConnectionReadonly(connectionId);
      const pageSize = 100;

      resultPanelManager.showLoading(title, { color });

      try {
        const tableInfo = await driver.getTableInfo(tableName, schema);
        const pkColumns = tableInfo.columns.filter(c => c.isPrimaryKey).map(c => c.name);

        let totalRowCount: number | undefined;
        let isEstimatedCount = false;
        if (driver.getEstimatedRowCount) {
          totalRowCount = await driver.getEstimatedRowCount(tableName, schema);
          if (totalRowCount !== undefined && totalRowCount < 10000 && driver.getTableRowCount) {
            totalRowCount = await driver.getTableRowCount(tableName, schema);
          } else {
            isEstimatedCount = true;
          }
        }

        const result = await driver.getTableData(tableName, schema, pageSize, 0);
        if (result.error) {
          resultPanelManager.closePanel(title);
          return;
        }

        const columnInfoForWebview = tableInfo.columns.map(c => ({
          name: c.name, nullable: c.nullable, defaultValue: c.defaultValue,
        }));
        resultPanelManager.show(result, title, {
          connectionId,
          tableName,
          schema,
          pkColumns, color, readonly, pageSize, currentPage: 0, totalRowCount, isEstimatedCount,
          databaseName,
          databaseType: state?.config.type,
          columnInfo: columnInfoForWebview,
          query: customQuery,
        });

        if (customQuery && execute) {
          const limitMatch = customQuery.match(/LIMIT\s+(\d+)/i);
          const queryPageSize = limitMatch ? Math.min(parseInt(limitMatch[1], 10), 1000) : pageSize;
          await new Promise(resolve => setTimeout(resolve, 200));
          await vscode.commands.executeCommand(
            'viewstor._runCustomTableQuery',
            connectionId, tableName, schema, customQuery, queryPageSize, databaseName, title,
          );
        }
      } catch (err) {
        resultPanelManager.closePanel(title);
      }
    }),
  );
}
