import * as vscode from 'vscode';
import { CommandContext } from './shared';
import { QueryColumn } from '../types/query';

export interface MapCommandPayload {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  color?: string;
  tableName?: string;
  schema?: string;
  connectionName?: string;
}

export function registerMapCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('viewstor.showOnMap', (data?: MapCommandPayload) => {
      if (!data?.columns || !data?.rows) {
        vscode.window.showWarningMessage(vscode.l10n.t('No data to show on map.'));
        return;
      }
      if (data.rows.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t('No rows to plot on map.'));
        return;
      }

      const title = data.tableName
        ? `Map — ${data.tableName}`
        : data.connectionName
          ? `Map — ${data.connectionName}`
          : 'Map';

      const ok = ctx.mapPanelManager.show(data.columns, data.rows, title, {
        color: data.color,
      });

      if (!ok) {
        vscode.window.showWarningMessage(
          vscode.l10n.t('No geographic coordinates detected. Viewstor looks for a column containing GeoJSON, WKT, {lat,lng} objects, or a separate pair of lat/lng columns.'),
        );
      }
    }),
  );
}
