import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_PORTS, type ConnectionConfig, type DatabaseType, type StandaloneMcpSettings } from '../types/connection';
import type { ConnectionStore } from './connectionStore';

export type AddConnectionMode = NonNullable<StandaloneMcpSettings['allowAddConnection']>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export const ADD_CONNECTION_TOOL: ToolDef = {
  name: 'add_connection',
  description: 'Add a new database connection. For SQLite: set type="sqlite", database="/path/to/file.db" (or ":memory:"), host and port are ignored.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Display name' },
      type: { type: 'string', enum: ['postgresql', 'redis', 'clickhouse', 'sqlite'], description: 'Database type' },
      host: { type: 'string', description: 'Host (ignored for SQLite)' },
      port: { type: 'number', description: 'Port (ignored for SQLite)' },
      username: { type: 'string', description: 'Username' },
      password: { type: 'string', description: 'Password' },
      database: { type: 'string', description: 'Database name, or file path for SQLite (e.g. "/tmp/test.db", ":memory:")' },
      ssl: { type: 'boolean', description: 'Use SSL' },
      readonly: { type: 'boolean', description: 'Read-only mode' },
    },
    required: ['name', 'type'],
  },
};

export interface AddConnectionInput {
  name: string;
  type: DatabaseType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  readonly?: boolean;
}

export interface AddConnectionWarning {
  kind: 'readonly_forced' | 'agent_created_writeable_connection';
  message: string;
}

export interface AddConnectionAuditEntry {
  timestamp: string;
  tool: 'add_connection';
  mode: AddConnectionMode;
  outcome: 'disabled' | 'rejected' | 'resolved' | 'persist_failed';
  config?: ReturnType<typeof connectionConfigForAudit>;
}

export function resolveAddConnectionMode(value: unknown): AddConnectionMode {
  return value === 'off' || value === 'restricted' || value === 'unrestricted'
    ? value
    : 'restricted';
}

export function toolDefinitionsForMode(tools: ToolDef[], mode: AddConnectionMode): ToolDef[] {
  return mode === 'off' ? tools : [...tools, ADD_CONNECTION_TOOL];
}

export function resolveAddConnection(
  input: AddConnectionInput,
  mode: Exclude<AddConnectionMode, 'off'>,
  id: string,
): { config: ConnectionConfig; warnings: AddConnectionWarning[] } {
  const warnings: AddConnectionWarning[] = [];
  // Allowlist tool fields instead of spreading runtime input: MCP callers must not
  // smuggle extra ConnectionConfig fields (proxy secrets, scope, flags) past the gate.
  const baseConfig: ConnectionConfig = {
    id,
    name: input.name,
    type: input.type,
    host: input.host,
    port: input.port,
    username: input.username,
    password: input.password,
    database: input.database,
    ssl: input.ssl,
  };

  if (mode === 'restricted') {
    if (input.readonly === false) {
      warnings.push({
        kind: 'readonly_forced',
        message: 'readonly: false was ignored; agent-created connections are always read-only in restricted mode.',
      });
    }
    return {
      config: {
        ...baseConfig,
        name: input.name.startsWith('[agent] ') ? input.name : `[agent] ${input.name}`,
        readonly: true,
        scope: 'project',
        agentCreated: true,
      },
      warnings,
    };
  }

  warnings.push({
    kind: 'agent_created_writeable_connection',
    message: 'Connection created with unrestricted agent access.',
  });
  return {
    config: { ...baseConfig, readonly: input.readonly, agentCreated: true },
    warnings,
  };
}

export async function handleAddConnection(store: ConnectionStore, args: unknown) {
  const mode = resolveAddConnectionMode(store.getSettings().allowAddConnection);
  const auditBase = { timestamp: new Date().toISOString(), tool: 'add_connection' as const, mode };
  if (mode === 'off') {
    await appendAddConnectionAudit({ ...auditBase, outcome: 'disabled' });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'Tool disabled',
          kind: 'tool_disabled',
          message: 'Configure allowAddConnection in ~/.viewstor/connections.json settings.',
        }),
      }],
      isError: true,
    };
  }

  let input: AddConnectionInput;
  try {
    input = parseAddConnectionInput(args);
  } catch (err) {
    await appendAddConnectionAudit({ ...auditBase, outcome: 'rejected' });
    return errorResponse(
      'Invalid connection configuration',
      'invalid_config',
      err instanceof Error ? err.message : 'Invalid arguments',
    );
  }

  const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  const { config, warnings } = resolveAddConnection(input, mode, id);
  const auditConfig = connectionConfigForAudit(config);

  // Write the resolved, secret-free record before persisting the connection. If the
  // audit log is unavailable, fail the call instead of creating an unaudited handle.
  await appendAddConnectionAudit({ ...auditBase, outcome: 'resolved', config: auditConfig });
  try {
    await store.add(config);
  } catch (err) {
    await appendAddConnectionAudit({
      ...auditBase,
      timestamp: new Date().toISOString(),
      outcome: 'persist_failed',
      config: auditConfig,
    });
    throw err;
  }

  return jsonResponse({
    id,
    name: config.name,
    type: config.type,
    host: config.host,
    port: config.port,
    database: config.database,
    message: mode === 'restricted'
      ? 'Connection added (restricted mode: read-only, project-scoped)'
      : 'Connection added',
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

function parseAddConnectionInput(args: unknown): AddConnectionInput {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Arguments must be an object');
  }
  const value = args as Record<string, unknown>;
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error('name must be a non-empty string');
  }
  if (!['postgresql', 'redis', 'clickhouse', 'sqlite'].includes(String(value.type))) {
    throw new Error('type must be postgresql, redis, clickhouse, or sqlite');
  }
  for (const key of ['username', 'password', 'database'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Error(`${key} must be a string`);
    }
  }
  if (value.host !== undefined && typeof value.host !== 'string') {
    throw new Error('host must be a string');
  }
  if (value.port !== undefined && (typeof value.port !== 'number' || !Number.isFinite(value.port))) {
    throw new Error('port must be a finite number');
  }
  for (const key of ['ssl', 'readonly'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new Error(`${key} must be a boolean`);
    }
  }

  const type = value.type as DatabaseType;
  return {
    name: value.name,
    type,
    host: (value.host as string | undefined) ?? (type === 'sqlite' ? '' : 'localhost'),
    port: (value.port as number | undefined) ?? DEFAULT_PORTS[type],
    username: value.username as string | undefined,
    password: value.password as string | undefined,
    database: value.database as string | undefined,
    ssl: value.ssl as boolean | undefined,
    readonly: value.readonly as boolean | undefined,
  };
}

export function connectionConfigForAudit(config: ConnectionConfig) {
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    host: config.host,
    port: config.port,
    username: config.username,
    database: config.database,
    ssl: config.ssl,
    readonly: config.readonly,
    scope: config.scope,
    agentCreated: config.agentCreated,
  };
}

export async function appendAddConnectionAudit(
  entry: AddConnectionAuditEntry,
  filePath = path.join(os.homedir(), '.viewstor', 'audit.jsonl'),
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.promises.appendFile(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function jsonResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResponse(error: string, kind: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error, kind, message }) }],
    isError: true,
  };
}
