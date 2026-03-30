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

interface CommandContext {
  connectionManager: ConnectionManager;
  connectionTreeProvider: ConnectionTreeProvider;
  queryHistoryProvider: QueryHistoryProvider;
  queryEditorProvider: QueryEditorProvider;
  resultPanelManager: ResultPanelManager;
  connectionFormPanel: ConnectionFormPanel;
  folderFormPanel: FolderFormPanel;
}

let queryResultCounter = 0;

export function registerCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  const { connectionManager, connectionTreeProvider, queryHistoryProvider, queryEditorProvider, resultPanelManager, connectionFormPanel, folderFormPanel } = ctx;

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
        vscode.window.showErrorMessage(vscode.l10n.t('Connection failed: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor.disconnect', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId) return;
      await connectionManager.disconnect(item.connectionId);
    }),

    vscode.commands.registerCommand('viewstor.refreshConnection', () => {
      connectionTreeProvider.refresh();
    }),

    vscode.commands.registerCommand('viewstor.openQuery', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId) return;
      const state = connectionManager.get(item.connectionId);
      if (state && !state.connected) {
        try {
          await connectionManager.connect(item.connectionId);
        } catch (err) {
          vscode.window.showErrorMessage(vscode.l10n.t('Connection failed: {0}', err instanceof Error ? err.message : String(err)));
          return;
        }
      }
      await queryEditorProvider.openNewQuery(item.connectionId);
    }),

    vscode.commands.registerCommand('viewstor.runQuery', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const connectionId = queryEditorProvider.getConnectionIdFromUri(editor.document.uri);
      if (!connectionId) {
        vscode.window.showWarningMessage(vscode.l10n.t('No connection associated with this query tab.'));
        return;
      }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) {
        vscode.window.showWarningMessage(vscode.l10n.t('Not connected. Please connect first.'));
        return;
      }

      const selection = editor.selection;
      const query = selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(selection);

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
          finalQuery = trimmed + ' LIMIT 1000';
        } else {
          finalQuery = trimmed;
        }
      }

      // Safe mode: EXPLAIN check for seq scans (PostgreSQL only)
      if (safeMode !== 'off' && state?.config.type === 'postgresql' && finalQuery.trim().toUpperCase().startsWith('SELECT')) {
        try {
          const explainResult = await driver.execute('EXPLAIN ' + finalQuery);
          const plan = explainResult.rows.map(r => Object.values(r).join(' ')).join('\n');
          if (plan.includes('Seq Scan')) {
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

      try {
        const shortQuery = finalQuery.length > 100 ? finalQuery.substring(0, 100) + '...' : finalQuery;
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Running: ${shortQuery}` },
          () => driver.execute(finalQuery)
        );

        const color = connectionManager.getConnectionColor(connectionId);
        const readonly = connectionManager.isConnectionReadonly(connectionId);
        queryResultCounter++;
        resultPanelManager.show(result, `Results #${queryResultCounter} — ${state?.config.name || 'Query'}`, { color, readonly });

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
        resultPanelManager.show({
          columns: [], rows: [], rowCount: 0, executionTimeMs: 0, error: errorMsg,
        });
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

      const driver = connectionManager.getDriver(item.connectionId);
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
        const state = connectionManager.get(item.connectionId);
        const title = `${item.schemaObject.name} — ${state?.config.name}`;
        const color = connectionManager.getConnectionColor(item.connectionId);
        const readonly = connectionManager.isConnectionReadonly(item.connectionId);
        resultPanelManager.show(result, title, {
          connectionId: item.connectionId,
          tableName: item.schemaObject.name,
          schema: item.schemaObject.schema,
          pkColumns, color, readonly, pageSize, currentPage: 0, totalRowCount, isEstimatedCount,
        });
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to load data: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor._fetchPage', async (connectionId: string, tableName: string, schema: string | undefined, page: number, pageSize: number, orderBy?: SortColumn[]) => {
      const driver = connectionManager.getDriver(connectionId);
      if (!driver) return;

      try {
        const tableInfo = await driver.getTableInfo(tableName, schema);
        const pkColumns = tableInfo.columns.filter(c => c.isPrimaryKey).map(c => c.name);

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
        const state = connectionManager.get(connectionId);
        const title = `${tableName} — ${state?.config.name}`;
        const color = connectionManager.getConnectionColor(connectionId);
        const readonly = connectionManager.isConnectionReadonly(connectionId);
        resultPanelManager.show(result, title, {
          connectionId, tableName, schema, pkColumns, color, orderBy, readonly,
          pageSize, currentPage: page, totalRowCount, isEstimatedCount,
        });
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to load data: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor._exportAllData', async (connectionId: string, tableName: string, schema: string | undefined, format: string, orderBy?: SortColumn[], customQuery?: string) => {
      const driver = connectionManager.getDriver(connectionId);
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
        vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor._saveEdits', async (connectionId: string, tableName: string, schema: string | undefined, pkColumns: string[], edits: any[]) => {
      const driver = connectionManager.getDriver(connectionId);
      if (!driver) return;

      // Build all SQL statements
      const statements: string[] = [];
      for (const edit of edits) {
        const setClauses = Object.entries(edit.changes)
          .map(([col, val]) => `"${col}" = ${val === null ? 'NULL' : `'${String(val).replace(/'/g, '\'\'')}'`}`)
          .join(', ');
        const whereClauses = pkColumns
          .map(pk => `"${pk}" = '${String(edit.pkValues[pk]).replace(/'/g, '\'\'')}'`)
          .join(' AND ');
        const quoted = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
        statements.push(`UPDATE ${quoted} SET ${setClauses} WHERE ${whereClauses};`);
      }

      const confirmEdits = vscode.workspace.getConfiguration('viewstor').get<boolean>('confirmEdits', true);

      if (confirmEdits) {
        const fullSql = statements.join('\n');
        const doc = await vscode.workspace.openTextDocument({ content: fullSql, language: 'sql' });
        const editor = await vscode.window.showTextDocument(doc, { preview: false });

        const executeBtn = vscode.l10n.t('Execute');
        const dontAskBtn = vscode.l10n.t('Don\'t ask again');
        const cancelBtn = vscode.l10n.t('Cancel');
        const action = await vscode.window.showWarningMessage(
          vscode.l10n.t('Execute {0} UPDATE statement(s)?', statements.length),
          executeBtn, dontAskBtn, cancelBtn
        );

        if (action === dontAskBtn) {
          await vscode.workspace.getConfiguration('viewstor').update('confirmEdits', false, vscode.ConfigurationTarget.Global);
        }

        if (action !== executeBtn && action !== dontAskBtn) {
          return;
        }

        // Re-read from editor in case user edited the SQL
        const editedSql = editor.document.getText();
        const editedStatements = editedSql.split(';').map(s => s.trim()).filter(Boolean);

        const errors: string[] = [];
        for (const sql of editedStatements) {
          const result = await driver.execute(sql);
          if (result.error) errors.push(result.error);
        }

        if (errors.length > 0) {
          vscode.window.showErrorMessage(vscode.l10n.t('Save errors: {0}', errors.join('; ')));
        } else {
          vscode.window.showInformationMessage(vscode.l10n.t('{0} row(s) saved.', editedStatements.length));
        }
      } else {
        // Execute without confirmation
        const errors: string[] = [];
        for (const sql of statements) {
          const result = await driver.execute(sql);
          if (result.error) errors.push(result.error);
        }

        if (errors.length > 0) {
          vscode.window.showErrorMessage(vscode.l10n.t('Save errors: {0}', errors.join('; ')));
        } else {
          vscode.window.showInformationMessage(vscode.l10n.t('{0} row(s) saved.', statements.length));
        }
      }
    }),

    vscode.commands.registerCommand('viewstor._runCustomTableQuery', async (connectionId: string, tableName: string, schema: string | undefined, query: string, pageSize: number) => {
      const driver = connectionManager.getDriver(connectionId);
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
        const state = connectionManager.get(connectionId);
        const title = `${tableName} — ${state?.config.name}`;
        const color = connectionManager.getConnectionColor(connectionId);
        const readonly = connectionManager.isConnectionReadonly(connectionId);
        resultPanelManager.show(result, title, {
          connectionId, tableName, schema, color, readonly,
          pageSize, currentPage: 0,
          totalRowCount: result.rowCount,
          isEstimatedCount: false,
          query,
        });
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Query failed: {0}', err instanceof Error ? err.message : String(err)));
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

    vscode.commands.registerCommand('viewstor._refreshCount', async (connectionId: string, tableName: string, schema: string | undefined, panelKey: string) => {
      const driver = connectionManager.getDriver(connectionId);
      if (!driver || !driver.getTableRowCount) return;
      try {
        const count = await driver.getTableRowCount(tableName, schema);
        resultPanelManager.postMessage(panelKey, { type: 'updateRowCount', count });
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to count rows: {0}', err instanceof Error ? err.message : String(err)));
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
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to get DDL: {0}', err instanceof Error ? err.message : String(err)));
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

      // Open query text in editor
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: entry.query });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });

      // Show cached results if available
      if (entry.cachedResult && entry.cachedResult.columns.length > 0) {
        const color = connectionManager.getConnectionColor(entry.connectionId);
        const readonly = connectionManager.isConnectionReadonly(entry.connectionId);
        queryResultCounter++;
        resultPanelManager.show({
          columns: entry.cachedResult.columns,
          rows: entry.cachedResult.rows,
          rowCount: entry.cachedResult.rows.length,
          executionTimeMs: entry.executionTimeMs,
          error: entry.error,
        }, `Results #${queryResultCounter} — ${state.config.name}`, { color, readonly });
      }
    }),

    vscode.commands.registerCommand('viewstor.removeHistoryEntry', async (item: { entry?: QueryHistoryEntry }) => {
      if (!item?.entry?.id) return;
      await queryHistoryProvider.removeEntry(item.entry.id);
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

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
