import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { QueryEditorProvider } from './queryEditor';

/**
 * Provides inline diagnostics (hints) when WHERE/ORDER BY columns lack indexes.
 */
export class IndexHintProvider {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private debounceTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly queryEditorProvider: QueryEditorProvider,
  ) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('viewstor-index-hints');
  }

  register(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      this.diagnosticCollection,
      vscode.workspace.onDidChangeTextDocument(e => this.scheduleCheck(e.document)),
      vscode.window.onDidChangeActiveTextEditor(e => { if (e) this.scheduleCheck(e.document); }),
      vscode.languages.registerCodeActionsProvider('sql', {
        provideCodeActions: (document, range, ctx) => {
          const viewstorDiags = ctx.diagnostics.filter(d => d.source === 'viewstor');
          if (viewstorDiags.length === 0) return [];

          const connId = this.queryEditorProvider.getConnectionIdFromUri(document.uri);
          if (!connId) return [];
          const dbName = this.queryEditorProvider.getDatabaseNameFromUri(document.uri);

          const explainAction = new vscode.CodeAction(vscode.l10n.t('See EXPLAIN plan'), vscode.CodeActionKind.QuickFix);
          explainAction.command = {
            command: 'viewstor._showExplain',
            title: vscode.l10n.t('See EXPLAIN plan'),
            arguments: [connId, document.getText(), dbName],
          };
          explainAction.diagnostics = viewstorDiags;
          explainAction.isPreferred = false;
          return [explainAction];
        },
      }),
    );

    // Register the EXPLAIN command
    context.subscriptions.push(
      vscode.commands.registerCommand('viewstor._showExplain', async (connectionId: string, query: string, databaseName?: string) => {
        let driver;
        try {
          driver = databaseName
            ? await this.connectionManager.getDriverForDatabase(connectionId, databaseName)
            : this.connectionManager.getDriver(connectionId);
        } catch { return; }
        if (!driver) return;
        try {
          const result = await driver.execute('EXPLAIN ' + query.trim().replace(/;+\s*$/, ''));
          const plan = result.rows.map(r => Object.values(r).join(' ')).join('\n');
          const doc = await vscode.workspace.openTextDocument({
            content: `-- EXPLAIN plan\n-- Query: ${query.trim().substring(0, 100)}...\n\n${plan}`,
            language: 'plaintext',
          });
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (err) {
          vscode.window.showErrorMessage(vscode.l10n.t('EXPLAIN failed: {0}', err instanceof Error ? err.message : String(err)));
        }
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
    if (!connectionId) {
      this.diagnosticCollection.delete(document.uri);
      return;
    }

    const databaseName = this.queryEditorProvider.getDatabaseNameFromUri(document.uri);
    let driver;
    try {
      driver = databaseName
        ? await this.connectionManager.getDriverForDatabase(connectionId, databaseName)
        : this.connectionManager.getDriver(connectionId);
    } catch {
      this.diagnosticCollection.delete(document.uri);
      return;
    }
    if (!driver?.getIndexedColumns) {
      this.diagnosticCollection.delete(document.uri);
      return;
    }

    const text = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];

    // Extract table names from FROM/JOIN
    const tables = extractTables(text);
    if (tables.length === 0) {
      this.diagnosticCollection.set(document.uri, []);
      return;
    }

    // Check row count threshold — skip small tables
    const threshold = vscode.workspace.getConfiguration('viewstor').get<number>('indexHintThreshold', 100000);
    const indexCache = new Map<string, Set<string>>();
    const largeTables = new Set<string>();

    for (const t of tables) {
      if (!indexCache.has(t.name)) {
        try {
          // Check estimated row count first
          if (driver.getEstimatedRowCount) {
            const count = await driver.getEstimatedRowCount(t.name, t.schema);
            if (count < threshold) {
              indexCache.set(t.name, new Set()); // skip — too small
              continue;
            }
          }
          largeTables.add(t.name);
          const indexed = await driver.getIndexedColumns(t.name, t.schema);
          indexCache.set(t.name, indexed);
        } catch {
          indexCache.set(t.name, new Set());
        }
      }
    }

    if (largeTables.size === 0) {
      this.diagnosticCollection.set(document.uri, []);
      return;
    }

    const largeTablesArr = tables.filter(t => largeTables.has(t.name));

    // Find columns in WHERE clauses
    const whereColumns = extractClauseColumns(text, /\bWHERE\b/gi, /\b(?:AND|OR)\b/gi);
    for (const col of whereColumns) {
      const indexed = findColumnIndex(col.column, col.tableHint, largeTablesArr, indexCache);
      if (indexed === false) {
        const range = findColumnRange(document, col.offset, col.column);
        if (range) {
          const d = new vscode.Diagnostic(range, vscode.l10n.t('Column "{0}" has no index', col.column), vscode.DiagnosticSeverity.Warning);
          d.source = 'viewstor';

          diagnostics.push(d);
        }
      }
    }

    // Find columns in ORDER BY clauses
    const orderByColumns = extractOrderByColumns(text);
    for (const col of orderByColumns) {
      const indexed = findColumnIndex(col.column, col.tableHint, largeTablesArr, indexCache);
      if (indexed === false) {
        const range = findColumnRange(document, col.offset, col.column);
        if (range) {
          const d = new vscode.Diagnostic(range, vscode.l10n.t('Column "{0}" in ORDER BY has no index — may cause slow sorting', col.column), vscode.DiagnosticSeverity.Warning);
          d.source = 'viewstor';
          diagnostics.push(d);
        }
      }
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
  }

  dispose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.diagnosticCollection.dispose();
  }
}

interface TableRef {
  name: string;
  schema?: string;
  alias?: string;
}

interface ColumnRef {
  column: string;
  tableHint?: string; // table name or alias prefix
  offset: number; // character offset in the full text
}

function extractTables(sql: string): TableRef[] {
  const tables: TableRef[] = [];
  const regex = /\b(?:FROM|JOIN)\s+(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?(?:\s+(?:AS\s+)?"?(\w+)"?)?/gi;
  let m: RegExpExecArray | null;
  const kwSet = new Set(['where', 'on', 'set', 'left', 'right', 'inner', 'outer', 'cross', 'full', 'join', 'order', 'group', 'having', 'limit', 'union']);
  while ((m = regex.exec(sql)) !== null) {
    const alias = m[3] && !kwSet.has(m[3].toLowerCase()) ? m[3] : undefined;
    tables.push({ name: m[2], schema: m[1], alias });
  }
  return tables;
}

function extractClauseColumns(sql: string, _clauseRegex: RegExp, _splitRegex: RegExp): ColumnRef[] {
  const cols: ColumnRef[] = [];
  // Find WHERE ... (until GROUP BY, ORDER BY, LIMIT, HAVING, or end)
  const whereRegex = /\bWHERE\b([\s\S]*?)(?=\b(?:GROUP|ORDER|LIMIT|HAVING|UNION|EXCEPT|INTERSECT)\b|;|$)/gi;
  let wm: RegExpExecArray | null;
  while ((wm = whereRegex.exec(sql)) !== null) {
    const clause = wm[1];
    const baseOffset = wm.index + 6; // "WHERE " length
    // Find column references in conditions: "col = ..." or "table.col = ..."
    const colRegex = /(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?\s*(?:=|!=|<>|>=?|<=?|(?:NOT\s+)?(?:IN|LIKE|ILIKE|BETWEEN|IS))\b/gi;
    let cm: RegExpExecArray | null;
    while ((cm = colRegex.exec(clause)) !== null) {
      cols.push({
        column: cm[2],
        tableHint: cm[1],
        offset: baseOffset + cm.index + (cm[0].length - cm[0].trimStart().length),
      });
    }
  }
  return cols;
}

function extractOrderByColumns(sql: string): ColumnRef[] {
  const cols: ColumnRef[] = [];
  const regex = /\bORDER\s+BY\b([\s\S]*?)(?=\bLIMIT\b|;|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(sql)) !== null) {
    const clause = m[1];
    const baseOffset = m.index + m[0].indexOf(clause);
    const colRegex = /(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?\s*(?:ASC|DESC|,|$)/gi;
    let cm: RegExpExecArray | null;
    while ((cm = colRegex.exec(clause)) !== null) {
      if (cm[2].toUpperCase() === 'ASC' || cm[2].toUpperCase() === 'DESC') continue;
      cols.push({
        column: cm[2],
        tableHint: cm[1],
        offset: baseOffset + cm.index,
      });
    }
  }
  return cols;
}

function findColumnIndex(
  column: string,
  tableHint: string | undefined,
  tables: TableRef[],
  indexCache: Map<string, Set<string>>,
): boolean | undefined {
  // If table hint given, resolve alias → table name
  if (tableHint) {
    const table = tables.find(t =>
      t.name.toLowerCase() === tableHint.toLowerCase() ||
      t.alias?.toLowerCase() === tableHint.toLowerCase()
    );
    if (table) {
      const indexed = indexCache.get(table.name);
      if (indexed) return indexed.has(column);
    }
    return undefined; // can't determine
  }

  // No table hint — check all tables
  for (const t of tables) {
    const indexed = indexCache.get(t.name);
    if (indexed?.has(column)) return true;
  }
  // Column found in none — only report if exactly one table
  if (tables.length === 1) {
    const indexed = indexCache.get(tables[0].name);
    if (indexed && !indexed.has(column)) return false;
  }
  return undefined;
}

function findColumnRange(document: vscode.TextDocument, offset: number, column: string): vscode.Range | undefined {
  const text = document.getText();
  const idx = text.indexOf(column, offset);
  if (idx < 0) return undefined;
  const pos = document.positionAt(idx);
  return new vscode.Range(pos, pos.translate(0, column.length));
}
