import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConnectionConfig, ConnectionFolder, StandaloneMcpSettings } from '../types/connection';
import { DatabaseDriver } from '../types/driver';
import { createDriver } from '../drivers';
import { AnonymizationPolicy, resolveAnonymizationPolicy } from '../mcp/anonymizer';

const USER_CONFIG_DIR = path.join(os.homedir(), '.viewstor');
const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, 'connections.json');
const PROJECT_CONFIG_FILE = '.vscode/viewstor.json';

interface ConfigData {
  connections: ConnectionConfig[];
  folders?: ConnectionFolder[];
  settings?: StandaloneMcpSettings;
  [key: string]: unknown;
}

export class ConnectionStore {
  private connections = new Map<string, ConnectionConfig>();
  private folders = new Map<string, ConnectionFolder>();
  private drivers = new Map<string, DatabaseDriver>();
  private dbDrivers = new Map<string, DatabaseDriver>();
  private dbDriverLocks = new Map<string, Promise<DatabaseDriver>>();
  private settings: StandaloneMcpSettings = {};

  constructor() {
    this.reload();
  }

  reload() {
    this.connections.clear();
    this.folders.clear();
    this.settings = {};
    // Load user-level config
    this.loadFile(USER_CONFIG_FILE, 'user');

    // Load project-level config
    const projectFile = path.join(process.cwd(), PROJECT_CONFIG_FILE);
    this.loadFile(projectFile, 'project');
  }

  getSettings(): StandaloneMcpSettings {
    return this.settings;
  }

  private loadFile(filePath: string, scope: 'user' | 'project') {
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf8');
      const data: ConfigData = JSON.parse(raw);
      for (const config of data.connections || []) {
        config.scope = scope;
        this.connections.set(config.id, config);
      }
      for (const folder of data.folders || []) {
        folder.scope = scope;
        this.folders.set(folder.id, folder);
      }
      // Security settings are user-owned: a project file must never be able to
      // override an `off` / `restricted` policy chosen in the user config.
      if (scope === 'user' && data.settings) {
        this.settings = { ...data.settings };
      }
    } catch {
      // File doesn't exist or invalid JSON — skip silently
    }
  }

  getFolder(id: string): ConnectionFolder | undefined {
    return this.folders.get(id);
  }

  /** Resolve the effective anonymization policy for a connection. */
  getAnonymizationPolicy(id: string): AnonymizationPolicy {
    const config = this.connections.get(id);
    if (!config) return { mode: 'off', strategy: 'hash' };
    return resolveAnonymizationPolicy(config, fid => this.folders.get(fid));
  }

  getAll(): ConnectionConfig[] {
    return Array.from(this.connections.values());
  }

  get(id: string): ConnectionConfig | undefined {
    return this.connections.get(id);
  }

  getDriver(id: string): DatabaseDriver | undefined {
    return this.drivers.get(id);
  }

  async connect(id: string): Promise<DatabaseDriver> {
    const existing = this.drivers.get(id);
    if (existing) return existing;

    const config = this.connections.get(id);
    if (!config) throw new Error(`Connection "${id}" not found`);

    const driver = createDriver(config.type);
    await driver.connect(config);
    this.drivers.set(id, driver);
    return driver;
  }

  async ensureDriver(id: string): Promise<DatabaseDriver> {
    return this.drivers.get(id) || this.connect(id);
  }

  /**
   * Get a driver for a specific database on the same server as an existing connection.
   * Reuses the connection's host/user/password/ssl to avoid re-entering credentials.
   * If database matches the connection's primary database, returns the primary driver.
   */
  async ensureDriverForDatabase(id: string, database: string): Promise<DatabaseDriver> {
    const config = this.connections.get(id);
    if (!config) throw new Error(`Connection "${id}" not found`);

    if (config.database === database) {
      return this.ensureDriver(id);
    }

    const cacheKey = `${id}:${database}`;
    const cached = this.dbDrivers.get(cacheKey);
    if (cached) {
      try { await cached.ping(); return cached; } catch { this.dbDrivers.delete(cacheKey); }
    }

    const inflight = this.dbDriverLocks.get(cacheKey);
    if (inflight) return inflight;

    const promise = (async () => {
      const driver = createDriver(config.type);
      await driver.connect({ ...config, database });
      this.dbDrivers.set(cacheKey, driver);
      return driver;
    })();
    this.dbDriverLocks.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.dbDriverLocks.delete(cacheKey);
    }
  }

  async add(config: ConnectionConfig): Promise<void> {
    const project = config.scope === 'project';
    const targetFile = project ? path.join(process.cwd(), PROJECT_CONFIG_FILE) : USER_CONFIG_FILE;

    // The process may have been running while VS Code or another MCP client changed
    // the file. Merge into a fresh snapshot instead of serializing our stale Map.
    let existing: ConfigData = { connections: [] };
    if (fs.existsSync(targetFile)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Invalid connection config: ${targetFile}`);
      }
      const data = parsed as Partial<ConfigData>;
      if (data.connections !== undefined && !Array.isArray(data.connections)) {
        throw new Error(`Invalid connections array: ${targetFile}`);
      }
      existing = { ...data, connections: data.connections || [] };
    }

    let persisted = config;
    if (project) {
      const { password, ...withoutPassword } = config;
      persisted = withoutPassword;
    }
    existing.connections = [
      ...existing.connections.filter(item => item.id !== config.id),
      persisted,
    ];

    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, JSON.stringify(existing, null, 2), 'utf8');
    // A failed write must not expose a connection that was never persisted.
    this.connections.set(config.id, config);
  }

  async disconnectAll() {
    for (const [id, driver] of this.drivers) {
      try {
        await driver.disconnect();
      } catch {
        // Ignore disconnect errors during cleanup
      }
      this.drivers.delete(id);
    }
    for (const [key, driver] of this.dbDrivers) {
      try {
        await driver.disconnect();
      } catch {
        // Ignore disconnect errors during cleanup
      }
      this.dbDrivers.delete(key);
    }
  }
}
