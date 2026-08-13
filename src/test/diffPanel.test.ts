import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffSource } from '../diff/diffTypes';
import type { TableStatistic } from '../types/schema';

const mocks = vi.hoisted(() => ({
  panels: [] as Array<{
    title: string;
    reveal: ReturnType<typeof vi.fn>;
    webview: {
      html: string;
      cspSource: string;
      asWebviewUri: (value: unknown) => unknown;
      postMessage: ReturnType<typeof vi.fn>;
      onDidReceiveMessage: (handler: (message: Record<string, unknown>) => Promise<void>) => { dispose(): void };
      handler?: (message: Record<string, unknown>) => Promise<void>;
    };
    onDidDispose: (handler: () => void) => void;
    dispose?: () => void;
    disposeHandler?: () => void;
  }>,
}));

vi.mock('vscode', () => ({
  window: {
    createWebviewPanel: (_viewType: string, title: string) => {
      const panel = {
        title,
        reveal: vi.fn(),
        webview: {
          html: '',
          cspSource: 'test-source',
          asWebviewUri: (value: unknown) => value,
          postMessage: vi.fn(async () => true),
          onDidReceiveMessage(handler: (message: Record<string, unknown>) => Promise<void>) {
            panel.webview.handler = handler;
            return { dispose() {} };
          },
          handler: undefined as ((message: Record<string, unknown>) => Promise<void>) | undefined,
        },
        onDidDispose(handler: () => void) { panel.disposeHandler = handler; },
        dispose() { panel.disposeHandler?.(); },
        disposeHandler: undefined as (() => void) | undefined,
      };
      mocks.panels.push(panel);
      return panel;
    },
    showSaveDialog: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  ViewColumn: { Active: 1 },
  Uri: {
    file: (value: string) => value,
    joinPath: (...parts: unknown[]) => parts.join('/'),
  },
  workspace: { fs: { writeFile: vi.fn() } },
  l10n: { t: (value: string) => value },
  Disposable: class {
    constructor(private readonly callback: () => void) {}
    dispose() { this.callback(); }
  },
}));

import { DiffPanelManager } from '../diff/diffPanel';

function source(label: string, connectionId: string): DiffSource {
  return {
    label,
    connectionId,
    tableName: 'items',
    columns: [{ name: 'id', dataType: 'integer' }],
    rows: [{ id: 1 }],
  };
}

function stat(key: string, value: number): TableStatistic {
  return { key, label: key, value, unit: 'count' };
}

function setup() {
  const types = new Map([
    ['pg', 'postgresql'],
    ['ch', 'clickhouse'],
  ]);
  const driver = { execute: vi.fn(async () => ({ columns: [{ name: 'id', dataType: 'integer' }], rows: [{ id: 1 }] })) };
  const connectionManager = {
    get: (id: string) => ({ config: { type: types.get(id) } }),
    isConnectionReadonly: () => false,
    ensureDriver: vi.fn(async () => driver),
  };
  const context = { extensionPath: '/test' };
  return {
    manager: new DiffPanelManager(context as never, connectionManager as never),
    connectionManager,
  };
}

describe('DiffPanelManager cross-type statistics', () => {
  beforeEach(() => { mocks.panels.length = 0; });

  it('uses branded labels, explains estimates, and hides semantically incompatible key collisions', () => {
    const { manager } = setup();
    manager.show(
      source('PG items', 'pg'),
      source('CH items', 'ch'),
      { keyColumns: ['id'], rowLimit: 100 },
      undefined, undefined, undefined, undefined,
      [stat('row_count', 100), stat('total_size', 200), stat('dead_tuples', 3)],
      [stat('row_count', 101), stat('total_size', 150)],
    );

    const html = mocks.panels[0].webview.html;
    expect(html).toContain('Comparing PostgreSQL ↔ ClickHouse — showing 1 comparable metric.');
    expect(html).toContain('2 PostgreSQL metrics and 1 ClickHouse metric not comparable and hidden.');
    expect(html).toContain('PostgreSQL row counts may be estimated.');
    expect(html).toContain('<vscode-icon name="info" aria-hidden="true"></vscode-icon>');
    expect(manager.getDiffStatesForTesting()[0].statsDiff?.items.map(item => item.key)).toEqual(['row_count']);
  });

  it('still explains a fully shared cross-type metric set', () => {
    const { manager } = setup();
    manager.show(
      source('PG items', 'pg'), source('CH items', 'ch'),
      { keyColumns: ['id'], rowLimit: 100 },
      undefined, undefined, undefined, undefined,
      [stat('row_count', 100)], [stat('row_count', 100)],
    );
    expect(mocks.panels[0].webview.html).toContain('showing 1 comparable metric.');
    expect(mocks.panels[0].webview.html).toContain('PostgreSQL row counts may be estimated.');
  });

  it('renders an explicit empty state for a cross-type diff with no comparable metrics', () => {
    const { manager } = setup();
    manager.show(
      source('PG items', 'pg'), source('CH items', 'ch'),
      { keyColumns: ['id'], rowLimit: 100 },
      undefined, undefined, undefined, undefined,
      [stat('total_size', 200)], [stat('total_size', 150)],
    );
    expect(mocks.panels[0].webview.html).toContain('No comparable statistics are available for these database types.');
    expect(mocks.panels[0].webview.html).not.toContain('data-tab="stats"');
  });

  it('does not create a Statistics tab for two empty metric arrays', () => {
    const { manager } = setup();
    manager.show(
      source('PG items', 'pg'), source('CH items', 'ch'),
      { keyColumns: ['id'], rowLimit: 100 },
      undefined, undefined, undefined, undefined, [], [],
    );
    expect(mocks.panels[0].webview.html).not.toContain('id="tabHeader-stats"');
  });

  it('keeps distinct source pairs separate even when their labels match', () => {
    const { manager } = setup();
    manager.show(source('items', 'pg'), source('items', 'ch'), { keyColumns: ['id'], rowLimit: 100 });
    manager.show(source('items', 'pg-2'), source('items', 'ch-2'), { keyColumns: ['id'], rowLimit: 100 });
    expect(mocks.panels).toHaveLength(2);
    expect(manager.getDiffCount()).toBe(2);
  });

  it('swaps sides in place and reverses statistics, types, and edited queries', async () => {
    const { manager } = setup();
    manager.show(
      source('PG items', 'pg'), source('CH items', 'ch'),
      { keyColumns: ['id'], rowLimit: 100 },
      undefined, undefined, undefined, undefined,
      [stat('row_count', 100), stat('dead_tuples', 1), stat('table_size', 2)],
      [stat('row_count', 101), stat('active_parts', 1)],
      { leftQuery: 'SELECT pg', rightQuery: 'SELECT ch', syncMode: false },
    );

    await mocks.panels[0].webview.handler?.({ type: 'swapSides' });

    expect(mocks.panels).toHaveLength(1);
    expect(manager.getDiffCount()).toBe(1);
    const state = manager.getDiffStatesForTesting()[0];
    expect(state.left.label).toBe('CH items');
    expect(state.right.label).toBe('PG items');
    expect(state.leftType).toBe('clickhouse');
    expect(state.rightType).toBe('postgresql');
    expect(state.leftQuery).toBe('SELECT ch');
    expect(state.rightQuery).toBe('SELECT pg');
    expect(state.statsDiff?.summary.leftHiddenCount).toBe(1);
    expect(state.statsDiff?.summary.rightHiddenCount).toBe(2);
    expect(mocks.panels[0].title).toContain('CH items ↔ PG items');
  });

  it('reconnects drivers before rerunning edited queries', async () => {
    const { manager, connectionManager } = setup();
    manager.show(
      source('PG items', 'pg'), source('CH items', 'ch'),
      { keyColumns: ['id'], rowLimit: 100 },
    );
    await mocks.panels[0].webview.handler?.({
      type: 'runDiffQuery',
      leftQuery: 'SELECT id FROM items',
      rightQuery: 'SELECT id FROM items',
      syncMode: false,
    });
    expect(connectionManager.ensureDriver).toHaveBeenCalledTimes(2);
  });

  it('deduplicates reconnect for two sides of the same connection', async () => {
    const { manager, connectionManager } = setup();
    manager.show(
      source('Left items', 'pg'), source('Right items', 'pg'),
      { keyColumns: ['id'], rowLimit: 100 },
    );
    await mocks.panels[0].webview.handler?.({
      type: 'runDiffQuery', leftQuery: 'SELECT 1', rightQuery: 'SELECT 2', syncMode: false,
    });
    expect(connectionManager.ensureDriver).toHaveBeenCalledTimes(1);
  });

  it('latest rerun wins and executes immutable query snapshots', async () => {
    const { manager, connectionManager } = setup();
    const executions: Array<{ query: string; resolve: (value: unknown) => void }> = [];
    const driver = {
      execute: vi.fn((query: string) => new Promise(resolve => executions.push({ query, resolve }))),
    };
    connectionManager.ensureDriver.mockResolvedValue(driver);
    manager.show(source('PG items', 'pg'), source('CH items', 'ch'), { keyColumns: ['id'], rowLimit: 100 });

    const first = mocks.panels[0].webview.handler?.({
      type: 'runDiffQuery', leftQuery: 'SELECT first-left', rightQuery: 'SELECT first-right', syncMode: false,
    });
    await vi.waitFor(() => expect(executions).toHaveLength(2));
    const second = mocks.panels[0].webview.handler?.({
      type: 'runDiffQuery', leftQuery: 'SELECT second-left', rightQuery: 'SELECT second-right', syncMode: false,
    });
    await vi.waitFor(() => expect(executions).toHaveLength(4));
    expect(executions.map(entry => entry.query)).toEqual([
      'SELECT first-left', 'SELECT first-right', 'SELECT second-left', 'SELECT second-right',
    ]);

    const result = { columns: [{ name: 'id', dataType: 'integer' }], rows: [{ id: 2 }] };
    executions[2].resolve(result);
    executions[3].resolve(result);
    await second;
    executions[0].resolve({ ...result, rows: [{ id: 1 }] });
    executions[1].resolve({ ...result, rows: [{ id: 1 }] });
    await first;

    expect(manager.getDiffStatesForTesting()[0].left.rows).toEqual([{ id: 2 }]);
  });

  it('does not post an async query result after the panel is disposed', async () => {
    const { manager, connectionManager } = setup();
    const resolveExecutions: Array<(value: unknown) => void> = [];
    const execute = vi.fn(() => new Promise(resolve => { resolveExecutions.push(resolve); }));
    connectionManager.ensureDriver.mockResolvedValue({ execute });
    manager.show(source('PG items', 'pg'), source('CH items', 'ch'), { keyColumns: ['id'], rowLimit: 100 });
    const run = mocks.panels[0].webview.handler?.({
      type: 'runDiffQuery', leftQuery: 'SELECT 1', rightQuery: 'SELECT 2', syncMode: false,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    mocks.panels[0].dispose?.();
    const postsBeforeResolve = mocks.panels[0].webview.postMessage.mock.calls.length;
    const result = { columns: [{ name: 'id', dataType: 'integer' }], rows: [{ id: 1 }] };
    resolveExecutions.forEach(resolve => resolve(result));
    await run;
    expect(mocks.panels[0].webview.postMessage).toHaveBeenCalledTimes(postsBeforeResolve);
    expect(manager.getDiffCount()).toBe(0);
  });
});
