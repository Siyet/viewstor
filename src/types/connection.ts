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
  /**
   * Agent write-approval policy for MCP tools. Controls how queries sent
   * through the in-process or standalone MCP servers are gated.
   *
   * - `always`: every non-SELECT requires human confirmation (default on new
   *   connections; safest).
   * - `ddl-and-admin`: INSERT/UPDATE/DELETE run without prompt, but
   *   CREATE/ALTER/DROP/TRUNCATE/GRANT/etc. still prompt.
   * - `never`: no prompts (effectively the pre-0.3.3 behavior).
   *
   * The standalone MCP server cannot display a modal; it refuses writes
   * unless this value is `'never'`. See #75.
   */
  agentWriteApproval?: 'always' | 'ddl-and-admin' | 'never';
  /** Proxy/tunnel configuration */
  proxy?: ProxyConfig;
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
  /** Inherited by contained connections when they don't override. See ConnectionConfig.agentWriteApproval. */
  agentWriteApproval?: 'always' | 'ddl-and-admin' | 'never';
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
