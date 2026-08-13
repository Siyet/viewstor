import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClickHouseDriver } from '../../drivers/clickhouse';
import { PostgresDriver } from '../../drivers/postgres';
import { SqliteDriver } from '../../drivers/sqlite';
import { computeRowDiff, computeSchemaDiff, computeStatsDiff } from '../../diff/diffEngine';
import {
  completeCompareColumnSelection,
  createCompareColumnPlan,
  findCompatiblePrimaryKey,
} from '../../diff/diffColumnSelection';
import { DiffSource } from '../../diff/diffTypes';
import { DatabaseDriver } from '../../types/driver';
import { COMMON_STAT_KEYS, TableInfo, TableStatistic } from '../../types/schema';
import { startTestStack, stopTestStack, TestStack } from '../shared/containers';
import { describeIf, isDockerAvailable } from './helpers/dockerCheck';

type Engine = 'pg' | 'ch' | 'sqlite';

interface EngineFixture {
  driver: DatabaseDriver;
  namespace?: string;
}

interface TableSnapshot {
  source: DiffSource;
  info: TableInfo;
  stats: TableStatistic[];
}

const NAMESPACE = 'viewstor_compare_e2e';
const LARGE_TEXT_INTEGER = '900719925474099312345';

const ALL_PAIRS = [
  ['PostgreSQL ↔ PostgreSQL', 'pg', 'pg'],
  ['ClickHouse ↔ ClickHouse', 'ch', 'ch'],
  ['SQLite ↔ SQLite', 'sqlite', 'sqlite'],
  ['PostgreSQL ↔ ClickHouse', 'pg', 'ch'],
  ['PostgreSQL ↔ SQLite', 'pg', 'sqlite'],
  ['ClickHouse ↔ SQLite', 'ch', 'sqlite'],
] as const;

const SAME_TYPE_PAIRS = ALL_PAIRS.slice(0, 3);
const CROSS_TYPE_PAIRS = ALL_PAIRS.slice(3);

