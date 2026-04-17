import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionConfig, DatabaseType, DEFAULT_PORTS } from '../types/connection';
import { ConnectionManager } from '../connections/connectionManager';
import { createDriver } from '../drivers';
import { wrapError } from '../utils/errors';

export interface ConnectionFormDefaults {
  folderId?: string;
  readonly?: boolean;
}

export class ConnectionFormPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionManager: ConnectionManager,
  ) {}

  open(config?: ConnectionConfig, defaults?: ConnectionFormDefaults) {
    const folderDefaults = defaults || {};

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.panel.webview.postMessage({ type: 'setConfig', config: config || null, defaults: folderDefaults });
      return;
    }

    const title = config ? `Edit: ${config.name}` : 'New Connection';

    this.panel = vscode.window.createWebviewPanel(
      'viewstor.connectionForm',
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this.context.extensionPath, 'dist')),
        ],
      },
    );

    this.panel.iconPath = new vscode.ThemeIcon('database');

    const distRoot = vscode.Uri.file(path.join(this.context.extensionPath, 'dist'));
    const tokensUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'styles', 'tokens.css'));
    const codiconUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'styles', 'codicon.css'));
    const styleUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'styles', 'connection-form.css'));
    const shellUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'scripts', 'webview-shell.js'));
    const elementsUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'scripts', 'vscode-elements.js'));
    const scriptUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'scripts', 'connection-form.js'));

    this.panel.webview.html = this.buildHtml(
      { tokensUri, codiconUri, styleUri, shellUri, elementsUri, scriptUri },
      config,
      folderDefaults,
    );

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'save':
            await this.handleSave(message.config);
            break;
          case 'testConnection':
            await this.handleTest(message.config);
            break;
          case 'fetchDatabases':
            await this.handleFetchDatabases(message.config);
            break;
          case 'cancel':
            this.panel?.dispose();
            break;
        }
      },
      undefined,
      this.context.subscriptions,
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private async handleSave(data: Record<string, string>) {
    const config = this.parseFormData(data);
    const existing = this.connectionManager.get(config.id);

    if (existing) {
      await this.connectionManager.update(config);
      vscode.window.showInformationMessage(vscode.l10n.t('Connection "{0}" updated.', config.name));
    } else {
      await this.connectionManager.add(config);
      vscode.window.showInformationMessage(vscode.l10n.t('Connection "{0}" added.', config.name));
    }

    this.panel?.dispose();
  }

  private async handleTest(data: Record<string, string>) {
    const config = this.parseFormData(data);
    this.panel?.webview.postMessage({ type: 'testResult', status: 'testing' });

    try {
      const success = await this.connectionManager.testConnection(config);
      this.panel?.webview.postMessage({
        type: 'testResult',
        status: success ? 'success' : 'failure',
        message: success ? vscode.l10n.t('Connection successful!') : vscode.l10n.t('Connection failed.'),
      });
    } catch (err) {
      this.panel?.webview.postMessage({
        type: 'testResult',
        status: 'failure',
        message: wrapError(err),
      });
    }
  }

  private async handleFetchDatabases(data: Record<string, string>) {
    const config = this.parseFormData(data);
    // Use 'postgres' as default DB for listing databases (always exists in PG)
    if (config.type === 'postgresql' && !config.database) {
      config.database = 'postgres';
    }
    try {
      const driver = createDriver(config.type);
      await driver.connect(config);
      let databases: string[] = [];
      if (config.type === 'postgresql') {
        const res = await driver.execute('SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname');
        databases = res.rows.map((r: Record<string, unknown>) => String(r.datname));
      } else if (config.type === 'clickhouse') {
        const res = await driver.execute('SHOW DATABASES');
        databases = res.rows.map((r: Record<string, unknown>) => String(r.name || Object.values(r)[0]));
      }
      await driver.disconnect();
      this.panel?.webview.postMessage({ type: 'databaseList', databases });
    } catch {
      this.panel?.webview.postMessage({ type: 'databaseList', databases: [] });
    }
  }

  private parseFormData(data: Record<string, string>): ConnectionConfig {
    return {
      id: data.id || generateId(),
      name: data.name,
      type: data.type as DatabaseType,
      host: data.host || 'localhost',
      port: parseInt(data.port, 10) || DEFAULT_PORTS[data.type as DatabaseType],
      username: data.username || undefined,
      password: data.password || undefined,
      database: data.database || undefined,
      databases: data.databases ? data.databases.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
      ssl: data.ssl === 'true',
      color: data.color || undefined,
      readonly: data.readonly === 'true' ? true : undefined,
      folderId: data.folderId || undefined,
      scope: (data.scope as 'user' | 'project') || 'user',
      safeMode: data.safeMode ? (data.safeMode as 'off' | 'warn' | 'block') : undefined,
      proxy: data.proxyType && data.proxyType !== 'none' ? {
        type: data.proxyType as 'ssh' | 'socks5' | 'http',
        sshHost: data.sshHost || undefined,
        sshPort: parseInt(data.sshPort, 10) || 22,
        sshUsername: data.sshUsername || undefined,
        sshPassword: data.sshPassword || undefined,
        sshPrivateKey: data.sshPrivateKey || undefined,
        proxyHost: data.proxyHost || undefined,
        proxyPort: parseInt(data.proxyPort, 10) || 1080,
        proxyUsername: data.proxyUsername || undefined,
        proxyPassword: data.proxyPassword || undefined,
      } : undefined,
      hiddenSchemas: data.hiddenSchemas ? (() => {
        const schemas = data.hiddenSchemas.split(',').map((s: string) => s.trim()).filter(Boolean);
        if (schemas.length === 0) return undefined;
        const db = data.database || 'default';
        return { [db]: schemas };
      })() : undefined,
    };
  }

  private buildHtml(
    uris: {
      tokensUri: vscode.Uri;
      codiconUri: vscode.Uri;
      styleUri: vscode.Uri;
      shellUri: vscode.Uri;
      elementsUri: vscode.Uri;
      scriptUri: vscode.Uri;
    },
    config?: ConnectionConfig,
    defaults?: ConnectionFormDefaults,
  ): string {
    const c = config;
    const isEdit = !!c;
    const readonlyChecked = c ? !!c.readonly : !!defaults?.readonly;
    const folderId = c?.folderId || defaults?.folderId || '';
    const cspSource = (this.panel?.webview as vscode.Webview).cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src ${cspSource};">
  <link id="vscode-codicon-stylesheet" rel="stylesheet" href="${uris.codiconUri}">
  <link rel="stylesheet" href="${uris.tokensUri}">
  <link rel="stylesheet" href="${uris.styleUri}">
  <script src="${uris.shellUri}"></script>
  <script type="module" src="${uris.elementsUri}"></script>
</head>
<body>
  <div class="form-container">
    <h2>${isEdit ? 'Edit Connection' : 'New Connection'}</h2>

    <input type="hidden" id="connId" value="${esc(c?.id)}">
    <input type="hidden" id="folderId" value="${esc(folderId)}">

    <div class="form-group">
      <label for="connName">Connection Name</label>
      <vscode-textfield id="connName" placeholder="My Database" value="${esc(c?.name)}"></vscode-textfield>
    </div>

    <div class="form-group">
      <label for="dbType">Database Type</label>
      <vscode-single-select id="dbType"${isEdit ? ' disabled' : ''}>
        <vscode-option value="postgresql"${c?.type === 'postgresql' ? ' selected' : ''}>PostgreSQL</vscode-option>
        <vscode-option value="redis"${c?.type === 'redis' ? ' selected' : ''}>Redis</vscode-option>
        <vscode-option value="clickhouse"${c?.type === 'clickhouse' ? ' selected' : ''}>ClickHouse</vscode-option>
        <vscode-option value="sqlite"${c?.type === 'sqlite' ? ' selected' : ''}>SQLite</vscode-option>
      </vscode-single-select>
    </div>

    <div class="form-row" id="hostPortRow">
      <div class="form-group flex-grow">
        <label for="host">Host</label>
        <vscode-textfield id="host" placeholder="localhost" value="${esc(c?.host || 'localhost')}"></vscode-textfield>
      </div>
      <div class="form-group port-field">
        <label for="port">Port</label>
        <vscode-textfield id="port" type="number" value="${c?.port || DEFAULT_PORTS[c?.type || 'postgresql']}"></vscode-textfield>
      </div>
    </div>

    <div id="authFields">
      <div class="form-group">
        <label for="username">Username</label>
        <vscode-textfield id="username" value="${esc(c?.username)}"></vscode-textfield>
      </div>

      <div class="form-group">
        <label for="password">Password</label>
        <vscode-textfield id="password" type="password" value="${esc(c?.password)}"></vscode-textfield>
      </div>
    </div>

    <div id="dbFields" class="form-group" style="position:relative;">
      <label for="dbInput">Databases</label>
      <div class="chips-container" id="chipsContainer">
        <input type="text" id="dbInput" class="chips-input" placeholder="Type database name..." autocomplete="off" />
      </div>
      <div id="dbDropdown" class="db-dropdown hidden"></div>
      <input type="hidden" id="database" value="${esc(c?.database)}" />
      <input type="hidden" id="databases" value="${esc(c?.databases?.join(','))}" />
    </div>

    <div id="redisDbField" class="form-group hidden">
      <label for="redisDb">Database Number (0-15)</label>
      <vscode-textfield id="redisDb" type="number" min="0" max="15" value="${c?.type === 'redis' && c?.database ? esc(c.database) : '0'}"></vscode-textfield>
    </div>

    <div id="sqliteFileField" class="form-group hidden">
      <label for="sqliteFile">Database File</label>
      <vscode-textfield id="sqliteFile" placeholder="/path/to/database.sqlite" value="${c?.type === 'sqlite' ? esc(c?.database) : ''}"></vscode-textfield>
      <div class="field-hint">
        Path to an existing .sqlite/.db file, or a new file to create. Use <code>:memory:</code> for in-memory database.
      </div>
    </div>

    <div class="form-group checkbox-group" id="sslGroup">
      <vscode-checkbox id="ssl"${c?.ssl ? ' checked' : ''}>Use SSL</vscode-checkbox>
    </div>

    <div class="form-group" id="proxyGroup">
      <label for="proxyType">Proxy / Tunnel</label>
      <vscode-single-select id="proxyType">
        <vscode-option value="none"${(!c?.proxy || c?.proxy?.type === 'none') ? ' selected' : ''}>None</vscode-option>
        <vscode-option value="ssh"${c?.proxy?.type === 'ssh' ? ' selected' : ''}>SSH Tunnel</vscode-option>
        <vscode-option value="socks5"${c?.proxy?.type === 'socks5' ? ' selected' : ''}>SOCKS5 Proxy</vscode-option>
        <vscode-option value="http"${c?.proxy?.type === 'http' ? ' selected' : ''}>HTTP Proxy</vscode-option>
      </vscode-single-select>
    </div>

    <div id="sshFields" class="hidden">
      <div class="form-row">
        <div class="form-group flex-grow">
          <label for="sshHost">SSH Host</label>
          <vscode-textfield id="sshHost" placeholder="bastion.example.com" value="${esc(c?.proxy?.sshHost)}"></vscode-textfield>
        </div>
        <div class="form-group port-field">
          <label for="sshPort">SSH Port</label>
          <vscode-textfield id="sshPort" type="number" value="${c?.proxy?.sshPort || 22}"></vscode-textfield>
        </div>
      </div>
      <div class="form-group">
        <label for="sshUsername">SSH Username</label>
        <vscode-textfield id="sshUsername" value="${esc(c?.proxy?.sshUsername)}"></vscode-textfield>
      </div>
      <div class="form-group">
        <label for="sshPassword">SSH Password</label>
        <vscode-textfield id="sshPassword" type="password" value="${esc(c?.proxy?.sshPassword)}"></vscode-textfield>
      </div>
      <div class="form-group">
        <label for="sshPrivateKey">Private Key (paste content)</label>
        <vscode-textarea id="sshPrivateKey" rows="3" monospace value="${esc(c?.proxy?.sshPrivateKey)}"></vscode-textarea>
      </div>
    </div>

    <div id="proxyFields" class="hidden">
      <div class="form-row">
        <div class="form-group flex-grow">
          <label for="proxyHost">Proxy Host</label>
          <vscode-textfield id="proxyHost" placeholder="proxy.example.com" value="${esc(c?.proxy?.proxyHost)}"></vscode-textfield>
        </div>
        <div class="form-group port-field">
          <label for="proxyPort">Proxy Port</label>
          <vscode-textfield id="proxyPort" type="number" value="${c?.proxy?.proxyPort || 1080}"></vscode-textfield>
        </div>
      </div>
      <div class="form-group">
        <label for="proxyUsername">Proxy Username</label>
        <vscode-textfield id="proxyUsername" value="${esc(c?.proxy?.proxyUsername)}"></vscode-textfield>
      </div>
      <div class="form-group">
        <label for="proxyPassword">Proxy Password</label>
        <vscode-textfield id="proxyPassword" type="password" value="${esc(c?.proxy?.proxyPassword)}"></vscode-textfield>
      </div>
    </div>

    <div class="form-group">
      <label for="connColor">Color</label>
      <div class="color-row">
        <span class="color-swatch-preview" id="colorSwatchPreview" title="Pick a color">
          <span class="swatch-fill" id="colorSwatchFill"></span>
          <input type="color" id="connColorPicker" value="${esc(c?.color || '#1e1e1e')}" />
        </span>
        <vscode-textfield id="connColor" placeholder="#e06c75" value="${esc(c?.color)}"></vscode-textfield>
        <vscode-button id="btnRandomColor" secondary title="Pick a random color">Random</vscode-button>
        <vscode-button id="btnClearColor" secondary>Clear</vscode-button>
      </div>
      <div class="color-palette" id="colorPalette"></div>
    </div>

    <div class="form-group checkbox-group">
      <vscode-checkbox id="readonlyMode"${readonlyChecked ? ' checked' : ''}>Read-only (disable data editing)</vscode-checkbox>
    </div>

    <vscode-collapsible id="advancedSection" title="Advanced">
      <div class="collapsible-body">
        <div class="form-group">
          <label for="safeMode">Safe mode</label>
          <vscode-single-select id="safeMode">
            <vscode-option value=""${!c?.safeMode ? ' selected' : ''}>Default (from settings)</vscode-option>
            <vscode-option value="block"${c?.safeMode === 'block' ? ' selected' : ''}>Block — blocks dangerous queries</vscode-option>
            <vscode-option value="warn"${c?.safeMode === 'warn' ? ' selected' : ''}>Warn — recommended for daily work</vscode-option>
            <vscode-option value="off"${c?.safeMode === 'off' ? ' selected' : ''}>Off — no checks</vscode-option>
          </vscode-single-select>
          <div class="field-hint">
            Auto-adds LIMIT to SELECTs, runs EXPLAIN to detect full table scans before execution.
          </div>
        </div>

        <div class="form-group">
          <label for="scope">Store in</label>
          <vscode-single-select id="scope">
            <vscode-option value="user"${(c?.scope || 'user') === 'user' ? ' selected' : ''}>User (global)</vscode-option>
            <vscode-option value="project"${c?.scope === 'project' ? ' selected' : ''}>Project (.vscode/viewstor.json)</vscode-option>
          </vscode-single-select>
          <div id="scopeHint" class="field-hint hidden">
            Password is not saved to the project file for security. You will be prompted on connect.
          </div>
        </div>

        <div class="form-group" id="hiddenSchemasGroup">
          <label for="hiddenSchemas">Hidden schemas <span class="viewstor-meta">(comma-separated)</span></label>
          <vscode-textfield id="hiddenSchemas" placeholder="pg_catalog, information_schema" value="${esc(c?.hiddenSchemas ? Object.values(c.hiddenSchemas).flat().join(', ') : '')}"></vscode-textfield>
        </div>
      </div>
    </vscode-collapsible>

    <div id="testResult" class="test-result hidden"></div>

    <div class="button-row">
      <vscode-button id="btnTest" secondary>Test Connection</vscode-button>
      <div class="spacer"></div>
      <vscode-button id="btnCancel" secondary>Cancel</vscode-button>
      <vscode-button id="btnSave">Save</vscode-button>
    </div>
  </div>

  <script src="${uris.scriptUri}"></script>
</body>
</html>`;
  }
}

function esc(value?: string): string {
  if (!value) return '';
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
