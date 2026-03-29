export type DatabaseType = 'postgresql' | 'redis' | 'clickhouse';

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
}

export interface ConnectionFolder {
  id: string;
  name: string;
  color?: string;
  readonly?: boolean;
  sortOrder: number;
  parentFolderId?: string;
  scope?: 'user' | 'project';
}

export interface ConnectionState {
  config: ConnectionConfig;
  connected: boolean;
}

export const DEFAULT_PORTS: Record<DatabaseType, number> = {
  postgresql: 5432,
  redis: 6379,
  clickhouse: 8123,
};