describeIf(isDockerAvailable)('Compare Tables E2E matrix', () => {
  let stack: TestStack | undefined;
  let postgres: PostgresDriver | undefined;
  let clickhouse: ClickHouseDriver | undefined;
  let sqlite: SqliteDriver | undefined;
  let sqlitePath: string | undefined;
  let fixtures: Record<Engine, EngineFixture>;
  let rowLeft: Record<Engine, TableSnapshot>;
  let rowRight: Record<Engine, TableSnapshot>;
  let schemaLeft: Record<Engine, TableInfo>;
  let schemaRight: Record<Engine, TableInfo>;
  let customers: Record<Engine, TableSnapshot>;
  let customerSummary: Record<Engine, TableSnapshot>;

  beforeAll(async () => {
    stack = await startTestStack({ pg: true, ch: true, redis: false });

    postgres = new PostgresDriver();
    await postgres.connect({
      id: 'compare-tables-e2e-pg',
      name: 'Compare Tables E2E PostgreSQL',
      type: 'postgresql',
      host: stack.pg!.host,
      port: stack.pg!.port,
      username: stack.pg!.username,
      password: stack.pg!.password,
      database: stack.pg!.database,
    });

    clickhouse = new ClickHouseDriver();
    await clickhouse.connect({
      id: 'compare-tables-e2e-ch',
      name: 'Compare Tables E2E ClickHouse',
      type: 'clickhouse',
      host: stack.ch!.host,
      port: stack.ch!.httpPort,
      username: stack.ch!.username,
      password: stack.ch!.password,
      database: stack.ch!.database,
    });

    sqlitePath = path.join(os.tmpdir(), `viewstor-compare-tables-${process.pid}-${Date.now()}.sqlite`);
    sqlite = new SqliteDriver();
    await sqlite.connect({
      id: 'compare-tables-e2e-sqlite',
      name: 'Compare Tables E2E SQLite',
      type: 'sqlite',
      host: '',
      port: 0,
      database: sqlitePath,
    });

    fixtures = {
      pg: { driver: postgres, namespace: NAMESPACE },
      ch: { driver: clickhouse, namespace: NAMESPACE },
      sqlite: { driver: sqlite },
    };

    await seedPostgres(postgres);
    await seedClickHouse(clickhouse);
    await seedSqlite(sqlite);

    [rowLeft, rowRight, schemaLeft, schemaRight, customers, customerSummary] = await Promise.all([
      snapshotAll(fixtures, 'row_left'),
      snapshotAll(fixtures, 'row_right'),
      tableInfoAll(fixtures, 'schema_left'),
      tableInfoAll(fixtures, 'schema_right'),
      snapshotAll(fixtures, 'customers'),
      snapshotAll(fixtures, 'customer_summary'),
    ]);
  });

  afterAll(async () => {
    await Promise.allSettled([
      postgres ? executeOrThrow(postgres, `DROP SCHEMA IF EXISTS ${NAMESPACE} CASCADE`) : Promise.resolve(),
      clickhouse ? executeOrThrow(clickhouse, `DROP DATABASE IF EXISTS ${NAMESPACE}`) : Promise.resolve(),
    ]);
    await Promise.allSettled([
      postgres?.disconnect(),
      clickhouse?.disconnect(),
      sqlite?.disconnect(),
    ].filter((operation): operation is Promise<void> => operation !== undefined));
    try {
      if (stack) await stopTestStack(stack);
    } finally {
      if (sqlitePath) {
        for (const suffix of ['', '-wal', '-shm']) {
          const file = sqlitePath + suffix;
          if (fs.existsSync(file)) fs.unlinkSync(file);
        }
      }
    }
  });

  it.each(ALL_PAIRS)('%s produces a stable semantic row diff', (_label, leftEngine, rightEngine) => {
    const result = computeRowDiff(rowLeft[leftEngine].source, rowRight[rightEngine].source, {
      keyColumns: ['id'],
      rowLimit: 100,
    });

    expect(result.truncated).toBe(false);
    expect(result.summary).toEqual({ total: 7, unchanged: 4, changed: 1, added: 1, removed: 1 });
    expect(result.leftOnly.map(row => String(row.id))).toEqual(['3']);
    expect(result.rightOnly.map(row => String(row.id))).toEqual(['7']);

    const changed = result.matched.find(row => row.key === '2e0');
    expect(changed?.changedColumns).toEqual(['note']);
    expect(result.matched.find(row => row.key === '4e0')?.changedColumns).toEqual([]);

    const stableEdgeCaseRows = result.matched.filter(row => ['1e0', '4e0', '5e0', '6e0'].includes(row.key));
    expect(stableEdgeCaseRows).toHaveLength(4);
    expect(stableEdgeCaseRows.every(row => row.changedColumns.length === 0)).toBe(true);
    expect(stableEdgeCaseRows.every(row => row.left.huge_code === LARGE_TEXT_INTEGER)).toBe(true);
  });

  it.each(['pg', 'ch', 'sqlite'] as const)(
    '%s table/view comparison ignores side-only columns selected out of Row Diff',
    engine => {
      const keyColumns = findCompatiblePrimaryKey(customers[engine].info, customerSummary[engine].info) ?? [];
      expect(keyColumns).toEqual(['id']);

      const selection = createCompareColumnPlan(
        customers[engine].info,
        customerSummary[engine].info,
        keyColumns,
      );
      expect(selection.requiresSelection).toBe(true);
      expect(selection.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'exact:id', label: 'id ↔ id', kind: 'exact', picked: true }),
        expect.objectContaining({ id: 'exact:name', label: 'name ↔ name', kind: 'exact', picked: true }),
        expect.objectContaining({
          id: 'similar:lifetime_value:total_value',
          label: 'lifetime_value ↔ total_value',
          kind: 'similar',
          picked: false,
        }),
        expect.objectContaining({ id: 'left:email', kind: 'leftOnly', picked: false }),
        expect.objectContaining({ id: 'right:order_count', kind: 'rightOnly', picked: false }),
      ]));
      const columnMappings = completeCompareColumnSelection(selection, [
        'exact:id',
        'exact:name',
        'similar:lifetime_value:total_value',
      ]);

      const result = computeRowDiff(customers[engine].source, customerSummary[engine].source, {
        keyColumns,
        columnMappings,
        rowLimit: 100,
      });

      expect(result.allColumns).toEqual(['id', 'name', 'lifetime_value ↔ total_value']);
      expect(result.summary).toEqual({ total: 2, unchanged: 2, changed: 0, added: 0, removed: 0 });
      expect(result.matched.every(row => row.changedColumns.length === 0)).toBe(true);
      expect(customers[engine].info.columns.find(column => column.name === 'id')?.isPrimaryKey).toBe(true);
    },
  );

  it.each([
    ['PostgreSQL ↔ SQLite', 'pg', 'sqlite'],
    ['PostgreSQL ↔ ClickHouse', 'pg', 'ch'],
  ] as const)('%s normalizes boolean flags and UTC timestamps across native representations', (_label, leftEngine, rightEngine) => {
    const keyColumns = ['id'];
    const selection = createCompareColumnPlan(customers[leftEngine].info, customers[rightEngine].info, keyColumns);
    const columnMappings = completeCompareColumnSelection(
      selection,
      selection.candidates.filter(candidate => candidate.picked).map(candidate => candidate.id),
    );
    const result = computeRowDiff(customers[leftEngine].source, customers[rightEngine].source, {
      keyColumns,
      columnMappings,
      rowLimit: 100,
    });

    expect(result.summary).toEqual({ total: 2, unchanged: 2, changed: 0, added: 0, removed: 0 });
    expect(result.matched.every(row => !row.changedColumns.includes('active'))).toBe(true);
    expect(result.matched.every(row => !row.changedColumns.includes('created_at'))).toBe(true);
  });

  it.each(['pg', 'ch', 'sqlite'] as const)(
    '%s reports an exact row count for customer_summary view',
    engine => {
      expect(customerSummary[engine].stats.find(stat => stat.key === 'row_count')).toMatchObject({
        value: 2,
        unit: 'count',
      });
    },
  );

  it.each(ALL_PAIRS)('%s reports schema differences by meaning', (_label, leftEngine, rightEngine) => {
    const result = computeSchemaDiff(schemaLeft[leftEngine].columns, schemaRight[rightEngine].columns);
    const common = new Map(result.commonColumns.map(column => [column.name, column]));

    expect(result.leftOnlyColumns.map(column => column.name)).toEqual(['left_only']);
    expect(result.rightOnlyColumns.map(column => column.name)).toEqual(['right_only']);
    expect(common.get('changed_type')?.typeDiffers).toBe(true);
    expect(common.get('changed_nullable')?.nullableDiffers).toBe(true);
    expect(common.get('stable_text')?.nullableDiffers).toBe(false);
    expect(common.get('id')?.pkDiffers).toBe(true);
    expect(common.get('commented')?.commentDiffers).toBe(
      !(leftEngine === 'sqlite' && rightEngine === 'sqlite'),
    );
  });

  it.each(SAME_TYPE_PAIRS)('%s keeps the complete statistics set', (_label, leftEngine, rightEngine) => {
    const leftStats = rowLeft[leftEngine].stats;
    const rightStats = rowRight[rightEngine].stats;
    const result = computeStatsDiff(leftStats, rightStats);
    const keys = new Set(result.items.map(item => item.key));

    expect(result.summary).toEqual({ crossType: false, leftHiddenCount: 0, rightHiddenCount: 0 });
    for (const key of COMMON_STAT_KEYS) expect(keys.has(key)).toBe(true);
    expect(keys.has({ pg: 'live_tuples', ch: 'engine', sqlite: 'index_count' }[leftEngine])).toBe(true);

    const rowCount = result.items.find(item => item.key === 'row_count');
    expect(rowCount).toMatchObject({ leftValue: 6, rightValue: 6, status: 'same' });
    if (leftEngine !== 'ch') {
      expect(result.items.find(item => item.key === 'last_modified')?.status).toBe('missing');
    }
  });

  it.each(CROSS_TYPE_PAIRS)('%s compares only semantically shared statistics', (_label, leftEngine, rightEngine) => {
    const result = computeStatsDiff(rowLeft[leftEngine].stats, rowRight[rightEngine].stats, { crossType: true });

    expect(result.items.map(item => item.key)).toEqual(['row_count']);
    expect(result.items[0]).toMatchObject({ leftValue: 6, rightValue: 6, status: 'same' });
    expect(result.summary.crossType).toBe(true);
    expect(result.summary.leftHiddenCount).toBeGreaterThan(0);
    expect(result.summary.rightHiddenCount).toBeGreaterThan(0);
    expect(result.items.some(item => item.key === 'total_size')).toBe(false);
  });
});

