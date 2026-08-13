import * as vscode from 'vscode';
import { CommandContext, logAndShowError, getRequiredDriver, wrapError } from './shared';
import { QueryResult, QueryColumn, SortColumn } from '../types/query';
import { ExportService } from '../services/exportService';

export function registerExportCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  const { connectionManager, chartPanelManager, queryEditorProvider } = ctx;

  context.subscriptions.push(
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

    vscode.commands.registerCommand('viewstor._exportAllData', async (connectionId: string, tableName: string, schema: string | undefined, format: string, orderBy?: SortColumn[], customQuery?: string, databaseName?: string) => {
      const driver = await getRequiredDriver(connectionManager, connectionId, databaseName);
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
        logAndShowError(vscode.l10n.t('Export failed: {0}', wrapError(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor.visualizeResults', (data?: {
      columns: QueryColumn[];
      rows: Record<string, unknown>[];
      query?: string;
      connectionId?: string;
      databaseName?: string;
      databaseType?: string;
      color?: string;
      tableName?: string;
      schema?: string;
      resultPanelKey?: string;
    }) => {
      if (!data?.columns || !data?.rows) {
        vscode.window.showWarningMessage(vscode.l10n.t('No data to visualize.'));
        return;
      }
      const result: QueryResult = {
        columns: data.columns,
        rows: data.rows,
        rowCount: data.rows.length,
        executionTimeMs: 0,
      };
      const state = data.connectionId ? connectionManager.get(data.connectionId) : undefined;
      const chartTitle = data.tableName
        ? `Chart — ${data.tableName}`
        : `Chart — ${state?.config.name || 'Query'}`;
      chartPanelManager.show(result, chartTitle, {
        connectionId: data.connectionId,
        databaseName: data.databaseName,
        databaseType: data.databaseType || state?.config.type,
        query: data.query,
        color: data.color,
        tableName: data.tableName,
        schema: data.schema,
        resultPanelKey: data.resultPanelKey,
      });
    }),

    vscode.commands.registerCommand('viewstor.exportGrafana', () => {
      vscode.window.showInformationMessage(
        vscode.l10n.t('Open a chart panel and use the Export to Grafana button.'),
      );
    }),

    // MCP: open SQL editor with query text
    vscode.commands.registerCommand('viewstor._openQueryFromMcp', async (
      connectionId: string, query: string, databaseName?: string,
    ) => {
      await queryEditorProvider.openNewQuery(connectionId, databaseName);
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const lastLine = editor.document.lineCount - 1;
        const lastChar = editor.document.lineAt(lastLine).text.length;
        await editor.edit(editBuilder => {
          editBuilder.insert(new vscode.Position(lastLine, lastChar), query);
        });
      }
    }),
  );
}
