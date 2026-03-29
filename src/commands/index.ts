import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { ConnectionTreeProvider, ConnectionTreeItem } from '../views/connectionTree';
import { QueryHistoryProvider } from '../views/queryHistory';
import { QueryEditorProvider, QueryDocumentProvider } from '../editors/queryEditor';
import { ResultPanelManager } from '../views/resultPanel';
import { ConnectionFormPanel } from '../views/connectionForm';
import { FolderFormPanel } from '../views/folderForm';
import { SortColumn, QueryResult, QueryColumn } from '../types/query';
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
      const confirm = await vscode.window.showWarningMessage(
        `Remove connection "${state.config.name}"?`, { modal: true }, 'Remove'
      );
      if (confirm !== 'Remove') return;
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
          { location: vscode.ProgressLocation.Notification, title: 'Connecting...' },
          () => connectionManager.connect(item.connectionId!)
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Connection failed: ${err instanceof Error ? err.message : err}`);
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
          vscode.window.showErrorMessage(`Connection failed: ${err instanceof Error ? err.message : err}`);
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
        vscode.window.showWarningMessage('No connection associated with this query tab.');
        return;
      }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) {
        vscode.window.showWarningMessage('Not connected. Please connect first.');
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
          const defaultLimit = vscode.workspace.getConfiguration('viewstor').get<number>('defaultPageSize', 100);
          finalQuery = trimmed + ` LIMIT ${defaultLimit}`;
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
            const message = `Seq Scan on "${tableName}" — may be slow on large tables.`;

            if (safeMode === 'block') {
              const action = await vscode.window.showErrorMessage(
                `Blocked: ${message}`,
                'See EXPLAIN', 'Cancel'
              );
              if (action === 'See EXPLAIN') {
                const doc = await vscode.workspace.openTextDocument({ content: plan, language: 'plaintext' });
                await vscode.window.showTextDocument(doc, { preview: true });
              }
              return;
            } else {
              const action = await vscode.window.showWarningMessage(
                message,
                'Run Anyway', 'See EXPLAIN', 'Cancel'
              );
              if (action === 'See EXPLAIN') {
                const doc = await vscode.workspace.openTextDocument({ content: plan, language: 'plaintext' });
                await vscode.window.showTextDocument(doc, { preview: true });
                return;
              }
              if (action !== 'Run Anyway') return;
            }
          }
        } catch { /* EXPLAIN failed — proceed anyway */ }
      }

      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Running query...' },
          () => driver.execute(finalQuery)
        );

        const color = connectionManager.getConnectionColor(connectionId);
        const readonly = connectionManager.isConnectionReadonly(connectionId);
        queryResultCounter++;
        resultPanelManager.show(result, `Results #${queryResultCounter} — ${state?.config.name || 'Query'}`, { color, readonly });

        await queryHistoryProvider.addEntry({
          id: generateId(),
          connectionId,
          connectionName: state?.config.name || '',
          query,
          executedAt: Date.now(),
          executionTimeMs: result.executionTimeMs,
          rowCount: result.rowCount,
          error: result.error,
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
        vscode.window.showWarningMessage('No data to export.');
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
        { label: 'Open in Editor', value: 'editor' },
        { label: 'Save to File', value: 'file' },
        { label: 'Copy to Clipboard', value: 'clipboard' },
      ], { placeHolder: 'Action' });
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
            vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
          }
          break;
        }
        case 'clipboard':
          await vscode.env.clipboard.writeText(content);
          vscode.window.showInformationMessage('Copied to clipboard');
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

        // Use fast estimated count first, exact count only via refresh button
        let totalRowCount: number | undefined;
        let isEstimatedCount = false;
        if (driver.getEstimatedRowCount) {
          totalRowCount = await driver.getEstimatedRowCount(item.schemaObject.name, item.schemaObject.schema);
          isEstimatedCount = true;
        }

        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Loading ${item.schemaObject.name}...` },
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
        vscode.window.showErrorMessage(`Failed to load data: ${err instanceof Error ? err.message : err}`);
      }
    }),

    vscode.commands.registerCommand('viewstor._fetchPage', async (connectionId: string, tableName: string, schema: string | undefined, page: number, pageSize: number, orderBy?: SortColumn[]) => {
      const driver = connectionManager.getDriver(connectionId);
      if (!driver) return;

      try {
        const tableInfo = await driver.getTableInfo(tableName, schema);
        const pkColumns = tableInfo.columns.filter(c => c.isPrimaryKey).map(c => c.name);

        // Use estimated count for page navigation (fast)
        let totalRowCount: number | undefined;
        let isEstimatedCount = false;
        if (driver.getEstimatedRowCount) {
          totalRowCount = await driver.getEstimatedRowCount(tableName, schema);
          isEstimatedCount = true;
        }
        const offset = page * pageSize;

        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Loading ${tableName}...` },
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
        vscode.window.showErrorMessage(`Failed to load data: ${err instanceof Error ? err.message : err}`);
      }
    }),

    vscode.commands.registerCommand('viewstor._exportAllData', async (connectionId: string, tableName: string, schema: string | undefined, format: string, orderBy?: SortColumn[]) => {
      const driver = connectionManager.getDriver(connectionId);
      if (!driver) return;

      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Exporting ${tableName}...`, cancellable: false },
          () => driver.getTableData(tableName, schema, 100000, 0, orderBy),
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
          { label: 'Open in Editor', value: 'editor' },
          { label: 'Save to File', value: 'file' },
          { label: 'Copy to Clipboard', value: 'clipboard' },
        ], { placeHolder: 'Action' });
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
              vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
            }
            break;
          }
          case 'clipboard':
            await vscode.env.clipboard.writeText(content);
            vscode.window.showInformationMessage('Copied to clipboard');
            break;
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : err}`);
      }
    }),

    vscode.commands.registerCommand('viewstor._saveEdits', async (connectionId: string, tableName: string, schema: string | undefined, pkColumns: string[], edits: any[]) => {
      const driver = connectionManager.getDriver(connectionId);
      if (!driver) return;

      const errors: string[] = [];
      for (const edit of edits) {
        const setClauses = Object.entries(edit.changes)
          .map(([col, val]) => `"${col}" = ${val === null ? 'NULL' : `'${String(val).replace(/'/g, '\'\'')}'`}`)
          .join(', ');
        const whereClauses = pkColumns
          .map(pk => `"${pk}" = '${String(edit.pkValues[pk]).replace(/'/g, '\'\'')}'`)
          .join(' AND ');
        const quoted = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
        const sql = `UPDATE ${quoted} SET ${setClauses} WHERE ${whereClauses}`;
        const result = await driver.execute(sql);
        if (result.error) errors.push(result.error);
      }

      if (errors.length > 0) {
        vscode.window.showErrorMessage(`Save errors: ${errors.join('; ')}`);
      } else {
        vscode.window.showInformationMessage(`${edits.length} row(s) saved.`);
      }
    }),

    vscode.commands.registerCommand('viewstor._cancelQuery', async (connectionId: string) => {
      const driver = connectionManager.getDriver(connectionId);
      if (driver?.cancelQuery) {
        try {
          await driver.cancelQuery();
          vscode.window.showInformationMessage('Query cancelled.');
        } catch (err) {
          vscode.window.showWarningMessage(`Cancel failed: ${err instanceof Error ? err.message : err}`);
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
        vscode.window.showErrorMessage(`Failed to count rows: ${err instanceof Error ? err.message : err}`);
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
        vscode.window.showWarningMessage('DDL generation is not supported for this connection type.');
        return;
      }
      try {
        const ddl = await driver.getDDL(item.schemaObject.name, item.schemaObject.type, item.schemaObject.schema);
        const doc = await vscode.workspace.openTextDocument({ content: ddl, language: 'sql' });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to get DDL: ${err instanceof Error ? err.message : err}`);
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
      const confirm = await vscode.window.showWarningMessage(
        'Delete this folder? Connections will be moved to root.', { modal: true }, 'Delete'
      );
      if (confirm !== 'Delete') return;
      await connectionManager.removeFolder(item.folderId);
    }),

    vscode.commands.registerCommand('viewstor.importConnections', async () => {
      const source = await vscode.window.showQuickPick([
        { label: 'DBeaver', description: 'data-sources.json', value: 'dbeaver' as ImportSource },
        { label: 'DataGrip', description: 'dataSources.xml', value: 'datagrip' as ImportSource },
        { label: 'pgAdmin', description: 'servers.json', value: 'pgadmin' as ImportSource },
      ], { placeHolder: 'Import connections from...' });
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
        vscode.window.showInformationMessage('No compatible connections found.');
        return;
      }

      const pick = await vscode.window.showQuickPick(
        result.connections.map(c => ({
          label: c.name,
          description: `${c.type} — ${c.host}:${c.port}${c.database ? '/' + c.database : ''}`,
          picked: true,
          connection: c,
        })),
        { canPickMany: true, placeHolder: `Found ${result.connections.length} connection(s). Select to import:` },
      );
      if (!pick || pick.length === 0) return;

      for (const item of pick) {
        await connectionManager.add(item.connection);
      }

      vscode.window.showInformationMessage(`Imported ${pick.length} connection(s). Passwords must be entered manually.`);
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

    vscode.commands.registerCommand('viewstor.reportIssue', () => {
      const ext = vscode.extensions.getExtension('viewstor.viewstor');
      const version = ext?.packageJSON?.version || 'unknown';
      const vscodeVersion = vscode.version;
      const platform = process.platform;
      const body = encodeURIComponent(
        `## Description\n\n<!-- Describe the issue -->\n\n## Steps to Reproduce\n\n1. \n2. \n\n## Environment\n- Viewstor: v${version}\n- VS Code: ${vscodeVersion}\n- OS: ${platform}\n`
      );
      const url = `https://github.com/Siyet/viewstor/issues/new?body=${body}&labels=bug`;
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),
  );
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
