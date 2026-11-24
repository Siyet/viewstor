import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ConnectionConfig, DatabaseType } from '../types/connection';
import type { ConnectionStore, StandaloneMcpSettings } from './connectionStore';

export type AddConnectionMode = NonNullable<StandaloneMcpSettings['allowAddConnection']>;

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
  outcome: 'disabled' | 'resolved';
  config?: ReturnType<typeof connectionConfigForAudit>;
}

export function resolveAddConnectionMode(value: unknown): AddConnectionMode {
  return value === 'off' || value === 'restricted' || value === 'unrestricted'
    ? value
    : 'restricted';
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
  if (mode === 'off') {
    await appendAddConnectionAudit({
      timestamp: new Date().toISOString(),
      tool: 'add_connection',
      mode,
      outcome: 'disabled',
    });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'Tool disabled. Configure allowAddConnection in ~/.viewstor/connections.json settings.',
          kind: 'tool_disabled',
        }),
      }],
      isError: true,
    };
  }

  const input = args as AddConnectionInput;
  const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  const { config, warnings } = resolveAddConnection(input, mode, id);

  // Write the resolved, secret-free record before persisting the connection. If the
  // audit log is unavailable, fail the call instead of creating an unaudited handle.
  await appendAddConnectionAudit({
    timestamp: new Date().toISOString(),
    tool: 'add_connection',
    mode,
    outcome: 'resolved',
    config: connectionConfigForAudit(config),
  });
  await store.add(config);

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
