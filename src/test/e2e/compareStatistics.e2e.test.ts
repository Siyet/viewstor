import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClickHouseDriver } from '../../drivers/clickhouse';
import { PostgresDriver } from '../../drivers/postgres';
import { SqliteDriver } from '../../drivers/sqlite';
import { computeStatsDiff } from '../../diff/diffEngine';
import { COMMON_STAT_KEYS, TableStatistic } from '../../types/schema';
import { isDockerAvailable, describeIf } from './helpers/dockerCheck';
import { startTestStack, stopTestStack, TestStack } from '../shared/containers';

describeIf(isDockerAvailable)('Compare Tables cross-type statistics E2E', () => {
  let stack: TestStack;
  let postgres: PostgresDriver;
  let clickhouse: ClickHouseDriver;
  let sqlite: SqliteDriver;
  let sqlitePath: string;
  let pgStats: TableStatistic[];
  let chStats: TableStatistic[];
  let sqliteStats: TableStatistic[];

  beforeAll(async () => {
    stack = await startTestStack({ pg: true, ch: true, redis: false });

    postgres = new PostgresDriver();
    await postgres.connect({
      id: 'compare-stats-pg',
      name: 'Compare Stats PostgreSQL',
      type: 'postgresql',
      host: stack.pg!.host,
      port: stack.pg!.port,
      username: stack.pg!.username,
      password: stack.pg!.password,
      database: stack.pg!.database,
    });

    clickhouse = new ClickHouseDriver();
    await clickhouse.connect({
      id: 'compare-stats-ch',
      name: 'Compare Stats ClickHouse',
      type: 'clickhouse',
      host: stack.ch!.host,
      port: stack.ch!.httpPort,
      username: stack.ch!.username,
      password: stack.ch!.password,
      database: stack.ch!.database,
    });

    sqlitePath = path.join(os.tmpdir(), `viewstor-compare-stats-${process.pid}-${Date.now()}.sqlite`);
    sqlite = new SqliteDriver();
    await sqlite.connect({
      id: 'compare-stats-sqlite',
      name: 'Compare Stats SQLite',
      type: 'sqlite',
      host: '',
      port: 0,
      database: sqlitePath,
    });
    await sqlite.execute('CREATE TABLE orders (id INTEGER PRIMARY KEY, amount NUMERIC NOT NULL)');
    await sqlite.execute('CREATE INDEX idx_compare_orders_amount ON orders (amount)');
    await sqlite.execute('INSERT INTO orders VALUES (1, 716.90), (2, 42), (3, 150), (4, 220.5), (5, 18.75), (6, 5000), (7, 0)');

    [pgStats, chStats, sqliteStats] = await Promise.all([
      postgres.getTableStatistics!('orders', 'public'),
      clickhouse.getTableStatistics!('orders', 'viewstor_test'),
      sqlite.getTableStatistics!('orders'),
    ]);
  });

  afterAll(async () => {
    await Promise.allSettled([
      postgres?.disconnect(),
      clickhouse?.disconnect(),
      sqlite?.disconnect(),
    ]);
    await stopTestStack(stack);
    for (const suffix of ['', '-wal', '-shm']) {
      const file = sqlitePath + suffix;
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });

  function assertPresenceContract(stats: TableStatistic[]) {
    const keys = new Set(stats.map(stat => stat.key));
    for (const key of COMMON_STAT_KEYS) expect(keys.has(key)).toBe(true);
  }

  it('all SQL drivers emit the normalized presence contract', async () => {
    assertPresenceContract(pgStats);
    assertPresenceContract(chStats);
    assertPresenceContract(sqliteStats);
  });

  it.each([
    ['PostgreSQL ↔ ClickHouse', 'pg', 'ch'],
    ['PostgreSQL ↔ SQLite', 'pg', 'sqlite'],
    ['ClickHouse ↔ SQLite', 'ch', 'sqlite'],
  ] as const)('%s compares only the explicit semantic allowlist', async (_label, leftKey, rightKey) => {
    const stats = {
      pg: pgStats,
      ch: chStats,
      sqlite: sqliteStats,
    };

    const diff = computeStatsDiff(stats[leftKey], stats[rightKey], { crossType: true });
    expect(diff.items.map(item => item.key)).toEqual(['row_count']);
    expect(diff.items[0]).toMatchObject({ leftValue: 7, rightValue: 7, status: 'same' });
    expect(diff.summary.leftHiddenCount).toBeGreaterThan(0);
    expect(diff.summary.rightHiddenCount).toBeGreaterThan(0);
  });
});
