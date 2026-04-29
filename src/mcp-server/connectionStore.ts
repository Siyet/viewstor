import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConnectionConfig } from '../types/connection';
import { DatabaseDriver } from '../types/driver';
import { createDriver } from '../drivers';

const USER_CONFIG_DIR = path.join(os.homedir(), '.viewstor');
const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, 'connections.json');
const USER_SETTINGS_FILE = path.join(USER_CONFIG_DIR, 'settings.json');
const AUDIT_LOG_FILE = path.join(USER_CONFIG_DIR, 'audit.log');
const PROJECT_CONFIG_FILE = '.vscode/viewstor.json';

export type AddConnectionMode = 'off' | 'restricted' | 'unrestricted';

interface ConfigData {
  connections: ConnectionConfig[];
  folders?: unknown[];
}

export class ConnectionStore {
  private connections = new Map<string, ConnectionConfig>();
  private drivers = new Map<string, DatabaseDriver>();
  private dbDrivers = new Map<string, DatabaseDriver>();
  private dbDriverLocks = new Map<string, Promise<DatabaseDriver>>();

  constructor() {
    this.reload();
  }

  reload() {
    this.connections.clear();
    // Load user-level config
    this.loadFile(USER_CONFIG_FILE, 'user');

    // Load project-level config
    const projectFile = path.join(process.cwd(), PROJECT_CONFIG_FILE);
    this.loadFile(projectFile, 'project');
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
    } catch {
      // File doesn't exist or invalid JSON — skip silently
    }
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
    this.connections.set(config.id, config);
    if (config.scope === 'project') {
      await this.saveProjectConfig();
    } else {
      await this.saveUserConfig();
    }
  }

  private async saveUserConfig() {
    const userConfigs = Array.from(this.connections.values())
      .filter(c => c.scope !== 'project');

    if (!fs.existsSync(USER_CONFIG_DIR)) {
      fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
    }

    const data: ConfigData = { connections: userConfigs };
    fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  }

  private async saveProjectConfig() {
    const projectConfigs = Array.from(this.connections.values())
      .filter(c => c.scope === 'project')
      .map(c => ({ ...c, password: undefined }));

    const projectDir = path.join(process.cwd(), '.vscode');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    const projectFile = path.join(process.cwd(), PROJECT_CONFIG_FILE);
    let existing: ConfigData = { connections: [] };
    try {
      if (fs.existsSync(projectFile)) {
        existing = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      }
    } catch { /* ignore */ }

    const merged = new Map(
      (existing.connections || []).map(c => [c.id, c] as const),
    );
    for (const c of projectConfigs) {
      merged.set(c.id, c);
    }

    const data: ConfigData = {
      connections: Array.from(merged.values()),
      folders: existing.folders,
    };
    fs.writeFileSync(projectFile, JSON.stringify(data, null, 2), 'utf8');
  }

  getAddConnectionMode(): AddConnectionMode {
    const envVal = process.env['VIEWSTOR_MCP_ADD_CONNECTION'];
    if (envVal === 'off' || envVal === 'restricted' || envVal === 'unrestricted') {
      return envVal;
    }
    try {
      if (fs.existsSync(USER_SETTINGS_FILE)) {
        const settings = JSON.parse(fs.readFileSync(USER_SETTINGS_FILE, 'utf8'));
        const val = settings['standaloneMcp.allowAddConnection'];
        if (val === 'off' || val === 'restricted' || val === 'unrestricted') {
          return val;
        }
      }
    } catch { /* ignore */ }
    return 'restricted';
  }

  writeAuditEntry(entry: { action: string; mode: AddConnectionMode; config: Record<string, unknown> }) {
    try {
      if (!fs.existsSync(USER_CONFIG_DIR)) {
        fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
      }
      const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
      fs.appendFileSync(AUDIT_LOG_FILE, line, 'utf8');
    } catch { /* best-effort */ }
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
