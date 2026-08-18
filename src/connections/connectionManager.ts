import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConnectionConfig, ConnectionState, ConnectionFolder, ProxyConfig, DEFAULT_PORTS } from '../types/connection';
import { DatabaseDriver } from '../types/driver';
import { SchemaObject } from '../types/schema';
import { createDriver } from '../drivers';
import { AnonymizationPolicy, resolveAnonymizationPolicy } from '../mcp/anonymizer';

const STORAGE_KEY = 'viewstor.connections';
const FOLDERS_KEY = 'viewstor.connectionFolders';
const PROJECT_FILE = '.vscode/viewstor.json';
const USER_CONFIG_DIR = path.join(os.homedir(), '.viewstor');
const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, 'connections.json');

/**
 * Project-scope connections are written to `.vscode/viewstor.json`, which is meant to be
 * shareable/committable — so every credential (DB password, proxy/SSH password, private key,
 * passphrase, on every hop) must be stripped, not just the top-level DB password.
 */
function stripSecretsForProjectFile(config: ConnectionConfig): ConnectionConfig {
  const { password: _password, proxy, ...rest } = config;
  if (!proxy) return rest as ConnectionConfig;

  const {
    sshPassword: _sshPassword,
    sshPrivateKey: _sshPrivateKey,
    sshPassphrase: _sshPassphrase,
    proxyPassword: _proxyPassword,
    sshHops,
    ...restProxy
  } = proxy;

  return {
    ...rest,
    proxy: {
      ...restProxy,
      sshHops: sshHops?.map(({ password: _hopPassword, privateKey: _hopPrivateKey, passphrase: _hopPassphrase, ...restHop }) => restHop),
    },
  } as ConnectionConfig;
}

/**
 * Who a credential was entered for. Remembered credentials are only reapplied to the
 * same endpoint — the project file is shared and committed, so a pulled change to a
 * host/user must fail closed (prompting the user) rather than silently forwarding the
 * password they typed for the old one to whatever host now sits in its place.
 */
function endpointIdentity(host: string | undefined, port: number | undefined, username: string | undefined, defaultPort?: number): string {
  // An omitted port and its default are the same endpoint — the config in memory and
  // the one read back from the file often differ only in whether it was spelled out.
  return `${host ?? ''}:${port ?? defaultPort ?? ''}:${username ?? ''}`;
}

/** The proxy's own endpoint — SSH hop 1, or the SOCKS5/HTTP proxy for those types. */
function proxyIdentityOf(proxy: ProxyConfig): string {
  // Type is part of the identity: the same host/user reached as an SSH bastion and as
  // a SOCKS5 proxy are different things to hold a credential for.
  return proxy.type === 'ssh'
    ? `ssh|${endpointIdentity(proxy.sshHost, proxy.sshPort, proxy.sshUsername, 22)}`
    : `${proxy.type}|${endpointIdentity(proxy.proxyHost, proxy.proxyPort, proxy.proxyUsername, 1080)}`;
}

/** Exactly the fields stripSecretsForProjectFile() drops, kept in memory so a reload can put them back. */
interface ProjectSecrets {
  dbIdentity: string;
  password?: string;
  proxyIdentity?: string;
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
  proxyPassword?: string;
  hops?: Array<{ identity: string; password?: string; privateKey?: string; passphrase?: string }>;
}

function extractProjectSecrets(config: ConnectionConfig): ProjectSecrets | undefined {
  const proxy = config.proxy;
  const secrets: ProjectSecrets = {
    dbIdentity: endpointIdentity(config.host, config.port, config.username, DEFAULT_PORTS[config.type]),
    password: config.password,
    proxyIdentity: proxy && proxyIdentityOf(proxy),
    sshPassword: proxy?.sshPassword,
    sshPrivateKey: proxy?.sshPrivateKey,
    sshPassphrase: proxy?.sshPassphrase,
    proxyPassword: proxy?.proxyPassword,
    hops: proxy?.sshHops?.map(hop => ({
      identity: endpointIdentity(hop.host, hop.port, hop.username, 22),
      password: hop.password,
      privateKey: hop.privateKey,
      passphrase: hop.passphrase,
    })),
  };
  const hasAny = secrets.password || secrets.sshPassword || secrets.sshPrivateKey || secrets.sshPassphrase
    || secrets.proxyPassword || secrets.hops?.some(h => h.password || h.privateKey || h.passphrase);
  return hasAny ? secrets : undefined;
}

