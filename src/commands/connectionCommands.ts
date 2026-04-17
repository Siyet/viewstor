import * as vscode from 'vscode';
import { CommandContext, logAndShowError, wrapError } from './shared';
import { ConnectionTreeItem } from '../views/connectionTree';
import { ImportSource, parseImportFile } from '../services/importService';

export function registerConnectionCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  const { connectionManager, connectionTreeProvider, connectionFormPanel, folderFormPanel, queryEditorProvider } = ctx;

  context.subscriptions.push(
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
        logAndShowError(vscode.l10n.t('Connection failed: {0}', wrapError(err)));
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
          logAndShowError(vscode.l10n.t('Connection failed: {0}', wrapError(err)));
          return;
        }
      }
      await queryEditorProvider.openNewQuery(item.connectionId, item.databaseName);
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

    // --- Import ---

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
        for (const warning of result.warnings) {
          vscode.window.showWarningMessage(warning);
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

      for (const picked of pick) {
        await connectionManager.add(picked.connection);
      }

      vscode.window.showInformationMessage(vscode.l10n.t('Imported {0} connection(s). Passwords must be entered manually.', pick.length));
    }),

    // --- Schema visibility ---

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
  );
}
