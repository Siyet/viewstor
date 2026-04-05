import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { ConnectionTreeProvider, ConnectionTreeItem } from '../views/connectionTree';
import { QueryHistoryProvider } from '../views/queryHistory';
import { QueryEditorProvider, QueryDocumentProvider } from '../editors/queryEditor';
import { ResultPanelManager } from '../views/resultPanel';
import { ConnectionFormPanel } from '../views/connectionForm';
import { FolderFormPanel } from '../views/folderForm';
import { SortColumn, QueryResult, QueryColumn, QueryHistoryEntry } from '../types/query';
import { ExportService } from '../services/exportService';
import { ImportSource, parseImportFile } from '../services/importService';
import { enhanceColumnError, buildUpdateSql, buildDeleteSql, buildInsertDefaultSql, buildInsertRowSql, getStatementAtOffset, splitStatements, firstSqlTokenOffset, parseTablesFromQuery } from '../utils/queryHelpers';
import { TempFileManager } from '../services/tempFileManager';
import { QueryFileManager } from '../services/queryFileManager';
import { dbg } from '../utils/debug';

interface CommandContext {
  connectionManager: ConnectionManager;
  connectionTreeProvider: ConnectionTreeProvider;
  queryHistoryProvider: QueryHistoryProvider;
  queryEditorProvider: QueryEditorProvider;
  resultPanelManager: ResultPanelManager;
  connectionFormPanel: ConnectionFormPanel;
  folderFormPanel: FolderFormPanel;
  outputChannel: vscode.LogOutputChannel;
  tempFileManager: TempFileManager;
  queryFileManager: QueryFileManager;
}

let queryResultCounter = 0;
const historyDocMap = new Map<string, string>(); // entry.id → doc URI
let _outputChannel: vscode.LogOutputChannel;

// --- Query result CodeLens + gutter icons ---

interface QueryResultInfo {
  line: number;
  text: string;
  isError: boolean;
  timestamp: string;
}

// Per-document query results for CodeLens + gutter
const queryResults = new Map<string, QueryResultInfo[]>();
let codeLensEmitter: vscode.EventEmitter<void>;

class QueryCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor() {
    codeLensEmitter = this._onDidChangeCodeLenses;
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const results = queryResults.get(document.uri.toString()) || [];

    // Play buttons for each statement
    const fullText = document.getText();
    // Skip metadata line
    const firstLine = document.lineAt(0).text;
    const hasMetadata = firstLine.startsWith('-- viewstor:');
    const statementsText = hasMetadata
      ? fullText.substring(fullText.indexOf('\n') + 1)
      : fullText;
    const metadataOffset = fullText.length - statementsText.length;

    const stmts = splitStatements(statementsText);
    for (const stmt of stmts) {
      const rawContent = statementsText.substring(stmt.start, stmt.end);
      const sqlOffset = firstSqlTokenOffset(rawContent);
      const stmtLine = document.positionAt(stmt.start + metadataOffset + sqlOffset).line;
      const range = new vscode.Range(stmtLine, 0, stmtLine, 0);

      const result = results.find(r => r.line === stmtLine);
      if (result) {
        // Result + rerun on same line
        const icon = result.isError ? '$(error)' : '$(check)';
        lenses.push(new vscode.CodeLens(range, {
          title: `${icon} ${result.timestamp}  ${result.text}`,
          command: 'viewstor._showOutputChannel',
          tooltip: vscode.l10n.t('Show query log'),
        }));
        lenses.push(new vscode.CodeLens(range, {
          title: '$(play)  Rerun Query',
          command: 'viewstor._runStatementAtLine',
          arguments: [stmtLine],
          tooltip: vscode.l10n.t('Re-run this statement'),
        }));
      } else {
        // Play button only
        lenses.push(new vscode.CodeLens(range, {
          title: '$(play)  Run Query',
          command: 'viewstor._runStatementAtLine',
          arguments: [stmtLine],
          tooltip: vscode.l10n.t('Execute this statement'),
        }));
      }
    }

    return lenses;
  }
}

// Gutter decoration types
const gutterDecoSuccess = vscode.window.createTextEditorDecorationType({
  gutterIconPath: vscode.Uri.parse('data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#4ec9b0" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm3.35 4.65a.5.5 0 0 0-.7 0L7 9.3 5.35 7.65a.5.5 0 1 0-.7.7l2 2a.5.5 0 0 0 .7 0l4-4a.5.5 0 0 0 0-.7z"/></svg>'
  )),
  gutterIconSize: '80%',
});
const gutterDecoError = vscode.window.createTextEditorDecorationType({
  gutterIconPath: vscode.Uri.parse('data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#f44747" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm2.65 3.65a.5.5 0 0 0-.7 0L8 6.59 6.05 4.65a.5.5 0 1 0-.7.7L7.29 7.3 5.35 9.25a.5.5 0 1 0 .7.7L8 8.01l1.95 1.94a.5.5 0 0 0 .7-.7L8.71 7.3l1.94-1.95a.5.5 0 0 0 0-.7z"/></svg>'
  )),
  gutterIconSize: '80%',
});

