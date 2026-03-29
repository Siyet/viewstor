import * as vscode from 'vscode';
import { ConnectionConfig, ConnectionState, ConnectionFolder } from '../types/connection';
import { DatabaseDriver } from '../types/driver';
import { SchemaObject } from '../types/schema';
import { createDriver } from '../drivers';

const STORAGE_KEY = 'viewstor.connections';
const FOLDERS_KEY = 'viewstor.connectionFolders';

export class ConnectionManager {
  private connections: Map<string, ConnectionState> = new Map();
  private drivers: Map<string, DatabaseDriver> = new Map();
  private folders: Map<string, ConnectionFolder> = new Map();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.loadConnections();
    this.loadFolders();
  }

  private loadConnections() {
    const stored = this.context.globalState.get<ConnectionConfig[]>(STORAGE_KEY, []);
    for (const config of stored) {
      this.connections.set(config.id, { config, connected: false });
    }
  }

  private loadFolders() {
    const stored = this.context.globalState.get<ConnectionFolder[]>(FOLDERS_KEY, []);
    for (const folder of stored) {
      this.folders.set(folder.id, folder);
    }
  }

  private async saveConnections() {
    const configs = Array.from(this.connections.values()).map(s => s.config);
    await this.context.globalState.update(STORAGE_KEY, configs);
  }

  private async saveFolders() {
    const folders = Array.from(this.folders.values());
    await this.context.globalState.update(FOLDERS_KEY, folders);
  }

  // --- Connections ---

  getAll(): ConnectionState[] {
    return Array.from(this.connections.values());
  }

  get(id: string): ConnectionState | undefined {
    return this.connections.get(id);
  }

  getDriver(id: string): DatabaseDriver | undefined {
    return this.drivers.get(id);
  }

  async add(config: ConnectionConfig): Promise<void> {
    this.connections.set(config.id, { config, connected: false });
    await this.saveConnections();
    this._onDidChange.fire();
  }

  async update(config: ConnectionConfig): Promise<void> {
    const existing = this.connections.get(config.id);
    if (existing?.connected) {
      await this.disconnect(config.id);
    }
    this.connections.set(config.id, { config, connected: false });
    await this.saveConnections();
    this._onDidChange.fire();
  }

  async remove(id: string): Promise<void> {
    if (this.connections.get(id)?.connected) {
      await this.disconnect(id);
    }
    this.connections.delete(id);
    this.drivers.delete(id);
    await this.saveConnections();
    this._onDidChange.fire();
  }

  async connect(id: string): Promise<void> {
    const state = this.connections.get(id);
    if (!state) {
      throw new Error(`Connection ${id} not found`);
    }

    const driver = createDriver(state.config.type);
    await driver.connect(state.config);

    this.drivers.set(id, driver);
    state.connected = true;
    this._onDidChange.fire();
  }

  async disconnect(id: string): Promise<void> {
    const driver = this.drivers.get(id);
    if (driver) {
      await driver.disconnect();
      this.drivers.delete(id);
    }
    const state = this.connections.get(id);
    if (state) {
      state.connected = false;
    }
    this._onDidChange.fire();
  }

  /** Get schema for a specific database (multi-DB connections) */
  async getSchemaForDatabase(connectionId: string, database: string): Promise<SchemaObject[]> {
    const state = this.connections.get(connectionId);
    if (!state) throw new Error('Connection not found');

    // Create a temporary driver connected to the target database
    const tempConfig = { ...state.config, database };
    const driver = createDriver(tempConfig.type);
    try {
      await driver.connect(tempConfig);
      const schema = await driver.getSchema();
      await driver.disconnect();
      return schema;
    } catch (err) {
      await driver.disconnect().catch(() => {});
      throw err;
    }
  }

  async testConnection(config: ConnectionConfig): Promise<boolean> {
    const driver = createDriver(config.type);
    try {
      await driver.connect(config);
      const result = await driver.ping();
      await driver.disconnect();
      return result;
    } catch {
      return false;
    }
  }

  async setConnectionColor(id: string, color: string | undefined): Promise<void> {
    const state = this.connections.get(id);
    if (!state) return;
    state.config.color = color;
    await this.saveConnections();
    this._onDidChange.fire();
  }

  async moveConnectionToFolder(connectionId: string, folderId: string | undefined): Promise<void> {
    const state = this.connections.get(connectionId);
    if (!state) return;
    state.config.folderId = folderId;
    await this.saveConnections();
    this._onDidChange.fire();
  }

  async toggleHiddenSchema(connectionId: string, database: string, schema: string): Promise<void> {
    const state = this.connections.get(connectionId);
    if (!state) return;
    if (!state.config.hiddenSchemas) state.config.hiddenSchemas = {};
    const list = state.config.hiddenSchemas[database] || [];
    const idx = list.indexOf(schema);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(schema);
    state.config.hiddenSchemas[database] = list;
    await this.saveConnections();
    this._onDidChange.fire();
  }

  async toggleHiddenDatabase(connectionId: string, database: string): Promise<void> {
    const state = this.connections.get(connectionId);
    if (!state) return;
    if (!state.config.hiddenDatabases) state.config.hiddenDatabases = [];
    const idx = state.config.hiddenDatabases.indexOf(database);
    if (idx >= 0) state.config.hiddenDatabases.splice(idx, 1);
    else state.config.hiddenDatabases.push(database);
    await this.saveConnections();
    this._onDidChange.fire();
  }

  // --- Folders ---

  getAllFolders(): ConnectionFolder[] {
    return Array.from(this.folders.values()).sort((a, b) => a.sortOrder - b.sortOrder);
  }

  getFolder(id: string): ConnectionFolder | undefined {
    return this.folders.get(id);
  }

  async addFolder(name: string, color?: string, readonly?: boolean, parentFolderId?: string): Promise<ConnectionFolder> {
    const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    const sortOrder = this.folders.size;
    const folder: ConnectionFolder = { id, name, color, readonly, sortOrder, parentFolderId };
    this.folders.set(id, folder);
    await this.saveFolders();
    this._onDidChange.fire();
    return folder;
  }

  async moveFolderToFolder(folderId: string, parentFolderId: string | undefined): Promise<void> {
    const folder = this.folders.get(folderId);
    if (!folder) return;
    // Prevent circular nesting
    if (parentFolderId) {
      let current = parentFolderId;
      while (current) {
        if (current === folderId) return; // would create a cycle
        current = this.folders.get(current)?.parentFolderId || '';
      }
    }
    folder.parentFolderId = parentFolderId;
    await this.saveFolders();
    this._onDidChange.fire();
  }

  async updateFolder(id: string, updates: Partial<Pick<ConnectionFolder, 'name' | 'color' | 'readonly' | 'sortOrder'>>): Promise<void> {
    const folder = this.folders.get(id);
    if (!folder) return;
    Object.assign(folder, updates);
    await this.saveFolders();
    this._onDidChange.fire();
  }

  async removeFolder(id: string): Promise<void> {
    const removed = this.folders.get(id);
    const parentId = removed?.parentFolderId;
    this.folders.delete(id);
    // Reparent child folders to the deleted folder's parent
    for (const folder of this.folders.values()) {
      if (folder.parentFolderId === id) {
        folder.parentFolderId = parentId;
      }
    }
    // Reparent connections to the deleted folder's parent
    for (const state of this.connections.values()) {
      if (state.config.folderId === id) {
        state.config.folderId = parentId;
      }
    }
    await this.saveFolders();
    await this.saveConnections();
    this._onDidChange.fire();
  }

  /** Get the effective color for a connection (own color or folder color) */
  getConnectionColor(id: string): string | undefined {
    const state = this.connections.get(id);
    if (!state) return undefined;
    if (state.config.color) return state.config.color;
    if (state.config.folderId) {
      return this.folders.get(state.config.folderId)?.color;
    }
    return undefined;
  }

  /** Check if a connection is effectively readonly (own setting or folder setting) */
  isConnectionReadonly(id: string): boolean {
    const state = this.connections.get(id);
    if (!state) return false;
    if (state.config.readonly !== undefined) return state.config.readonly;
    if (state.config.folderId) {
      return this.folders.get(state.config.folderId)?.readonly || false;
    }
    return false;
  }

  dispose() {
    for (const [id] of this.drivers) {
      this.disconnect(id).catch(() => {});
    }
    this._onDidChange.dispose();
  }
}