/** Mutates `config` in place, restoring only fields it doesn't already carry, and only for unchanged endpoints. */
function applyProjectSecrets(config: ConnectionConfig, secrets: ProjectSecrets) {
  if (endpointIdentity(config.host, config.port, config.username, DEFAULT_PORTS[config.type]) === secrets.dbIdentity) {
    config.password ??= secrets.password;
  }
  const proxy = config.proxy;
  if (!proxy) return;

  if (proxyIdentityOf(proxy) === secrets.proxyIdentity) {
    proxy.sshPassword ??= secrets.sshPassword;
    proxy.sshPrivateKey ??= secrets.sshPrivateKey;
    proxy.sshPassphrase ??= secrets.sshPassphrase;
    proxy.proxyPassword ??= secrets.proxyPassword;
  }
  // Matched by identity, not position: a reordered chain keeps each hop's own
  // credential, and an inserted or retargeted hop simply gets none.
  proxy.sshHops?.forEach(hop => {
    const identity = endpointIdentity(hop.host, hop.port, hop.username, 22);
    const remembered = secrets.hops?.find(h => h.identity === identity);
    if (!remembered) return;
    hop.password ??= remembered.password;
    hop.privateKey ??= remembered.privateKey;
    hop.passphrase ??= remembered.passphrase;
  });
}

interface ProjectData {
  connections: ConnectionConfig[];
  folders: ConnectionFolder[];
}

