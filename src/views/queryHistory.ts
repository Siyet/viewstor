import * as vscode from 'vscode';
import { QueryHistoryEntry } from '../types/query';

const STORAGE_KEY = 'viewstor.queryHistory';
const MAX_ENTRIES = 200;

export class QueryHistoryProvider implements vscode.TreeDataProvider<QueryHistoryItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getEntries(): QueryHistoryEntry[] {
    return this.context.globalState.get<QueryHistoryEntry[]>(STORAGE_KEY, []);
  }

  async addEntry(entry: QueryHistoryEntry): Promise<void> {
    const entries = this.getEntries();
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) {
      entries.length = MAX_ENTRIES;
    }
    await this.context.globalState.update(STORAGE_KEY, entries);
    this.refresh();
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, []);
    this.refresh();
  }

  getTreeItem(element: QueryHistoryItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<QueryHistoryItem[]> {
    return this.getEntries().map(entry => {
      const shortQuery = entry.query.substring(0, 60).replace(/\n/g, ' ');
      const item = new QueryHistoryItem(
        shortQuery,
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = `${entry.connectionName} · ${entry.executionTimeMs}ms`;
      item.tooltip = entry.query;
      item.iconPath = new vscode.ThemeIcon(entry.error ? 'error' : 'history');
      item.entry = entry;
      return item;
    });
  }
}

class QueryHistoryItem extends vscode.TreeItem {
  entry?: QueryHistoryEntry;
}