async function snapshotAll(fixtures: Record<Engine, EngineFixture>, table: string): Promise<Record<Engine, TableSnapshot>> {
  const entries = await Promise.all((Object.entries(fixtures) as Array<[Engine, EngineFixture]>).map(
    async ([engine, fixture]) => [engine, await snapshotTable(fixture, table)] as const,
  ));
  return Object.fromEntries(entries) as Record<Engine, TableSnapshot>;
}

async function tableInfoAll(fixtures: Record<Engine, EngineFixture>, table: string): Promise<Record<Engine, TableInfo>> {
  const entries = await Promise.all((Object.entries(fixtures) as Array<[Engine, EngineFixture]>).map(
    async ([engine, fixture]) => [engine, await fixture.driver.getTableInfo(table, fixture.namespace)] as const,
  ));
  return Object.fromEntries(entries) as Record<Engine, TableInfo>;
}

async function snapshotTable(fixture: EngineFixture, table: string): Promise<TableSnapshot> {
  const [info, data, stats] = await Promise.all([
    fixture.driver.getTableInfo(table, fixture.namespace),
    fixture.driver.getTableData(table, fixture.namespace, 100, 0, [{ column: 'id', direction: 'asc' }]),
    fixture.driver.getTableStatistics!(table, fixture.namespace),
  ]);
  if (data.error) throw new Error(`Cannot load ${table}: ${data.error}`);
  return {
    info,
    stats,
    source: {
      label: table,
      tableName: table,
      schema: fixture.namespace,
      columns: data.columns,
      rows: data.rows,
    },
  };
}

