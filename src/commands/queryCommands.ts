import * as vscode from 'vscode';
import { CommandContext, clearQueryDecorations, showQueryResult, logQueryToOutput, logAndShowError, generateId, incrementQueryResultCounter, getOutputChannel } from './shared';
import { enhanceColumnError, getStatementAtOffset, firstSqlTokenOffset, parseTablesFromQuery } from '../utils/queryHelpers';
import { dbg } from '../utils/debug';

export function registerQueryCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  const { connectionManager, queryHistoryProvider, queryEditorProvider, resultPanelManager, tempFileManager, queryFileManager } = ctx;

  // Wire up TempFileManager callbacks
  tempFileManager.setOnSqlExecuted(async (sqlCtx, sql) => {
    const driver = sqlCtx.databaseName
      ? await connectionManager.getDriverForDatabase(sqlCtx.connectionId, sqlCtx.databaseName)
      : connectionManager.getDriver(sqlCtx.connectionId);
    if (!driver) return;
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    const errors: string[] = [];
    const insertedRows: Record<string, unknown>[] = [];
    for (const stmt of statements) {
      const result = await driver.execute(stmt);
      if (result.error) errors.push(result.error);
      else if (sqlCtx.context === 'insertRow' && result.rows.length > 0) {
        insertedRows.push(...result.rows);
      }
    }
    if (errors.length > 0) {
      logAndShowError(errors.join('; '));
    } else {
      const count = statements.length;
      if (sqlCtx.context === 'deleteRows') {
        vscode.window.showInformationMessage(vscode.l10n.t('{0} row(s) deleted.', count));
      } else if (sqlCtx.context === 'insertRow') {
        vscode.window.showInformationMessage(vscode.l10n.t('{0} row(s) inserted.', count));
      } else {
        vscode.window.showInformationMessage(vscode.l10n.t('{0} row(s) saved.', count));
      }
      if (sqlCtx.panelKey) {
        if (insertedRows.length > 0) {
          resultPanelManager.postMessage(sqlCtx.panelKey, { type: 'insertedRows', rows: insertedRows });
        }
        resultPanelManager.postMessage(sqlCtx.panelKey, { type: 'rerunQuery' });
      }
    }
  });

  tempFileManager.setOnSqlSaved(async (sqlCtx, sql) => {
    const state = connectionManager.get(sqlCtx.connectionId);
    const filePath = queryFileManager.createPinnedQueryFile(
      sqlCtx.connectionId, sql, sqlCtx.databaseName,
    );
    await queryHistoryProvider.addEntry({
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 8),
      connectionId: sqlCtx.connectionId,
      connectionName: state?.config.name || '',
      query: sql,
      executedAt: Date.now(),
      executionTimeMs: 0,
      rowCount: 0,
      pinned: true,
      filePath,
    });
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('viewstor.executeTempSql', async () => {
      await tempFileManager.executeSqlFromActiveEditor();
    }),

    vscode.commands.registerCommand('viewstor.runQuery', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      // If this is a temp SQL file (from Save Changes / Insert / Delete), execute it
      if (tempFileManager.isTempSqlFile(editor.document.uri)) {
        await tempFileManager.executeSqlFromActiveEditor();
        return;
      }

      const connectionId = queryEditorProvider.getConnectionIdFromUri(editor.document.uri);
      if (!connectionId) {
        vscode.window.showWarningMessage(vscode.l10n.t('No connection associated with this query tab.'));
        return;
      }

      // Auto-connect if disconnected
      const connState = connectionManager.get(connectionId);
      if (connState && !connState.connected) {
        try {
          await connectionManager.connect(connectionId);
        } catch (err) {
          logAndShowError(vscode.l10n.t('Connection failed: {0}', err instanceof Error ? err.message : String(err)));
          return;
        }
      }

      const databaseName = queryEditorProvider.getDatabaseNameFromUri(editor.document.uri);
      const driver = databaseName
        ? await connectionManager.getDriverForDatabase(connectionId, databaseName)
        : connectionManager.getDriver(connectionId);
      if (!driver) {
        vscode.window.showWarningMessage(vscode.l10n.t('Not connected. Please connect first.'));
        return;
      }

      const selection = editor.selection;
      const fullText = queryFileManager.isViewstorFile(editor.document.uri)
        ? queryFileManager.getQueryText(editor.document)
        : editor.document.getText();

      let query: string;
      let queryStartLine = 0;
      if (!selection.isEmpty) {
        query = editor.document.getText(selection);
        queryStartLine = selection.start.line;
      } else {
        const cursorOffset = editor.document.offsetAt(editor.selection.active);
        const rawText = editor.document.getText();
        const metadataOffset = rawText.length - fullText.length;
        const adjustedOffset = Math.max(0, cursorOffset - metadataOffset);
        const stmt = getStatementAtOffset(fullText, adjustedOffset);
        if (stmt) {
          query = stmt.text;
          const rawContent = rawText.substring(stmt.start + metadataOffset, stmt.end + metadataOffset);
          const sqlOffset = firstSqlTokenOffset(rawContent);
          queryStartLine = editor.document.positionAt(stmt.start + metadataOffset + sqlOffset).line;
        } else {
          query = fullText;
        }
      }

      if (!query.trim()) return;

      const state = connectionManager.get(connectionId);
      const globalSafeMode = vscode.workspace.getConfiguration('viewstor').get<string>('safeMode', 'warn');
      const safeMode = state?.config.safeMode || globalSafeMode;
      let finalQuery = query;

      // Auto-add LIMIT if missing on SELECT queries
      {
        const trimmed = query.trim().replace(/;+\s*$/, '');
        const upper = trimmed.toUpperCase();
        if (upper.startsWith('SELECT') && !upper.includes('LIMIT')) {
          const autoLimit = Math.max(
            vscode.workspace.getConfiguration('viewstor').get<number>('defaultPageSize', 100),
            1000,
          );
          finalQuery = trimmed + ` LIMIT ${autoLimit}`;
        } else {
          finalQuery = trimmed;
        }
      }

      // Safe mode: EXPLAIN check for full table scans
      const dbType = state?.config.type;
      const isSafeModeDB = dbType === 'postgresql' || dbType === 'sqlite' || dbType === 'clickhouse';
      if (safeMode !== 'off' && isSafeModeDB && finalQuery.trim().toUpperCase().startsWith('SELECT')) {
        try {
          const explainCmd = dbType === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ';
          const explainResult = await driver.execute(explainCmd + finalQuery);
          const plan = explainResult.rows.map(r => Object.values(r).join(' ')).join('\n');
          const limitMatch = finalQuery.match(/\bLIMIT\s+(\d+)/i);
          const limitValue = limitMatch ? parseInt(limitMatch[1], 10) : Infinity;
          const hasFullScan = dbType === 'postgresql' ? plan.includes('Seq Scan')
            : dbType === 'sqlite' ? plan.includes('SCAN TABLE')
            : dbType === 'clickhouse' ? plan.includes('Full') : false;
          const scanMatch = dbType === 'postgresql' ? plan.match(/Seq Scan on (\w+)/)
            : dbType === 'sqlite' ? plan.match(/SCAN TABLE (\w+)/)
            : null;
          dbg('safeMode', 'fullScan:', hasFullScan, 'limit:', limitValue, 'mode:', safeMode, 'db:', dbType);
          if (hasFullScan && limitValue > 1000) {
            const tableName = scanMatch ? scanMatch[1] : 'unknown';
            const scanLabel = dbType === 'sqlite' ? 'SCAN TABLE' : dbType === 'clickhouse' ? 'Full Scan' : 'Seq Scan';
            const message = vscode.l10n.t('{0} on "{1}" — may be slow on large tables.', scanLabel, tableName);

            if (safeMode === 'block') {
              const seeExplainBtn = vscode.l10n.t('See EXPLAIN');
              const cancelBtn = vscode.l10n.t('Cancel');
              const action = await vscode.window.showErrorMessage(
                vscode.l10n.t('Blocked: {0}', message),
                seeExplainBtn, cancelBtn
              );
              if (action === seeExplainBtn) {
                const doc = await vscode.workspace.openTextDocument({ content: plan, language: 'plaintext' });
                await vscode.window.showTextDocument(doc, { preview: true });
              }
              return;
            } else {
              const runAnywayBtn = vscode.l10n.t('Run Anyway');
              const seeExplainBtn2 = vscode.l10n.t('See EXPLAIN');
              const cancelBtn2 = vscode.l10n.t('Cancel');
              const action = await vscode.window.showWarningMessage(
                message,
                runAnywayBtn, seeExplainBtn2, cancelBtn2
              );
              if (action === seeExplainBtn2) {
                const doc = await vscode.workspace.openTextDocument({ content: plan, language: 'plaintext' });
                await vscode.window.showTextDocument(doc, { preview: true });
                return;
              }
              if (action !== runAnywayBtn) return;
            }
          }
        } catch { /* EXPLAIN failed — proceed anyway */ }
      }

      const shortQuery = finalQuery.length > 255 ? finalQuery.substring(0, 255) + '...' : finalQuery;
      clearQueryDecorations(editor);

      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Running: ${shortQuery}` },
          () => driver.execute(finalQuery)
        );

        if (result.error) {
          const enhanced = await enhanceColumnError(result.error, finalQuery, driver);
          logAndShowError(`${enhanced}\n\n---\n${shortQuery}`);
          const errorMsg = result.error.split('\n')[0];
          showQueryResult(editor, queryStartLine, `Error: ${errorMsg}`, true);
          logQueryToOutput(finalQuery, `Error: ${errorMsg}`, true);
        } else {
          const hasResultSet = result.columns.length > 0;
          if (hasResultSet) {
            const color = connectionManager.getConnectionColor(connectionId);
            const readonly = connectionManager.isConnectionReadonly(connectionId);
            const counter = incrementQueryResultCounter();

            let queryTableName: string | undefined;
            let querySchema: string | undefined;
            let queryPkColumns: string[] | undefined;
            let queryColumnInfo: Array<{ name: string; nullable: boolean; defaultValue?: string }> | undefined;
            const tables = parseTablesFromQuery(finalQuery);
            dbg('queryResult', 'tables:', tables, 'readonly:', readonly);
            if (tables.length === 1 && !readonly) {
              queryTableName = tables[0].table;
              querySchema = tables[0].schema;
              try {
                const tableInfo = await driver.getTableInfo(queryTableName, querySchema);
                const pks = tableInfo.columns.filter(c => c.isPrimaryKey).map(c => c.name);
                if (pks.length > 0) queryPkColumns = pks;
                queryColumnInfo = tableInfo.columns.map(c => ({ name: c.name, nullable: c.nullable, defaultValue: c.defaultValue }));
                dbg('queryResult', 'table:', queryTableName, 'schema:', querySchema, 'pkColumns:', queryPkColumns);
              } catch { /* table info unavailable — skip */ }
            }

            const queryLimitMatch = finalQuery.match(/\bLIMIT\s+(\d+)/i);
            const queryPageSize = queryLimitMatch
              ? Math.min(parseInt(queryLimitMatch[1], 10), 1000)
              : Math.min(result.rowCount, 1000);
            resultPanelManager.show(result, `Results #${counter} — ${state?.config.name || 'Query'}`, {
              color, readonly,
              connectionId: queryPkColumns ? connectionId : undefined,
              tableName: queryTableName,
              schema: querySchema,
              pkColumns: queryPkColumns,
              databaseName: queryPkColumns ? databaseName : undefined,
              databaseType: state?.config.type,
              columnInfo: queryColumnInfo,
              query: finalQuery,
              queryMode: true,
              pageSize: queryPageSize,
            });
            const resultMsg = `${result.rowCount} rows, ${result.executionTimeMs} ms`;
            showQueryResult(editor, queryStartLine, resultMsg, false);
            logQueryToOutput(finalQuery, resultMsg, false);
          } else {
            const affected = result.affectedRows ?? 0;
            const resultMsg = `${affected} rows affected, ${result.executionTimeMs} ms`;
            showQueryResult(editor, queryStartLine, resultMsg, false);
            logQueryToOutput(finalQuery, resultMsg, false);
            getOutputChannel().show(true);

          }
        }

        const cachedRows = result.rows.slice(0, 500);
        await queryHistoryProvider.addEntry({
          id: generateId(),
          connectionId,
          connectionName: state?.config.name || '',
          query,
          executedAt: Date.now(),
          executionTimeMs: result.executionTimeMs,
          rowCount: result.rowCount,
          error: result.error,
          cachedResult: !result.error ? { columns: result.columns, rows: cachedRows } : undefined,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logAndShowError(`${errorMsg}\n\n---\n${shortQuery}`);
      }
    }),

    vscode.commands.registerCommand('viewstor._executeSqlStatements', async (connectionId: string, sql: string, executionContext: string, tableName?: string, databaseName?: string) => {
      const driver = databaseName
        ? await connectionManager.getDriverForDatabase(connectionId, databaseName)
        : connectionManager.getDriver(connectionId);
      if (!driver) return;

      const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
      const errors: string[] = [];
      for (const stmt of statements) {
        const result = await driver.execute(stmt);
        if (result.error) errors.push(result.error);
      }

      if (errors.length > 0) {
        logAndShowError(errors.join('; '));
      } else {
        const count = statements.length;
        if (executionContext === 'deleteRows') {
          vscode.window.showInformationMessage(vscode.l10n.t('{0} row(s) deleted.', count));
        } else if (executionContext === 'insertRow') {
          vscode.window.showInformationMessage(vscode.l10n.t('Row inserted.'));
        } else {
          vscode.window.showInformationMessage(vscode.l10n.t('{0} row(s) saved.', count));
        }
        if (tableName) {
          const connState = connectionManager.get(connectionId);
          resultPanelManager.postMessage(`${tableName} — ${connState?.config.name}`, { type: 'rerunQuery' });
        }
      }
    }),

    vscode.commands.registerCommand('viewstor._cancelQuery', async (connectionId: string) => {
      const driver = connectionManager.getDriver(connectionId);
      if (driver?.cancelQuery) {
        try {
          await driver.cancelQuery();
          vscode.window.showInformationMessage(vscode.l10n.t('Query cancelled.'));
        } catch (err) {
          vscode.window.showWarningMessage(vscode.l10n.t('Cancel failed: {0}', err instanceof Error ? err.message : String(err)));
        }
      }
    }),
  );
}

