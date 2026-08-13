import * as vscode from 'vscode';
import { CommandContext, getRequiredDriver, wrapError } from './shared';
import { ConnectionTreeItem } from '../views/connectionTree';
import { DiffSource, DiffOptions } from '../diff/diffTypes';
import { TablePickResult } from '../diff/diffPanel';
import { dbg } from '../utils/debug';

export function registerDiffCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  const { connectionManager, diffPanelManager } = ctx;

  context.subscriptions.push(
    // Context menu on table: "Compare with..."
    vscode.commands.registerCommand('viewstor.compareWith', async (item?: ConnectionTreeItem) => {
      dbg('compareWith', 'item:', item?.connectionId, item?.schemaObject?.name);
      if (!item?.connectionId || !item.schemaObject) { dbg('compareWith', 'no item'); return; }
      if (!diffPanelManager) { dbg('compareWith', 'no diffPanelManager'); return; }

      const leftState = connectionManager.get(item.connectionId);
      if (!leftState) { dbg('compareWith', 'no leftState'); return; }

      const picked = await pickTableWithLoading(
        connectionManager,
        vscode.l10n.t('Select table to compare with "{0}"', item.schemaObject.name),
      );
      dbg('compareWith', 'picked:', picked?.tableName, picked?.connectionId);
      if (!picked) return;

      const leftDriver = await getRequiredDriver(connectionManager, item.connectionId, item.databaseName);
      if (!leftDriver) { dbg('compareWith', 'no leftDriver'); return; }

      const rightDriver = await getRequiredDriver(connectionManager, picked.connectionId, picked.databaseName);
      if (!rightDriver) { dbg('compareWith', 'no rightDriver for', picked.connectionId); return; }

      const rowLimit = vscode.workspace.getConfiguration('viewstor').get<number>('diffRowLimit', 10000);

      try {
      dbg('compareWith', 'starting diff, rowLimit:', rowLimit);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Comparing data...') },
        async () => {
          dbg('compareWith', 'fetching table info and data...');
          const [leftInfo, rightInfo, leftData, rightData] = await Promise.all([
            leftDriver.getTableInfo(item.schemaObject!.name, item.schemaObject!.schema),
            rightDriver.getTableInfo(picked.tableName, picked.schema),
            leftDriver.getTableData(item.schemaObject!.name, item.schemaObject!.schema, rowLimit, 0),
            rightDriver.getTableData(picked.tableName, picked.schema, rowLimit, 0),
          ]);

          // Fetch table objects (indexes, constraints, etc.) — non-critical, fallback to undefined
          let leftObjects, rightObjects;
          try {
            [leftObjects, rightObjects] = await Promise.all([
              leftDriver.getTableObjects ? leftDriver.getTableObjects(item.schemaObject!.name, item.schemaObject!.schema) : undefined,
              rightDriver.getTableObjects ? rightDriver.getTableObjects(picked.tableName, picked.schema) : undefined,
            ]);
          } catch { /* schema objects unavailable — diff will show columns only */ }

          // Fetch table statistics — only when both drivers are the same type and both support it
          let leftStats, rightStats;
          const sameType = leftState.config.type === connectionManager.get(picked.connectionId)?.config.type;
          if (sameType && leftDriver.getTableStatistics && rightDriver.getTableStatistics) {
            try {
              [leftStats, rightStats] = await Promise.all([
                leftDriver.getTableStatistics(item.schemaObject!.name, item.schemaObject!.schema),
                rightDriver.getTableStatistics(picked.tableName, picked.schema),
              ]);
            } catch { /* statistics unavailable — diff will omit stats tab */ }
          }

          // Auto-detect key columns from left table PKs
          const pkColumns = leftInfo.columns.filter(c => c.isPrimaryKey).map(c => c.name);
          let keyColumns = pkColumns;

          if (keyColumns.length === 0) {
            // No PK — ask user to pick key columns
            const colPick = await vscode.window.showQuickPick(
              leftInfo.columns.map(c => ({ label: c.name, description: c.dataType, picked: false })),
              { canPickMany: true, placeHolder: vscode.l10n.t('No primary key found. Select key column(s) for matching:') },
            );
            if (!colPick || colPick.length === 0) return;
            keyColumns = colPick.map(c => c.label);
          }

          const leftSource: DiffSource = {
            label: `${leftState.config.name} → ${item.schemaObject!.name}`,
            columns: leftData.columns,
            rows: leftData.rows,
            connectionId: item.connectionId,
            tableName: item.schemaObject!.name,
            schema: item.schemaObject!.schema,
            databaseName: item.databaseName,
          };

          const rightState = connectionManager.get(picked.connectionId);
          const rightSource: DiffSource = {
            label: `${rightState?.config.name || 'Unknown'} → ${picked.tableName}`,
            columns: rightData.columns,
            rows: rightData.rows,
            connectionId: picked.connectionId,
            tableName: picked.tableName,
            schema: picked.schema,
            databaseName: picked.databaseName,
          };

          const options: DiffOptions = { keyColumns, rowLimit };

          diffPanelManager.show(leftSource, rightSource, options,
            { columns: leftInfo.columns },
            { columns: rightInfo.columns },
            leftObjects,
            rightObjects,
            leftStats,
            rightStats,
          );
        },
      );
      } catch (err) {
        const message = wrapError(err);
        dbg('compareWith', 'ERROR:', message, err instanceof Error ? err.stack : '');
        vscode.window.showErrorMessage(vscode.l10n.t('Compare failed: {0}', message));
      }
    }),

    // Command palette: "Compare Data" — opens panel immediately with placeholder panes
    vscode.commands.registerCommand('viewstor.compareData', async () => {
      if (!diffPanelManager) return;

      if (connectionManager.getAll().filter(s => s.connected).length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t('No connected databases. Connect first.'));
        return;
      }

      diffPanelManager.showPending((placeholder) =>
        pickTableForDiff(connectionManager, placeholder),
      );
    }),
  );
}

