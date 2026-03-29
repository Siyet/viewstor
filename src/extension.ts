import * as vscode from 'vscode';
import { ConnectionManager } from './connections/connectionManager';
import { ConnectionTreeProvider } from './views/connectionTree';
import { QueryHistoryProvider } from './views/queryHistory';
import { QueryEditorProvider } from './editors/queryEditor';
import { ResultPanelManager } from './views/resultPanel';
import { ConnectionFormPanel } from './views/connectionForm';
import { FolderFormPanel } from './views/folderForm';
import { SqlCompletionProvider } from './editors/completionProvider';
import { IndexHintProvider } from './editors/indexHintProvider';
import { registerMcpCommands } from './mcp/server';
import { registerCommands } from './commands';
import { registerChatParticipant } from './chat/participant';

let connectionManager: ConnectionManager;

export function activate(context: vscode.ExtensionContext) {
  connectionManager = new ConnectionManager(context);

  const connectionTreeProvider = new ConnectionTreeProvider(connectionManager);
  const queryHistoryProvider = new QueryHistoryProvider(context);
  const queryEditorProvider = new QueryEditorProvider(connectionManager);
  const resultPanelManager = new ResultPanelManager(context);
  const connectionFormPanel = new ConnectionFormPanel(context, connectionManager);
  const folderFormPanel = new FolderFormPanel(context, connectionManager);

  const connectionTreeView = vscode.window.createTreeView('viewstor.connections', {
    treeDataProvider: connectionTreeProvider,
    showCollapseAll: true,
    dragAndDropController: connectionTreeProvider,
  });

  vscode.window.createTreeView('viewstor.queryHistory', {
    treeDataProvider: queryHistoryProvider,
  });

  registerCommands(context, {
    connectionManager,
    connectionTreeProvider,
    queryHistoryProvider,
    queryEditorProvider,
    resultPanelManager,
    connectionFormPanel,
    folderFormPanel,
  });

  // MCP-compatible commands for AI agent integration
  registerMcpCommands(context, connectionManager);

  // Copilot Chat participant (@viewstor)
  registerChatParticipant(context, connectionManager, queryEditorProvider);

  // SQL autocomplete from DB schema
  const completionProvider = new SqlCompletionProvider(connectionManager, queryEditorProvider);
  // Index hints (missing index warnings)
  const indexHintProvider = new IndexHintProvider(connectionManager, queryEditorProvider);
  indexHintProvider.register(context);
  // Status bar: Report Issue button (visible only when Viewstor is active)
  const reportBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
  reportBtn.text = '$(github) Viewstor: bug report';
  reportBtn.tooltip = 'Report an issue on GitHub';
  reportBtn.command = 'viewstor.reportIssue';

  function updateReportBtnVisibility() {
    const editor = vscode.window.activeTextEditor;
    const isSqlEditor = editor?.document.languageId === 'sql' || editor?.document.uri.scheme === 'viewstor';
    // Show when: tree visible, SQL editor active, OR no text editor active (webview panel like data table/results)
    const isViewstorContext = connectionTreeView.visible || isSqlEditor || !editor;
    if (isViewstorContext) reportBtn.show();
    else reportBtn.hide();
  }
  updateReportBtnVisibility();
  connectionTreeView.onDidChangeVisibility(() => updateReportBtnVisibility());
  vscode.window.onDidChangeActiveTextEditor(() => updateReportBtnVisibility());

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider('sql', completionProvider, '.'),
    connectionTreeView,
    reportBtn,
  );

  // "What's New" notification after update
  showWhatsNew(context);
}

function showWhatsNew(context: vscode.ExtensionContext) {
  const ext = vscode.extensions.getExtension('Siyet.viewstor');
  if (!ext) return;
  const currentVersion: string = ext.packageJSON.version;
  const lastVersion = context.globalState.get<string>('viewstor.lastVersion');
  const suppressed = context.globalState.get<boolean>('viewstor.suppressWhatsNew', false);

  context.globalState.update('viewstor.lastVersion', currentVersion);

  if (!lastVersion || lastVersion === currentVersion || suppressed) return;

  const seeChanges = vscode.l10n.t('See Changes');
  const dontShow = vscode.l10n.t('Don\'t show again');
  vscode.window.showInformationMessage(
    vscode.l10n.t('Viewstor updated to v{0}', currentVersion),
    seeChanges,
    dontShow,
  ).then(action => {
    if (action === seeChanges) {
      const changelogPath = vscode.Uri.joinPath(ext.extensionUri, 'CHANGELOG.md');
      vscode.commands.executeCommand('markdown.showPreview', changelogPath);
    } else if (action === dontShow) {
      context.globalState.update('viewstor.suppressWhatsNew', true);
    }
  });
}

export function deactivate() {
  connectionManager?.dispose();
}
