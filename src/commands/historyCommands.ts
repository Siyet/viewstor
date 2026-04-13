import * as vscode from 'vscode';
import { CommandContext, historyDocMap } from './shared';
import { QueryHistoryEntry } from '../types/query';
import { dbg } from '../utils/debug';

export function registerHistoryCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  const { connectionManager, queryHistoryProvider, queryEditorProvider, resultPanelManager, queryFileManager } = ctx;

  context.subscriptions.push(
    vscode.commands.registerCommand('viewstor.openQueryFromHistory', async (entry: QueryHistoryEntry) => {
      if (!entry?.connectionId || !entry?.query) return;
      const state = connectionManager.get(entry.connectionId);
      if (!state) return;

      let fileOpened = false;
      if (entry.filePath) {
        try {
          const uri = vscode.Uri.file(entry.filePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
          queryEditorProvider.setConnectionForUri(uri, entry.connectionId, entry.databaseName);
          fileOpened = true;
        } catch {
          // File was deleted — fall through to create temp
        }
      }

      if (!fileOpened) {
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

      // Show cached results
      if (entry.cachedResult && entry.cachedResult.columns.length > 0) {
        const color = connectionManager.getConnectionColor(entry.connectionId);
        const readonly = connectionManager.isConnectionReadonly(entry.connectionId);
        const title = `History — ${state.config.name}`;
        resultPanelManager.show({
          columns: entry.cachedResult.columns,
          rows: entry.cachedResult.rows,
          rowCount: entry.cachedResult.rows.length,
          executionTimeMs: entry.executionTimeMs,
        }, title, { color, readonly, databaseType: state.config.type });
      }
    }),

    vscode.commands.registerCommand('viewstor.renameHistoryEntry', async (item: { entry?: QueryHistoryEntry }) => {
      dbg('renameHistoryEntry', 'id:', item?.entry?.id, 'filePath:', item?.entry?.filePath);
      if (!item?.entry?.id || !item.entry.filePath) return;
      const currentName = item.entry.filePath.replace(/\\/g, '/').split('/').pop() || '';
      const newName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Rename pinned query'),
        value: currentName.replace(/\.sql$/, ''),
        validateInput: (value) => value.trim() ? undefined : vscode.l10n.t('Name cannot be empty'),
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
