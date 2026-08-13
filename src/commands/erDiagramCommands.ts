import * as vscode from 'vscode';
import { buildErDiagramData } from '../er/erDataTransform';
import { ConnectionTreeItem } from '../views/connectionTree';
import { CommandContext, getRequiredDriver } from './shared';

export function registerErDiagramCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('viewstor.showErDiagram', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId) {
        vscode.window.showWarningMessage(vscode.l10n.t('Open an ER diagram from a connection, database, or schema in the Connections view.'));
        return;
      }

      const connectionId = item.connectionId;
      const state = ctx.connectionManager.get(connectionId);
      if (!state) return;
      const databaseName = item.databaseName;
      const schemaName = item.schemaObject?.type === 'schema' ? item.schemaObject.name : undefined;
      const scopeName = schemaName || databaseName || state.config.database || state.config.name;
      const key = `${connectionId}:${databaseName ?? ''}:${schemaName ?? '*'}`;

      const loadData = async () => {
        if (!ctx.connectionManager.get(connectionId)?.connected && !databaseName) {
          await ctx.connectionManager.connect(connectionId);
        }
        const driver = await getRequiredDriver(ctx.connectionManager, connectionId, databaseName);
        if (!driver) throw new Error(vscode.l10n.t('Connection is not connected.'));
        const [schema, foreignKeys] = await Promise.all([
          driver.getSchema(),
          driver.getForeignKeys ? driver.getForeignKeys(schemaName) : Promise.resolve([]),
        ]);
        return buildErDiagramData(schema, foreignKeys, {
          schema: schemaName,
          namespaceKind: state.config.type === 'clickhouse' ? 'database' : 'schema',
          foreignKeysUnsupported: !driver.getForeignKeys,
        });
      };

      ctx.erDiagramPanelManager.show(
        key,
        vscode.l10n.t('ER Diagram — {0}', scopeName),
        loadData,
        {
          connectionId,
          databaseName,
          color: ctx.connectionManager.getConnectionColor(connectionId),
        },
      );
    }),
  );
}