async function executeOrThrow(driver: DatabaseDriver, sql: string): Promise<void> {
  const result = await driver.execute(sql);
  if (result.error) throw new Error(`${result.error}\nSQL: ${sql}`);
}

async function executeAll(driver: DatabaseDriver, statements: string[]): Promise<void> {
  for (const statement of statements) await executeOrThrow(driver, statement);
}

async function seedPostgres(driver: DatabaseDriver): Promise<void> {
  await executeAll(driver, [
    `DROP SCHEMA IF EXISTS ${NAMESPACE} CASCADE`,
    `CREATE SCHEMA ${NAMESPACE}`,
    `CREATE TABLE ${NAMESPACE}.row_left (
      id BIGINT PRIMARY KEY, amount NUMERIC(30,4) NOT NULL, note TEXT,
      unicode_text TEXT NOT NULL, huge_code TEXT NOT NULL, date_text TEXT NOT NULL
    )`,
    `CREATE TABLE ${NAMESPACE}.row_right (
      id BIGINT PRIMARY KEY, amount NUMERIC(30,4) NOT NULL, note TEXT,
      unicode_text TEXT NOT NULL, huge_code TEXT NOT NULL, date_text TEXT NOT NULL
    )`,
    `CREATE INDEX row_left_amount_idx ON ${NAMESPACE}.row_left (amount)`,
    `CREATE INDEX row_right_amount_idx ON ${NAMESPACE}.row_right (amount)`,
    `INSERT INTO ${NAMESPACE}.row_left VALUES ${leftRowsSql()}`,
    `INSERT INTO ${NAMESPACE}.row_right VALUES ${rightRowsSql()}`,
    `CREATE TABLE ${NAMESPACE}.schema_left (
      id BIGINT PRIMARY KEY, stable_text TEXT NOT NULL, changed_type NUMERIC,
      changed_nullable TEXT, commented TEXT, left_only TEXT
    )`,
    `CREATE TABLE ${NAMESPACE}.schema_right (
      id BIGINT NOT NULL, stable_text TEXT NOT NULL, changed_type TEXT,
      changed_nullable TEXT NOT NULL, commented TEXT, right_only TEXT
    )`,
    `COMMENT ON COLUMN ${NAMESPACE}.schema_left.commented IS 'left comment'`,
    `COMMENT ON COLUMN ${NAMESPACE}.schema_right.commented IS 'right comment'`,
    `CREATE TABLE ${NAMESPACE}.customers (
      id BIGINT PRIMARY KEY, name TEXT NOT NULL, email TEXT,
      lifetime_value NUMERIC NOT NULL, active BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL
    )`,
    `INSERT INTO ${NAMESPACE}.customers VALUES
      (1, 'Customer 1', 'one@example.com', 10, TRUE, '2026-01-01 01:00:00+00'),
      (2, 'Customer 2', 'two@example.com', 20, FALSE, '2026-01-01 02:00:00+00')`,
    `CREATE VIEW ${NAMESPACE}.customer_summary AS
      SELECT id, name, 0::BIGINT AS order_count, lifetime_value AS total_value
      FROM ${NAMESPACE}.customers`,
  ]);
}

