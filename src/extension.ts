import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ConnectionManager } from './connections/connectionManager';
import { ConnectionTreeProvider } from './views/connectionTree';
import { QueryHistoryProvider } from './views/queryHistory';
import { QueryEditorProvider } from './editors/queryEditor';
import { ResultPanelManager } from './views/resultPanel';
import { ConnectionFormPanel } from './views/connectionForm';
import { FolderFormPanel } from './views/folderForm';
import { SqlCompletionProvider } from './editors/completionProvider';
import { IndexHintProvider } from './editors/indexHintProvider';
import { SqlDiagnosticProvider } from './editors/sqlDiagnosticProvider';
import { registerMcpCommands } from './mcp/server';
import { registerCommands } from './commands';
import { registerChatParticipant } from './chat/participant';
import { TempFileManager } from './services/tempFileManager';
import { QueryFileManager } from './services/queryFileManager';
import { setDebugChannel, dbg } from './utils/debug';

let connectionManager: ConnectionManager;
let outputChannel: vscode.LogOutputChannel;
let tempFileManager: TempFileManager;
let queryFileManager: QueryFileManager;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Viewstor', { log: true });
  context.subscriptions.push(outputChannel);
  setDebugChannel(outputChannel);

  try {
    dbg('activate', 'starting activation');
    connectionManager = new ConnectionManager(context);

    const connectionTreeProvider = new ConnectionTreeProvider(connectionManager);
    const queryHistoryProvider = new QueryHistoryProvider(context);
    queryFileManager = new QueryFileManager();
    const queryEditorProvider = new QueryEditorProvider(connectionManager, queryFileManager);
    const resultPanelManager = new ResultPanelManager(context);
    tempFileManager = new TempFileManager(context, queryFileManager);
    tempFileManager.setPostMessage((key, msg) => resultPanelManager.postMessage(key, msg));
    resultPanelManager.setTempFileManager(tempFileManager);

    // Wire up file rename handling (pin on save)
    queryFileManager.setOnQueryPinned((oldUri, newUri) => {
      dbg('onQueryPinned', 'old:', oldUri.fsPath, 'new:', newUri.fsPath);
      queryEditorProvider.handleFileRenamed(oldUri, newUri);

      // Mark the corresponding history entry as pinned with file path.
      // Match by connectionId + databaseName, take the most recent entry without filePath.
      // Query text is NOT compared — user often edits the query after execution before saving.
      const metadata = queryFileManager.parseMetadataFromFile(newUri.fsPath);
      dbg('onQueryPinned', 'metadata:', metadata);
      if (metadata) {
        const entries = queryHistoryProvider.getEntries();
        // entries are sorted newest-first (unshift in addEntry), so first match = most recent
        const match = entries.find(e =>
          e.connectionId === metadata.connectionId &&
          !e.filePath &&
          (e.databaseName ?? undefined) === metadata.databaseName,
        );
        dbg('onQueryPinned', 'historyMatch:', match ? { id: match.id, query: match.query.substring(0, 60) } : 'none');
        if (match) {
          queryHistoryProvider.togglePin(match.id, true);
          queryHistoryProvider.updateFilePath(match.id, newUri.fsPath);
        }
      }
    });
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
      outputChannel,
      tempFileManager,
      queryFileManager,
    });

    // MCP-compatible commands for AI agent integration
    registerMcpCommands(context, connectionManager);

    // Register MCP server for VS Code-internal agents (Copilot, Cursor)
    registerMcpServerProvider(context);

    // Copilot Chat participant (@viewstor)
    registerChatParticipant(context, connectionManager, queryEditorProvider);

    // SQL autocomplete from DB schema
    const completionProvider = new SqlCompletionProvider(connectionManager, queryEditorProvider);
    // Index hints (missing index warnings)
    const indexHintProvider = new IndexHintProvider(connectionManager, queryEditorProvider);
    indexHintProvider.register(context);
    // SQL diagnostics (non-existent tables/columns)
    const sqlDiagnosticProvider = new SqlDiagnosticProvider(connectionManager, queryEditorProvider);
    sqlDiagnosticProvider.register(context);
    // Status bar: Report Issue button (visible only when Viewstor is active)
    const reportBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    reportBtn.text = '$(github) Viewstor: bug report';
    reportBtn.tooltip = 'Report an issue on GitHub';
    reportBtn.command = 'viewstor.reportIssue';

    const updateReportBtnVisibility = () => {
      const editor = vscode.window.activeTextEditor;
      const isSqlEditor = editor?.document.languageId === 'sql' || editor?.document.uri.scheme === 'viewstor';
      // Show when: tree visible, SQL editor active, OR no text editor active (webview panel like data table/results)
      const isViewstorContext = connectionTreeView.visible || isSqlEditor || !editor;
      if (isViewstorContext) reportBtn.show();
      else reportBtn.hide();
    };
    updateReportBtnVisibility();
    connectionTreeView.onDidChangeVisibility(() => updateReportBtnVisibility());
    vscode.window.onDidChangeActiveTextEditor(() => updateReportBtnVisibility());

    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider('sql', completionProvider, '.'),
      connectionTreeView,
      reportBtn,
    );

    // MCP launcher at stable path (~/.viewstor/mcp-server.js)
    ensureMcpLauncher(context);
    context.subscriptions.push(
      vscode.commands.registerCommand('viewstor.setupMcp', () => showMcpSetup()),
      vscode.commands.registerCommand('viewstor.getStarted', () => showGetStarted(context)),
    );

    // Welcome page on first install
    showGetStartedOnFirstInstall(context);

    // "What's New" notification after update
    showWhatsNew(context);

    outputChannel.info(`Viewstor activated (v${vscode.extensions.getExtension('Siyet.viewstor')?.packageJSON.version ?? '?'})`);

    // Test API — used by VS Code e2e tests only
    return { queryHistoryProvider, queryFileManager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    outputChannel.error(`Activation failed: ${message}`);
    if (stack) outputChannel.error(stack);
    const showLogs = vscode.l10n.t('Show Logs');
    vscode.window.showErrorMessage(
      vscode.l10n.t('Viewstor failed to activate: {0}', message),
      showLogs,
    ).then(action => {
      if (action === showLogs) outputChannel.show();
    });
    throw err;
  }
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

