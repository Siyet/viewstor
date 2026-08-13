import { ConnectionManager } from '../connections/connectionManager';
import { CompletionItem as DriverCompletion } from '../types/driver';

const TTL_MS = 60_000;

/**
 * Shared TTL cache for driver-supplied completion items.
 * Used by SqlCompletionProvider and SqlDiagnosticProvider so a single
 * `getCompletions()` call serves both the autocomplete and the
 * diagnostics pass after typing.
 */
export class SchemaCache {
  private cache = new Map<string, DriverCompletion[]>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly cm: ConnectionManager) {}

  async get(connectionId: string, databaseName?: string): Promise<DriverCompletion[]> {
    const key = this.keyFor(connectionId, databaseName);
    const hit = this.cache.get(key);
    if (hit) return hit;

    let driver;
    try {
      driver = databaseName
        ? await this.cm.getDriverForDatabase(connectionId, databaseName)
        : this.cm.getDriver(connectionId);
    } catch {
      return [];
    }
    if (!driver?.getCompletions) return [];

    try {
      const items = await driver.getCompletions();
      this.cache.set(key, items);
      const oldTimer = this.timers.get(key);
      if (oldTimer) clearTimeout(oldTimer);
      this.timers.set(key, setTimeout(() => this.evict(key), TTL_MS));
      return items;
    } catch {
      return [];
    }
  }

  /** Clear one connection's entries (including database-scoped) or all. */
  clear(connectionId?: string): void {
    if (!connectionId) {
      this.cache.clear();
      for (const t of this.timers.values()) clearTimeout(t);
      this.timers.clear();
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key === connectionId || key.startsWith(connectionId + ':')) {
        this.evict(key);
      }
    }
  }

  dispose(): void {
    this.clear();
  }

  private evict(key: string) {
    this.cache.delete(key);
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
  }

  private keyFor(connectionId: string, databaseName?: string): string {
    return databaseName ? `${connectionId}:${databaseName}` : connectionId;
  }
}
