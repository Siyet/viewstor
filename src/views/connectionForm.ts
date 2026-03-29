import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionConfig, DatabaseType, DEFAULT_PORTS } from '../types/connection';
import { ConnectionManager } from '../connections/connectionManager';
import { createDriver } from '../drivers';

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

    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'styles', 'connection-form.css'))
    );
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'scripts', 'connection-form.js'))
    );

    this.panel.webview.html = this.buildHtml(styleUri, scriptUri, config, folderDefaults);

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
      vscode.window.showInformationMessage(`Connection "${config.name}" updated.`);
    } else {
      await this.connectionManager.add(config);
      vscode.window.showInformationMessage(`Connection "${config.name}" added.`);
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
        message: success ? 'Connection successful!' : 'Connection failed.',
      });
    } catch (err) {
      this.panel?.webview.postMessage({
        type: 'testResult',
        status: 'failure',
        message: err instanceof Error ? err.message : String(err),
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
    };
  }

  private buildHtml(styleUri: vscode.Uri, scriptUri: vscode.Uri, config?: ConnectionConfig, defaults?: ConnectionFormDefaults): string {
    const c = config;
    const isEdit = !!c;
    const readonlyChecked = c ? !!c.readonly : !!defaults?.readonly;
    const folderId = c?.folderId || defaults?.folderId || '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div class="form-container">
    <h2>${isEdit ? 'Edit Connection' : 'New Connection'}</h2>

    <input type="hidden" id="connId" value="${c?.id || ''}">
    <input type="hidden" id="folderId" value="${esc(folderId)}">

    <div class="form-group">
      <label for="dbType">Database Type</label>
      <select id="dbType" ${isEdit ? 'disabled' : ''}>
        <option value="postgresql" ${c?.type === 'postgresql' ? 'selected' : ''}>PostgreSQL</option>
        <option value="redis" ${c?.type === 'redis' ? 'selected' : ''}>Redis</option>
        <option value="clickhouse" ${c?.type === 'clickhouse' ? 'selected' : ''}>ClickHouse</option>
      </select>
    </div>

    <div class="form-group">
      <label for="safeMode">Safe mode</label>
      <select id="safeMode">
        <option value="" ${!c?.safeMode ? 'selected' : ''}>Default (from settings)</option>
        <option value="block" ${c?.safeMode === 'block' ? 'selected' : ''}>🛡️ Block — beginner-friendly, blocks dangerous queries</option>
        <option value="warn" ${c?.safeMode === 'warn' ? 'selected' : ''}>⚠️ Warn — recommended for daily work, warns on Seq Scans</option>
        <option value="off" ${c?.safeMode === 'off' ? 'selected' : ''}>🔓 Off — for Jedi who trust the Force</option>
      </select>
      <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px;line-height:1.4;">
        Auto-adds LIMIT to SELECTs, runs EXPLAIN to detect full table scans before execution.
      </div>
    </div>

    <div class="form-group">
      <label for="connName">Connection Name</label>
      <input type="text" id="connName" placeholder="My Database" value="${esc(c?.name)}" />
    </div>

    <div class="form-row">
      <div class="form-group flex-grow">
        <label for="host">Host</label>
        <input type="text" id="host" placeholder="localhost" value="${esc(c?.host || 'localhost')}" />
      </div>
      <div class="form-group port-field">
        <label for="port">Port</label>
        <input type="number" id="port" value="${c?.port || DEFAULT_PORTS[c?.type || 'postgresql']}" />
      </div>
    </div>

    <div id="authFields">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" value="${esc(c?.username)}" />
      </div>

      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" value="${esc(c?.password)}" />
      </div>

      <div class="form-group" style="position:relative;">
        <label for="dbInput">Databases</label>
        <div class="chips-container" id="chipsContainer">
          <input type="text" id="dbInput" class="chips-input" placeholder="Type database name..." autocomplete="off" />
        </div>
        <div id="dbDropdown" class="db-dropdown hidden"></div>
        <input type="hidden" id="database" value="${esc(c?.database)}" />
        <input type="hidden" id="databases" value="${esc(c?.databases?.join(','))}" />
      </div>
    </div>

    <div class="form-group checkbox-group">
      <label>
        <input type="checkbox" id="ssl" ${c?.ssl ? 'checked' : ''} />
        Use SSL
      </label>
    </div>

    <div class="form-group">
      <label for="connColor">Color</label>
      <div class="color-row">
        <input type="color" id="connColorPicker" value="${esc(c?.color || '#1e1e1e')}" />
        <input type="text" id="connColor" placeholder="#e06c75" value="${esc(c?.color)}" />
        <button type="button" id="btnRandomColor" class="btn btn-secondary btn-small">🎲</button>
        <button type="button" id="btnClearColor" class="btn btn-secondary btn-small">Clear</button>
      </div>
      <div class="color-palette" id="colorPalette"></div>
    </div>

    <div class="form-group">
      <label for="scope">Store in</label>
      <select id="scope">
        <option value="user" ${(c?.scope || 'user') === 'user' ? 'selected' : ''}>User (global)</option>
        <option value="project" ${c?.scope === 'project' ? 'selected' : ''}>Project (.vscode/viewstor.json)</option>
      </select>
    </div>

    <div class="form-group checkbox-group">
      <label>
        <input type="checkbox" id="readonlyMode" ${readonlyChecked ? 'checked' : ''} />
        Read-only (disable data editing)
      </label>
    </div>

    <div id="testResult" class="test-result hidden"></div>

    <div class="button-row">
      <button id="btnTest" class="btn btn-secondary">Test Connection</button>
      <div class="spacer"></div>
      <button id="btnCancel" class="btn btn-secondary">Cancel</button>
      <button id="btnSave" class="btn btn-primary">Save</button>
    </div>
  </div>

  <script src="${scriptUri}"></script>
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