function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function updateGutterIcons(editor: vscode.TextEditor) {
  const results = queryResults.get(editor.document.uri.toString()) || [];
  const successRanges: vscode.Range[] = [];
  const errorRanges: vscode.Range[] = [];
  for (const result of results) {
    const range = new vscode.Range(result.line, 0, result.line, 0);
    if (result.isError) {
      errorRanges.push(range);
    } else {
      successRanges.push(range);
    }
  }
  editor.setDecorations(gutterDecoSuccess, successRanges);
  editor.setDecorations(gutterDecoError, errorRanges);
}

function clearQueryDecorations(editor: vscode.TextEditor) {
  editor.setDecorations(gutterDecoSuccess, []);
  editor.setDecorations(gutterDecoError, []);
}

function showQueryResult(editor: vscode.TextEditor, line: number, resultText: string, isError: boolean) {
  const ts = formatTimestamp();
  const docUri = editor.document.uri.toString();

  // Add result to CodeLens data (replace previous result on same line)
  let results = queryResults.get(docUri);
  if (!results) {
    results = [];
    queryResults.set(docUri, results);
  }
  const existing = results.findIndex(r => r.line === line);
  const info: QueryResultInfo = { line, text: resultText, isError, timestamp: ts };
  if (existing >= 0) {
    results[existing] = info;
  } else {
    results.push(info);
  }

  // Update all gutter icons (handles mixed success/error)
  updateGutterIcons(editor);

  // Trigger CodeLens refresh
  codeLensEmitter.fire();
}

function logQueryToOutput(sql: string, resultText: string, isError: boolean) {
  const shortSql = sql.replace(/\s+/g, ' ').trim();
  _outputChannel.info(shortSql);
  if (isError) {
    _outputChannel.error(resultText);
  } else {
    _outputChannel.info(resultText);
  }
  _outputChannel.info('────────────────────────────────────────');
}

