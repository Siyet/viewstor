import * as vscode from 'vscode';
import { QueryHistoryEntry } from '../types/query';

const STORAGE_KEY = 'viewstor.queryHistory';

export class QueryHistoryProvider implements vscode.TreeDataProvider<QueryHistoryItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private getMaxEntries(): number {
    return vscode.workspace.getConfiguration('viewstor').get<number>('queryHistoryLimit', 200);
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getEntries(): QueryHistoryEntry[] {
    return this.context.globalState.get<QueryHistoryEntry[]>(STORAGE_KEY, []);
  }

  async addEntry(entry: QueryHistoryEntry): Promise<void> {
    const entries = this.getEntries();
    entries.unshift(entry);
    // Evict oldest non-pinned entries over the limit
    const max = this.getMaxEntries();
    while (entries.length > max) {
      let lastUnpinned = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (!entries[i].pinned) { lastUnpinned = i; break; }
      }
      if (lastUnpinned === -1) break; // all pinned — don't evict
      entries.splice(lastUnpinned, 1);
    }
    await this.context.globalState.update(STORAGE_KEY, entries);
    this.refresh();
  }

  async removeEntry(id: string): Promise<void> {
    const entries = this.getEntries().filter(e => e.id !== id);
    await this.context.globalState.update(STORAGE_KEY, entries);
    this.refresh();
  }

  async togglePin(id: string, pinned: boolean): Promise<void> {
    const entries = this.getEntries();
    const entry = entries.find(e => e.id === id);
    if (entry) {
      entry.pinned = pinned;
      await this.context.globalState.update(STORAGE_KEY, entries);
      this.refresh();
    }
  }

  async updateFilePath(id: string, filePath: string): Promise<void> {
    const entries = this.getEntries();
    const entry = entries.find(e => e.id === id);
    if (entry) {
      entry.filePath = filePath;
      await this.context.globalState.update(STORAGE_KEY, entries);
      this.refresh();
    }
  }

  async clear(): Promise<void> {
    // Keep pinned entries
    const pinned = this.getEntries().filter(e => e.pinned);
    await this.context.globalState.update(STORAGE_KEY, pinned);
    this.refresh();
  }

  getTreeItem(element: QueryHistoryItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: QueryHistoryItem): Promise<QueryHistoryItem[]> {
    if (element) return [];

    const entries = this.getEntries();
    const pinned = entries.filter(e => e.pinned);
    const unpinned = entries.filter(e => !e.pinned);

    const items: QueryHistoryItem[] = [];

    if (pinned.length > 0) {
      const pinnedHeader = new QueryHistoryItem(
        vscode.l10n.t('Pinned'),
        vscode.TreeItemCollapsibleState.None,
      );
      pinnedHeader.iconPath = new vscode.ThemeIcon('pinned');
      pinnedHeader.description = `${pinned.length}`;
      items.push(pinnedHeader);
      items.push(...pinned.map(e => this.createHistoryItem(e, true)));
    }

    items.push(...unpinned.map(e => this.createHistoryItem(e, false)));

    return items;
  }

  private createHistoryItem(entry: QueryHistoryEntry, isPinned: boolean): QueryHistoryItem {
    const shortQuery = entry.query.substring(0, 60).replace(/\n/g, ' ');
    const item = new QueryHistoryItem(shortQuery, vscode.TreeItemCollapsibleState.None);
    const time = new Date(entry.executedAt).toLocaleTimeString();
    item.description = `${entry.connectionName} · ${entry.executionTimeMs}ms · ${time}`;
    item.tooltip = entry.query;
    item.iconPath = new vscode.ThemeIcon(
      entry.error ? 'error' : isPinned ? 'pinned' : 'history',
    );
    item.contextValue = isPinned ? 'queryHistoryPinned' : 'queryHistoryEntry';
    item.entry = entry;
    item.command = {
      command: 'viewstor.openQueryFromHistory',
      title: 'Open Query',
      arguments: [entry],
    };
    return item;
  }
}

export class QueryHistoryItem extends vscode.TreeItem {
  entry?: QueryHistoryEntry;
}
