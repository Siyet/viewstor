import { describe, it, expect } from 'vitest';
import { resolveAgentAccess, isAgentOpAllowed } from '../mcp/agentAccess';
import { ConnectionConfig, ConnectionFolder } from '../types/connection';

function folder(id: string, agentAccess?: ConnectionFolder['agentAccess'], parentFolderId?: string): ConnectionFolder {
  return { id, name: id, sortOrder: 0, agentAccess, parentFolderId };
}

function conn(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'c1',
    name: 'C1',
    type: 'postgresql',
    host: 'localhost',
    port: 5432,
    ...over,
  };
}

describe('resolveAgentAccess', () => {
  it('returns the connection\'s own agentAccess when set', () => {
    expect(resolveAgentAccess(conn({ agentAccess: 'schema-only' }), () => undefined)).toBe('schema-only');
  });

  it('returns the default when no connection, folder, or override applies', () => {
    expect(resolveAgentAccess(conn(), () => undefined)).toBe('full');
    expect(resolveAgentAccess(conn(), () => undefined, 'schema-only')).toBe('schema-only');
  });

  it('inherits from direct folder when connection has no override', () => {
    const folders = new Map([['f1', folder('f1', 'none')]]);
    const mode = resolveAgentAccess(conn({ folderId: 'f1' }), (id) => folders.get(id));
    expect(mode).toBe('none');
  });

  it('walks up the folder chain via parentFolderId', () => {
    // Grandparent restricts, parent + connection don't override → grandparent wins.
    const folders = new Map([
      ['grand', folder('grand', 'schema-only')],
      ['parent', folder('parent', undefined, 'grand')],
    ]);
    const mode = resolveAgentAccess(conn({ folderId: 'parent' }), (id) => folders.get(id));
    expect(mode).toBe('schema-only');
  });

  it('nearest ancestor wins over further ancestors', () => {
    const folders = new Map([
      ['grand', folder('grand', 'none')],
      ['parent', folder('parent', 'schema-only', 'grand')],
    ]);
    const mode = resolveAgentAccess(conn({ folderId: 'parent' }), (id) => folders.get(id));
    expect(mode).toBe('schema-only');
  });

  it('connection override wins over folder chain', () => {
    const folders = new Map([['f1', folder('f1', 'none')]]);
    const mode = resolveAgentAccess(conn({ folderId: 'f1', agentAccess: 'full' }), (id) => folders.get(id));
    expect(mode).toBe('full');
  });

  it('handles cycles in folder chain without infinite loop', () => {
    // f1.parent=f2, f2.parent=f1 — pathological, but must not hang.
    const folders = new Map([
      ['f1', folder('f1', undefined, 'f2')],
      ['f2', folder('f2', undefined, 'f1')],
    ]);
    const mode = resolveAgentAccess(conn({ folderId: 'f1' }), (id) => folders.get(id), 'schema-only');
    expect(mode).toBe('schema-only');
  });

  it('handles missing folder refs gracefully', () => {
    const mode = resolveAgentAccess(conn({ folderId: 'ghost' }), () => undefined);
    expect(mode).toBe('full');
  });
});

describe('isAgentOpAllowed', () => {
  it('full mode allows everything', () => {
    for (const op of ['list', 'schema-read', 'data-read', 'ui-open'] as const) {
      expect(isAgentOpAllowed('full', op)).toBe(true);
    }
  });

  it('schema-only mode allows only list + schema-read', () => {
    expect(isAgentOpAllowed('schema-only', 'list')).toBe(true);
    expect(isAgentOpAllowed('schema-only', 'schema-read')).toBe(true);
    expect(isAgentOpAllowed('schema-only', 'data-read')).toBe(false);
    expect(isAgentOpAllowed('schema-only', 'ui-open')).toBe(false);
  });

  it('none mode blocks all operations', () => {
    for (const op of ['list', 'schema-read', 'data-read', 'ui-open'] as const) {
      expect(isAgentOpAllowed('none', op)).toBe(false);
    }
  });
});
