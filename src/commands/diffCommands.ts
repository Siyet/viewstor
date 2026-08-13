import * as vscode from 'vscode';
import { CommandContext, getRequiredDriver, wrapError } from './shared';
import type { ConnectionTreeItem } from '../views/connectionTree';
import type { DiffColumnMapping, DiffSource, DiffOptions } from '../diff/diffTypes';
import type { QueryResult } from '../types/query';
import type { TableInfo } from '../types/schema';
import { collectComparableTables } from '../diff/diffTablePicker';
import {
  completeCompareColumnSelection,
  createCompareColumnPlan,
  findCompatiblePrimaryKey,
} from '../diff/diffColumnSelection';
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
          assertDiffDataLoaded(leftData, rightData);

          // Fetch table objects (indexes, constraints, etc.) — non-critical, fallback to undefined
          let leftObjects, rightObjects;
          try {
            [leftObjects, rightObjects] = await Promise.all([
              leftDriver.getTableObjects ? leftDriver.getTableObjects(item.schemaObject!.name, item.schemaObject!.schema) : undefined,
              rightDriver.getTableObjects ? rightDriver.getTableObjects(picked.tableName, picked.schema) : undefined,
            ]);
          } catch { /* schema objects unavailable — diff will show columns only */ }

          // Fetch table statistics from both sides when both drivers support it.
          // Cross-type comparisons (e.g. PG ↔ ClickHouse) are no longer gated out —
          // `computeStatsDiff` (called in DiffPanelManager) restricts the view to the
          // explicit semantic allowlist and reports the hidden per-side counts so the
          // user can compare row counts without presenting same-named but incompatible
          // storage metrics as equivalent.
          let leftStats, rightStats;
          if (leftDriver.getTableStatistics && rightDriver.getTableStatistics) {
            try {
              [leftStats, rightStats] = await Promise.all([
                leftDriver.getTableStatistics(item.schemaObject!.name, item.schemaObject!.schema),
                rightDriver.getTableStatistics(picked.tableName, picked.schema),
              ]);
            } catch { /* statistics unavailable — diff will omit stats tab */ }
          }

          const keyColumns = await chooseKeyColumns(leftInfo, rightInfo);
          if (!keyColumns) return;
          const columnMappings = await chooseCompareColumns(leftInfo, rightInfo, keyColumns);
          if (!columnMappings) return;

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

          const options: DiffOptions = { keyColumns, columnMappings, rowLimit };

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
          const leftDriver = await getRequiredDriver(connectionManager, leftPick.connectionId, leftPick.databaseName);
          const rightDriver = await getRequiredDriver(connectionManager, rightPick.connectionId, rightPick.databaseName);
          if (!leftDriver || !rightDriver) return;

          const [leftInfo, rightInfo, leftData, rightData] = await Promise.all([
            leftDriver.getTableInfo(leftPick.tableName, leftPick.schema),
            rightDriver.getTableInfo(rightPick.tableName, rightPick.schema),
            leftDriver.getTableData(leftPick.tableName, leftPick.schema, rowLimit, 0),
            rightDriver.getTableData(rightPick.tableName, rightPick.schema, rowLimit, 0),
          ]);
          assertDiffDataLoaded(leftData, rightData);

          let leftObjects, rightObjects;
          try {
            [leftObjects, rightObjects] = await Promise.all([
              leftDriver.getTableObjects ? leftDriver.getTableObjects(leftPick.tableName, leftPick.schema) : undefined,
              rightDriver.getTableObjects ? rightDriver.getTableObjects(rightPick.tableName, rightPick.schema) : undefined,
            ]);
          } catch { /* schema objects unavailable — diff will show columns only */ }

          // Fetch stats from both sides regardless of DB type; see note in
          // `viewstor.compareWith` — the diff panel applies the cross-type metric contract.
          let leftStats, rightStats;
          if (leftDriver.getTableStatistics && rightDriver.getTableStatistics) {
            try {
              [leftStats, rightStats] = await Promise.all([
                leftDriver.getTableStatistics(leftPick.tableName, leftPick.schema),
                rightDriver.getTableStatistics(rightPick.tableName, rightPick.schema),
              ]);
            } catch { /* statistics unavailable — diff will omit stats tab */ }
          }

          const keyColumns = await chooseKeyColumns(leftInfo, rightInfo);
          if (!keyColumns) return;
          const columnMappings = await chooseCompareColumns(leftInfo, rightInfo, keyColumns);
          if (!columnMappings) return;

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

          diffPanelManager.show(leftSource, rightSource, { keyColumns, columnMappings, rowLimit },
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
        vscode.window.showErrorMessage(vscode.l10n.t('Compare failed: {0}', wrapError(err)));
      }
    }),
  );
}

