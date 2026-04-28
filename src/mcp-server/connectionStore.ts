import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConnectionConfig } from '../types/connection';
import { DatabaseDriver } from '../types/driver';
import { createDriver } from '../drivers';

const USER_CONFIG_DIR = path.join(os.homedir(), '.viewstor');
const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, 'connections.json');
const PROJECT_CONFIG_FILE = '.vscode/viewstor.json';

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
    await this.saveUserConfig();
  }

  async addProjectScoped(config: ConnectionConfig): Promise<void> {
    config.scope = 'project';
    const { password: _, ...safe } = config as ConnectionConfig & { password?: string };
    this.connections.set(config.id, config);
    const projectFile = path.join(process.cwd(), PROJECT_CONFIG_FILE);
    let data: ConfigData = { connections: [] };
    try {
      if (fs.existsSync(projectFile)) {
        data = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      }
    } catch {
      // Start fresh if unreadable
    }
    const existing = (data.connections || []).filter(c => c.id !== safe.id);
    existing.push(safe);
    data.connections = existing;
    const dir = path.dirname(projectFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(projectFile, JSON.stringify(data, null, 2), 'utf8');
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
