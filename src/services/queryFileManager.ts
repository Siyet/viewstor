import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { dbg } from '../utils/debug';
import {
  QueryFileMetadata,
  buildMetadataComment,
  parseMetadataFromLine,
  parseMetadataFromFile,
  stripMetadataFromContent,
  isUnderDir,
  listSqlFiles,
} from '../utils/queryFileHelpers';

export { QueryFileMetadata } from '../utils/queryFileHelpers';

export class QueryFileManager {
  private readonly queriesDir: string;
  private readonly tmpDir: string;
  private readonly disposables: vscode.Disposable[] = [];
  // URIs of documents saved manually (Ctrl+S) — used to skip autosave pins
  private readonly manualSaveUris = new Set<string>();

  // Called when a tmp file is saved (Ctrl+S) — pins it to ~/.viewstor/queries/
  private onQueryPinned: (oldUri: vscode.Uri, newUri: vscode.Uri) => void = () => {};

  constructor() {
    const baseDir = path.join(os.homedir(), '.viewstor');
    this.queriesDir = path.join(baseDir, 'queries');
    this.tmpDir = path.join(baseDir, 'tmp');
    fs.mkdirSync(this.queriesDir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });

    this.disposables.push(
      vscode.workspace.onWillSaveTextDocument(e => {
        if (e.reason === vscode.TextDocumentSaveReason.Manual) {
          this.manualSaveUris.add(e.document.uri.toString());
        }
      }),
      vscode.workspace.onDidSaveTextDocument(doc => this.handleSave(doc)),
      vscode.window.onDidChangeActiveTextEditor(e => this.updateContextKey(e)),
    );
  }

  setOnQueryPinned(fn: (oldUri: vscode.Uri, newUri: vscode.Uri) => void) {
    this.onQueryPinned = fn;
  }

  getQueriesDir(): string {
    return this.queriesDir;
  }

  getTmpDir(): string {
    return this.tmpDir;
  }

  /** Create a temp query file in ~/.viewstor/tmp/ and open it */
  async createTempQuery(connectionId: string, databaseName?: string, initialContent?: string): Promise<vscode.Uri> {
    const header = buildMetadataComment(connectionId, databaseName);
    const content = initialContent
      ? header + '\n' + initialContent
      : header + '\n';
    const fileName = `query_${Date.now()}.sql`;
    const filePath = path.join(this.tmpDir, fileName);
    fs.writeFileSync(filePath, content, 'utf-8');

    const uri = vscode.Uri.file(filePath);
    await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });

    this.updateContextKey(vscode.window.activeTextEditor);
    return uri;
  }

  /** Create a confirmation SQL file (for save/insert/delete) in ~/.viewstor/tmp/ */
  async createConfirmationQuery(sql: string, connectionId: string, databaseName?: string): Promise<vscode.Uri> {
    const header = buildMetadataComment(connectionId, databaseName);
    const content = header + '\n' + sql;
    const fileName = `confirm_${Date.now()}.sql`;
    const filePath = path.join(this.tmpDir, fileName);
    fs.writeFileSync(filePath, content, 'utf-8');

    const uri = vscode.Uri.file(filePath);
    await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });

    this.updateContextKey(vscode.window.activeTextEditor);
    return uri;
  }

  /** Parse metadata comment from the first line of a document */
  parseMetadata(doc: vscode.TextDocument): QueryFileMetadata | undefined {
    const firstLine = doc.lineAt(0).text;
    return parseMetadataFromLine(firstLine);
  }

  /** Parse metadata from a line string */
  parseMetadataFromLine(line: string): QueryFileMetadata | undefined {
    return parseMetadataFromLine(line);
  }

  /** Parse metadata from a file on disk (sync, reads only first line) */
  parseMetadataFromFile(filePath: string): QueryFileMetadata | undefined {
    return parseMetadataFromFile(filePath);
  }

  /** Get query text without the metadata comment line */
  getQueryText(doc: vscode.TextDocument): string {
    const fullText = doc.getText();
    return stripMetadataFromContent(fullText);
  }

  /** Check if a file is in ~/.viewstor/tmp/ */
  isTmpFile(uri: vscode.Uri): boolean {
    return isUnderDir(uri.fsPath, this.tmpDir);
  }

  /** Check if a file is in ~/.viewstor/queries/ */
  isPinnedFile(uri: vscode.Uri): boolean {
    return isUnderDir(uri.fsPath, this.queriesDir);
  }

  /** Check if a file is a viewstor query file (tmp or pinned) */
  isViewstorFile(uri: vscode.Uri): boolean {
    return this.isTmpFile(uri) || this.isPinnedFile(uri);
  }

  /** Create a pinned query file directly in ~/.viewstor/queries/ (for manual pin from history) */
  createPinnedQueryFile(connectionId: string, query: string, databaseName?: string): string {
    const header = buildMetadataComment(connectionId, databaseName);
    const content = header + '\n' + query;
    const fileName = `query_${Date.now()}.sql`;
    const filePath = path.join(this.queriesDir, fileName);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  /** Pin a temp query: move from tmp/ to queries/ */
  async pinQuery(doc: vscode.TextDocument, name?: string): Promise<vscode.Uri | undefined> {
    dbg('pinQuery', 'uri:', doc.uri.fsPath, 'isTmp:', this.isTmpFile(doc.uri));
    if (!this.isTmpFile(doc.uri)) return undefined;

    const baseName = name || path.basename(doc.uri.fsPath);
    let targetName = baseName;

    // Avoid overwriting existing files
    const targetPath = path.join(this.queriesDir, targetName);
    if (fs.existsSync(targetPath)) {
      const ext = path.extname(targetName);
      const stem = path.basename(targetName, ext);
      targetName = `${stem}_${Date.now()}${ext}`;
    }

    const newPath = path.join(this.queriesDir, targetName);
    const newUri = vscode.Uri.file(newPath);

    // Use workspace edit to rename — keeps the editor open
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(doc.uri, newUri);
    const success = await vscode.workspace.applyEdit(edit);
    dbg('pinQuery', 'rename success:', success, 'target:', newPath);

    if (success) {
      this.onQueryPinned(doc.uri, newUri);
      return newUri;
    }
    return undefined;
  }

  /** Rename a pinned query file */
  async renamePinnedQuery(uri: vscode.Uri, newName: string): Promise<vscode.Uri | undefined> {
    dbg('renamePinnedQuery', 'uri:', uri.fsPath, 'newName:', newName, 'isPinned:', this.isPinnedFile(uri));
    if (!this.isPinnedFile(uri)) return undefined;

    if (!newName.endsWith('.sql')) newName += '.sql';
    const newPath = path.join(this.queriesDir, newName);
    if (fs.existsSync(newPath)) {
      vscode.window.showWarningMessage(vscode.l10n.t('A query with this name already exists.'));
      return undefined;
    }

    const newUri = vscode.Uri.file(newPath);
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(uri, newUri);
    const success = await vscode.workspace.applyEdit(edit);
    return success ? newUri : undefined;
  }

  /** Delete a temp file */
  deleteTmpFile(uri: vscode.Uri) {
    if (!this.isTmpFile(uri)) return;
    try { fs.unlinkSync(uri.fsPath); } catch { /* ok */ }
  }

  /** Clean up all tmp files (removes individual files, keeps dir to avoid race with autosave) */
  cleanupTmp() {
    try {
      const entries = fs.readdirSync(this.tmpDir);
      for (const entry of entries) {
        try { fs.unlinkSync(path.join(this.tmpDir, entry)); } catch { /* ok */ }
      }
    } catch { /* ok */ }
  }

  /** List all pinned query files */
  listPinnedQueries(): { name: string; uri: vscode.Uri; metadata?: QueryFileMetadata }[] {
    return listSqlFiles(this.queriesDir).map(f => ({
      name: f.name,
      uri: vscode.Uri.file(f.filePath),
      metadata: f.metadata,
    }));
  }

  private handleSave(doc: vscode.TextDocument) {
    dbg('handleSave', 'uri:', doc.uri.fsPath, 'isTmp:', this.isTmpFile(doc.uri));
    // Only handle files in ~/.viewstor/tmp/ that are regular queries (not confirmations)
    if (!this.isTmpFile(doc.uri)) return;
    const baseName = path.basename(doc.uri.fsPath);
    // Don't auto-pin confirmation SQL files — they have their own lifecycle
    if (baseName.startsWith('confirm_')) return;

    // Only pin on explicit Ctrl+S, not on autosave (afterDelay / focusOut)
    const uriKey = doc.uri.toString();
    const isManual = this.manualSaveUris.has(uriKey);
    dbg('handleSave', 'isManualSave:', isManual, 'baseName:', baseName);
    if (!isManual) return;
    this.manualSaveUris.delete(uriKey);

    this.pinQuery(doc).catch(() => {});
  }

  private updateContextKey(editor: vscode.TextEditor | undefined) {
    if (!editor) {
      vscode.commands.executeCommand('setContext', 'viewstor.isViewstorSqlFile', false);
      return;
    }
    // Check by path OR by metadata header (handles path normalization differences across sessions)
    let isViewstor = this.isViewstorFile(editor.document.uri);
    if (!isViewstor && editor.document.languageId === 'sql' && editor.document.lineCount > 0) {
      const meta = this.parseMetadata(editor.document);
      isViewstor = !!meta;
    }
    vscode.commands.executeCommand('setContext', 'viewstor.isViewstorSqlFile', isViewstor);
  }

  dispose() {
    this.cleanupTmp();
    this.disposables.forEach(d => d.dispose());
  }
}
