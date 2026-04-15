import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConnectionConfig, ConnectionState, ConnectionFolder } from '../types/connection';
import { DatabaseDriver } from '../types/driver';
import { SchemaObject } from '../types/schema';
import { createDriver } from '../drivers';

const STORAGE_KEY = 'viewstor.connections';
const FOLDERS_KEY = 'viewstor.connectionFolders';
const PROJECT_FILE = '.vscode/viewstor.json';
const USER_CONFIG_DIR = path.join(os.homedir(), '.viewstor');
const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, 'connections.json');

interface ProjectData {
  connections: ConnectionConfig[];
  folders: ConnectionFolder[];
}

export class ConnectionManager {
  private connections: Map<string, ConnectionState> = new Map();
  private drivers: Map<string, DatabaseDriver> = new Map();
  private dbDrivers: Map<string, DatabaseDriver> = new Map(); // connectionId:database → driver
  private dbDriverLocks: Map<string, Promise<DatabaseDriver>> = new Map(); // in-flight driver creation
  private folders: Map<string, ConnectionFolder> = new Map();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private projectFileWatcher: vscode.FileSystemWatcher | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.loadConnections();
    this.loadFolders();
    this.loadUserConfigFile();
    this.loadProjectData();
    this.watchProjectFile();
  }

  private loadConnections() {
    const stored = this.context.globalState.get<ConnectionConfig[]>(STORAGE_KEY, []);
    for (const config of stored) {
      config.scope = config.scope || 'user';
      this.connections.set(config.id, { config, connected: false });
    }
  }

  private loadFolders() {
    const stored = this.context.globalState.get<ConnectionFolder[]>(FOLDERS_KEY, []);
    for (const folder of stored) {
      folder.scope = folder.scope || 'user';
      this.folders.set(folder.id, folder);
    }
  }

  private loadUserConfigFile() {
    try {
      // fs imported at top level
      if (!fs.existsSync(USER_CONFIG_FILE)) return;
      const raw = fs.readFileSync(USER_CONFIG_FILE, 'utf8');
      const data: ProjectData = JSON.parse(raw);
      for (const config of data.connections || []) {
        config.scope = config.scope || 'user';
        if (!this.connections.has(config.id)) {
          this.connections.set(config.id, { config, connected: false });
        }
      }
    } catch { /* file doesn't exist or invalid — ok */ }
  }

  private loadProjectData() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, PROJECT_FILE);
    try {
      // Synchronous read not available — schedule async load
      vscode.workspace.fs.readFile(fileUri).then(content => {
        const data: ProjectData = JSON.parse(Buffer.from(content).toString('utf8'));
        for (const config of data.connections || []) {
          config.scope = 'project';
          if (!this.connections.has(config.id)) {
            this.connections.set(config.id, { config, connected: false });
          }
        }
        for (const folder of data.folders || []) {
          folder.scope = 'project';
          if (!this.folders.has(folder.id)) {
            this.folders.set(folder.id, folder);
          }
        }
        this._onDidChange.fire();
      }).then(undefined, () => { /* file doesn't exist — ok */ });
    } catch { /* ignore */ }
  }

  private watchProjectFile() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const pattern = new vscode.RelativePattern(workspaceFolders[0], PROJECT_FILE);
    this.projectFileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.projectFileWatcher.onDidChange(() => this.reloadProjectData());
    this.projectFileWatcher.onDidCreate(() => this.reloadProjectData());
    this.projectFileWatcher.onDidDelete(() => this.reloadProjectData());
  }

  private reloadProjectData() {
    // Remove old project-scoped items
    for (const [id, state] of this.connections) {
      if (state.config.scope === 'project') this.connections.delete(id);
    }
    for (const [id, folder] of this.folders) {
      if (folder.scope === 'project') this.folders.delete(id);
    }
    this.loadProjectData();
  }

  private async saveConnections() {
    // Save user-scoped to globalState
    const userConfigs = Array.from(this.connections.values())
      .filter(s => s.config.scope !== 'project')
      .map(s => s.config);
    await this.context.globalState.update(STORAGE_KEY, userConfigs);
    // Sync user-scoped to ~/.viewstor/connections.json (for standalone MCP server)
    this.saveUserConfigFile(userConfigs);
    // Save project-scoped to file
    await this.saveProjectData();
  }

  private saveUserConfigFile(configs: ConnectionConfig[]) {
    try {
      // fs imported at top level
      if (!fs.existsSync(USER_CONFIG_DIR)) {
        fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
      }
      const data: ProjectData = { connections: configs, folders: [] };
      fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch { /* ignore write errors */ }
  }

  private async saveFolders() {
    const userFolders = Array.from(this.folders.values())
      .filter(f => f.scope !== 'project');
    await this.context.globalState.update(FOLDERS_KEY, userFolders);
    await this.saveProjectData();
  }

  private async saveProjectData() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    const projectConns = Array.from(this.connections.values())
      .filter(s => s.config.scope === 'project')
      .map(s => {
        // Strip password from project file for security
        const { password: _password, ...rest } = s.config;
        return rest as ConnectionConfig;
      });
    const projectFolders = Array.from(this.folders.values())
      .filter(f => f.scope === 'project');

    if (projectConns.length === 0 && projectFolders.length === 0) return;

    const data: ProjectData = { connections: projectConns, folders: projectFolders };
    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, PROJECT_FILE);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
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

  /** Get or create a cached driver for a specific database within a multi-DB connection */
  async getDriverForDatabase(connectionId: string, database: string): Promise<DatabaseDriver> {
    const state = this.connections.get(connectionId);
    if (!state) throw new Error('Connection not found');

    // If it's the main database, return the primary driver
    if (state.config.database === database) {
      const d = this.drivers.get(connectionId);
      if (d) return d;
    }

    const cacheKey = `${connectionId}:${database}`;

    // Reuse in-flight creation to prevent duplicate drivers from concurrent calls
    const inflight = this.dbDriverLocks.get(cacheKey);
    if (inflight) return inflight;

    const promise = this.resolveDbDriver(cacheKey, state, database);
    this.dbDriverLocks.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.dbDriverLocks.delete(cacheKey);
    }
  }

  private async resolveDbDriver(cacheKey: string, state: ConnectionState, database: string): Promise<DatabaseDriver> {
    let driver = this.dbDrivers.get(cacheKey);
    if (driver) {
      try { await driver.ping(); return driver; } catch { /* reconnect below */ }
    }

    const tempConfig = { ...state.config, database };
    driver = createDriver(tempConfig.type);
    await driver.connect(tempConfig);
    this.dbDrivers.set(cacheKey, driver);
    return driver;
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
    // Disconnect cached multi-DB drivers
    for (const [key, dbDriver] of this.dbDrivers) {
      if (key.startsWith(`${id}:`)) {
        await dbDriver.disconnect().catch(() => {});
        this.dbDrivers.delete(key);
      }
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

  /**
   * Resolve the effective agent-write-approval policy for a connection:
   * connection override first, then folder (walking up the folder tree),
   * then the default 'always'.
   */
  getAgentWriteApproval(id: string): 'always' | 'ddl-and-admin' | 'never' {
    const state = this.connections.get(id);
    if (!state) return 'always';
    if (state.config.agentWriteApproval) return state.config.agentWriteApproval;
    let folderId: string | undefined = state.config.folderId;
    const seen = new Set<string>();
    while (folderId && !seen.has(folderId)) {
      seen.add(folderId);
      const folder = this.folders.get(folderId);
      if (!folder) break;
      if (folder.agentWriteApproval) return folder.agentWriteApproval;
      folderId = folder.parentFolderId;
    }
    return 'always';
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
    this.projectFileWatcher?.dispose();
    this._onDidChange.dispose();
  }
}
