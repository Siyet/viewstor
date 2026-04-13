import * as vscode from 'vscode';
import { CommandContext } from './shared';
import { ConnectionTreeItem } from '../views/connectionTree';
import { DiffSource, DiffOptions } from '../diff/diffTypes';
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

      const leftDriver = item.databaseName
        ? await connectionManager.getDriverForDatabase(item.connectionId, item.databaseName)
        : connectionManager.getDriver(item.connectionId);
      if (!leftDriver) { dbg('compareWith', 'no leftDriver'); return; }

      const rightDriver = picked.databaseName
        ? await connectionManager.getDriverForDatabase(picked.connectionId, picked.databaseName)
        : connectionManager.getDriver(picked.connectionId);
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
            label: `${item.schemaObject!.name} — ${leftState.config.name}`,
            columns: leftData.columns,
            rows: leftData.rows,
            connectionId: item.connectionId,
            tableName: item.schemaObject!.name,
            schema: item.schemaObject!.schema,
            databaseName: item.databaseName,
          };

          const rightState = connectionManager.get(picked.connectionId);
          const rightSource: DiffSource = {
            label: `${picked.tableName} — ${rightState?.config.name || 'Unknown'}`,
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
          );
        },
      );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        dbg('compareWith', 'ERROR:', message, err instanceof Error ? err.stack : '');
        vscode.window.showErrorMessage(vscode.l10n.t('Compare failed: {0}', message));
      }
    }),

    // Command palette: "Compare Data"
    vscode.commands.registerCommand('viewstor.compareData', async () => {
      if (!diffPanelManager) return;

      if (connectionManager.getAll().filter(s => s.connected).length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t('No connected databases. Connect first.'));
        return;
      }

      const leftPick = await pickTableWithLoading(
        connectionManager,
        vscode.l10n.t('Select LEFT table'),
      );
      if (!leftPick) return;

      const rightPick = await pickTableWithLoading(
        connectionManager,
        vscode.l10n.t('Select RIGHT table'),
      );
      if (!rightPick) return;

      const rowLimit = vscode.workspace.getConfiguration('viewstor').get<number>('diffRowLimit', 10000);

      try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Comparing data...') },
        async () => {
          const leftDriver = leftPick.databaseName
            ? await connectionManager.getDriverForDatabase(leftPick.connectionId, leftPick.databaseName)
            : connectionManager.getDriver(leftPick.connectionId);
          const rightDriver = rightPick.databaseName
            ? await connectionManager.getDriverForDatabase(rightPick.connectionId, rightPick.databaseName)
            : connectionManager.getDriver(rightPick.connectionId);
          if (!leftDriver || !rightDriver) return;

          const [leftInfo, rightInfo, leftData, rightData] = await Promise.all([
            leftDriver.getTableInfo(leftPick.tableName, leftPick.schema),
            rightDriver.getTableInfo(rightPick.tableName, rightPick.schema),
            leftDriver.getTableData(leftPick.tableName, leftPick.schema, rowLimit, 0),
            rightDriver.getTableData(rightPick.tableName, rightPick.schema, rowLimit, 0),
          ]);

          let leftObjects, rightObjects;
          try {
            [leftObjects, rightObjects] = await Promise.all([
              leftDriver.getTableObjects ? leftDriver.getTableObjects(leftPick.tableName, leftPick.schema) : undefined,
              rightDriver.getTableObjects ? rightDriver.getTableObjects(rightPick.tableName, rightPick.schema) : undefined,
            ]);
          } catch { /* schema objects unavailable — diff will show columns only */ }

          const pkColumns = leftInfo.columns.filter(c => c.isPrimaryKey).map(c => c.name);
          let keyColumns = pkColumns;

          if (keyColumns.length === 0) {
            const colPick = await vscode.window.showQuickPick(
              leftInfo.columns.map(c => ({ label: c.name, description: c.dataType, picked: false })),
              { canPickMany: true, placeHolder: vscode.l10n.t('No primary key found. Select key column(s) for matching:') },
            );
            if (!colPick || colPick.length === 0) return;
            keyColumns = colPick.map(c => c.label);
          }

          const leftState = connectionManager.get(leftPick.connectionId);
          const rightState = connectionManager.get(rightPick.connectionId);

          const leftSource: DiffSource = {
            label: `${leftPick.tableName} — ${leftState?.config.name || 'Unknown'}`,
            columns: leftData.columns,
            rows: leftData.rows,
            connectionId: leftPick.connectionId,
            tableName: leftPick.tableName,
            schema: leftPick.schema,
          };

          const rightSource: DiffSource = {
            label: `${rightPick.tableName} — ${rightState?.config.name || 'Unknown'}`,
            columns: rightData.columns,
            rows: rightData.rows,
            connectionId: rightPick.connectionId,
            tableName: rightPick.tableName,
            schema: rightPick.schema,
          };

          diffPanelManager.show(leftSource, rightSource, { keyColumns, rowLimit },
            { columns: leftInfo.columns },
            { columns: rightInfo.columns },
            leftObjects,
            rightObjects,
          );
        },
      );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(vscode.l10n.t('Compare failed: {0}', message));
      }
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

    // Load tables in background
    loadAllTables(connectionManager).then(items => {
      if (items.length === 0) {
        picker.dispose();
        vscode.window.showWarningMessage(vscode.l10n.t('No tables available for comparison.'));
        resolve(undefined);
        return;
      }
      picker.items = items;
      picker.busy = false;
      picker.enabled = true;
    });

    picker.onDidAccept(() => {
      const selected = picker.selectedItems[0];
      picker.dispose();
      resolve(selected);
    });

    picker.onDidHide(() => {
      picker.dispose();
      resolve(undefined);
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
              });
            }
          }
        }
      }
    } catch { /* skip connections with schema fetch errors */ }
  }
  return items;
}
