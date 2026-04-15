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

    const distRoot = vscode.Uri.file(path.join(this.context.extensionPath, 'dist'));
    const tokensUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'styles', 'tokens.css'));
    const codiconUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'styles', 'codicon.css'));
    const styleUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'styles', 'connection-form.css'));
    const shellUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'scripts', 'webview-shell.js'));
    const elementsUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'scripts', 'vscode-elements.js'));
    const scriptUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'scripts', 'folder-form.js'));

    this.panel.webview.html = this.buildHtml(
      { tokensUri, codiconUri, styleUri, shellUri, elementsUri, scriptUri },
      folder,
    );

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
      vscode.window.showInformationMessage(vscode.l10n.t('Folder "{0}" updated.', name));
    } else {
      const folder = await this.connectionManager.addFolder(name, color, readonly, this.parentFolderIdForNew);
      folder.scope = scope;
      await this.connectionManager.updateFolder(folder.id, { name, color, readonly });
      vscode.window.showInformationMessage(vscode.l10n.t('Folder "{0}" created.', name));
    }
    this.parentFolderIdForNew = undefined;

    this.panel?.dispose();
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
    folder?: ConnectionFolder,
  ): string {
    const f = folder;
    const cspSource = (this.panel?.webview as vscode.Webview).cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src ${cspSource};">
  <link rel="stylesheet" href="${uris.codiconUri}">
  <link rel="stylesheet" href="${uris.tokensUri}">
  <link rel="stylesheet" href="${uris.styleUri}">
  <script src="${uris.shellUri}"></script>
  <script type="module" src="${uris.elementsUri}"></script>
</head>
<body>
  <div class="form-container">
    <h2>${f ? 'Folder Settings' : 'New Folder'}</h2>

    <div class="form-group">
      <label for="folderName">Folder Name</label>
      <vscode-textfield id="folderName" placeholder="My Folder" value="${esc(f?.name)}"></vscode-textfield>
    </div>

    <div class="form-group">
      <label for="folderColor">Color</label>
      <div class="color-row">
        <span class="color-swatch-preview" id="colorSwatchPreview" title="Pick a color">
          <span class="swatch-fill" id="colorSwatchFill"></span>
          <input type="color" id="folderColorPicker" value="${esc(f?.color || '#1e1e1e')}" />
        </span>
        <vscode-textfield id="folderColor" placeholder="#e06c75" value="${esc(f?.color)}"></vscode-textfield>
        <vscode-button id="btnRandomColor" secondary title="Pick a random color">Random</vscode-button>
        <vscode-button id="btnClearColor" secondary>Clear</vscode-button>
      </div>
      <div class="color-palette" id="colorPalette"></div>
    </div>

    <div class="form-group">
      <label for="scope">Store in</label>
      <vscode-single-select id="scope">
        <vscode-option value="user"${(f?.scope || 'user') === 'user' ? ' selected' : ''}>User (global)</vscode-option>
        <vscode-option value="project"${f?.scope === 'project' ? ' selected' : ''}>Project (.vscode/viewstor.json)</vscode-option>
      </vscode-single-select>
    </div>

    <div class="form-group checkbox-group">
      <vscode-checkbox id="readonlyMode"${f?.readonly ? ' checked' : ''}>Read-only (default for new connections in this folder)</vscode-checkbox>
    </div>

    <div class="button-row">
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
