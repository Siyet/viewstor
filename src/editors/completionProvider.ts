import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { CompletionItem as DriverCompletion } from '../types/driver';
import { QueryEditorProvider } from './queryEditor';

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'ALTER', 'DROP', 'TABLE', 'VIEW', 'INDEX', 'SCHEMA',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'ON',
  'GROUP', 'BY', 'ORDER', 'ASC', 'DESC', 'HAVING',
  'LIMIT', 'OFFSET', 'DISTINCT', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'UNION', 'ALL', 'EXCEPT', 'INTERSECT',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST',
  'TRUE', 'FALSE', 'DEFAULT', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
  'CONSTRAINT', 'UNIQUE', 'CHECK', 'WITH', 'RECURSIVE', 'RETURNING',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'EXPLAIN', 'ANALYZE',
  'GRANT', 'REVOKE', 'TRUNCATE', 'CASCADE', 'RESTRICT',
  'SERIAL', 'BIGSERIAL', 'INTEGER', 'BIGINT', 'SMALLINT', 'TEXT', 'VARCHAR',
  'BOOLEAN', 'TIMESTAMP', 'DATE', 'NUMERIC', 'REAL', 'DOUBLE', 'JSON', 'JSONB', 'UUID',
];

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  private cache = new Map<string, DriverCompletion[]>();
  private cacheTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly queryEditorProvider: QueryEditorProvider,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const connectionId = this.queryEditorProvider.getConnectionIdFromUri(document.uri);
    if (!connectionId) return [];

    const dbItems = await this.getDbItems(connectionId);
    const fullText = document.getText();
    const lineText = document.lineAt(position).text.substring(0, position.character);

    // After "column = ", "column != ", "column <> ", "column IN (" — suggest enum values
    const enumMatch = lineText.match(/\b(\w+)\s*(?:=|!=|<>)\s*'?[\w]*$/i)
      || lineText.match(/\b(\w+)\s+IN\s*\(\s*(?:'[^']*'\s*,\s*)*'?[\w]*$/i);
    if (enumMatch) {
      const colName = enumMatch[1].toLowerCase();
      const aliases = extractAliases(fullText);
      const referencedTables = extractTableNames(fullText);

      for (const c of dbItems) {
        if (c.kind === 'column' && c.enumValues && c.label.toLowerCase() === colName) {
          // Check column belongs to a referenced table
          if (c.parent && referencedTables.has(c.parent.toLowerCase())) {
            // Find already-used values in IN clause to exclude them
            const alreadyUsed = new Set<string>();
            const inMatch = lineText.match(/IN\s*\(\s*((?:'[^']*'\s*,\s*)*)/i);
            if (inMatch) {
              const used = inMatch[1].matchAll(/'([^']*)'/g);
              for (const u of used) alreadyUsed.add(u[1]);
            }

            return c.enumValues
              .filter(v => !alreadyUsed.has(v))
              .map(v => {
                const item = new vscode.CompletionItem(`'${v}'`, vscode.CompletionItemKind.EnumMember);
                item.detail = `${c.parent}.${c.label}`;
                item.sortText = '0_' + v;
                item.insertText = `'${v}'`;
                return item;
              });
          }
        }
      }
    }

    // After "tablename." or "alias." — show only that table's columns
    const dotMatch = lineText.match(/(\w+)\.\w*$/);
    if (dotMatch) {
      const prefix = dotMatch[1].toLowerCase();
      const aliases = extractAliases(fullText);
      const tableName = aliases.get(prefix) || prefix;
      return dbItems
        .filter(c => c.kind === 'column' && c.parent?.toLowerCase() === tableName)
        .map(c => {
          const item = new vscode.CompletionItem(c.label, vscode.CompletionItemKind.Field);
          item.detail = c.detail;
          item.sortText = '0_' + c.label;
          return item;
        });
    }

    // After FROM/JOIN/INTO/UPDATE/TABLE — show only tables and views
    if (/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+\w*$/i.test(lineText)) {
      return dbItems
        .filter(c => c.kind === 'table' || c.kind === 'view' || c.kind === 'schema')
        .map(c => toVscodeItem(c));
    }

    // General context (SELECT, WHERE, etc.) — show columns from referenced tables + keywords + tables
    const referencedTables = extractTableNames(fullText);
    const results: vscode.CompletionItem[] = [];

    // Columns — only from tables mentioned in the query
    if (referencedTables.size > 0) {
      for (const c of dbItems) {
        if (c.kind === 'column' && c.parent && referencedTables.has(c.parent.toLowerCase())) {
          const item = new vscode.CompletionItem(c.label, vscode.CompletionItemKind.Field);
          item.detail = `${c.parent}.${c.label}  ${c.detail || ''}`.trim();
          item.sortText = '0_' + c.label;
          results.push(item);
        }
      }
    }

    // Tables/views/schemas
    for (const c of dbItems) {
      if (c.kind === 'table' || c.kind === 'view' || c.kind === 'schema') {
        results.push(toVscodeItem(c));
      }
    }

    // SQL keywords
    for (const kw of SQL_KEYWORDS) {
      const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
      item.sortText = '2_' + kw;
      results.push(item);
    }

    return results;
  }

  private async getDbItems(connectionId: string): Promise<DriverCompletion[]> {
    if (this.cache.has(connectionId)) return this.cache.get(connectionId)!;

    const driver = this.connectionManager.getDriver(connectionId);
    if (!driver?.getCompletions) return [];

    try {
      const items = await driver.getCompletions();
      this.cache.set(connectionId, items);
      const oldTimer = this.cacheTimers.get(connectionId);
      if (oldTimer) clearTimeout(oldTimer);
      this.cacheTimers.set(connectionId, setTimeout(() => {
        this.cache.delete(connectionId);
        this.cacheTimers.delete(connectionId);
      }, 60000));
      return items;
    } catch {
      return [];
    }
  }

  clearCache(connectionId?: string) {
    if (connectionId) {
      this.cache.delete(connectionId);
      const timer = this.cacheTimers.get(connectionId);
      if (timer) { clearTimeout(timer); this.cacheTimers.delete(connectionId); }
    } else {
      this.cache.clear();
      for (const timer of this.cacheTimers.values()) clearTimeout(timer);
      this.cacheTimers.clear();
    }
  }
}

function toVscodeItem(c: DriverCompletion): vscode.CompletionItem {
  const item = new vscode.CompletionItem(c.label, mapKind(c.kind));
  if (c.detail) item.detail = c.detail;
  item.sortText = '1_' + c.label;
  return item;
}

/** Extract table names from FROM/JOIN/INTO/UPDATE clauses */
function extractTableNames(sql: string): Set<string> {
  const tables = new Set<string>();
  // Match: FROM/JOIN/INTO/UPDATE followed by optional schema.table or just table
  const regex = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(sql)) !== null) {
    tables.add(m[2].toLowerCase());
  }
  return tables;
}

