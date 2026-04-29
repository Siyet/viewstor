import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { ConnectionState } from '../types/connection';
import { SchemaObject, SchemaObjectType } from '../types/schema';

const MIME_TYPE = 'application/vnd.code.tree.viewstor.connections';

export class ConnectionTreeProvider implements vscode.TreeDataProvider<ConnectionTreeItem>, vscode.TreeDragAndDropController<ConnectionTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ConnectionTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  /** Cache schema per connection to avoid re-fetching on filter/visibility changes */
  private schemaCache = new Map<string, SchemaObject[]>();

  readonly dropMimeTypes = [MIME_TYPE];
  readonly dragMimeTypes = [MIME_TYPE];

  constructor(private readonly connectionManager: ConnectionManager) {
    connectionManager.onDidChange(() => this.refresh());
  }

  refresh(clearCache = false) {
    if (clearCache) this.schemaCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ConnectionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ConnectionTreeItem): Promise<ConnectionTreeItem[]> {
    if (!element) {
      return this.getFolderContents(undefined);
    }

    // Folder children → sub-folders + connections in folder
    if (element.itemType === 'folder' && element.folderId) {
      return this.getFolderContents(element.folderId);
    }

    if (element.connectionId && element.itemType === 'connection') {
      const state = this.connectionManager.get(element.connectionId);
      if (state && !state.connected) {
        // If schema is already cached (e.g. during a tree refresh after hideSchema),
        // skip auto-connect and use the cached schema instead of triggering I/O.
        if (!this.schemaCache.has(element.connectionId)) {
          try {
            await this.connectionManager.connect(element.connectionId);
          } catch {
            return [new ConnectionTreeItem(vscode.l10n.t('Connection failed'), vscode.TreeItemCollapsibleState.None)];
          }
        }
      }

      // Multi-DB: show database nodes listed in config.databases
      const config = state?.config;
      // Combine main database + additional databases, deduplicated
      const allDbs = new Set<string>();
      if (config?.database) allDbs.add(config.database);
      if (config?.databases) config.databases.forEach(db => allDbs.add(db));
      const databases = [...allDbs];
      if (databases.length > 1) {
        const iconColor = colorToThemeColor(this.connectionManager.getConnectionColor(element.connectionId!));
        return databases.map(db => {
          const dbItem = new ConnectionTreeItem(db, vscode.TreeItemCollapsibleState.Collapsed);
          dbItem.connectionId = element.connectionId;
          dbItem.itemType = 'database';
          dbItem.contextValue = 'database';
          dbItem.databaseName = db;
          dbItem.iconPath = new vscode.ThemeIcon('database', iconColor);
          dbItem.command = { command: 'viewstor._noop', title: '' };
          return dbItem;
        });
      }

      // Single-DB: load schema (cached)
      const driver = this.connectionManager.getDriver(element.connectionId);
      if (!driver) {
        // Disconnected but schema is cached — use cache (e.g. after hideSchema refresh)
        const cached = this.schemaCache.get(element.connectionId!);
        if (cached) {
          const schema = this.filterSchema(cached, element.connectionId!);
          if (schema.length === 1 && schema[0].type === 'database' && schema[0].children) {
            let children = schema[0].children;
            if (children.length === 1 && children[0].type === 'schema' && children[0].children) {
              children = children[0].children;
            }
            return this.createSchemaItems(children, element.connectionId!);
          }
          return this.createSchemaItems(schema, element.connectionId!);
        }
        return [];
      }
      try {
        let rawSchema = this.schemaCache.get(element.connectionId!);
        if (!rawSchema) {
          rawSchema = await driver.getSchema();
          this.schemaCache.set(element.connectionId!, rawSchema);
        }
        const schema = this.filterSchema(rawSchema, element.connectionId!);
        // Collapse single-database level
        if (schema.length === 1 && schema[0].type === 'database' && schema[0].children) {
          let children = schema[0].children;
          if (children.length === 1 && children[0].type === 'schema' && children[0].children) {
            children = children[0].children;
          }
          return this.createSchemaItems(children, element.connectionId!);
        }
        return this.createSchemaItems(schema, element.connectionId!);
      } catch (err) {
        return [new ConnectionTreeItem(
          vscode.l10n.t('Error: {0}', err instanceof Error ? err.message : 'Unknown'),
          vscode.TreeItemCollapsibleState.None,
        )];
      }
    }

    // Multi-DB: expanding a database node → connect to that DB and load schema (cached)
    if (element.connectionId && element.itemType === 'database' && element.databaseName) {
      try {
        const cacheKey = `${element.connectionId}:${element.databaseName}`;
        let schema = this.schemaCache.get(cacheKey);
        if (!schema) {
          schema = await this.connectionManager.getSchemaForDatabase(element.connectionId, element.databaseName);
          this.schemaCache.set(cacheKey, schema);
        }
        const filtered = this.filterSchema(schema, element.connectionId);
        // Collapse single-database or single-schema level
        if (filtered.length === 1 && (filtered[0].type === 'schema' || filtered[0].type === 'database') && filtered[0].children) {
          let children = filtered[0].children;
          // Also collapse nested single-schema (e.g. database > schema > tables)
          if (children.length === 1 && children[0].type === 'schema' && children[0].children) {
            children = children[0].children;
          }
          return this.createSchemaItems(children, element.connectionId, element.databaseName);
        }
        return this.createSchemaItems(filtered, element.connectionId, element.databaseName);
      } catch (err) {
        return [new ConnectionTreeItem(
          vscode.l10n.t('Error: {0}', err instanceof Error ? err.message : 'Unknown'),
          vscode.TreeItemCollapsibleState.None,
        )];
      }
    }

    if (element.schemaObject?.children && element.schemaObject.children.length > 0) {
      let children = element.schemaObject.children;
      if (element.connectionId) {
        children = this.filterSchema(children, element.connectionId);
      }
      // Collapse single-schema level when expanding a database
      if (element.schemaObject.type === 'database' && children.length === 1 && children[0].type === 'schema' && children[0].children) {
        children = children[0].children;
      }
      return this.createSchemaItems(children, element.connectionId!);
    }

    return [];
  }

  // --- Helpers ---

  private getFolderContents(parentFolderId: string | undefined): ConnectionTreeItem[] {
    const items: ConnectionTreeItem[] = [];

    // Sub-folders at this level
    for (const folder of this.connectionManager.getAllFolders()) {
      if ((folder.parentFolderId || undefined) !== parentFolderId) continue;
      const fi = new ConnectionTreeItem(folder.name, vscode.TreeItemCollapsibleState.Collapsed);
      fi.itemType = 'folder';
      fi.folderId = folder.id;
      fi.contextValue = 'folder';
      fi.iconPath = new vscode.ThemeIcon('folder', colorToThemeColor(folder.color));
      fi.command = { command: 'viewstor._noop', title: '' };
      items.push(fi);
    }

    // Connections at this level
    for (const state of this.connectionManager.getAll()) {
      if ((state.config.folderId || undefined) !== parentFolderId) continue;
      items.push(this.createConnectionItem(state));
    }

    return items;
  }

  // --- Drag and Drop ---

  handleDrag(source: readonly ConnectionTreeItem[], dataTransfer: vscode.DataTransfer): void {
    const items = source.filter(i => (i.itemType === 'connection' && i.connectionId) || i.itemType === 'folder');
    if (items.length > 0) {
      const payload = items.map(i => ({ type: i.itemType!, id: i.connectionId || i.folderId! }));
      dataTransfer.set(MIME_TYPE, new vscode.DataTransferItem(JSON.stringify(payload)));
    }
  }

  async handleDrop(target: ConnectionTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const raw = dataTransfer.get(MIME_TYPE);
    if (!raw) return;
    const payload: Array<{ type: string; id: string }> = JSON.parse(raw.value);
    const targetFolderId = target?.itemType === 'folder' ? target.folderId : undefined;
    for (const item of payload) {
      if (item.type === 'connection') {
        await this.connectionManager.moveConnectionToFolder(item.id, targetFolderId);
      } else if (item.type === 'folder') {
        await this.connectionManager.moveFolderToFolder(item.id, targetFolderId);
      }
    }
  }

  // --- Filtering ---

  private filterSchema(objects: SchemaObject[], connectionId: string): SchemaObject[] {
    const config = this.connectionManager.get(connectionId)?.config;
    if (!config) return objects;

    return objects.filter(obj => {
      // Filter hidden databases
      if (obj.type === 'database' && config.hiddenDatabases?.includes(obj.name)) return false;
      // Filter hidden schemas
      if (obj.type === 'schema') {
        // Find parent database name from schema field or assume default
        const db = obj.schema || config.database || 'default';
        if (config.hiddenSchemas?.[db]?.includes(obj.name)) return false;
      }
      return true;
    }).map(obj => {
      if (obj.children) {
        return { ...obj, children: this.filterSchema(obj.children, connectionId) };
      }
      return obj;
    });
  }

  // --- Item Builders ---

  private createConnectionItem(state: ConnectionState): ConnectionTreeItem {
    const { config, connected } = state;
    const label = config.name;
    const collapsible = vscode.TreeItemCollapsibleState.Collapsed;

    const item = new ConnectionTreeItem(label, collapsible);
    item.connectionId = config.id;
    item.itemType = 'connection';
    item.contextValue = connected ? 'connection-connected' : 'connection-disconnected';
    const iconColor = colorToThemeColor(this.connectionManager.getConnectionColor(config.id));
    item.iconPath = new vscode.ThemeIcon(`viewstor-${config.type}`, iconColor);
    let desc = connected
      ? (config.type === 'sqlite' ? (config.database || ':memory:') : `${config.host}:${config.port}`)
      : '';
    if (config.agentCreated) {
      desc = desc ? `${desc} (agent)` : '(agent)';
    }
    item.description = desc;
    item.command = { command: 'viewstor._noop', title: '' };
    return item;
  }

  private createSchemaItems(objects: SchemaObject[], connectionId: string, databaseName?: string): ConnectionTreeItem[] {
    return objects.map(obj => this.createSchemaItem(obj, connectionId, databaseName));
  }

  private createSchemaItem(obj: SchemaObject, connectionId: string, databaseName?: string): ConnectionTreeItem {
    const hasChildren = obj.children && obj.children.length > 0;
    // Columns are always leaf; tables/views/groups/sequences always collapsible for twistie alignment
    const isStructural = obj.type !== 'column' && obj.type !== 'index' && obj.type !== 'key';
    const collapsible = (hasChildren || isStructural)
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    // Append a "*" to the column name when NOT NULL — universal "required" marker.
    const label = obj.type === 'column' && obj.notNullable ? `${obj.name}\u2009*` : obj.name;
    const item = new ConnectionTreeItem(label, collapsible);
    item.connectionId = connectionId;
    item.schemaObject = obj;
    // Indexed columns get a distinct contextValue so menus can target them
    // (e.g. "Show index DDL" only appears for column-indexed).
    const isIndexedColumn = obj.type === 'column' && obj.indexNames && obj.indexNames.length > 0;
    item.contextValue = isIndexedColumn ? 'column-indexed' : obj.type;
    if (databaseName) item.databaseName = databaseName;

    // Inaccessible items get error color. Indexed columns keep the default
    // (white/foreground) icon to stand out; non-indexed columns get a muted
    // gray to fade into the background.
    if (obj.inaccessible) {
      item.iconPath = new vscode.ThemeIcon(schemaIcon(obj.type), new vscode.ThemeColor('errorForeground'));
      item.tooltip = `${obj.name} — no access`;
    } else if (obj.type === 'column' && !isIndexedColumn) {
      item.iconPath = new vscode.ThemeIcon(schemaIcon(obj.type), new vscode.ThemeColor('descriptionForeground'));
    } else {
      item.iconPath = new vscode.ThemeIcon(schemaIcon(obj.type));
      if (isIndexedColumn) {
        item.tooltip = `${obj.name} — indexed by ${obj.indexNames!.join(', ')}`;
      }
    }

    if (obj.detail) {
      item.description = obj.detail;
    }

    // Collapsible items: no-op command so label click doesn't expand
    if (collapsible === vscode.TreeItemCollapsibleState.Collapsed) {
      item.command = { command: 'viewstor._noop', title: '' };
    }

    return item;
  }
}

