/**
 * Unit tests for ConnectionTreeProvider caching and refresh behavior.
 * Verifies that hideSchema/hideDatabase does not trigger connect() on unrelated connections.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock vscode module before imports
vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    collapsibleState: number;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(public id: string, public color?: unknown) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  EventEmitter: class {
    private listeners: Array<(...args: unknown[]) => void> = [];
    event = (listener: (...args: unknown[]) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(...args: unknown[]) {
      for (const listener of this.listeners) listener(...args);
    }
    dispose() {}
  },
  DataTransferItem: class {
    constructor(public value: unknown) {}
  },
  DataTransfer: class {
    private items = new Map<string, unknown>();
    set(mime: string, item: unknown) { this.items.set(mime, item); }
    get(mime: string) { return this.items.get(mime); }
  },
  l10n: { t: (str: string, ...args: unknown[]) => str.replace(/\{(\d+)\}/g, (_, idx) => String(args[Number(idx)])) },
}));

import { ConnectionTreeProvider } from '../views/connectionTree';

// Minimal mock of ConnectionManager
function createMockConnectionManager(connections: Map<string, { config: Record<string, unknown>; connected: boolean }>) {
  const onDidChangeListeners: Array<() => void> = [];
  let connectCallCount = 0;
  const connectCalledFor: string[] = [];

  return {
    onDidChange: (listener: () => void) => {
      onDidChangeListeners.push(listener);
      return { dispose: () => {} };
    },
    fireChange: () => onDidChangeListeners.forEach((listener) => listener()),
    get: (id: string) => connections.get(id),
    getAll: () => [...connections.values()].map((state) => state),
    getDriver: (id: string) => {
      const state = connections.get(id);
      if (!state?.connected) return undefined;
      return {
        getSchema: async () => [
          { name: 'public', type: 'schema', children: [
            { name: 'users', type: 'table', children: [] },
          ] },
        ],
      };
    },
    connect: async (id: string) => {
      connectCallCount++;
      connectCalledFor.push(id);
      const state = connections.get(id);
      if (state) state.connected = true;
    },
    getConnectionColor: () => undefined,
    isConnectionReadonly: () => false,
    getAllFolders: () => [],
    getFolder: () => undefined,
    // Test helpers
    getConnectCallCount: () => connectCallCount,
    getConnectCalledFor: () => connectCalledFor,
    resetConnectCalls: () => { connectCallCount = 0; connectCalledFor.length = 0; },
  };
}

describe('ConnectionTreeProvider — schema cache prevents reconnect', () => {
  it('getChildren does not auto-connect when schema is cached for disconnected connection', async () => {
    const connections = new Map([
      ['conn-a', { config: { id: 'conn-a', name: 'A', type: 'postgresql', host: 'a', port: 5432 }, connected: true }],
      ['conn-b', { config: { id: 'conn-b', name: 'B', type: 'postgresql', host: 'b', port: 5432 }, connected: false }],
    ]);
    const mgr = createMockConnectionManager(connections);
    const provider = new ConnectionTreeProvider(mgr as never);

    // First call: conn-a is connected, should fetch schema and cache it
    const connAItem = { connectionId: 'conn-a', itemType: 'connection' } as never;
    const childrenA = await provider.getChildren(connAItem);
    expect(childrenA.length).toBeGreaterThan(0);
    expect(mgr.getConnectCallCount()).toBe(0); // Was already connected

    // Simulate disconnect of conn-a (e.g. network issue)
    connections.get('conn-a')!.connected = false;
    mgr.resetConnectCalls();

    // Second call: conn-a is disconnected but schema is cached — should NOT connect
    const childrenA2 = await provider.getChildren(connAItem);
    expect(childrenA2.length).toBeGreaterThan(0); // Still has children from cache
    expect(mgr.getConnectCallCount()).toBe(0); // No connect call!
  });

  it('getChildren auto-connects when no cache exists for disconnected connection', async () => {
    const connections = new Map([
      ['conn-new', { config: { id: 'conn-new', name: 'New', type: 'postgresql', host: 'x', port: 5432 }, connected: false }],
    ]);
    const mgr = createMockConnectionManager(connections);
    const provider = new ConnectionTreeProvider(mgr as never);

    // First call: conn-new is disconnected, no cache — should auto-connect
    const connItem = { connectionId: 'conn-new', itemType: 'connection' } as never;
    await provider.getChildren(connItem);
    expect(mgr.getConnectCallCount()).toBe(1);
    expect(mgr.getConnectCalledFor()).toEqual(['conn-new']);
  });

  it('refresh after hideSchema does not trigger connect on other connections', async () => {
    const connections = new Map([
      ['conn-active', { config: { id: 'conn-active', name: 'Active', type: 'postgresql', host: 'a', port: 5432 }, connected: true }],
      ['conn-dead', { config: { id: 'conn-dead', name: 'Dead', type: 'postgresql', host: 'b', port: 5432 }, connected: false }],
    ]);
    const mgr = createMockConnectionManager(connections);
    const provider = new ConnectionTreeProvider(mgr as never);

    // Expand conn-active to populate cache
    const activeItem = { connectionId: 'conn-active', itemType: 'connection' } as never;
    await provider.getChildren(activeItem);

    // Simulate conn-active disconnecting
    connections.get('conn-active')!.connected = false;
    mgr.resetConnectCalls();

    // Simulate hideSchema → triggers refresh()
    provider.refresh();

    // Now getChildren would be called for all expanded nodes.
    // conn-active has cache → no connect. conn-dead has no cache but is not expanded.
    const childrenAfter = await provider.getChildren(activeItem);
    expect(childrenAfter.length).toBeGreaterThan(0);
    expect(mgr.getConnectCallCount()).toBe(0); // Key assertion: no connect!
  });
});