/** Extract aliases: "table AS alias" or "table alias" (after FROM/JOIN) */
function extractAliases(sql: string): Map<string, string> {
  const aliases = new Map<string, string>();
  // "FROM/JOIN table AS alias" or "FROM/JOIN table alias" (alias is not a keyword)
  const regex = /\b(?:FROM|JOIN)\s+(?:"?\w+"?\s*\.\s*)?"?(\w+)"?\s+(?:AS\s+)?"?(\w+)"?/gi;
  const kwSet = new Set(SQL_KEYWORDS.map(k => k.toLowerCase()));
  let m: RegExpExecArray | null;
  while ((m = regex.exec(sql)) !== null) {
    const table = m[1].toLowerCase();
    const alias = m[2].toLowerCase();
    if (!kwSet.has(alias) && alias !== 'on' && alias !== 'where' && alias !== 'set') {
      aliases.set(alias, table);
    }
  }
  return aliases;
}

function mapKind(kind: DriverCompletion['kind']): vscode.CompletionItemKind {
  switch (kind) {
    case 'table': return vscode.CompletionItemKind.Class;
    case 'view': return vscode.CompletionItemKind.Interface;
    case 'column': return vscode.CompletionItemKind.Field;
    case 'schema': return vscode.CompletionItemKind.Module;
    case 'database': return vscode.CompletionItemKind.Module;
    case 'function': return vscode.CompletionItemKind.Function;
    case 'keyword': return vscode.CompletionItemKind.Keyword;
    default: return vscode.CompletionItemKind.Text;
  }
}
