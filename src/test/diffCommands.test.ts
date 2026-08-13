import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseDriver } from '../types/driver';
import type { QueryResult } from '../types/query';
import type { SchemaObject, TableInfo, TableObjects, TableStatistic } from '../types/schema';

interface PickerPlan {
  cancel?: boolean;
  connectionId?: string;
  tableName?: string;
}

interface PickItem {
  label: string;
  connectionId: string;
  tableName: string;
}

type CommandHandler = (...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  pickerPlans: [] as PickerPlan[],
  pickerItems: [] as PickItem[][],
  columnPicks: [] as Array<Array<{ label: string; description?: string }> | undefined>,
  showQuickPick: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand(command: string, handler: CommandHandler) {
      mocks.commands.set(command, handler);
      return { dispose() {} };
    },
  },
  window: {
    createQuickPick() {
      const plan = mocks.pickerPlans.shift() || {};
      let items: PickItem[] = [];
      let selectedItems: PickItem[] = [];
      const acceptHandlers: Array<() => void> = [];
      const hideHandlers: Array<() => void> = [];
      return {
        placeholder: '',
        busy: false,
        enabled: true,
        get items() { return items; },
        set items(value: PickItem[]) {
          items = value;
          mocks.pickerItems.push(value);
          const selected = value.find(item =>
            item.connectionId === plan.connectionId && item.tableName === plan.tableName
          );
          selectedItems = selected ? [selected] : [];
          queueMicrotask(() => acceptHandlers.forEach(handler => handler()));
        },
        get selectedItems() { return selectedItems; },
        show() {
          if (plan.cancel) queueMicrotask(() => hideHandlers.forEach(handler => handler()));
        },
        dispose() {},
        onDidAccept(handler: () => void) {
          acceptHandlers.push(handler);
          return { dispose() {} };
        },
        onDidHide(handler: () => void) {
          hideHandlers.push(handler);
          return { dispose() {} };
        },
      };
    },
    showQuickPick: mocks.showQuickPick,
    showWarningMessage: mocks.showWarningMessage,
    showErrorMessage: mocks.showErrorMessage,
    withProgress: (_options: unknown, task: () => Promise<unknown>) => task(),
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  ProgressLocation: { Notification: 15 },
  l10n: {
    t: (message: string, ...args: unknown[]) => args.reduce(
      (result, value, index) => result.replace(`{${index}}`, String(value)),
      message,
    ),
  },
}));

