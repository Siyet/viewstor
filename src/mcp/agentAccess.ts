import { AgentAccessMode, ConnectionConfig, ConnectionFolder } from '../types/connection';

/**
 * The set of operations an AI agent can request against a connection.
 * Grouped so the gate logic below stays readable and trivially testable.
 */
export type AgentOp =
  | 'list'           // enumerate connection metadata
  | 'schema-read'    // getSchema / getTableInfo
  | 'data-read'      // executeQuery / getTableData / visualize / exportGrafana
  | 'ui-open';       // openQuery / openTableData (editor surfaces)

/**
 * Resolve the effective `agentAccess` for a connection:
 *   1. The connection's own `agentAccess` (if set)
 *   2. Walk up the folder chain via `parentFolderId` until an `agentAccess` is found
 *   3. Fall back to `defaultMode`
 *
 * `getFolder` lets callers plug in their own storage (Map lookup, JSON, etc.).
 * The folder walk is cycle-guarded.
 */
export function resolveAgentAccess(
  config: Pick<ConnectionConfig, 'agentAccess' | 'folderId'>,
  getFolder: (id: string) => ConnectionFolder | undefined,
  defaultMode: AgentAccessMode = 'full',
): AgentAccessMode {
  if (config.agentAccess) return config.agentAccess;

  const visited = new Set<string>();
  let folderId: string | undefined = config.folderId;
  while (folderId && !visited.has(folderId)) {
    visited.add(folderId);
    const folder = getFolder(folderId);
    if (!folder) break;
    if (folder.agentAccess) return folder.agentAccess;
    folderId = folder.parentFolderId;
  }
  return defaultMode;
}

/**
 * Returns `true` iff `mode` permits the given agent operation.
 *
 *   full        → everything allowed
 *   schema-only → list + schema-read only
 *   none        → nothing allowed (connection invisible to agents)
 */
export function isAgentOpAllowed(mode: AgentAccessMode, op: AgentOp): boolean {
  switch (mode) {
    case 'full':
      return true;
    case 'schema-only':
      return op === 'list' || op === 'schema-read';
    case 'none':
      return false;
  }
}