function getMcpLauncherPath(): string {
  return path.join(os.homedir(), '.viewstor', 'mcp-server.js');
}

function ensureMcpLauncher(context: vscode.ExtensionContext) {
  try {
    const launcherPath = getMcpLauncherPath();
    const actualMcpServer = path.join(context.extensionPath, 'dist', 'mcp-server.js').replace(/\\/g, '/');
    const content = `#!/usr/bin/env node\n// Auto-generated by Viewstor extension — do not edit\nrequire("${actualMcpServer}");\n`;
    const dir = path.dirname(launcherPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(launcherPath, content, 'utf-8');
  } catch {
    // Non-critical — don't block activation
  }
}

function showMcpSetup() {
  const launcherPath = getMcpLauncherPath().replace(/\\/g, '/');
  const config = JSON.stringify({
    mcpServers: {
      viewstor: {
        command: 'node',
        args: [launcherPath],
      },
    },
  }, null, 2);

  const copyBtn = vscode.l10n.t('Copy Config');
  vscode.window.showInformationMessage(
    vscode.l10n.t('Add this to your AI agent MCP config (Claude Code, Cline, etc.):'),
    { modal: true, detail: config },
    copyBtn,
  ).then(action => {
    if (action === copyBtn) {
      vscode.env.clipboard.writeText(config);
      vscode.window.showInformationMessage(vscode.l10n.t('MCP config copied to clipboard'));
    }
  });
}

function registerMcpServerProvider(context: vscode.ExtensionContext) {
  // vscode.lm.registerMcpServerDefinitionProvider may not exist in older VS Code versions
  if (!vscode.lm?.registerMcpServerDefinitionProvider) return;

  const version = vscode.extensions.getExtension('Siyet.viewstor')?.packageJSON.version ?? '0.0.0';
  const mcpServerPath = path.join(context.extensionPath, 'dist', 'mcp-server.js');

  const provider = vscode.lm.registerMcpServerDefinitionProvider('viewstor.mcpServer', {
    provideMcpServerDefinitions: async () => [
      new vscode.McpStdioServerDefinition('Viewstor', 'node', [mcpServerPath], {}, version),
    ],
    resolveMcpServerDefinition: async (server: vscode.McpServerDefinition) => server,
  });
  context.subscriptions.push(provider);
}

function showGetStartedOnFirstInstall(context: vscode.ExtensionContext) {
  const shown = context.globalState.get<boolean>('viewstor.getStartedShown');
  if (shown) return;
  context.globalState.update('viewstor.getStartedShown', true);
  showGetStarted(context);
}

function showGetStarted(_context: vscode.ExtensionContext) {
  const mcpLauncherPath = getMcpLauncherPath().replace(/\\/g, '/');
  const mcpConfig = JSON.stringify({
    mcpServers: {
      viewstor: {
        command: 'node',
        args: [mcpLauncherPath],
      },
    },
  }, null, 2);

  const panel = vscode.window.createWebviewPanel(
    'viewstor.getStarted',
    'Viewstor — Get Started',
    vscode.ViewColumn.Active,
    { enableScripts: true },
  );

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px 40px; max-width: 720px; margin: 0 auto; line-height: 1.6; }
  h1 { font-size: 1.8em; margin-bottom: 4px; }
  h2 { font-size: 1.2em; margin-top: 28px; margin-bottom: 8px; color: var(--vscode-textLink-foreground); }
  .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 24px; }
  .step { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; padding: 16px 20px; margin-bottom: 16px; }
  .step-number { display: inline-block; width: 24px; height: 24px; line-height: 24px; text-align: center; border-radius: 50%; background: var(--vscode-textLink-foreground); color: var(--vscode-editor-background); font-weight: bold; font-size: 0.85em; margin-right: 8px; }
  code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; font-family: var(--vscode-editor-fontFamily); font-size: 0.9em; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 12px 16px; border-radius: 6px; overflow-x: auto; font-family: var(--vscode-editor-fontFamily); font-size: 0.85em; position: relative; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 0.9em; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .copy-btn { position: absolute; top: 8px; right: 8px; padding: 4px 10px; font-size: 0.8em; }
  .actions { margin-top: 24px; display: flex; gap: 10px; }
  .actions button { padding: 8px 18px; font-size: 1em; }
  ul { padding-left: 20px; }
  li { margin-bottom: 4px; }
  .kbd { display: inline-block; background: var(--vscode-keybindingLabel-background); border: 1px solid var(--vscode-keybindingLabel-border); border-bottom-color: var(--vscode-keybindingLabel-bottomBorder); border-radius: 3px; padding: 1px 6px; font-size: 0.85em; }
