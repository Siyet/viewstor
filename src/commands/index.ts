import * as vscode from 'vscode';
import { QueryDocumentProvider } from '../editors/queryEditor';
import { CommandContext, QueryCodeLensProvider, queryResults, historyDocMap, setOutputChannel, clearQueryDecorations, fireCodeLens } from './shared';
import { registerQueryCommands } from './queryCommands';
import { registerTableCommands } from './tableCommands';
import { registerConnectionCommands } from './connectionCommands';
import { registerHistoryCommands } from './historyCommands';
import { registerSchemaCommands } from './schemaCommands';
import { registerExportCommands } from './exportCommands';
import { registerDiffCommands } from './diffCommands';
import { registerStatsCommands } from './statsCommands';

// Re-export CommandContext so extension.ts import path stays the same
export type { CommandContext } from './shared';

export function registerCommands(context: vscode.ExtensionContext, ctx: CommandContext) {
  setOutputChannel(ctx.outputChannel);

  // Register CodeLens provider for query results
  const codeLensProvider = new QueryCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, codeLensProvider),
    vscode.commands.registerCommand('viewstor._showOutputChannel', () => {
      ctx.outputChannel.show(true);
    }),
    vscode.commands.registerCommand('viewstor._runStatementAtLine', async (line: number) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      await vscode.commands.executeCommand('viewstor.runQuery');
    }),
  );

  // Clear results when document changes or closes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      queryResults.delete(event.document.uri.toString());
      fireCodeLens();
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.toString() === event.document.uri.toString()) {
        clearQueryDecorations(editor);
      }
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      queryResults.delete(doc.uri.toString());
      historyDocMap.forEach((uri, id) => { if (uri === doc.uri.toString()) historyDocMap.delete(id); });
      ctx.queryEditorProvider.removeConnectionForUri(doc.uri);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('viewstor', new QueryDocumentProvider()),
    vscode.commands.registerCommand('viewstor._noop', () => {}),
  );

  // Register command groups
  registerQueryCommands(context, ctx);
  registerTableCommands(context, ctx);
  registerConnectionCommands(context, ctx);
  registerHistoryCommands(context, ctx);
  registerSchemaCommands(context, ctx);
  registerExportCommands(context, ctx);
  registerDiffCommands(context, ctx);
  registerStatsCommands(context, ctx);
}