function schemaIcon(type: SchemaObjectType): string {
  switch (type) {
    case 'database': return 'database';
    case 'schema': return 'symbol-namespace';
    case 'table': return 'table';
    case 'view': return 'eye';
    case 'column': return 'symbol-field';
    case 'index': return 'list-ordered';
    case 'key': return 'key';
    case 'keyspace': return 'folder';
    case 'trigger': return 'zap';
    case 'sequence': return 'symbol-number';
    case 'group': return 'list-flat';
    default: return 'symbol-misc';
  }
}

export class ConnectionTreeItem extends vscode.TreeItem {
  connectionId?: string;
  schemaObject?: SchemaObject;
  itemType?: string;
  folderId?: string;
  databaseName?: string;
}

/** Convert a color string (CSS var or hex) to a ThemeColor for icon tinting */
function colorToThemeColor(color?: string): vscode.ThemeColor | undefined {
  if (!color) return undefined;
  // CSS variable: var(--vscode-terminal-ansiRed) → terminal.ansiRed
  const varMatch = color.match(/var\(--vscode-([\w-]+)\)/);
  if (varMatch) {
    const id = varMatch[1].replace(/-([a-zA-Z])/g, (_, c: string) => '.' + c);
    return new vscode.ThemeColor(id);
  }
  // For hex colors, approximate to a charts.* color
  return new vscode.ThemeColor('charts.foreground');
}
