import { ConnectionConfig, DatabaseType, DEFAULT_PORTS } from '../types/connection';

export type ImportSource = 'dbeaver' | 'datagrip' | 'pgadmin';

export interface ImportResult {
  connections: ConnectionConfig[];
  warnings: string[];
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// --- DBeaver: data-sources.json ---

interface DBeaverDataSources {
  connections?: Record<string, DBeaverConnection>;
}

interface DBeaverConnection {
  provider?: string;
  driver?: string;
  name?: string;
  'save-password'?: boolean;
  'read-only'?: boolean;
  configuration?: {
    host?: string;
    port?: string;
    database?: string;
    url?: string;
    properties?: Record<string, string>;
    'auth-model'?: string;
    user?: string;
  };
}

export function parseDBeaver(content: string): ImportResult {
  const warnings: string[] = [];
  const connections: ConnectionConfig[] = [];

  let data: DBeaverDataSources;
  try {
    data = JSON.parse(content);
  } catch {
    return { connections: [], warnings: ['Invalid JSON in DBeaver data-sources file.'] };
  }

  if (!data.connections) {
    return { connections: [], warnings: ['No connections found in DBeaver file.'] };
  }

  for (const [key, conn] of Object.entries(data.connections)) {
    const dbType = mapDBeaverProvider(conn.provider, conn.driver);
    if (!dbType) {
      warnings.push(`Skipped "${conn.name || key}": unsupported provider "${conn.provider}".`);
      continue;
    }

    const cfg = conn.configuration || {};
    const host = cfg.host || parseJdbcHost(cfg.url) || 'localhost';
    const port = parseInt(cfg.port || '', 10) || parseJdbcPort(cfg.url) || DEFAULT_PORTS[dbType];
    const database = cfg.database || parseJdbcDatabase(cfg.url) || undefined;
    const username = cfg.user || cfg.properties?.user || undefined;

    connections.push({
      id: generateId(),
      name: conn.name || key,
      type: dbType,
      host,
      port,
      username,
      database,
      readonly: conn['read-only'] || undefined,
    });
  }

  return { connections, warnings };
}

function mapDBeaverProvider(provider?: string, driver?: string): DatabaseType | null {
  const p = (provider || driver || '').toLowerCase();
  if (p.includes('postgres')) return 'postgresql';
  if (p.includes('redis') || p.includes('iredis')) return 'redis';
  if (p.includes('clickhouse')) return 'clickhouse';
  if (p.includes('sqlite')) return 'sqlite';
  if (p.includes('sqlserver') || p.includes('mssql')) return 'mssql';
  return null;
}

// --- DataGrip: dataSources.xml ---

export function parseDataGrip(content: string): ImportResult {
  const warnings: string[] = [];
  const connections: ConnectionConfig[] = [];

  // Simple XML parsing without external dependency
  const dataSourceRegex = /<data-source[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/data-source>/g;
  let match: RegExpExecArray | null;

  while ((match = dataSourceRegex.exec(content)) !== null) {
    const name = match[1];
    const body = match[2];

    const driverRef = extractXmlValue(body, 'driver-ref');
    const jdbcUrl = extractXmlValue(body, 'jdbc-url');

    const dbType = mapDataGripDriver(driverRef);
    if (!dbType) {
      warnings.push(`Skipped "${name}": unsupported driver "${driverRef}".`);
      continue;
    }

    const host = parseJdbcHost(jdbcUrl) || 'localhost';
    const port = parseJdbcPort(jdbcUrl) || DEFAULT_PORTS[dbType];
    const database = parseJdbcDatabase(jdbcUrl) || undefined;
    const username = extractXmlValue(body, 'user-name') || undefined;
    const ssl = jdbcUrl?.includes('ssl=true') || jdbcUrl?.includes('sslmode=') || false;

    connections.push({
      id: generateId(),
      name,
      type: dbType,
      host,
      port,
      username,
      database,
      ssl: ssl || undefined,
    });
  }

  if (connections.length === 0 && warnings.length === 0) {
    warnings.push('No data sources found in DataGrip XML file.');
  }

  return { connections, warnings };
}

function extractXmlValue(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`);
  const m = xml.match(regex);
  return m ? m[1].trim() : undefined;
}

function mapDataGripDriver(driver?: string): DatabaseType | null {
  const d = (driver || '').toLowerCase();
  if (d.includes('postgres')) return 'postgresql';
  if (d.includes('redis')) return 'redis';
  if (d.includes('clickhouse')) return 'clickhouse';
  if (d.includes('sqlite')) return 'sqlite';
  if (d.includes('sqlserver') || d.includes('mssql')) return 'mssql';
  return null;
}

// --- pgAdmin: servers.json ---

interface PgAdminServers {
  Servers?: Record<string, PgAdminServer>;
}

interface PgAdminServer {
  Name?: string;
  Group?: string;
  Host?: string;
  HostAddr?: string;
  Port?: number;
  Username?: string;
  MaintenanceDB?: string;
  SSLMode?: string;
  DBRestriction?: string;
  Comment?: string;
}

export function parsePgAdmin(content: string): ImportResult {
  const warnings: string[] = [];
  const connections: ConnectionConfig[] = [];

  let data: PgAdminServers;
  try {
    data = JSON.parse(content);
  } catch {
    return { connections: [], warnings: ['Invalid JSON in pgAdmin servers file.'] };
  }

  if (!data.Servers) {
    return { connections: [], warnings: ['No servers found in pgAdmin file.'] };
  }

  for (const [key, srv] of Object.entries(data.Servers)) {
    const host = srv.Host || srv.HostAddr || 'localhost';
    const port = srv.Port || 5432;
    const ssl = srv.SSLMode && srv.SSLMode !== 'disable' && srv.SSLMode !== 'prefer';

    connections.push({
      id: generateId(),
      name: srv.Name || `pgAdmin Server ${key}`,
      type: 'postgresql',
      host,
      port,
      username: srv.Username || undefined,
      database: srv.MaintenanceDB || srv.DBRestriction || undefined,
      ssl: ssl || undefined,
    });
  }

  return { connections, warnings };
}

// --- JDBC URL parsing helpers ---

function parseJdbcHost(url?: string): string | undefined {
  if (!url) return undefined;
  // jdbc:postgresql://host:port/db or host:port/db
  const m = url.match(/:\/\/([^:/]+)/);
  return m ? m[1] : undefined;
}

function parseJdbcPort(url?: string): number | undefined {
  if (!url) return undefined;
  const m = url.match(/:\/\/[^:/]+:(\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}

function parseJdbcDatabase(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/:\/\/[^/]+\/([^?;&]+)/);
  return m ? m[1] : undefined;
}

// --- Main import dispatcher ---

export function parseImportFile(source: ImportSource, content: string): ImportResult {
  switch (source) {
    case 'dbeaver': return parseDBeaver(content);
    case 'datagrip': return parseDataGrip(content);
    case 'pgadmin': return parsePgAdmin(content);
  }
}