export function registerCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  const { connectionManager, connectionTreeProvider, queryHistoryProvider, queryEditorProvider, resultPanelManager, connectionFormPanel, folderFormPanel, outputChannel, tempFileManager, queryFileManager } = ctx;
  _outputChannel = outputChannel;

  // Register CodeLens provider for query results
  const codeLensProvider = new QueryCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, codeLensProvider),
    vscode.commands.registerCommand('viewstor._showOutputChannel', () => {
      _outputChannel.show(true);
    }),
    vscode.commands.registerCommand('viewstor._runStatementAtLine', async (line: number) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      // Move cursor to the target line and run query
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      await vscode.commands.executeCommand('viewstor.runQuery');
    }),
  );

  // Clear results when document changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      queryResults.delete(e.document.uri.toString());
      codeLensEmitter.fire();
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.toString() === e.document.uri.toString()) {
        clearQueryDecorations(editor);
      }
    }),
  );

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
    vscode.workspace.registerTextDocumentContentProvider('viewstor', new QueryDocumentProvider())
  );

  context.subscriptions.push(
    // No-op command for tree item click interception
    vscode.commands.registerCommand('viewstor._noop', () => {}),

    vscode.commands.registerCommand('viewstor.addConnection', (item?: ConnectionTreeItem) => {
      if (item?.itemType === 'folder' && item.folderId) {
        const folder = connectionManager.getFolder(item.folderId);
        connectionFormPanel.open(undefined, {
          folderId: item.folderId,
          readonly: folder?.readonly,
        });
      } else {
        connectionFormPanel.open();
      }
    }),

    vscode.commands.registerCommand('viewstor.removeConnection', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId) return;
      const state = connectionManager.get(item.connectionId);
      if (!state) return;
      const removeBtn = vscode.l10n.t('Remove');
      const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t('Remove connection "{0}"?', state.config.name), { modal: true }, removeBtn
      );
      if (confirm !== removeBtn) return;
      await connectionManager.remove(item.connectionId);
    }),

    vscode.commands.registerCommand('viewstor.editConnection', (item?: ConnectionTreeItem) => {
      if (!item?.connectionId) return;
      const state = connectionManager.get(item.connectionId);
      if (!state) return;
      connectionFormPanel.open(state.config);
    }),

    vscode.commands.registerCommand('viewstor.connect', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId) return;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Connecting...') },
          () => connectionManager.connect(item.connectionId!)
        );
      } catch (err) {
        logAndShowError(vscode.l10n.t('Connection failed: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor.disconnect', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId) return;
      await connectionManager.disconnect(item.connectionId);
    }),

    vscode.commands.registerCommand('viewstor.refreshConnection', () => {
      connectionTreeProvider.refresh(true);
    }),

    vscode.commands.registerCommand('viewstor.openQuery', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId) return;
      const state = connectionManager.get(item.connectionId);
      if (state && !state.connected) {
        try {
          await connectionManager.connect(item.connectionId);
        } catch (err) {
          logAndShowError(vscode.l10n.t('Connection failed: {0}', err instanceof Error ? err.message : String(err)));
          return;
        }
      }
      await queryEditorProvider.openNewQuery(item.connectionId, item.databaseName);
    }),

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
        // Find the statement at cursor position
        const cursorOffset = editor.document.offsetAt(editor.selection.active);
        // If file has metadata, adjust offset for stripped content
        const rawText = editor.document.getText();
        const metadataOffset = rawText.length - fullText.length;
        const stmt = getStatementAtOffset(fullText, cursorOffset - metadataOffset);
        if (stmt) {
          query = stmt.text;
          // Skip leading whitespace to find actual statement start line
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

      // Auto-add LIMIT if missing on SELECT queries (always, regardless of safe mode)
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

      // Safe mode: EXPLAIN check for seq scans (PostgreSQL only)
      if (safeMode !== 'off' && state?.config.type === 'postgresql' && finalQuery.trim().toUpperCase().startsWith('SELECT')) {
        try {
          const explainResult = await driver.execute('EXPLAIN ' + finalQuery);
          const plan = explainResult.rows.map(r => Object.values(r).join(' ')).join('\n');
          // Skip warning when LIMIT is small — Seq Scan with a small LIMIT is harmless
          const limitMatch = finalQuery.match(/\bLIMIT\s+(\d+)/i);
          const limitValue = limitMatch ? parseInt(limitMatch[1], 10) : Infinity;
          dbg('safeMode', 'seqScan:', plan.includes('Seq Scan'), 'limit:', limitValue, 'mode:', safeMode);
          if (plan.includes('Seq Scan') && limitValue > 1000) {
            const seqMatch = plan.match(/Seq Scan on (\w+)/);
            const tableName = seqMatch ? seqMatch[1] : 'unknown';

            // Create a diagnostic with the EXPLAIN plan attached for AI agents
            const message = vscode.l10n.t('Seq Scan on "{0}" — may be slow on large tables.', tableName);

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
      // Clear previous decorations before execution
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
          showQueryResult(editor, queryStartLine,`Error: ${errorMsg}`, true);
          logQueryToOutput(finalQuery, `Error: ${errorMsg}`, true);
        } else {
          const hasResultSet = result.columns.length > 0;
          if (hasResultSet) {
            const color = connectionManager.getConnectionColor(connectionId);
            const readonly = connectionManager.isConnectionReadonly(connectionId);
            queryResultCounter++;

            // For single-table SELECTs, resolve PK so edits work in query mode
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

            resultPanelManager.show(result, `Results #${queryResultCounter} — ${state?.config.name || 'Query'}`, {
              color, readonly,
              connectionId: queryPkColumns ? connectionId : undefined,
              tableName: queryTableName,
              schema: querySchema,
              pkColumns: queryPkColumns,
              databaseName: queryPkColumns ? databaseName : undefined,
              columnInfo: queryColumnInfo,
              query: finalQuery,
              queryMode: true,
            });
            const resultMsg = `${result.rowCount} rows, ${result.executionTimeMs} ms`;
            showQueryResult(editor, queryStartLine,resultMsg, false);
            logQueryToOutput(finalQuery, resultMsg, false);
          } else {
            const affected = result.affectedRows ?? 0;
            const resultMsg = `${affected} rows affected, ${result.executionTimeMs} ms`;
            showQueryResult(editor, queryStartLine,resultMsg, false);
            logQueryToOutput(finalQuery, resultMsg, false);
            _outputChannel.show(true);
          }
        }

        // Cache up to 500 rows to keep globalState reasonable
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

    vscode.commands.registerCommand('viewstor.exportResults', async (resultData?: { columns: QueryColumn[]; rows: Record<string, unknown>[]; format?: string }) => {
      if (!resultData || !resultData.columns || resultData.columns.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t('No data to export.'));
        return;
      }
      const result: QueryResult = {
        columns: resultData.columns,
        rows: resultData.rows,
        rowCount: resultData.rows.length,
        executionTimeMs: 0,
      };

      const formatValue = resultData.format;
      if (!formatValue) return;

      const formatLabels: Record<string, string> = {
        csv: 'CSV', tsv: 'TSV', 'csv-semicolon': 'CSV (semicolon)', json: 'JSON', markdown: 'Markdown Table',
      };

      let content: string;
      let lang: string;
      switch (formatValue) {
        case 'csv': content = ExportService.toCsv(result); lang = 'csv'; break;
        case 'tsv': content = ExportService.toTsv(result); lang = 'plaintext'; break;
        case 'csv-semicolon': content = ExportService.toCsv(result, { delimiter: ';' }); lang = 'csv'; break;
        case 'json': content = ExportService.toJson(result); lang = 'json'; break;
        case 'markdown': content = ExportService.toMarkdownTable(result); lang = 'markdown'; break;
        default: return;
      }

      const action = await vscode.window.showQuickPick([
        { label: vscode.l10n.t('Open in Editor'), value: 'editor' },
        { label: vscode.l10n.t('Save to File'), value: 'file' },
        { label: vscode.l10n.t('Copy to Clipboard'), value: 'clipboard' },
      ], { placeHolder: vscode.l10n.t('Action') });
      if (!action) return;

      switch (action.value) {
        case 'editor': {
          const doc = await vscode.workspace.openTextDocument({ content, language: lang });
          await vscode.window.showTextDocument(doc);
          break;
        }
        case 'file': {
          const ext = formatValue === 'json' ? 'json' : formatValue === 'markdown' ? 'md' : formatValue === 'tsv' ? 'tsv' : 'csv';
          const label = formatLabels[formatValue] || 'Export';
          const uri = await vscode.window.showSaveDialog({ filters: { [label]: [ext] } });
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
            vscode.window.showInformationMessage(vscode.l10n.t('Exported to {0}', uri.fsPath));
          }
          break;
        }
        case 'clipboard':
          await vscode.env.clipboard.writeText(content);
          vscode.window.showInformationMessage(vscode.l10n.t('Copied to clipboard'));
          break;
      }
    }),

    vscode.commands.registerCommand('viewstor.showTableData', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId || !item.schemaObject) return;

      const driver = item.databaseName
        ? await connectionManager.getDriverForDatabase(item.connectionId, item.databaseName)
        : connectionManager.getDriver(item.connectionId);
      if (!driver) return;

      const pageSize = 100;

      try {
        const tableInfo = await driver.getTableInfo(item.schemaObject.name, item.schemaObject.schema);
        const pkColumns = tableInfo.columns.filter(c => c.isPrimaryKey).map(c => c.name);

        // Use estimated count; if < 100k, get exact count (fast enough)
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

        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Loading {0}...', item.schemaObject.name) },
          () => driver.getTableData(item.schemaObject!.name, item.schemaObject!.schema, pageSize, 0),
        );
        if (result.error) {
          logAndShowError(vscode.l10n.t('Failed to load data: {0}', result.error));
          return;
        }
        const state = connectionManager.get(item.connectionId);
        const title = `${item.schemaObject.name} — ${state?.config.name}`;
        const color = connectionManager.getConnectionColor(item.connectionId);
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
          columnInfo: columnInfoForWebview,
        });
      } catch (err) {
        logAndShowError(vscode.l10n.t('Failed to load data: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor._fetchPage', async (connectionId: string, tableName: string, schema: string | undefined, page: number, pageSize: number, orderBy?: SortColumn[], databaseName?: string, explicitPanelKey?: string) => {
      const driver = databaseName
        ? await connectionManager.getDriverForDatabase(connectionId, databaseName)
        : connectionManager.getDriver(connectionId);
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
          logAndShowError(vscode.l10n.t('Failed to load data: {0}', result.error));
          resultPanelManager.postMessage(explicitPanelKey || `${tableName} — ${connectionManager.get(connectionId)?.config.name}`, { type: 'hideLoading' });
          return;
        }
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
        logAndShowError(vscode.l10n.t('Failed to load data: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor._exportAllData', async (connectionId: string, tableName: string, schema: string | undefined, format: string, orderBy?: SortColumn[], customQuery?: string, databaseName?: string) => {
      const driver = databaseName
        ? await connectionManager.getDriverForDatabase(connectionId, databaseName)
        : connectionManager.getDriver(connectionId);
      if (!driver) return;

      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Exporting {0}...', tableName), cancellable: false },
          () => customQuery
            ? driver.execute(customQuery.replace(/LIMIT\s+\d+/i, 'LIMIT 100000'))
            : driver.getTableData(tableName, schema, 100000, 0, orderBy),
        );

        const formatLabels: Record<string, string> = {
          csv: 'CSV', tsv: 'TSV', 'csv-semicolon': 'CSV (semicolon)', json: 'JSON', markdown: 'Markdown Table',
        };

        let content: string;
        let lang: string;
        switch (format) {
          case 'csv': content = ExportService.toCsv(result); lang = 'csv'; break;
          case 'tsv': content = ExportService.toTsv(result); lang = 'plaintext'; break;
          case 'csv-semicolon': content = ExportService.toCsv(result, { delimiter: ';' }); lang = 'csv'; break;
          case 'json': content = ExportService.toJson(result); lang = 'json'; break;
          case 'markdown': content = ExportService.toMarkdownTable(result); lang = 'markdown'; break;
          default: return;
        }

        const action = await vscode.window.showQuickPick([
          { label: vscode.l10n.t('Open in Editor'), value: 'editor' },
          { label: vscode.l10n.t('Save to File'), value: 'file' },
          { label: vscode.l10n.t('Copy to Clipboard'), value: 'clipboard' },
        ], { placeHolder: vscode.l10n.t('Action') });
        if (!action) return;

        switch (action.value) {
          case 'editor': {
            const doc = await vscode.workspace.openTextDocument({ content, language: lang });
            await vscode.window.showTextDocument(doc);
            break;
          }
          case 'file': {
            const ext = format === 'json' ? 'json' : format === 'markdown' ? 'md' : format === 'tsv' ? 'tsv' : 'csv';
            const label = formatLabels[format] || 'Export';
            const uri = await vscode.window.showSaveDialog({ filters: { [label]: [ext] } });
            if (uri) {
              await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
              vscode.window.showInformationMessage(vscode.l10n.t('Exported to {0}', uri.fsPath));
            }
            break;
          }
          case 'clipboard':
            await vscode.env.clipboard.writeText(content);
            vscode.window.showInformationMessage(vscode.l10n.t('Copied to clipboard'));
            break;
        }
      } catch (err) {
        logAndShowError(vscode.l10n.t('Export failed: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor._saveEdits', async (connectionId: string, tableName: string, schema: string | undefined, pkColumns: string[], edits: any[], databaseName?: string, explicitPanelKey?: string) => {
      dbg('saveEdits', 'connectionId:', connectionId, 'table:', tableName, 'schema:', schema, 'pkColumns:', pkColumns, 'edits:', edits.length, 'db:', databaseName, 'panelKey:', explicitPanelKey);
      const driver = databaseName
        ? await connectionManager.getDriverForDatabase(connectionId, databaseName)
        : connectionManager.getDriver(connectionId);
      if (!driver) { dbg('saveEdits', 'no driver found'); return; }

      const state = connectionManager.get(connectionId);
      const panelKey = explicitPanelKey || `${tableName} — ${state?.config.name}`;

      // Build all SQL statements
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
      const driver = databaseName
        ? await connectionManager.getDriverForDatabase(connectionId, databaseName)
        : connectionManager.getDriver(connectionId);
      if (!driver) return;

      const state = connectionManager.get(connectionId);
      const panelKey = explicitPanelKey || `${tableName} — ${state?.config.name}`;

      // Get column info to build INSERT with DEFAULT values
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
      const driver = databaseName
        ? await connectionManager.getDriverForDatabase(connectionId, databaseName)
        : connectionManager.getDriver(connectionId);
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

    vscode.commands.registerCommand('viewstor._deleteRows', async (connectionId: string, tableName: string, schema: string | undefined, pkColumns: string[], rows: Record<string, unknown>[], databaseName?: string, pkTypes?: Record<string, string>, explicitPanelKey?: string) => {
      const driver = databaseName
        ? await connectionManager.getDriverForDatabase(connectionId, databaseName)
        : connectionManager.getDriver(connectionId);
      if (!driver) return;

      const statements = rows.map(pkValues => buildDeleteSql(tableName, schema, pkColumns, pkValues, pkTypes) + ';');

      const state = connectionManager.get(connectionId);
      const panelKey = explicitPanelKey || `${tableName} — ${state?.config.name}`;
      await tempFileManager.openSqlEditor(statements.join('\n'), {
        panelKey, connectionId, tableName, databaseName, context: 'deleteRows',
      });
    }),

    vscode.commands.registerCommand('viewstor._runCustomTableQuery', async (connectionId: string, tableName: string, _schema: string | undefined, query: string, pageSize: number, databaseName?: string, explicitPanelKey?: string) => {
      const driver = databaseName
        ? await connectionManager.getDriverForDatabase(connectionId, databaseName)
        : connectionManager.getDriver(connectionId);
      if (!driver) return;
      try {
        // Add LIMIT pageSize if the query doesn't already have a LIMIT <= pageSize
        let displayQuery = query.trim().replace(/;+\s*$/, '');
        const limitMatch = displayQuery.match(/LIMIT\s+(\d+)/i);
        const userLimit = limitMatch ? parseInt(limitMatch[1], 10) : 0;
        if (!limitMatch) {
          displayQuery += ` LIMIT ${pageSize}`;
        } else if (userLimit > pageSize) {
          displayQuery = displayQuery.replace(/LIMIT\s+\d+/i, `LIMIT ${pageSize}`);
        }

        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Running query...') },
          () => driver.execute(displayQuery),
        );
        if (result.error) {
          const shortQ = displayQuery.length > 255 ? displayQuery.substring(0, 255) + '...' : displayQuery;
          const enhanced = await enhanceColumnError(result.error, displayQuery, driver);
          logAndShowError(`${enhanced}\n\n---\n${shortQ}`);
          return;
        }
        const state = connectionManager.get(connectionId);
        const panelKey = explicitPanelKey || `${tableName} — ${state?.config.name}`;
        resultPanelManager.postMessage(panelKey, {
          type: 'updateData',
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          executionTimeMs: result.executionTimeMs,
        });
      } catch (err) {
        const shortQ = query.length > 255 ? query.substring(0, 255) + '...' : query;
        const errorMsg = err instanceof Error ? err.message : String(err);
        logAndShowError(`${errorMsg}\n\n---\n${shortQ}`);
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

    vscode.commands.registerCommand('viewstor._executeSqlStatements', async (connectionId: string, sql: string, context: string, tableName?: string, databaseName?: string) => {
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
        if (context === 'deleteRows') {
          vscode.window.showInformationMessage(vscode.l10n.t('{0} row(s) deleted.', count));
        } else if (context === 'insertRow') {
          vscode.window.showInformationMessage(vscode.l10n.t('Row inserted.'));
        } else {
          vscode.window.showInformationMessage(vscode.l10n.t('{0} row(s) saved.', count));
        }
        // Refresh the panel
        if (tableName) {
          const state = connectionManager.get(connectionId);
          resultPanelManager.postMessage(`${tableName} — ${state?.config.name}`, { type: 'rerunQuery' });
        }
      }
    }),

    vscode.commands.registerCommand('viewstor._refreshCount', async (connectionId: string, tableName: string, schema: string | undefined, panelKey: string, databaseName?: string) => {
      const driver = databaseName
        ? await connectionManager.getDriverForDatabase(connectionId, databaseName)
        : connectionManager.getDriver(connectionId);
      if (!driver || !driver.getTableRowCount) return;
      try {
        const count = await driver.getTableRowCount(tableName, schema);
        resultPanelManager.postMessage(panelKey, { type: 'updateRowCount', count });
      } catch (err) {
        logAndShowError(vscode.l10n.t('Failed to count rows: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor._openJsonInTab', async (jsonStr: string) => {
      const doc = await vscode.workspace.openTextDocument({
        content: jsonStr,
        language: 'json',
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('viewstor.showDDL', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId || !item.schemaObject) return;
      const driver = connectionManager.getDriver(item.connectionId);
      if (!driver || !driver.getDDL) {
        vscode.window.showWarningMessage(vscode.l10n.t('DDL generation is not supported for this connection type.'));
        return;
      }
      try {
        const ddl = await driver.getDDL(item.schemaObject.name, item.schemaObject.type, item.schemaObject.schema);
        const doc = await vscode.workspace.openTextDocument({ content: ddl, language: 'sql' });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        logAndShowError(vscode.l10n.t('Failed to get DDL: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),

    // --- Folder commands ---
    vscode.commands.registerCommand('viewstor.createFolder', (item?: ConnectionTreeItem) => {
      const parentFolderId = item?.itemType === 'folder' ? item.folderId : undefined;
      folderFormPanel.open(undefined, parentFolderId);
    }),

    vscode.commands.registerCommand('viewstor.editFolder', (item?: ConnectionTreeItem) => {
      if (!item?.folderId) return;
      const folder = connectionManager.getFolder(item.folderId);
      if (!folder) return;
      folderFormPanel.open(folder);
    }),

    vscode.commands.registerCommand('viewstor.deleteFolder', async (item?: ConnectionTreeItem) => {
      if (!item?.folderId) return;
      const deleteBtn = vscode.l10n.t('Delete');
      const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t('Delete this folder? Connections will be moved to root.'), { modal: true }, deleteBtn
      );
      if (confirm !== deleteBtn) return;
      await connectionManager.removeFolder(item.folderId);
    }),

    vscode.commands.registerCommand('viewstor.importConnections', async () => {
      const source = await vscode.window.showQuickPick([
        { label: 'DBeaver', description: 'data-sources.json', value: 'dbeaver' as ImportSource },
        { label: 'DataGrip', description: 'dataSources.xml', value: 'datagrip' as ImportSource },
        { label: 'pgAdmin', description: 'servers.json', value: 'pgadmin' as ImportSource },
      ], { placeHolder: vscode.l10n.t('Import connections from...') });
      if (!source) return;

      const filters: Record<string, string[]> = {
        dbeaver: ['json'],
        datagrip: ['xml'],
        pgadmin: ['json'],
      };

      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: { [source.label]: filters[source.value] },
        openLabel: `Import from ${source.label}`,
      });
      if (!uris || uris.length === 0) return;

      const content = Buffer.from(await vscode.workspace.fs.readFile(uris[0])).toString('utf8');
      const result = parseImportFile(source.value, content);

      if (result.warnings.length > 0) {
        for (const w of result.warnings) {
          vscode.window.showWarningMessage(w);
        }
      }

      if (result.connections.length === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t('No compatible connections found.'));
        return;
      }

      const pick = await vscode.window.showQuickPick(
        result.connections.map(c => ({
          label: c.name,
          description: `${c.type} — ${c.host}:${c.port}${c.database ? '/' + c.database : ''}`,
          picked: true,
          connection: c,
        })),
        { canPickMany: true, placeHolder: vscode.l10n.t('Found {0} connection(s). Select to import:', result.connections.length) },
      );
      if (!pick || pick.length === 0) return;

      for (const item of pick) {
        await connectionManager.add(item.connection);
      }

      vscode.window.showInformationMessage(vscode.l10n.t('Imported {0} connection(s). Passwords must be entered manually.', pick.length));
    }),

    vscode.commands.registerCommand('viewstor.hideSchema', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId || !item.schemaObject) return;
      const obj = item.schemaObject;
      if (obj.type === 'schema') {
        const db = obj.schema || connectionManager.get(item.connectionId)?.config.database || 'default';
        await connectionManager.toggleHiddenSchema(item.connectionId, db, obj.name);
      }
    }),

    vscode.commands.registerCommand('viewstor.hideDatabase', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId || !item.schemaObject) return;
      if (item.schemaObject.type === 'database') {
        await connectionManager.toggleHiddenDatabase(item.connectionId, item.schemaObject.name);
      }
    }),

    vscode.commands.registerCommand('viewstor.showAllSchemas', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId) return;
      const state = connectionManager.get(item.connectionId);
      if (!state) return;
      state.config.hiddenSchemas = {};
      state.config.hiddenDatabases = [];
      await connectionManager.update(state.config);
    }),

    vscode.commands.registerCommand('viewstor.copyName', async (item?: ConnectionTreeItem) => {
      const name = item?.schemaObject?.name || item?.label?.toString() || '';
      if (name) {
        await vscode.env.clipboard.writeText(name);
        vscode.window.showInformationMessage(vscode.l10n.t('Copied: {0}', name));
      }
    }),

    vscode.commands.registerCommand('viewstor.renameObject', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId || !item.schemaObject) return;
      const obj = item.schemaObject;
      const schema = obj.schema || 'public';
      const quoted = `"${schema}"."${obj.name}"`;
      let sql = '';
      switch (obj.type) {
        case 'table': sql = `ALTER TABLE ${quoted} RENAME TO "${obj.name}_new";`; break;
        case 'view': sql = `ALTER VIEW ${quoted} RENAME TO "${obj.name}_new";`; break;
        case 'index': sql = `ALTER INDEX "${schema}"."${obj.name}" RENAME TO "${obj.name}_new";`; break;
        case 'sequence': sql = `ALTER SEQUENCE ${quoted} RENAME TO "${obj.name}_new";`; break;
        case 'column': sql = `ALTER TABLE "${schema}"."${obj.schema}" RENAME COLUMN "${obj.name}" TO "${obj.name}_new";`; break;
        case 'schema': sql = `ALTER SCHEMA "${obj.name}" RENAME TO "${obj.name}_new";`; break;
        case 'database': sql = `ALTER DATABASE "${obj.name}" RENAME TO "${obj.name}_new";`; break;
        default: return;
      }
      const doc = await vscode.workspace.openTextDocument({ content: sql, language: 'sql' });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('viewstor.createObject', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId) return;
      const obj = item.schemaObject;
      const schema = obj?.schema || obj?.name || 'public';
      let sql = '';
      switch (obj?.type || item.itemType) {
        case 'connection':
        case 'database':
          sql = 'CREATE DATABASE "new_database";'; break;
        case 'schema':
          sql = 'CREATE SCHEMA "new_schema";'; break;
        case 'table':
          sql = `CREATE TABLE "${schema}"."new_table" (\n  id BIGSERIAL PRIMARY KEY,\n  name TEXT NOT NULL,\n  created_at TIMESTAMPTZ DEFAULT NOW()\n);`; break;
        case 'group':
          if (obj?.name === 'Indexes' || obj?.name?.startsWith('Indexes')) {
            sql = `CREATE INDEX CONCURRENTLY "idx_table_column"\n  ON "${schema}"."table_name" ("column_name");`;
          } else if (obj?.name === 'Triggers' || obj?.name?.startsWith('Triggers')) {
            sql = `CREATE TRIGGER "trigger_name"\n  BEFORE INSERT ON "${schema}"."table_name"\n  FOR EACH ROW\n  EXECUTE FUNCTION trigger_function();`;
          }
          break;
        default:
          sql = `CREATE TABLE "${schema}"."new_table" (\n  id BIGSERIAL PRIMARY KEY,\n  name TEXT NOT NULL,\n  created_at TIMESTAMPTZ DEFAULT NOW()\n);`;
      }
      if (sql) {
        const doc = await vscode.workspace.openTextDocument({ content: sql, language: 'sql' });
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    }),

    vscode.commands.registerCommand('viewstor.dropObject', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId || !item.schemaObject) return;
      const obj = item.schemaObject;
      const schema = obj.schema || 'public';
      const quoted = `"${schema}"."${obj.name}"`;
      let sql = '';
      switch (obj.type) {
        case 'table': sql = `DROP TABLE ${quoted} CASCADE;`; break;
        case 'view': sql = `DROP VIEW ${quoted} CASCADE;`; break;
        case 'index': sql = `DROP INDEX CONCURRENTLY "${schema}"."${obj.name}";`; break;
        case 'sequence': sql = `DROP SEQUENCE ${quoted} CASCADE;`; break;
        case 'trigger': sql = `DROP TRIGGER "${obj.name}" ON "${schema}"."table_name" CASCADE;`; break;
        case 'schema': sql = `DROP SCHEMA "${obj.name}" CASCADE;`; break;
        case 'database': sql = `DROP DATABASE "${obj.name}";`; break;
        default: return;
      }
      const doc = await vscode.workspace.openTextDocument({ content: `-- ⚠️ DANGER: This will permanently delete data!\n${sql}`, language: 'sql' });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('viewstor.reportIssue', async () => {
      const ext = vscode.extensions.getExtension('viewstor.viewstor');
      const version = ext?.packageJSON?.version || 'unknown';
      const vscodeVersion = vscode.version;
      const platform = process.platform;
      const arch = process.arch;
      const nodeVersion = process.version;
      const locale = vscode.env.language;
      const theme = vscode.window.activeColorTheme?.kind === 2 ? 'Dark' : vscode.window.activeColorTheme?.kind === 1 ? 'Light' : 'High Contrast';

      const connections = connectionManager.getAll();
      const connSummary = connections.length > 0
        ? connections.map(s => `${s.config.type}${s.connected ? ' (connected)' : ''}`).join(', ')
        : 'none';

      const safeMode = vscode.workspace.getConfiguration('viewstor').get<string>('safeMode', 'warn');

      const body =
`## What happened?

<!-- Describe what went wrong -->

## What did you expect?

<!-- Describe expected behavior -->

## Steps to reproduce

1.
2.
3.

## Screenshots

<!-- Drag & drop screenshots here if applicable -->

## Environment

| Parameter | Value |
|---|---|
| Viewstor | v${version} |
| VS Code | ${vscodeVersion} |
| OS | ${platform} ${arch} |
| Node | ${nodeVersion} |
| Theme | ${theme} |
| Locale | ${locale} |
| Safe mode | ${safeMode} |
| Connections | ${connSummary} |
`;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cp = require('child_process');
      // Encode only chars that break URL query params or shell: & | newline space
      const encoded = body
        .replace(/&/g, '%26')
        .replace(/\|/g, '%7C')
        .replace(/\n/g, '%0A')
        .replace(/ /g, '%20');
      const url = `https://github.com/Siyet/viewstor/issues/new?labels=bug&body=${encoded}`;
      if (process.platform === 'win32') {
        cp.exec(`start "" "${url}"`);
      } else if (process.platform === 'darwin') {
        cp.exec(`open "${url}"`);
      } else {
        cp.exec(`xdg-open "${url}"`);
      }
    }),

    vscode.commands.registerCommand('viewstor.openQueryFromHistory', async (entry: QueryHistoryEntry) => {
      if (!entry?.connectionId || !entry?.query) return;
      const state = connectionManager.get(entry.connectionId);
      if (!state) return;

      // If entry has a pinned file, open it directly
      if (entry.filePath) {
        try {
          const uri = vscode.Uri.file(entry.filePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
          queryEditorProvider.setConnectionForUri(uri, entry.connectionId, entry.databaseName);
        } catch {
          // File was deleted — fall through to create temp
        }
      }

      // Reuse existing editor if already open for this entry (tracked by URI)
      if (!entry.filePath) {
        const trackedUri = historyDocMap.get(entry.id);
        const existingDoc = trackedUri
          ? vscode.workspace.textDocuments.find(d => d.uri.toString() === trackedUri)
          : undefined;
        if (existingDoc) {
          await vscode.window.showTextDocument(existingDoc, { viewColumn: vscode.ViewColumn.One, preview: false });
        } else {
          const uri = await queryFileManager.createTempQuery(entry.connectionId, entry.databaseName, entry.query);
          historyDocMap.set(entry.id, uri.toString());
          queryEditorProvider.setConnectionForUri(uri, entry.connectionId, entry.databaseName);
        }
      }

      // Show cached results — reuse panel by stable title
      if (entry.cachedResult && entry.cachedResult.columns.length > 0) {
        const color = connectionManager.getConnectionColor(entry.connectionId);
        const readonly = connectionManager.isConnectionReadonly(entry.connectionId);
        const title = `History — ${state.config.name}`;
        resultPanelManager.show({
          columns: entry.cachedResult.columns,
          rows: entry.cachedResult.rows,
          rowCount: entry.cachedResult.rows.length,
          executionTimeMs: entry.executionTimeMs,
        }, title, { color, readonly });
      }
    }),

    vscode.commands.registerCommand('viewstor.renameHistoryEntry', async (item: { entry?: QueryHistoryEntry }) => {
      dbg('renameHistoryEntry', 'id:', item?.entry?.id, 'filePath:', item?.entry?.filePath);
      if (!item?.entry?.id || !item.entry.filePath) return;
      const currentName = item.entry.filePath.replace(/\\/g, '/').split('/').pop() || '';
      const newName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Rename pinned query'),
        value: currentName.replace(/\.sql$/, ''),
        validateInput: (v) => v.trim() ? undefined : vscode.l10n.t('Name cannot be empty'),
      });
      if (!newName) return;

      const uri = vscode.Uri.file(item.entry.filePath);
      const newUri = await queryFileManager.renamePinnedQuery(uri, newName);
      dbg('renameHistoryEntry', 'newUri:', newUri?.fsPath);
      if (newUri) {
        queryEditorProvider.handleFileRenamed(uri, newUri);
        await queryHistoryProvider.updateFilePath(item.entry.id, newUri.fsPath);
      }
    }),

    vscode.commands.registerCommand('viewstor.removeHistoryEntry', async (item: { entry?: QueryHistoryEntry }) => {
      if (!item?.entry?.id) return;
      await queryHistoryProvider.removeEntry(item.entry.id);
    }),

    vscode.commands.registerCommand('viewstor.pinHistoryEntry', async (item: { entry?: QueryHistoryEntry }) => {
      dbg('pinHistoryEntry', 'id:', item?.entry?.id, 'connectionId:', item?.entry?.connectionId);
      if (!item?.entry?.id) return;
      // Create a .sql file in queries/ so the entry can be renamed/reopened
      const filePath = queryFileManager.createPinnedQueryFile(
        item.entry.connectionId, item.entry.query, item.entry.databaseName,
      );
      dbg('pinHistoryEntry', 'createdFile:', filePath);
      await queryHistoryProvider.togglePin(item.entry.id, true);
      await queryHistoryProvider.updateFilePath(item.entry.id, filePath);
    }),

    vscode.commands.registerCommand('viewstor.unpinHistoryEntry', async (item: { entry?: QueryHistoryEntry }) => {
      if (!item?.entry?.id) return;
      await queryHistoryProvider.togglePin(item.entry.id, false);
    }),

    vscode.commands.registerCommand('viewstor.clearHistory', async () => {
      const confirmBtn = vscode.l10n.t('Clear');
      const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t('Clear all query history?'), { modal: true }, confirmBtn,
      );
      if (confirm !== confirmBtn) return;
      await queryHistoryProvider.clear();
    }),
  );
}

function logAndShowError(message: string) {
  _outputChannel.error(message);
  vscode.window.showErrorMessage(message);
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

