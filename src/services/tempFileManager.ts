import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface JsonFileContext {
  panelKey: string;
  rowIdx: number;
  colName: string;
  colDataType: string;
}

export interface SqlFileContext {
  panelKey: string;
  connectionId: string;
  tableName?: string;
  databaseName?: string;
  context: string; // 'saveEdits' | 'deleteRows' | 'insertRow'
}

export class TempFileManager {
  private tmpDir: string;
  private jsonFiles = new Map<string, JsonFileContext>();
  private sqlFiles = new Map<string, SqlFileContext>();
  private disposables: vscode.Disposable[] = [];
  private postMessage: (panelKey: string, msg: unknown) => void = () => {};
  private onSqlExecuted: (ctx: SqlFileContext, sql: string) => Promise<void> = async () => {};
  private onSqlSaved: (ctx: SqlFileContext, sql: string) => Promise<void> = async () => {};

  constructor(context: vscode.ExtensionContext) {
    this.tmpDir = path.join(context.globalStorageUri.fsPath, 'tmp');
    fs.mkdirSync(this.tmpDir, { recursive: true });

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => this.handleSave(doc)),
      vscode.window.onDidChangeActiveTextEditor(e => this.updateContextKey(e)),
    );
  }

  setPostMessage(fn: (panelKey: string, msg: unknown) => void) {
    this.postMessage = fn;
  }

  setOnSqlExecuted(fn: (ctx: SqlFileContext, sql: string) => Promise<void>) {
    this.onSqlExecuted = fn;
  }

  setOnSqlSaved(fn: (ctx: SqlFileContext, sql: string) => Promise<void>) {
    this.onSqlSaved = fn;
  }

  async openJsonEditor(jsonStr: string, ctx: JsonFileContext): Promise<void> {
    const fileName = `viewstor-json-${Date.now()}.json`;
    const filePath = path.join(this.tmpDir, fileName);
    let pretty: string;
    try { pretty = JSON.stringify(JSON.parse(jsonStr), null, 2); } catch { pretty = jsonStr; }
    fs.writeFileSync(filePath, pretty, 'utf-8');

    const uri = vscode.Uri.file(filePath);
    this.jsonFiles.set(uri.toString(), ctx);
    await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }

  async openSqlEditor(sql: string, ctx: SqlFileContext): Promise<void> {
    const fileName = `viewstor-sql-${Date.now()}.sql`;
    const filePath = path.join(this.tmpDir, fileName);
    fs.writeFileSync(filePath, sql, 'utf-8');

    const uri = vscode.Uri.file(filePath);
    this.sqlFiles.set(uri.toString(), ctx);
    await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    vscode.commands.executeCommand('setContext', 'viewstor.isTempSqlFile', true);
  }

  async executeSqlFromActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const key = editor.document.uri.toString();
    const ctx = this.sqlFiles.get(key);
    if (!ctx) return;

    const sql = editor.document.getText();
    await this.onSqlExecuted(ctx, sql);

    // Close the editor and clean up
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    this.sqlFiles.delete(key);
    try { fs.unlinkSync(editor.document.uri.fsPath); } catch { /* ok */ }
    vscode.commands.executeCommand('setContext', 'viewstor.isTempSqlFile', false);
  }

  isTempSqlFile(uri: vscode.Uri): boolean {
    return this.sqlFiles.has(uri.toString());
  }

  private handleSave(doc: vscode.TextDocument) {
    const key = doc.uri.toString();

    // JSON file saved → apply edit back to cell
    const jsonCtx = this.jsonFiles.get(key);
    if (jsonCtx) {
      const content = doc.getText();
      let parsed: unknown;
      try { parsed = JSON.parse(content); } catch {
        vscode.window.showErrorMessage('Invalid JSON');
        return;
      }
      this.postMessage(jsonCtx.panelKey, {
        type: 'applyJsonEdit',
        rowIdx: jsonCtx.rowIdx,
        colName: jsonCtx.colName,
        colDataType: jsonCtx.colDataType,
        newValue: parsed,
      });
    }

    // SQL file saved → pin in history
    const sqlCtx = this.sqlFiles.get(key);
    if (sqlCtx) {
      this.onSqlSaved(sqlCtx, doc.getText()).catch(() => {});
    }
  }

  private updateContextKey(editor: vscode.TextEditor | undefined) {
    const isSql = editor ? this.sqlFiles.has(editor.document.uri.toString()) : false;
    vscode.commands.executeCommand('setContext', 'viewstor.isTempSqlFile', isSql);
  }

  cleanupForPanel(panelKey: string) {
    for (const [key, ctx] of this.jsonFiles) {
      if (ctx.panelKey === panelKey) {
        this.jsonFiles.delete(key);
        try { fs.unlinkSync(vscode.Uri.parse(key).fsPath); } catch { /* ok */ }
      }
    }
    for (const [key, ctx] of this.sqlFiles) {
      if (ctx.panelKey === panelKey) {
        this.sqlFiles.delete(key);
        try { fs.unlinkSync(vscode.Uri.parse(key).fsPath); } catch { /* ok */ }
      }
    }
  }

  cleanupAll() {
    try { fs.rmSync(this.tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  }

  dispose() {
    this.cleanupAll();
    this.disposables.forEach(d => d.dispose());
  }
}