export class ConnectionManager {
  private connections: Map<string, ConnectionState> = new Map();
  private drivers: Map<string, DatabaseDriver> = new Map();
  private dbDrivers: Map<string, DatabaseDriver> = new Map(); // connectionId:database → driver
  private primaryDriverLocks: Map<string, Promise<DatabaseDriver>> = new Map(); // connectionId → in-flight reconnect
  private dbDriverLocks: Map<string, Promise<DatabaseDriver>> = new Map(); // in-flight driver creation
  private folders: Map<string, ConnectionFolder> = new Map();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private projectFileWatcher: vscode.FileSystemWatcher | undefined;
  // VS Code's FileSystemWatcher doesn't exempt the extension's own writes — saving a
  // project-scope connection fires onDidChange for the file this same save just
  // wrote. Without this, that triggers reloadProjectData(), which re-reads the
  // just-stripped file and wipes live-session-only secrets (SSH/DB passwords,
  // private keys) straight back out of the in-memory config.
  private lastWrittenProjectContent: string | undefined;
  // Chained to serialize saveProjectData() calls — see its own doc comment.
  private projectSaveQueue: Promise<void> = Promise.resolve();
  private projectSavesInFlight = 0;
  // Bumped by every completed write, so a guard check can tell whether the file it
  // read is still the one lastWrittenProjectContent describes.
  private projectSaveGeneration = 0;
  // Credentials belonging to project-scope connections, which by design never reach
  // `.vscode/viewstor.json`. Reloading takes that file as the truth, so without a copy
  // held outside the reloaded config a reload silently wipes them. Keeping them here
  // makes a reload harmless by construction, rather than something the watcher guards
  // above have to be perfect at avoiding.
  private projectSecrets: Map<string, ProjectSecrets> = new Map();
  // True between dropping project connections from memory and successfully reloading
  // them. While set, an empty in-memory project set means "not loaded yet", not
  // "none exist" — so projectSecrets must not be rebuilt from it.
  private projectLoadPending = false;

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
          // The file never holds credentials, so anything we still remember for this
          // connection is put back — otherwise every reload silently logs the user out.
          const secrets = this.projectSecrets.get(config.id);
          if (secrets) applyProjectSecrets(config, secrets);
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
        // In-memory project data now reflects the file again.
        this.projectLoadPending = false;
        this._onDidChange.fire();
      }).then(undefined, () => {
        // File is missing or mid-edit (invalid JSON), so project connections stay
        // unloaded — deliberately leaving projectLoadPending set, so a save landing
        // in that stretch doesn't mistake "none in memory" for "none exist" and drop
        // the credentials we're holding for them.
      });
    } catch { /* ignore */ }
  }

  private watchProjectFile() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const pattern = new vscode.RelativePattern(workspaceFolders[0], PROJECT_FILE);
    this.projectFileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.projectFileWatcher.onDidChange(() => this.reloadProjectDataIfChanged());
    this.projectFileWatcher.onDidCreate(() => this.reloadProjectDataIfChanged());
    this.projectFileWatcher.onDidDelete(() => this.reloadProjectData());
  }

  /** Skips the reload if the file on disk is exactly what this same instance just wrote — see lastWrittenProjectContent. */
  private async reloadProjectDataIfChanged() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    // A save that hasn't landed yet means disk still holds the *previous* write while
    // the marker already names the pending one — every comparison in that window is
    // meaningless, and treating it as an external edit would wipe live secrets.
    if (this.projectSavesInFlight > 0) return;
    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, PROJECT_FILE);
    const generation = this.projectSaveGeneration;
    try {
      const content = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8');
      // This read is only comparable to the marker if no save landed while it was in
      // flight. If one did, `content` predates the marker and would look like an
      // external edit — that save's own watcher event will re-check against fresh state.
      if (this.projectSaveGeneration !== generation) return;
      if (content === this.lastWrittenProjectContent) return;
    } catch { /* unreadable — fall through and let reloadProjectData's own read handle/report it */ }
    this.reloadProjectData();
  }

  private reloadProjectData() {
    // Disk is about to become the source of truth, so the marker — which describes the
    // file we last wrote — must stop matching. Otherwise a later restore of exactly
    // those bytes (git stash pop, undo-and-save, switching back to a branch) looks
    // like our own write and is silently ignored.
    this.lastWrittenProjectContent = undefined;
    this.projectLoadPending = true;
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

  /**
   * Serializes writes to the project file. Several public methods (add/update/remove,
   * folder moves, hidden-schema toggles, ...) each call this independently with no
   * lock between them — without a queue, two overlapping saves' writes could complete
   * out of order, leaving lastWrittenProjectContent out of sync with what's actually
   * on disk and making reloadProjectDataIfChanged() treat the extension's own write
   * as an external edit, wiping secrets (or reverting other changes) for real.
   */
  private saveProjectData(): Promise<void> {
    this.projectSavesInFlight++;
    const run = this.projectSaveQueue.then(() => this.doSaveProjectData());
    // A failed save must not permanently block every save queued after it.
    this.projectSaveQueue = run.catch(() => {}).then(() => { this.projectSavesInFlight--; });
    return run;
  }

  private async doSaveProjectData() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    const projectStates = Array.from(this.connections.values())
      .filter(s => s.config.scope === 'project');
    // Every save records the credentials it is about to strip, and normally starts
    // from scratch so a removed connection doesn't leave its own behind. While a
    // reload is outstanding the set in memory isn't the whole picture — the file
    // hasn't been read back yet, and may stay unreadable indefinitely (deleted,
    // merge-conflicted) — so carry the existing entries over instead: only pruning is
    // deferred, never the recording, or credentials entered in that stretch would
    // reach disk stripped with nothing left remembering them.
    const nextSecrets = this.projectLoadPending ? new Map(this.projectSecrets) : new Map<string, ProjectSecrets>();
    for (const s of projectStates) {
      const secrets = extractProjectSecrets(s.config);
      if (secrets) nextSecrets.set(s.config.id, secrets);
      else nextSecrets.delete(s.config.id);
    }
    this.projectSecrets = nextSecrets;
    const projectConns = projectStates.map(s => stripSecretsForProjectFile(s.config));
    const projectFolders = Array.from(this.folders.values())
      .filter(f => f.scope === 'project');

    if (projectConns.length === 0 && projectFolders.length === 0) return;

    const data: ProjectData = { connections: projectConns, folders: projectFolders };
    const json = JSON.stringify(data, null, 2);
    this.lastWrittenProjectContent = json;
    this.projectSaveGeneration++;
    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, PROJECT_FILE);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(json, 'utf8'));
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

  /** Return a usable driver, reconnecting a disconnected connection when needed. */
  async ensureDriver(connectionId: string, database?: string): Promise<DatabaseDriver> {
    const state = this.connections.get(connectionId);
    if (!state) throw new Error('Connection not found');

    if (!database || state.config.database === database) {
      const driver = this.drivers.get(connectionId);
      if (driver) return driver;

      const inflight = this.primaryDriverLocks.get(connectionId);
      if (inflight) return inflight;

      const reconnect = (async () => {
        await this.connect(connectionId);
        const connectedDriver = this.drivers.get(connectionId);
        if (!connectedDriver) throw new Error('Connection driver unavailable');
        return connectedDriver;
      })();
      this.primaryDriverLocks.set(connectionId, reconnect);
      try {
        return await reconnect;
      } finally {
        if (this.primaryDriverLocks.get(connectionId) === reconnect) {
          this.primaryDriverLocks.delete(connectionId);
        }
      }
    }

    return this.getDriverForDatabase(connectionId, database);
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

  async updateFolder(id: string, updates: Partial<Pick<ConnectionFolder, 'name' | 'color' | 'readonly' | 'sortOrder' | 'agentAnonymization' | 'agentAnonymizationStrategy'>>): Promise<void> {
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

  /** Resolve the effective anonymization policy, walking folder inheritance. */
  getAnonymizationPolicy(id: string): AnonymizationPolicy {
    const state = this.connections.get(id);
    if (!state) return { mode: 'off', strategy: 'hash' };
    return resolveAnonymizationPolicy(state.config, fid => this.folders.get(fid));
  }

  dispose() {
    for (const [id] of this.drivers) {
      this.disconnect(id).catch(() => {});
    }
    this.projectFileWatcher?.dispose();
    this._onDidChange.dispose();
  }
}
