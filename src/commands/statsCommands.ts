import * as vscode from 'vscode';
import { CommandContext } from './shared';
import { ConnectionTreeItem } from '../views/connectionTree';
import { DatabaseStatsPanelManager } from '../stats/databaseStatsPanel';
import { clampTopTablesLimit, clampAutoRefreshSeconds } from '../stats/databaseStatsFormat';
import { DatabaseStatistics } from '../types/schema';
import { DatabaseDriver } from '../types/driver';

/**
 * Register commands for the Database Statistics view (#73):
 *   - `viewstor.showDatabaseStatistics` — tree context menu on connection / database
 *     nodes and command-palette entry (prompts for connection when invoked globally).
 */
export function registerStatsCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  const { connectionManager } = ctx;
  const manager = new DatabaseStatsPanelManager(context);
  context.subscriptions.push({ dispose: () => manager.dispose() });

  async function pickConnection(): Promise<{ connectionId: string; databaseName?: string } | undefined> {
    const connected = connectionManager.getAll().filter(s => s.connected);
    if (connected.length === 0) {
      vscode.window.showWarningMessage(vscode.l10n.t('No connected databases. Connect first.'));
      return undefined;
    }
    const items: (vscode.QuickPickItem & { connectionId: string; databaseName?: string })[] = [];
    for (const state of connected) {
      const cfg = state.config;
      const dbs = new Set<string>();
      if (cfg.database) dbs.add(cfg.database);
      (cfg.databases || []).forEach(db => dbs.add(db));
      if (dbs.size <= 1) {
        items.push({
          label: cfg.name,
          description: cfg.type,
          connectionId: cfg.id,
          databaseName: cfg.database,
        });
      } else {
        for (const db of dbs) {
          items.push({
            label: `${cfg.name} / ${db}`,
            description: cfg.type,
            connectionId: cfg.id,
            databaseName: db,
          });
        }
      }
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: vscode.l10n.t('Select a database to view statistics'),
    });
    if (!picked) return undefined;
    return { connectionId: picked.connectionId, databaseName: picked.databaseName };
  }

  async function resolveDriver(connectionId: string, databaseName?: string): Promise<DatabaseDriver | undefined> {
    return databaseName
      ? await connectionManager.getDriverForDatabase(connectionId, databaseName)
      : connectionManager.getDriver(connectionId) || undefined;
  }

  async function fetchStats(
    connectionId: string,
    databaseName?: string,
  ): Promise<DatabaseStatistics | { error: string }> {
    const driver = await resolveDriver(connectionId, databaseName);
    if (!driver) return { error: vscode.l10n.t('Connection is not available.') };
    if (!driver.getDatabaseStatistics) {
      return { error: vscode.l10n.t('This database driver does not support statistics.') };
    }
    const cfg = vscode.workspace.getConfiguration('viewstor');
    const topTablesLimit = clampTopTablesLimit(cfg.get('databaseStats.topTablesLimit'));
    const state = connectionManager.get(connectionId);
    const hiddenMap = state?.config.hiddenSchemas;
    const hiddenSchemas = databaseName && hiddenMap ? (hiddenMap[databaseName] || []) : undefined;
    try {
      return await driver.getDatabaseStatistics({ topTablesLimit, hiddenSchemas });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message };
    }
  }

  async function showForConnection(connectionId: string, databaseName?: string) {
    const state = connectionManager.get(connectionId);
    if (!state) return;
    const initial = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Loading database statistics...') },
      () => fetchStats(connectionId, databaseName),
    );
    if ('error' in initial) {
      vscode.window.showErrorMessage(vscode.l10n.t('Database statistics failed: {0}', initial.error));
      return;
    }

    const cfg = vscode.workspace.getConfiguration('viewstor');
    const autoRefreshSeconds = clampAutoRefreshSeconds(cfg.get('databaseStats.autoRefreshSeconds'));

    manager.show({
      connectionId,
      connectionName: state.config.name,
      databaseName,
      stats: initial,
      autoRefreshSeconds,
      onRefresh: () => fetchStats(connectionId, databaseName),
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('viewstor.showDatabaseStatistics', async (item?: ConnectionTreeItem) => {
      let connectionId: string | undefined;
      let databaseName: string | undefined;

      if (item?.connectionId) {
        connectionId = item.connectionId;
        if (item.itemType === 'database' && item.databaseName) {
          databaseName = item.databaseName;
        } else {
          const state = connectionManager.get(connectionId);
          databaseName = state?.config.database;
        }
      } else {
        const picked = await pickConnection();
        if (!picked) return;
        connectionId = picked.connectionId;
        databaseName = picked.databaseName;
      }

      await showForConnection(connectionId, databaseName);
    }),
  );
}
