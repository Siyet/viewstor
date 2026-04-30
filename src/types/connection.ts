export type DatabaseType = 'postgresql' | 'redis' | 'clickhouse' | 'sqlite';

export interface ConnectionConfig {
  id: string;
  name: string;
  type: DatabaseType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  options?: Record<string, string>;
  folderId?: string;
  color?: string;
  readonly?: boolean;
  /** Multiple databases to connect to (PG/CH). If empty, uses `database` field. */
  databases?: string[];
  /** Hidden schemas per database: { "mydb": ["pg_catalog", "information_schema"] } */
  hiddenSchemas?: Record<string, string[]>;
  /** Hidden databases (by name) */
  hiddenDatabases?: string[];
  /** Storage scope: 'user' (globalState) or 'project' (.vscode/viewstor.json) */
  scope?: 'user' | 'project';
  /** Safe mode override per connection: 'off' | 'warn' | 'block' */
  safeMode?: 'off' | 'warn' | 'block';
  /** Proxy/tunnel configuration */
  proxy?: ProxyConfig;
  /**
   * Mask PII in rows returned via the MCP boundary (agent-facing tools).
   * `off` — no masking. `heuristic` — mask by column-name patterns.
   * `strict` — mask all text-like columns. Inherited from folder when unset.
   */
  agentAnonymization?: 'off' | 'heuristic' | 'strict';
  /** How masked cells are transformed. Inherited from folder when unset. */
  agentAnonymizationStrategy?: 'hash' | 'shape' | 'null' | 'redacted';
  /** Connection was created by an agent via the MCP `add_connection` tool. */
  agentCreated?: boolean;
}

export type ProxyType = 'none' | 'ssh' | 'socks5' | 'http';

export interface ProxyConfig {
  type: ProxyType;
  /** SSH tunnel */
  sshHost?: string;
  sshPort?: number;
  sshUsername?: string;
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
  /** SOCKS5 / HTTP proxy */
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
}

export interface ConnectionFolder {
  id: string;
  name: string;
  color?: string;
  readonly?: boolean;
  sortOrder: number;
  parentFolderId?: string;
  scope?: 'user' | 'project';
  /** Default anonymization policy for connections in this folder (unless overridden). */
  agentAnonymization?: 'off' | 'heuristic' | 'strict';
  /** Default anonymization strategy for connections in this folder (unless overridden). */
  agentAnonymizationStrategy?: 'hash' | 'shape' | 'null' | 'redacted';
}

export interface ConnectionState {
  config: ConnectionConfig;
  connected: boolean;
}

export const DEFAULT_PORTS: Record<DatabaseType, number> = {
  postgresql: 5432,
  redis: 6379,
  clickhouse: 8123,
  sqlite: 0,
};