async function seedClickHouse(driver: DatabaseDriver): Promise<void> {
  await executeAll(driver, [
    `DROP DATABASE IF EXISTS ${NAMESPACE}`,
    `CREATE DATABASE ${NAMESPACE}`,
    `CREATE TABLE ${NAMESPACE}.row_left (
      id Int64, amount Decimal(30,4), note Nullable(String),
      unicode_text String, huge_code String, date_text String
    ) ENGINE = MergeTree ORDER BY id`,
    `CREATE TABLE ${NAMESPACE}.row_right (
      id Int64, amount Decimal(30,4), note Nullable(String),
      unicode_text String, huge_code String, date_text String
    ) ENGINE = MergeTree ORDER BY id`,
    `INSERT INTO ${NAMESPACE}.row_left VALUES ${leftRowsSql()}`,
    `INSERT INTO ${NAMESPACE}.row_right VALUES ${rightRowsSql()}`,
    `CREATE TABLE ${NAMESPACE}.schema_left (
      id Int64, stable_text String, changed_type Decimal(30,4),
      changed_nullable Nullable(String), commented String COMMENT 'left comment', left_only String
    ) ENGINE = MergeTree ORDER BY id`,
    `CREATE TABLE ${NAMESPACE}.schema_right (
      id Int64, stable_text String, changed_type String,
      changed_nullable String, commented String COMMENT 'right comment', right_only String
    ) ENGINE = MergeTree ORDER BY tuple()`,
    `CREATE TABLE ${NAMESPACE}.customers (
      id UInt64, name String, email Nullable(String),
      lifetime_value Decimal(12, 2), active UInt8, created_at DateTime('UTC')
    ) ENGINE = MergeTree ORDER BY id`,
    `INSERT INTO ${NAMESPACE}.customers VALUES
      (1, 'Customer 1', 'one@example.com', 10, 1, '2026-01-01 01:00:00'),
      (2, 'Customer 2', 'two@example.com', 20, 0, '2026-01-01 02:00:00')`,
    `CREATE VIEW ${NAMESPACE}.customer_summary AS
      SELECT id, name, toUInt64(0) AS order_count, lifetime_value AS total_value
      FROM ${NAMESPACE}.customers`,
  ]);
}