vi.mock('../commands/shared', () => ({
  getRequiredDriver: (
    manager: { getDriver(id: string): DatabaseDriver | undefined; getDriverForDatabase?: (id: string, database: string) => DatabaseDriver | undefined },
    connectionId: string,
    databaseName?: string,
  ) => databaseName && manager.getDriverForDatabase
    ? manager.getDriverForDatabase(connectionId, databaseName)
    : manager.getDriver(connectionId),
  wrapError: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

vi.mock('../utils/debug', () => ({ dbg: vi.fn() }));

import { registerDiffCommands } from '../commands/diffCommands';

interface DriverOverrides {
  info?: (name: string) => TableInfo;
  data?: (name: string) => QueryResult;
  objects?: (name: string) => Promise<TableObjects>;
  stats?: (name: string) => Promise<TableStatistic[]>;
}

function makeDriver(schema: SchemaObject[], overrides: DriverOverrides = {}): DatabaseDriver {
  const defaultInfo = (name: string): TableInfo => ({
    name,
    columns: [
      { name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true },
      { name: 'value', dataType: 'text', nullable: true, isPrimaryKey: false },
    ],
  });
  const defaultData = (): QueryResult => ({
    columns: [{ name: 'id', dataType: 'integer' }, { name: 'value', dataType: 'text' }],
    rows: [{ id: 1, value: 'ok' }],
    rowCount: 1,
    executionTimeMs: 1,
  });

  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    ping: vi.fn(async () => true),
    execute: vi.fn(async () => defaultData()),
    getSchema: vi.fn(async () => schema),
    getTableInfo: vi.fn(async name => (overrides.info || defaultInfo)(name)),
    getTableData: vi.fn(async name => (overrides.data || defaultData)(name)),
    ...(overrides.objects ? { getTableObjects: vi.fn(overrides.objects) } : {}),
    ...(overrides.stats ? { getTableStatistics: vi.fn(overrides.stats) } : {}),
  };
}

function setup(connections: Array<{ id: string; name: string; type: string; driver: DatabaseDriver }>) {
  const states = connections.map(connection => ({
    connected: true,
    config: { id: connection.id, name: connection.name, type: connection.type },
  }));
  const drivers = new Map(connections.map(connection => [connection.id, connection.driver]));
  const connectionManager = {
    getAll: () => states,
    get: (id: string) => states.find(state => state.config.id === id),
    getDriver: (id: string) => drivers.get(id),
  };
  const diffPanelManager = { show: vi.fn() };
  const context = { subscriptions: [] as Array<{ dispose(): void }> };

  registerDiffCommands(context as never, { connectionManager, diffPanelManager } as never);
  return { connectionManager, diffPanelManager };
}

function command(name: 'viewstor.compareWith' | 'viewstor.compareData'): CommandHandler {
  const handler = mocks.commands.get(name);
  if (!handler) throw new Error(`Command not registered: ${name}`);
  return handler;
}

beforeEach(() => {
  mocks.commands.clear();
  mocks.pickerPlans.length = 0;
  mocks.pickerItems.length = 0;
  mocks.columnPicks.length = 0;
  mocks.showQuickPick.mockReset().mockImplementation(async () => mocks.columnPicks.shift());
  mocks.showWarningMessage.mockReset();
  mocks.showErrorMessage.mockReset();
});

describe('Data Diff commands', () => {
  it('Compare With exposes SQLite tables/views and uses the left primary key automatically', async () => {
    const pg = makeDriver([{ name: 'public', type: 'schema', children: [
      { name: 'customers', type: 'table', schema: 'public' },
    ] }]);
    const sqlite = makeDriver([
      { name: 'local_table', type: 'table' },
      { name: 'local_view', type: 'view' },
    ]);
    const { diffPanelManager } = setup([
      { id: 'pg', name: 'PostgreSQL', type: 'postgresql', driver: pg },
      { id: 'sqlite', name: 'SQLite', type: 'sqlite', driver: sqlite },
    ]);
    mocks.pickerPlans.push({ connectionId: 'sqlite', tableName: 'local_view' });

    await command('viewstor.compareWith')({
      connectionId: 'pg',
      schemaObject: { name: 'customers', type: 'table', schema: 'public' },
    });

    expect(mocks.pickerItems[0].map(item => [item.connectionId, item.tableName])).toEqual(expect.arrayContaining([
      ['sqlite', 'local_table'],
      ['sqlite', 'local_view'],
    ]));
    expect(mocks.showQuickPick).not.toHaveBeenCalled();
    expect(diffPanelManager.show).toHaveBeenCalledOnce();
    expect(diffPanelManager.show.mock.calls[0][2]).toEqual({ keyColumns: ['id'], rowLimit: 10000 });
    expect(diffPanelManager.show.mock.calls[0][1]).toMatchObject({ connectionId: 'sqlite', tableName: 'local_view' });
  });

  it('Compare With cancel stops before loading either table', async () => {
    const driver = makeDriver([{ name: 'items', type: 'table' }]);
    const { diffPanelManager } = setup([{ id: 'db', name: 'DB', type: 'sqlite', driver }]);
    mocks.pickerPlans.push({ cancel: true });

    await command('viewstor.compareWith')({
      connectionId: 'db',
      schemaObject: { name: 'items', type: 'table' },
    });

    expect(driver.getTableData).not.toHaveBeenCalled();
    expect(diffPanelManager.show).not.toHaveBeenCalled();
  });

  it('Compare Data asks for a matching key when the left table has no primary key', async () => {
    const driver = makeDriver([
      { name: 'left_no_pk', type: 'table' },
      { name: 'right_table', type: 'table' },
    ], {
      info: name => ({
        name,
        columns: [
          { name: 'external_id', dataType: 'text', nullable: false, isPrimaryKey: false },
          { name: 'value', dataType: 'text', nullable: true, isPrimaryKey: false },
        ],
      }),
      data: () => ({
        columns: [{ name: 'external_id', dataType: 'text' }, { name: 'value', dataType: 'text' }],
        rows: [{ external_id: 'A', value: 'ok' }],
        rowCount: 1,
        executionTimeMs: 1,
      }),
    });
    const { diffPanelManager } = setup([{ id: 'sqlite', name: 'SQLite', type: 'sqlite', driver }]);
    mocks.pickerPlans.push(
      { connectionId: 'sqlite', tableName: 'left_no_pk' },
      { connectionId: 'sqlite', tableName: 'right_table' },
    );
    mocks.columnPicks.push([{ label: 'external_id', description: 'text' }]);

    await command('viewstor.compareData')();

    expect(mocks.showQuickPick).toHaveBeenCalledOnce();
    expect(diffPanelManager.show).toHaveBeenCalledOnce();
    expect(diffPanelManager.show.mock.calls[0][2]).toEqual({ keyColumns: ['external_id'], rowLimit: 10000 });
  });

  it('Compare Data cancel at the second picker does not fetch data or open a panel', async () => {
    const driver = makeDriver([{ name: 'items', type: 'table' }]);
    const { diffPanelManager } = setup([{ id: 'db', name: 'DB', type: 'sqlite', driver }]);
    mocks.pickerPlans.push({ connectionId: 'db', tableName: 'items' }, { cancel: true });

    await command('viewstor.compareData')();

    expect(driver.getTableData).not.toHaveBeenCalled();
    expect(diffPanelManager.show).not.toHaveBeenCalled();
  });

  it('Compare Data cancel at key selection does not open a panel', async () => {
    const driver = makeDriver([
      { name: 'left_no_pk', type: 'table' },
      { name: 'right_table', type: 'table' },
    ], {
      info: name => ({
        name,
        columns: [{ name: 'external_id', dataType: 'text', nullable: false, isPrimaryKey: false }],
      }),
      data: () => ({
        columns: [{ name: 'external_id', dataType: 'text' }],
        rows: [{ external_id: 'A' }],
        rowCount: 1,
        executionTimeMs: 1,
      }),
    });
    const { diffPanelManager } = setup([{ id: 'db', name: 'DB', type: 'sqlite', driver }]);
    mocks.pickerPlans.push(
      { connectionId: 'db', tableName: 'left_no_pk' },
      { connectionId: 'db', tableName: 'right_table' },
    );
    mocks.columnPicks.push(undefined);

    await command('viewstor.compareData')();

    expect(mocks.showQuickPick).toHaveBeenCalledOnce();
    expect(diffPanelManager.show).not.toHaveBeenCalled();
  });

  it('does not open a panel when required table data fails', async () => {
    const failing = makeDriver([{ name: 'left', type: 'table' }], {
      data: () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 1, error: 'permission denied' }),
    });
    const healthy = makeDriver([{ name: 'right', type: 'table' }]);
    const { diffPanelManager } = setup([
      { id: 'left-db', name: 'Left', type: 'postgresql', driver: failing },
      { id: 'right-db', name: 'Right', type: 'sqlite', driver: healthy },
    ]);
    mocks.pickerPlans.push({ connectionId: 'right-db', tableName: 'right' });

    await command('viewstor.compareWith')({
      connectionId: 'left-db',
      schemaObject: { name: 'left', type: 'table' },
    });

    expect(diffPanelManager.show).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).toHaveBeenCalledWith('Compare failed: permission denied');
  });

  it('Compare Data does not open a panel when required table info throws', async () => {
    const left = makeDriver([{ name: 'left', type: 'table' }]);
    const right = makeDriver([{ name: 'right', type: 'table' }]);
    vi.mocked(left.getTableInfo).mockRejectedValueOnce(new Error('table disappeared'));
    const { diffPanelManager } = setup([
      { id: 'left-db', name: 'Left', type: 'postgresql', driver: left },
      { id: 'right-db', name: 'Right', type: 'sqlite', driver: right },
    ]);
    mocks.pickerPlans.push(
      { connectionId: 'left-db', tableName: 'left' },
      { connectionId: 'right-db', tableName: 'right' },
    );

    await command('viewstor.compareData')();

    expect(diffPanelManager.show).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).toHaveBeenCalledWith('Compare failed: table disappeared');
  });

  it('keeps row/schema comparison when optional objects and statistics fail', async () => {
    const optionalFailure = {
      objects: async () => { throw new Error('objects unavailable'); },
      stats: async () => { throw new Error('stats unavailable'); },
    };
    const left = makeDriver([{ name: 'left', type: 'table' }], optionalFailure);
    const right = makeDriver([{ name: 'right', type: 'view' }], optionalFailure);
    const { diffPanelManager } = setup([
      { id: 'left-db', name: 'Left', type: 'postgresql', driver: left },
      { id: 'right-db', name: 'Right', type: 'sqlite', driver: right },
    ]);
    mocks.pickerPlans.push({ connectionId: 'right-db', tableName: 'right' });

    await command('viewstor.compareWith')({
      connectionId: 'left-db',
      schemaObject: { name: 'left', type: 'table' },
    });

    expect(diffPanelManager.show).toHaveBeenCalledOnce();
    const args = diffPanelManager.show.mock.calls[0];
    expect(args.slice(5, 9)).toEqual([undefined, undefined, undefined, undefined]);
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it('Compare Data warns and exits when no connection is connected', async () => {
    const diffPanelManager = { show: vi.fn() };
    registerDiffCommands(
      { subscriptions: [] } as never,
      { connectionManager: { getAll: () => [] }, diffPanelManager } as never,
    );

    await command('viewstor.compareData')();

    expect(mocks.showWarningMessage).toHaveBeenCalledWith('No connected databases. Connect first.');
    expect(diffPanelManager.show).not.toHaveBeenCalled();
  });
});