interface TablePickItem {
  label: string;
  description: string;
  connectionId: string;
  tableName: string;
  schema?: string;
  databaseName?: string;
  connectionName: string;
}

/**
 * Show a QuickPick with a loading spinner while fetching table list from all connected databases.
 * The picker appears immediately with "Loading..." and becomes interactive when data arrives.
 */
function pickTableWithLoading(
  connectionManager: import('../connections/connectionManager').ConnectionManager,
  placeholder: string,
): Promise<TablePickItem | undefined> {
  return new Promise(resolve => {
    const picker = vscode.window.createQuickPick<TablePickItem>();
    picker.placeholder = placeholder;
    picker.busy = true;
    picker.enabled = false;
    picker.show();

    let resolved = false;
    const done = (value: TablePickItem | undefined) => {
      if (resolved) return;
      resolved = true;
      picker.dispose();
      resolve(value);
    };

    loadAllTables(connectionManager).then(items => {
      if (resolved) return;
      if (items.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t('No tables available for comparison.'));
        done(undefined);
        return;
      }
      picker.items = items;
      picker.busy = false;
      picker.enabled = true;
    });

    picker.onDidAccept(() => {
      done(picker.selectedItems[0]);
    });

    picker.onDidHide(() => {
      done(undefined);
    });
  });
}

async function loadAllTables(
  connectionManager: import('../connections/connectionManager').ConnectionManager,
): Promise<TablePickItem[]> {
  const items: TablePickItem[] = [];
  const allConnections = connectionManager.getAll().filter(state => state.connected);
  for (const conn of allConnections) {
    const driver = connectionManager.getDriver(conn.config.id);
    if (!driver) continue;
    try {
      const schema = await driver.getSchema();
      for (const schemaObj of schema) {
        if (schemaObj.children) {
          for (const child of schemaObj.children) {
            if (child.type === 'table' || child.type === 'view') {
              items.push({
                label: child.name,
                description: `${schemaObj.name} — ${conn.config.name}`,
                connectionId: conn.config.id,
                tableName: child.name,
                schema: schemaObj.name,
                connectionName: conn.config.name,
              });
            }
          }
        }
      }
    } catch { /* skip connections with schema fetch errors */ }
  }
  return items;
}

async function pickTableForDiff(
  connectionManager: import('../connections/connectionManager').ConnectionManager,
  placeholder: string,
): Promise<TablePickResult | undefined> {
  const pick = await pickTableWithLoading(connectionManager, placeholder);
  if (!pick) return undefined;
  return {
    connectionId: pick.connectionId,
    tableName: pick.tableName,
    schema: pick.schema,
    databaseName: pick.databaseName,
    connectionName: pick.connectionName,
  };
}
