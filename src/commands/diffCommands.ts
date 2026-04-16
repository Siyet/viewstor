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

      const leftLabel = `${leftState.config.name} → ${item.schemaObject.name}`;
      const rowLimit = vscode.workspace.getConfiguration('viewstor').get<number>('diffRowLimit', 10000);

      // Panel-first UX (#74): open the diff panel immediately with the left
      // source loaded and the right pane in a placeholder state. The picker
      // runs concurrently — the user sees the panel open right away and can
      // re-invoke the picker from inside the panel if they dismiss it.
      let picking = false;
      const runPicker = async (pendingPanel: vscode.WebviewPanel) => {
        if (picking) return;
        picking = true;
        try {
          const picked = await pickTableWithLoading(
            connectionManager,
            vscode.l10n.t('Select table to compare with "{0}"', item.schemaObject!.name),
          );
          dbg('compareWith', 'picked:', picked?.tableName, picked?.connectionId);
          if (!picked) return;
          await runCompare(
            connectionManager,
            diffPanelManager,
            leftState,
            item,
            picked,
            rowLimit,
            pendingPanel,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          dbg('compareWith', 'ERROR:', message, err instanceof Error ? err.stack : '');
          vscode.window.showErrorMessage(vscode.l10n.t('Compare failed: {0}', message));
        } finally {
          picking = false;
        }
      };

      const pendingPanel: vscode.WebviewPanel = diffPanelManager.showPending(
        leftLabel,
        () => { void runPicker(pendingPanel); },
      );
      // Auto-open the picker once so the user doesn't have to click twice on
      // the common path. If they cancel, the placeholder stays interactive.
      void runPicker(pendingPanel);
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

          let leftStats, rightStats;
          const leftStateCfg = connectionManager.get(leftPick.connectionId);
          const rightStateCfg = connectionManager.get(rightPick.connectionId);
          const sameType = leftStateCfg?.config.type === rightStateCfg?.config.type;
          if (sameType && leftDriver.getTableStatistics && rightDriver.getTableStatistics) {
            try {
              [leftStats, rightStats] = await Promise.all([
                leftDriver.getTableStatistics(leftPick.tableName, leftPick.schema),
                rightDriver.getTableStatistics(rightPick.tableName, rightPick.schema),
              ]);
            } catch { /* statistics unavailable — diff will omit stats tab */ }
          }

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
            label: `${leftState?.config.name || 'Unknown'} → ${leftPick.tableName}`,
            columns: leftData.columns,
            rows: leftData.rows,
            connectionId: leftPick.connectionId,
            tableName: leftPick.tableName,
            schema: leftPick.schema,
          };

          const rightSource: DiffSource = {
            label: `${rightState?.config.name || 'Unknown'} → ${rightPick.tableName}`,
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
            leftStats,
            rightStats,
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
 * Fetch both sides, compute the diff and hand the result to the panel. When
 * `existingPanel` is provided (panel-first UX), the `DiffPanelManager` adopts
 * that panel instead of opening a new one so the user sees a smooth transition
 * from the "pick a table" placeholder to the full diff view.
 */
async function runCompare(
  connectionManager: import('../connections/connectionManager').ConnectionManager,
  diffPanelManager: import('../diff/diffPanel').DiffPanelManager,
  leftState: import('../types/connection').ConnectionState,
  item: ConnectionTreeItem,
  picked: TablePickItem,
  rowLimit: number,
  existingPanel?: vscode.WebviewPanel,
): Promise<void> {
  const leftDriver = item.databaseName
    ? await connectionManager.getDriverForDatabase(item.connectionId!, item.databaseName)
    : connectionManager.getDriver(item.connectionId!);
  if (!leftDriver) { dbg('compareWith', 'no leftDriver'); return; }
  const rightDriver = picked.databaseName
    ? await connectionManager.getDriverForDatabase(picked.connectionId, picked.databaseName)
    : connectionManager.getDriver(picked.connectionId);
  if (!rightDriver) { dbg('compareWith', 'no rightDriver for', picked.connectionId); return; }

  dbg('compareWith', 'starting diff, rowLimit:', rowLimit);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Comparing data...') },
    async () => {
      const [leftInfo, rightInfo, leftData, rightData] = await Promise.all([
        leftDriver.getTableInfo(item.schemaObject!.name, item.schemaObject!.schema),
        rightDriver.getTableInfo(picked.tableName, picked.schema),
        leftDriver.getTableData(item.schemaObject!.name, item.schemaObject!.schema, rowLimit, 0),
        rightDriver.getTableData(picked.tableName, picked.schema, rowLimit, 0),
      ]);

      let leftObjects, rightObjects;
      try {
        [leftObjects, rightObjects] = await Promise.all([
          leftDriver.getTableObjects ? leftDriver.getTableObjects(item.schemaObject!.name, item.schemaObject!.schema) : undefined,
          rightDriver.getTableObjects ? rightDriver.getTableObjects(picked.tableName, picked.schema) : undefined,
        ]);
      } catch { /* schema objects unavailable — diff will show columns only */ }

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
        undefined,
        existingPanel,
      );
    },
  );
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
              });
            }
          }
        }
      }
    } catch { /* skip connections with schema fetch errors */ }
  }
  return items;
}
