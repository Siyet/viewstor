import * as vscode from 'vscode';
import { CommandContext, logAndShowError } from './shared';
import { ConnectionTreeItem } from '../views/connectionTree';

export function registerSchemaCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  const { connectionManager } = ctx;

  context.subscriptions.push(
    vscode.commands.registerCommand('viewstor.showDDL', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId || !item.schemaObject) return;
      const driver = connectionManager.getDriver(item.connectionId);
      if (!driver || !driver.getDDL) {
        vscode.window.showWarningMessage(vscode.l10n.t('DDL generation is not supported for this connection type.'));
        return;
      }
      try {
        const ddl = await driver.getDDL(item.schemaObject.name, item.schemaObject.type, item.schemaObject.schema);
        const doc = await vscode.workspace.openTextDocument({ content: ddl, language: 'sql' });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        logAndShowError(vscode.l10n.t('Failed to get DDL: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),

    vscode.commands.registerCommand('viewstor.copyName', async (item?: ConnectionTreeItem) => {
      const name = item?.schemaObject?.name || item?.label?.toString() || '';
      if (name) {
        await vscode.env.clipboard.writeText(name);
        vscode.window.showInformationMessage(vscode.l10n.t('Copied: {0}', name));
      }
    }),

    vscode.commands.registerCommand('viewstor.renameObject', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId || !item.schemaObject) return;
      const obj = item.schemaObject;
      const schema = obj.schema || 'public';
      const quoted = `"${schema}"."${obj.name}"`;
      let sql = '';
      switch (obj.type) {
        case 'table': sql = `ALTER TABLE ${quoted} RENAME TO "${obj.name}_new";`; break;
        case 'view': sql = `ALTER VIEW ${quoted} RENAME TO "${obj.name}_new";`; break;
        case 'index': sql = `ALTER INDEX "${schema}"."${obj.name}" RENAME TO "${obj.name}_new";`; break;
        case 'sequence': sql = `ALTER SEQUENCE ${quoted} RENAME TO "${obj.name}_new";`; break;
        case 'column': sql = `ALTER TABLE "${schema}"."${obj.schema}" RENAME COLUMN "${obj.name}" TO "${obj.name}_new";`; break;
        case 'schema': sql = `ALTER SCHEMA "${obj.name}" RENAME TO "${obj.name}_new";`; break;
        case 'database': sql = `ALTER DATABASE "${obj.name}" RENAME TO "${obj.name}_new";`; break;
        default: return;
      }
      const doc = await vscode.workspace.openTextDocument({ content: sql, language: 'sql' });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('viewstor.createObject', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId) return;
      const obj = item.schemaObject;
      const schema = obj?.schema || obj?.name || 'public';
      let sql = '';
      switch (obj?.type || item.itemType) {
        case 'connection':
        case 'database':
          sql = 'CREATE DATABASE "new_database";'; break;
        case 'schema':
          sql = 'CREATE SCHEMA "new_schema";'; break;
        case 'table':
          sql = `CREATE TABLE "${schema}"."new_table" (\n  id BIGSERIAL PRIMARY KEY,\n  name TEXT NOT NULL,\n  created_at TIMESTAMPTZ DEFAULT NOW()\n);`; break;
        case 'group':
          if (obj?.name === 'Indexes' || obj?.name?.startsWith('Indexes')) {
            sql = `CREATE INDEX CONCURRENTLY "idx_table_column"\n  ON "${schema}"."table_name" ("column_name");`;
          } else if (obj?.name === 'Triggers' || obj?.name?.startsWith('Triggers')) {
            sql = `CREATE TRIGGER "trigger_name"\n  BEFORE INSERT ON "${schema}"."table_name"\n  FOR EACH ROW\n  EXECUTE FUNCTION trigger_function();`;
          }
          break;
        default:
          sql = `CREATE TABLE "${schema}"."new_table" (\n  id BIGSERIAL PRIMARY KEY,\n  name TEXT NOT NULL,\n  created_at TIMESTAMPTZ DEFAULT NOW()\n);`;
      }
      if (sql) {
        const doc = await vscode.workspace.openTextDocument({ content: sql, language: 'sql' });
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    }),

    vscode.commands.registerCommand('viewstor.dropObject', async (item?: ConnectionTreeItem) => {
      if (!item?.connectionId || !item.schemaObject) return;
      const obj = item.schemaObject;
      const schema = obj.schema || 'public';
      const quoted = `"${schema}"."${obj.name}"`;
      let sql = '';
      switch (obj.type) {
        case 'table': sql = `DROP TABLE ${quoted} CASCADE;`; break;
        case 'view': sql = `DROP VIEW ${quoted} CASCADE;`; break;
        case 'index': sql = `DROP INDEX CONCURRENTLY "${schema}"."${obj.name}";`; break;
        case 'sequence': sql = `DROP SEQUENCE ${quoted} CASCADE;`; break;
        case 'trigger': sql = `DROP TRIGGER "${obj.name}" ON "${schema}"."table_name" CASCADE;`; break;
        case 'schema': sql = `DROP SCHEMA "${obj.name}" CASCADE;`; break;
        case 'database': sql = `DROP DATABASE "${obj.name}";`; break;
        default: return;
      }
      const doc = await vscode.workspace.openTextDocument({ content: `-- ⚠️ DANGER: This will permanently delete data!\n${sql}`, language: 'sql' });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('viewstor.reportIssue', async () => {
      const ext = vscode.extensions.getExtension('viewstor.viewstor');
      const version = ext?.packageJSON?.version || 'unknown';
      const vscodeVersion = vscode.version;
      const platform = process.platform;
      const arch = process.arch;
      const nodeVersion = process.version;
      const locale = vscode.env.language;
      const theme = vscode.window.activeColorTheme?.kind === 2 ? 'Dark' : vscode.window.activeColorTheme?.kind === 1 ? 'Light' : 'High Contrast';

      const connections = connectionManager.getAll();
      const connSummary = connections.length > 0
        ? connections.map(s => `${s.config.type}${s.connected ? ' (connected)' : ''}`).join(', ')
        : 'none';

      const safeMode = vscode.workspace.getConfiguration('viewstor').get<string>('safeMode', 'warn');

      const body =
`## What happened?

<!-- Describe what went wrong -->

## What did you expect?

<!-- Describe expected behavior -->

## Steps to reproduce

1.
2.
3.

## Screenshots

<!-- Drag & drop screenshots here if applicable -->

## Environment

| Parameter | Value |
|---|---|
| Viewstor | v${version} |
| VS Code | ${vscodeVersion} |
| OS | ${platform} ${arch} |
| Node | ${nodeVersion} |
| Theme | ${theme} |
| Locale | ${locale} |
| Safe mode | ${safeMode} |
| Connections | ${connSummary} |
`;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cp = require('child_process');
      const encoded = body
        .replace(/&/g, '%26')
        .replace(/\|/g, '%7C')
        .replace(/\n/g, '%0A')
        .replace(/ /g, '%20');
      const url = `https://github.com/Siyet/viewstor/issues/new?labels=bug&body=${encoded}`;
      if (process.platform === 'win32') {
        cp.exec(`start "" "${url}"`);
      } else if (process.platform === 'darwin') {
        cp.exec(`open "${url}"`);
      } else {
        cp.exec(`xdg-open "${url}"`);
      }
    }),
  );
}