function assertDiffDataLoaded(left: QueryResult, right: QueryResult): void {
  if (left.error) throw new Error(left.error);
  if (right.error) throw new Error(right.error);
}

/**
 * Resolve row-matching keys that exist on both sides. Prefer a complete PK from
 * the left source, then from the right source (important for table ↔ view
 * comparisons). If neither side exposes a usable PK, ask only about common
 * columns and suggest a conventional `id` column.
 */
async function chooseKeyColumns(left: TableInfo, right: TableInfo): Promise<string[] | undefined> {
  const rightNames = new Set(right.columns.map(column => column.name));
  const compatiblePrimaryKey = findCompatiblePrimaryKey(left, right);
  if (compatiblePrimaryKey) return compatiblePrimaryKey;

  const common = left.columns.filter(column => rightNames.has(column.name));
  if (common.length === 0) {
    throw new Error(vscode.l10n.t('The selected tables have no common columns to use for row matching.'));
  }

  const suggested = common.find(column => column.name.toLocaleLowerCase() === 'id')
    ?? (common.filter(column => /_id$/i.test(column.name)).length === 1
      ? common.find(column => /_id$/i.test(column.name))
      : undefined);
  const rightTypes = new Map(right.columns.map(column => [column.name, column.dataType]));
  const colPick = await vscode.window.showQuickPick(
    common.map(column => ({
      label: column.name,
      description: column.dataType === rightTypes.get(column.name)
        ? column.dataType
        : `${column.dataType} ↔ ${rightTypes.get(column.name)}`,
      picked: column.name === suggested?.name,
    })),
    {
      canPickMany: true,
      placeHolder: vscode.l10n.t('No shared primary key found. Select common column(s) that uniquely identify a row:'),
    },
  );
  if (!colPick || colPick.length === 0) return undefined;
  return colPick.map(column => column.label);
}

/**
 * Keep row comparison and schema comparison separate. When the sources expose
 * different column sets, show exact pairs, suggested similar-name mappings,
 * and the remaining one-sided fields. Matching keys are visible but mandatory;
 * unsafe mappings remain unchecked until the user explicitly selects them.
 */
async function chooseCompareColumns(
  left: TableInfo,
  right: TableInfo,
  keyColumns: string[],
): Promise<DiffColumnMapping[] | undefined> {
  const plan = createCompareColumnPlan(left, right, keyColumns);
  if (!plan.requiresSelection) return plan.fixedMappings;

  const picked = await vscode.window.showQuickPick(
    plan.candidates.map(column => ({
      id: column.id,
      label: column.label,
      description: column.description,
      picked: column.picked,
    })),
    {
      canPickMany: true,
      placeHolder: vscode.l10n.t('Select columns to compare. Exact matches are preselected; matching keys are always included.'),
    },
  );
  if (!picked) return undefined;
  return completeCompareColumnSelection(plan, picked.map(column => column.id));
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
      for (const table of collectComparableTables(schema)) {
        items.push({
          label: table.tableName,
          description: table.schema
            ? `${table.schema} — ${conn.config.name}`
            : conn.config.name,
          connectionId: conn.config.id,
          tableName: table.tableName,
          schema: table.schema,
        });
      }
    } catch { /* skip connections with schema fetch errors */ }
  }
  return items;
}
