import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionFolder } from '../types/connection';
import { ConnectionManager } from '../connections/connectionManager';

export class FolderFormPanel {
  private panel: vscode.WebviewPanel | undefined;
  private parentFolderIdForNew: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionManager: ConnectionManager,
  ) {}

  open(folder?: ConnectionFolder, parentFolderId?: string) {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.panel.webview.postMessage({ type: 'setFolder', folder: folder || null });
      return;
    }

    this.parentFolderIdForNew = parentFolderId;

    const title = folder ? `Folder: ${folder.name}` : 'New Folder';

    this.panel = vscode.window.createWebviewPanel(
      'viewstor.folderForm',
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

    this.panel.iconPath = new vscode.ThemeIcon('folder');

    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'styles', 'connection-form.css'))
    );

    this.panel.webview.html = this.buildHtml(styleUri, folder);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'save':
            await this.handleSave(message.data, folder);
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

  private async handleSave(data: { name: string; color: string; readonly: string; scope: string }, existing?: ConnectionFolder) {
    const name = data.name.trim();
    const color = data.color.trim() || undefined;
    const readonly = data.readonly === 'true';
    const scope = (data.scope as 'user' | 'project') || 'user';

    if (existing) {
      await this.connectionManager.updateFolder(existing.id, { name, color, readonly });
      vscode.window.showInformationMessage(`Folder "${name}" updated.`);
    } else {
      const folder = await this.connectionManager.addFolder(name, color, readonly, this.parentFolderIdForNew);
      folder.scope = scope;
      await this.connectionManager.updateFolder(folder.id, { name, color, readonly });
      vscode.window.showInformationMessage(`Folder "${name}" created.`);
    }
    this.parentFolderIdForNew = undefined;

    this.panel?.dispose();
  }

  private buildHtml(styleUri: vscode.Uri, folder?: ConnectionFolder): string {
    const f = folder;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div class="form-container">
    <h2>${f ? 'Folder Settings' : 'New Folder'}</h2>

    <div class="form-group">
      <label for="folderName">Folder Name</label>
      <input type="text" id="folderName" placeholder="My Folder" value="${esc(f?.name)}" />
    </div>

    <div class="form-group">
      <label for="folderColor">Color</label>
      <div class="color-row">
        <input type="color" id="folderColorPicker" value="${esc(f?.color || '#1e1e1e')}" />
        <input type="text" id="folderColor" placeholder="#e06c75" value="${esc(f?.color)}" />
        <button type="button" id="btnRandomColor" class="btn btn-secondary btn-small">🎲</button>
        <button type="button" id="btnClearColor" class="btn btn-secondary btn-small">Clear</button>
      </div>
      <div class="color-palette" id="colorPalette"></div>
    </div>

    <div class="form-group">
      <label for="scope">Store in</label>
      <select id="scope">
        <option value="user" ${(f?.scope || 'user') === 'user' ? 'selected' : ''}>User (global)</option>
        <option value="project" ${f?.scope === 'project' ? 'selected' : ''}>Project (.vscode/viewstor.json)</option>
      </select>
    </div>

    <div class="form-group checkbox-group">
      <label>
        <input type="checkbox" id="readonlyMode" ${f?.readonly ? 'checked' : ''} />
        Read-only (default for new connections in this folder)
      </label>
    </div>

    <div class="button-row">
      <div class="spacer"></div>
      <button id="btnCancel" class="btn btn-secondary">Cancel</button>
      <button id="btnSave" class="btn btn-primary">Save</button>
    </div>
  </div>

  <script>
  (function() {
    var vscode = acquireVsCodeApi();
    var folderName = document.getElementById('folderName');
    var folderColor = document.getElementById('folderColor');
    var folderColorPicker = document.getElementById('folderColorPicker');
    var btnClearColor = document.getElementById('btnClearColor');
    var readonlyMode = document.getElementById('readonlyMode');

    folderColorPicker.addEventListener('input', function() {
      folderColor.value = folderColorPicker.value;
    });
    folderColor.addEventListener('input', function() {
      if (/^#[0-9a-fA-F]{6}$/.test(folderColor.value)) {
        folderColorPicker.value = folderColor.value;
      }
    });
    btnClearColor.addEventListener('click', function() {
      folderColor.value = '';
      folderColorPicker.value = '#1e1e1e';
    });

    // Randomize color
    document.getElementById('btnRandomColor').addEventListener('click', function() {
      var h = Math.floor(Math.random() * 360);
      var s = 60 + Math.floor(Math.random() * 30);
      var l = 45 + Math.floor(Math.random() * 20);
      var hex = hslToHex(h, s, l);
      folderColor.value = hex;
      folderColorPicker.value = hex;
    });
    function hslToHex(h, s, l) {
      s /= 100; l /= 100;
      var a = s * Math.min(l, 1 - l);
      function f(n) { var k = (n + h / 30) % 12; var c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); return Math.round(255 * c).toString(16).padStart(2, '0'); }
      return '#' + f(0) + f(8) + f(4);
    }

    // Color palette
    var palette = document.getElementById('colorPalette');
    var themeColors = [
      { label: 'Red', css: 'var(--vscode-terminal-ansiRed)' },
      { label: 'Green', css: 'var(--vscode-terminal-ansiGreen)' },
      { label: 'Yellow', css: 'var(--vscode-terminal-ansiYellow)' },
      { label: 'Blue', css: 'var(--vscode-terminal-ansiBlue)' },
      { label: 'Magenta', css: 'var(--vscode-terminal-ansiMagenta)' },
      { label: 'Cyan', css: 'var(--vscode-terminal-ansiCyan)' },
      { label: 'Bright Red', css: 'var(--vscode-terminal-ansiBrightRed)' },
      { label: 'Bright Green', css: 'var(--vscode-terminal-ansiBrightGreen)' },
      { label: 'Bright Yellow', css: 'var(--vscode-terminal-ansiBrightYellow)' },
      { label: 'Bright Blue', css: 'var(--vscode-terminal-ansiBrightBlue)' },
      { label: 'Bright Magenta', css: 'var(--vscode-terminal-ansiBrightMagenta)' },
      { label: 'Bright Cyan', css: 'var(--vscode-terminal-ansiBrightCyan)' },
    ];
    themeColors.forEach(function(tc) {
      var swatch = document.createElement('button');
      swatch.type = 'button'; swatch.className = 'color-swatch';
      swatch.title = tc.label; swatch.style.background = tc.css;
      swatch.addEventListener('click', function() { folderColor.value = tc.css; });
      palette.appendChild(swatch);
    });

    document.getElementById('btnSave').addEventListener('click', function() {
      document.querySelectorAll('.error-text').forEach(function(el) { el.remove(); });
      if (!folderName.value.trim()) {
        var err = document.createElement('div');
        err.className = 'error-text';
        err.textContent = 'Folder name is required';
        folderName.parentNode.appendChild(err);
        return;
      }
      vscode.postMessage({
        type: 'save',
        data: {
          name: folderName.value.trim(),
          color: folderColor.value.trim(),
          readonly: readonlyMode.checked ? 'true' : 'false',
          scope: document.getElementById('scope').value,
        }
      });
    });

    document.getElementById('btnCancel').addEventListener('click', function() {
      vscode.postMessage({ type: 'cancel' });
    });

    window.addEventListener('message', function(event) {
      var message = event.data;
      if (message.type === 'setFolder' && message.folder) {
        var f = message.folder;
        folderName.value = f.name || '';
        folderColor.value = f.color || '';
        folderColorPicker.value = f.color || '#1e1e1e';
        readonlyMode.checked = !!f.readonly;
      }
    });
  })();
  </script>
</body>
</html>`;
  }
}

function esc(value?: string): string {
  if (!value) return '';
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
