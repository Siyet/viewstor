import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { CompletionItem as DriverCompletion } from '../types/driver';
import { QueryEditorProvider } from './queryEditor';
import { dbg } from '../utils/debug';

/**
 * Highlights references to non-existent tables and columns in SQL.
 * Uses the same schema cache as SqlCompletionProvider.
 */
export class SqlDiagnosticProvider {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private debounceTimer: NodeJS.Timeout | undefined;
  private schemaCache = new Map<string, DriverCompletion[]>();
  private cacheTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly queryEditorProvider: QueryEditorProvider,
  ) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('viewstor-sql-errors');
  }

  register(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      this.diagnosticCollection,
      vscode.workspace.onDidChangeTextDocument(e => this.scheduleCheck(e.document)),
      vscode.window.onDidChangeActiveTextEditor(e => { if (e) this.scheduleCheck(e.document); }),
      this.connectionManager.onDidChange(() => {
        this.schemaCache.clear();
        for (const t of this.cacheTimers.values()) clearTimeout(t);
        this.cacheTimers.clear();
      }),
    );
  }

  private scheduleCheck(document: vscode.TextDocument) {
    if (document.languageId !== 'sql') return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.checkDocument(document), 500);
  }

  private async checkDocument(document: vscode.TextDocument) {
    const connectionId = this.queryEditorProvider.getConnectionIdFromUri(document.uri);
    dbg('sqlDiag', 'checkDocument uri:', document.uri.fsPath, 'connectionId:', connectionId);
    if (!connectionId) {
      this.diagnosticCollection.delete(document.uri);
      return;
    }

    const items = await this.getSchemaItems(connectionId);
    dbg('sqlDiag', 'schemaItems:', items.length);
    if (items.length === 0) {
      this.diagnosticCollection.delete(document.uri);
      return;
    }

    const text = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];

    // Build lookup sets
    const tables = new Set<string>();
    const columnsByTable = new Map<string, Set<string>>();

    for (const item of items) {
      if (item.kind === 'table' || item.kind === 'view') {
        tables.add(item.label.toLowerCase());
      }
      if (item.kind === 'column' && item.parent) {
        const parentLower = item.parent.toLowerCase();
        if (!columnsByTable.has(parentLower)) columnsByTable.set(parentLower, new Set());
        columnsByTable.get(parentLower)!.add(item.label.toLowerCase());
      }
    }

    // Check table references after FROM/JOIN/INTO/UPDATE/DELETE FROM
    const tableRegex = /\b(?:FROM|JOIN|INTO|UPDATE|DELETE)\s+(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?/gi;
    let match: RegExpExecArray | null;
    const referencedTables = new Map<string, string>(); // alias/name → real table name

    while ((match = tableRegex.exec(text)) !== null) {
      const tableName = match[2];
      const tableNameLower = tableName.toLowerCase();

      if (!tables.has(tableNameLower) && !isKeyword(tableNameLower)) {
        const offset = match.index + match[0].lastIndexOf(tableName);
        const pos = document.positionAt(offset);
        const range = new vscode.Range(pos, pos.translate(0, tableName.length));
        const d = new vscode.Diagnostic(range, vscode.l10n.t('Table "{0}" not found in schema', tableName), vscode.DiagnosticSeverity.Error);
        d.source = 'viewstor';
        diagnostics.push(d);
      } else {
        referencedTables.set(tableNameLower, tableNameLower);
      }
    }

    // Extract aliases
    const aliasRegex = /\b(?:FROM|JOIN)\s+(?:"?\w+"?\s*\.\s*)?"?(\w+)"?\s+(?:AS\s+)?"?(\w+)"?/gi;
    while ((match = aliasRegex.exec(text)) !== null) {
      const table = match[1].toLowerCase();
      const alias = match[2].toLowerCase();
      if (!isKeyword(alias)) {
        referencedTables.set(alias, table);
      }
    }

    // Check column references — only table.column patterns where table is a known reference
    const colRefRegex = /\b(\w+)\.(\w+)\b/g;
    while ((match = colRefRegex.exec(text)) !== null) {
      const tableRef = match[1].toLowerCase();
      const colName = match[2].toLowerCase();
      const realTable = referencedTables.get(tableRef);

      // Skip if left side is not a known table/alias (avoids false positives on numbers, URLs)
      if (!realTable) continue;

      if (columnsByTable.has(realTable) && !columnsByTable.get(realTable)!.has(colName)) {
        const offset = match.index + match[1].length + 1; // skip "table."
        const pos = document.positionAt(offset);
        const range = new vscode.Range(pos, pos.translate(0, match[2].length));
        const d = new vscode.Diagnostic(range, vscode.l10n.t('Column "{0}" not found in table "{1}"', match[2], realTable), vscode.DiagnosticSeverity.Warning);
        d.source = 'viewstor';
        diagnostics.push(d);
      }
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
  }

  private async getSchemaItems(connectionId: string): Promise<DriverCompletion[]> {
    if (this.schemaCache.has(connectionId)) return this.schemaCache.get(connectionId)!;

    const driver = this.connectionManager.getDriver(connectionId);
    if (!driver?.getCompletions) return [];

    try {
      const items = await driver.getCompletions();
      this.schemaCache.set(connectionId, items);
      const oldTimer = this.cacheTimers.get(connectionId);
      if (oldTimer) clearTimeout(oldTimer);
      this.cacheTimers.set(connectionId, setTimeout(() => {
        this.schemaCache.delete(connectionId);
        this.cacheTimers.delete(connectionId);
      }, 60000));
      return items;
    } catch {
      return [];
    }
  }

  dispose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const timer of this.cacheTimers.values()) clearTimeout(timer);
    this.diagnosticCollection.dispose();
  }
}

const SQL_KW = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'exists', 'insert', 'into',
  'values', 'update', 'set', 'delete', 'create', 'alter', 'drop', 'table', 'view',
  'index', 'schema', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'full', 'on',
  'group', 'by', 'order', 'asc', 'desc', 'having', 'limit', 'offset', 'distinct', 'as',
  'case', 'when', 'then', 'else', 'end', 'is', 'null', 'like', 'ilike', 'between',
  'union', 'all', 'except', 'intersect', 'with', 'recursive', 'returning', 'true', 'false',
]);

function isKeyword(word: string): boolean {
  return SQL_KW.has(word);
}
