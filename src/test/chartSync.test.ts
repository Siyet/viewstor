/**
 * Tests for chart panel sync mechanism, server-side query execution,
 * and full data mode. Uses mocked vscode and ConnectionManager.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createWebviewPanel: () => ({
      webview: {
        html: '',
        asWebviewUri: (uri: unknown) => uri,
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: vi.fn(),
      },
      onDidDispose: () => ({ dispose: () => {} }),
      reveal: vi.fn(),
      dispose: vi.fn(),
    }),
    withProgress: async (_opts: unknown, task: () => Promise<unknown>) => task(),
    showSaveDialog: async () => undefined,
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  ViewColumn: { Beside: 2 },
  Uri: {
    file: (p: string) => ({ fsPath: p }),
    joinPath: (...parts: unknown[]) => parts.join('/'),
  },
  workspace: {
    getConfiguration: () => ({ get: () => '' }),
    fs: { writeFile: async () => {} },
  },
  env: { clipboard: { writeText: async () => {} } },
  l10n: { t: (str: string, ...args: unknown[]) => str.replace(/\{(\d+)\}/g, (_, idx: string) => String(args[Number(idx)])) },
  ProgressLocation: { Notification: 1 },
  Disposable: class { constructor(public fn: () => void) {} dispose() { this.fn(); } },
  ThemeIcon: class { constructor(public id: string) {} },
  EventEmitter: class {
    private listeners: Array<(...args: unknown[]) => void> = [];
    event = (listener: (...args: unknown[]) => void) => { this.listeners.push(listener); return { dispose: () => {} }; };
    fire(...args: unknown[]) { for (const listener of this.listeners) listener(...args); }
    dispose() {}
  },
}));

import { ChartPanelManager } from '../chart/chartPanel';
import { QueryColumn } from '../types/query';

function createMockContext() {
  return {
    extensionPath: '/test',
    subscriptions: [],
    globalState: { get: () => undefined, update: async () => {} },
  } as unknown as import('vscode').ExtensionContext;
}

describe('ChartPanelManager', () => {
  let manager: ChartPanelManager;

  beforeEach(() => {
    manager = new ChartPanelManager(createMockContext());
  });

  describe('show()', () => {
    it('creates a chart panel without errors', () => {
      const result = {
        columns: [{ name: 'x', dataType: 'integer' }, { name: 'y', dataType: 'integer' }],
        rows: [{ x: 1, y: 2 }],
        rowCount: 1,
        executionTimeMs: 0,
      };
      expect(() => manager.show(result, 'Test Chart')).not.toThrow();
    });

    it('passes tableName and schema in options', () => {
      const result = {
        columns: [{ name: 'id', dataType: 'integer' }],
        rows: [{ id: 1 }],
        rowCount: 1,
        executionTimeMs: 0,
      };
      expect(() => manager.show(result, 'Chart', {
        connectionId: 'conn-1',
        tableName: 'quotes',
        schema: 'public',
        databaseType: 'postgresql',
        resultPanelKey: 'quotes — Quotes DEV2',
      })).not.toThrow();
    });

    it('reuses existing panel on second show call', () => {
      const result = {
        columns: [{ name: 'x', dataType: 'integer' }],
        rows: [{ x: 1 }],
        rowCount: 1,
        executionTimeMs: 0,
      };
      manager.show(result, 'Same');
      manager.show(result, 'Same');
      // Should not throw — reuses panel
    });
  });

  describe('notifyDataChanged()', () => {
    it('does not throw when no charts exist', () => {
      const columns: QueryColumn[] = [{ name: 'x', dataType: 'integer' }];
      expect(() => manager.notifyDataChanged('some-panel', columns, [{ x: 1 }])).not.toThrow();
    });

    it('does not notify unlinked charts', () => {
      const result = {
        columns: [{ name: 'x', dataType: 'integer' }],
        rows: [{ x: 1 }],
        rowCount: 1,
        executionTimeMs: 0,
      };
      manager.show(result, 'Chart', { resultPanelKey: 'panel-A' });

      // Notify for a different panel key — should not crash
      expect(() => manager.notifyDataChanged('panel-B', result.columns, [{ x: 2 }])).not.toThrow();
    });
  });

  describe('setPinnedQueryProvider()', () => {
    it('accepts provider without errors', () => {
      expect(() => manager.setPinnedQueryProvider({
        getEntries: () => [],
      })).not.toThrow();
    });
  });

  describe('setConnectionManager()', () => {
    it('accepts connection manager without errors', () => {
      const mockCm = { getDriver: () => null, getDriverForDatabase: async () => null } as unknown;
      expect(() => manager.setConnectionManager(mockCm as never)).not.toThrow();
    });
  });
});

// ============================================================
// buildAggregationQuery integration scenarios
// ============================================================

import { buildAggregationQuery, buildFullDataQuery } from '../types/chart';

describe('buildAggregationQuery — real-world scenarios', () => {
  it('quotes per month query', () => {
    const sql = buildAggregationQuery(
      'quotes', 'public', 'created_at', ['id'], 'count', undefined,
      { function: 'count', timeBucketPreset: 'month' }, 'postgresql',
    );
    // Should produce: SELECT date_trunc('month', "created_at") AS "created_at", COUNT(*) AS "count"
    //                  FROM "public"."quotes" GROUP BY ... ORDER BY ...
    expect(sql).toContain('date_trunc(\'month\', "created_at")');
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain('"public"."quotes"');
    expect(sql).toContain('GROUP BY');
    expect(sql).not.toContain('LIMIT');
  });

  it('average response time per hour per endpoint', () => {
    const sql = buildAggregationQuery(
      'api_logs', 'public', 'timestamp', ['response_ms'], 'avg', 'endpoint',
      { function: 'avg', timeBucketPreset: 'hour' }, 'postgresql',
    );
    expect(sql).toContain('date_trunc(\'hour\', "timestamp")');
    expect(sql).toContain('AVG("response_ms")');
    expect(sql).toContain('"endpoint"');
  });

  it('daily revenue sum', () => {
    const sql = buildAggregationQuery(
      'orders', undefined, 'order_date', ['total'], 'sum', undefined,
      { function: 'sum', timeBucketPreset: 'day' },
    );
    expect(sql).toContain('date_trunc(\'day\', "order_date")');
    expect(sql).toContain('SUM("total")');
  });

  it('ClickHouse event counts per minute', () => {
    const sql = buildAggregationQuery(
      'events', 'default', 'event_time', ['user_id'], 'count', undefined,
      { function: 'count', timeBucketPreset: 'minute' }, 'clickhouse',
    );
    expect(sql).toContain('toStartOfMinute("event_time")');
    expect(sql).toContain('COUNT(*)');
  });

  it('full data query only selects needed columns', () => {
    const sql = buildFullDataQuery('quotes', 'public', ['created_at', 'price']);
    expect(sql).toBe('SELECT "created_at", "price" FROM "public"."quotes"');
    expect(sql).not.toContain('*');
    expect(sql).not.toContain('LIMIT');
  });
});

// ============================================================
// ResultPanel chart notifier
// ============================================================

vi.mock('../utils/queryHelpers', () => ({
  quoteIdentifier: (name: string) => `"${name}"`,
}));

import { ResultPanelManager } from '../views/resultPanel';

describe('ResultPanelManager — chart notifier', () => {
  it('setChartNotifier stores callback', () => {
    const ctx = createMockContext();
    const mgr = new ResultPanelManager(ctx);
    const notifier = vi.fn();
    mgr.setChartNotifier(notifier);
    // Notifier is stored — will be called when postMessage sends 'updateData'
  });

  it('postMessage with updateData triggers chart notifier', () => {
    const ctx = createMockContext();
    const mgr = new ResultPanelManager(ctx);
    const notifier = vi.fn();
    mgr.setChartNotifier(notifier);

    // postMessage to non-existent panel — panel.webview.postMessage is a no-op
    // but the notifier should still be called for 'updateData' type
    mgr.postMessage('test-panel', {
      type: 'updateData',
      columns: [{ name: 'x', dataType: 'integer' }],
      rows: [{ x: 1 }],
    });

    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledWith(
      'test-panel',
      [{ name: 'x', dataType: 'integer' }],
      [{ x: 1 }],
    );
  });

  it('postMessage with non-updateData type does not trigger notifier', () => {
    const ctx = createMockContext();
    const mgr = new ResultPanelManager(ctx);
    const notifier = vi.fn();
    mgr.setChartNotifier(notifier);

    mgr.postMessage('panel', { type: 'hideLoading' });
    mgr.postMessage('panel', { type: 'setData' });

    expect(notifier).not.toHaveBeenCalled();
  });

  it('postMessage works without notifier set', () => {
    const ctx = createMockContext();
    const mgr = new ResultPanelManager(ctx);
    // No notifier set — should not throw
    expect(() => mgr.postMessage('panel', { type: 'updateData', columns: [], rows: [] })).not.toThrow();
  });
});