async function seedSqlite(driver: DatabaseDriver): Promise<void> {
  await executeAll(driver, [
    `CREATE TABLE row_left (
      id INTEGER PRIMARY KEY, amount NUMERIC NOT NULL, note TEXT,
      unicode_text TEXT NOT NULL, huge_code TEXT NOT NULL, date_text TEXT NOT NULL
    )`,
    `CREATE TABLE row_right (
      id INTEGER PRIMARY KEY, amount NUMERIC NOT NULL, note TEXT,
      unicode_text TEXT NOT NULL, huge_code TEXT NOT NULL, date_text TEXT NOT NULL
    )`,
    'CREATE INDEX row_left_amount_idx ON row_left (amount)',
    'CREATE INDEX row_right_amount_idx ON row_right (amount)',
    `INSERT INTO row_left VALUES ${leftRowsSql()}`,
    `INSERT INTO row_right VALUES ${rightRowsSql()}`,
    `CREATE TABLE schema_left (
      id INTEGER PRIMARY KEY, stable_text TEXT NOT NULL, changed_type NUMERIC,
      changed_nullable TEXT, commented TEXT, left_only TEXT
    )`,
    `CREATE TABLE schema_right (
      id INTEGER NOT NULL, stable_text TEXT NOT NULL, changed_type TEXT,
      changed_nullable TEXT NOT NULL, commented TEXT, right_only TEXT
    )`,
    `CREATE TABLE customers (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT,
      lifetime_value NUMERIC NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL
    )`,
    `INSERT INTO customers VALUES
      (1, 'Customer 1', 'one@example.com', 10, 1, '2026-01-01 01:00:00'),
      (2, 'Customer 2', 'two@example.com', 20, 0, '2026-01-01 02:00:00')`,
    `CREATE VIEW customer_summary AS
      SELECT id, name, 0 AS order_count, lifetime_value AS total_value FROM customers`,
  ]);
}

function leftRowsSql(): string {
  return `
    (1, 10.0000, 'stable', 'Привет', '${LARGE_TEXT_INTEGER}', '2026-08-01'),
    (2, 20.0000, NULL, '東京', '${LARGE_TEXT_INTEGER}', '2026-08-02'),
    (3, 30.0000, 'removed', 'café', '${LARGE_TEXT_INTEGER}', '2026-08-03'),
    (4, 716.9000, 'decimal', '😀', '${LARGE_TEXT_INTEGER}', '2026-08-04'),
    (5, 50.0000, NULL, 'naïve', '${LARGE_TEXT_INTEGER}', '2026-08-05'),
    (6, 60.0000, '', '中文', '${LARGE_TEXT_INTEGER}', '2026-08-06')`;
}

function rightRowsSql(): string {
  return `
    (1, 10, 'stable', 'Привет', '${LARGE_TEXT_INTEGER}', '2026-08-01'),
    (2, 20, '', '東京', '${LARGE_TEXT_INTEGER}', '2026-08-02'),
    (4, 716.9, 'decimal', '😀', '${LARGE_TEXT_INTEGER}', '2026-08-04'),
    (5, 50, NULL, 'naïve', '${LARGE_TEXT_INTEGER}', '2026-08-05'),
    (6, 60, '', '中文', '${LARGE_TEXT_INTEGER}', '2026-08-06'),
    (7, 70, 'added', 'مرحبا', '${LARGE_TEXT_INTEGER}', '2026-08-07')`;
}