</style>
</head>
<body>
  <h1>Welcome to Viewstor</h1>
  <p class="subtitle">Free, open-source database client for VS Code. PostgreSQL, Redis, ClickHouse.</p>

  <h2><span class="step-number">1</span> Add a connection</h2>
  <div class="step">
    <p>Click the <strong>+</strong> button in the <strong>Viewstor</strong> sidebar panel, or run <code>Viewstor: Add Connection</code> from the Command Palette (<span class="kbd">Ctrl+Shift+P</span>).</p>
    <p style="margin-top:8px"><strong>Migrating from another tool?</strong> Import your existing connections:</p>
    <ul>
      <li><strong>DBeaver</strong> — import from <code>data-sources.json</code></li>
      <li><strong>DataGrip</strong> — import from <code>dataSources.xml</code></li>
      <li><strong>pgAdmin</strong> — import from <code>servers.json</code></li>
    </ul>
    <p>Use <code>Viewstor: Import Connections</code> command and select your config file.</p>
  </div>

  <h2><span class="step-number">2</span> Browse & query</h2>
  <div class="step">
    <p>Expand a connection to see schemas, tables, and columns. Click a table to view data. Right-click a connection and select <strong>New Query</strong> to open a SQL editor.</p>
    <p style="margin-top:8px">Features: autocomplete (<code>.</code> trigger), index hints, enum suggestions, safe mode (Seq Scan protection).</p>
  </div>

  <h2><span class="step-number">3</span> Setup MCP for AI agents</h2>
  <div class="step">
    <p>Connect your databases to AI agents (Claude Code, Cline, Cursor, etc.) via the built-in MCP server. Add this to your agent's MCP config:</p>
    <pre id="mcp-config"><button class="copy-btn" id="copy-btn">Copy</button>${escapeHtml(mcpConfig)}</pre>
    <p style="margin-top:8px; color: var(--vscode-descriptionForeground)">The MCP server path updates automatically when the extension is updated — no manual changes needed.</p>
  </div>

  <div class="actions">
    <button id="btn-add">Add Connection</button>
    <button id="btn-import">Import Connections</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('copy-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'copyMcpConfig' });
      const btn = document.getElementById('copy-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    });
    document.getElementById('btn-add').addEventListener('click', () => {
      vscode.postMessage({ type: 'addConnection' });
    });
    document.getElementById('btn-import').addEventListener('click', () => {
      vscode.postMessage({ type: 'importConnections' });
    });
  </script>
</body>
</html>`;

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'copyMcpConfig':
        await vscode.env.clipboard.writeText(mcpConfig);
        vscode.window.showInformationMessage(vscode.l10n.t('MCP config copied to clipboard'));
        break;
      case 'addConnection':
        vscode.commands.executeCommand('viewstor.addConnection');
        break;
      case 'importConnections':
        vscode.commands.executeCommand('viewstor.importConnections');
        break;
    }
  });
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function deactivate() {
  queryFileManager?.dispose();
  tempFileManager?.dispose();
  connectionManager?.dispose();
}
