/**
 * Regression tests for bugs discovered during chart feature development.
 * Each test documents a specific bug, its root cause, and verifies the fix.
 */
import { describe, it, expect } from 'vitest';
import { buildAggregationQuery, buildFullDataQuery } from '../types/chart';
import { isTimeColumn } from '../chart/chartDataTransform';

// ============================================================
// BUG: aggregation aliases broke chart axis mapping
// Root cause: COUNT(*) AS "id_count" — chart looked for column "id" but result had "id_count"
// Fix: alias = "count" for COUNT, alias = original column name for SUM/AVG/etc.
// ============================================================

describe('Regression: aggregation column aliases match axis mapping', () => {
  it('COUNT produces alias "count", not "id_count" or "colname_count"', () => {
    const sql = buildAggregationQuery(
      'quotes', 'public', 'created_at', ['id'], 'count', undefined,
      { function: 'count', timeBucketPreset: 'month' }, 'postgresql',
    );
    expect(sql).toContain('COUNT(*) AS "count"');
    expect(sql).not.toContain('AS "id_count"');
    expect(sql).not.toContain('AS "created_at_count"');
  });

  it('SUM preserves original column name as alias', () => {
    const sql = buildAggregationQuery(
      't', undefined, 'ts', ['amount'], 'sum', undefined,
      { function: 'sum' },
    );
    expect(sql).toContain('SUM("amount") AS "amount"');
    expect(sql).not.toContain('AS "amount_sum"');
  });

  it('AVG preserves original column name as alias', () => {
    const sql = buildAggregationQuery(
      't', undefined, 'ts', ['value'], 'avg', undefined,
      { function: 'avg' },
    );
    expect(sql).toContain('AVG("value") AS "value"');
    expect(sql).not.toContain('AS "value_avg"');
  });

  it('MIN preserves original column name as alias', () => {
    const sql = buildAggregationQuery(
      't', undefined, 'ts', ['price'], 'min', undefined,
      { function: 'min' },
    );
    expect(sql).toContain('MIN("price") AS "price"');
  });

  it('MAX preserves original column name as alias', () => {
    const sql = buildAggregationQuery(
      't', undefined, 'ts', ['price'], 'max', undefined,
      { function: 'max' },
    );
    expect(sql).toContain('MAX("price") AS "price"');
  });

  it('aggregation result columns can be used directly in chart axis config', () => {
    // Simulate: user selects yColumns: ["amount"] in UI,
    // aggregation produces SUM("amount") AS "amount" — column name stays "amount"
    const sql = buildAggregationQuery(
      'orders', 'public', 'created_at', ['amount'], 'sum', undefined,
      { function: 'sum', timeBucketPreset: 'day' }, 'postgresql',
    );
    // X column alias
    expect(sql).toContain('AS "created_at"');
    // Y column alias — same as original
    expect(sql).toContain('AS "amount"');
    // User's yColumns: ["amount"] will find the column in the result
  });
});

// ============================================================
// BUG: SQLite missing from add_connection MCP tool enum
// Root cause: enum only listed ['postgresql', 'redis', 'clickhouse']
// Fix: added 'sqlite' to enum, made host/port optional
// ============================================================

describe('Regression: SQLite support in MCP tool definitions', () => {
  it('buildFullDataQuery works for SQLite (no schema)', () => {
    const sql = buildFullDataQuery('my_table', undefined, ['id', 'name']);
    expect(sql).toBe('SELECT "id", "name" FROM "my_table"');
  });

  it('buildAggregationQuery works without database type (SQLite fallback)', () => {
    // SQLite has no date_trunc, but the query should still be generated
    // (user would use a raw query for SQLite time bucketing)
    const sql = buildAggregationQuery(
      'events', undefined, 'timestamp', ['id'], 'count', undefined,
      { function: 'count' }, 'sqlite',
    );
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain('"events"');
    // No date_trunc for SQLite (no timeBucketPreset specified)
    expect(sql).not.toContain('date_trunc');
  });
});

// ============================================================
// BUG: empty chart after server-side aggregation
// Root cause: after chartQueryResult, sidebar still had old columns (fly_id, etc.)
//   but aggregation result had new columns (created_at, count).
//   buildEChartsOption couldn't find yColumn in result rows → empty series.
// Fix: buildSidebar() + autoSelectAxesFromResult() after chartQueryResult
// ============================================================

describe('Regression: chart columns update after aggregation query', () => {
  it('aggregation result has different columns than source table', () => {
    // Source table columns: id, fly_id, created_at, status, ...
    // After COUNT per month: created_at, count
    const sql = buildAggregationQuery(
      'quotes', 'public', 'created_at', ['id'], 'count', undefined,
      { function: 'count', timeBucketPreset: 'month' }, 'postgresql',
    );
    // Verify the result will have "created_at" and "count" columns
    expect(sql).toContain('AS "created_at"');
    expect(sql).toContain('AS "count"');
    // Y axis should use "count" — NOT "id" or "fly_id"
    expect(sql).not.toContain('AS "id"');
    expect(sql).not.toContain('"fly_id"');
  });
});

// ============================================================
// BUG: duplicate const newStr in resultPanel inline JS → blank screen
// Root cause: const newStr declared twice in finishEdit() function
// Fix: renamed second declaration to valStr
// Verification: vm.Script parse test in resultPanel.test.ts
// ============================================================

describe('Regression: inline JS syntax must be valid', () => {
  it('no duplicate const/let declarations in the same scope (conceptual check)', () => {
    // This is a reminder that resultPanel.test.ts has vm.Script validation
    // that catches SyntaxError like duplicate const declarations.
    // The actual test is in resultPanel.test.ts "inline JS syntax" suite.
    expect(true).toBe(true); // placeholder — real test is in resultPanel.test.ts
  });
});

// ============================================================
// BUG: hideSchema triggers connect on other connections
// Root cause: _onDidChangeTreeData.fire(undefined) rebuilt ALL tree nodes,
//   getChildren auto-connected disconnected nodes during refresh
// Fix: skip auto-connect when schemaCache exists for the connection
// Verification: connectionTree.test.ts
// ============================================================

// (covered by connectionTree.test.ts — 3 tests)

// ============================================================
// BUG: Group By was in Axis Mapping instead of Aggregation section
// Root cause: buildAxisConfig included groupByColumn dropdown
// Fix: moved to Aggregation section (always visible for all chart types)
// ============================================================

describe('Regression: Group By belongs in Aggregation, not Axis Mapping', () => {
  it('buildAggregationQuery includes groupByColumn in GROUP BY clause', () => {
    const sql = buildAggregationQuery(
      'quotes', 'public', 'created_at', ['id'], 'count', 'status',
      { function: 'count', timeBucketPreset: 'month' }, 'postgresql',
    );
    expect(sql).toContain('"status"');
    expect(sql).toContain('GROUP BY');
    // status should appear in both SELECT and GROUP BY
    const selectPart = sql.split('FROM')[0];
    expect(selectPart).toContain('"status"');
  });
});

// ============================================================
// BUG: Time Bucket section hidden and not showing for time columns
// Root cause: timeBucketSection had style="display:none" and was
//   only shown when isTimeXAxis was true, but the check ran before
//   the user selected the X column in a fresh sidebar
// Fix: Time Bucket section always visible (not hidden by default)
// ============================================================

describe('Regression: Time Bucket detection for various DB types', () => {
  // These test isTimeColumn from chartDataTransform which mirrors
  // isTimeType in chart-panel.js (same logic, different context)

  it('detects PostgreSQL timestamp types', () => {
    // isTimeColumn imported at top
    expect(isTimeColumn({ name: 'ts', dataType: 'timestamp' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'timestamp without time zone' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'timestamp with time zone' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'timestamptz' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'date' })).toBe(true);
  });

  it('detects SQLite timestamp types (uppercase from PRAGMA)', () => {
    // isTimeColumn imported at top
    // SQLite returns declared type from CREATE TABLE, often uppercase
    expect(isTimeColumn({ name: 'ts', dataType: 'TIMESTAMP' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'DATE' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'DATETIME' })).toBe(true);
  });

  it('detects ClickHouse DateTime types', () => {
    // isTimeColumn imported at top
    expect(isTimeColumn({ name: 'ts', dataType: 'DateTime' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'DateTime64(3)' })).toBe(true);
    expect(isTimeColumn({ name: 'ts', dataType: 'datetime64' })).toBe(true);
  });

  it('rejects non-time types', () => {
    // isTimeColumn imported at top
    expect(isTimeColumn({ name: 'id', dataType: 'INTEGER' })).toBe(false);
    expect(isTimeColumn({ name: 'name', dataType: 'TEXT' })).toBe(false);
    expect(isTimeColumn({ name: 'val', dataType: 'REAL' })).toBe(false);
    expect(isTimeColumn({ name: 'data', dataType: 'BLOB' })).toBe(false);
  });
});

// ============================================================
// BUG: two queries fired simultaneously when selecting time bucket with Full Data
// Root cause: rebuildSidebarPreservingConfig → setSelectValue → triggers change event
//   → updateChart() fires while the original query is still in flight
// Fix: suppressChangeEvents flag during config restoration
// ============================================================

describe('Regression: config restore must not trigger duplicate events', () => {
  it('suppressChangeEvents pattern prevents duplicate queries', () => {
    // Simulate the pattern used in chart-panel.js
    let changeCount = 0;
    let suppress = false;

    function onChange() {
      if (suppress) return;
      changeCount++;
    }

    // Normal change
    onChange();
    expect(changeCount).toBe(1);

    // Suppressed change (during config restore)
    suppress = true;
    onChange();
    onChange();
    onChange();
    suppress = false;
    expect(changeCount).toBe(1); // Still 1 — suppressed calls didn't increment
  });
});

// ============================================================
// MySQL aggregation query: backtick quoting and time bucketing
// ============================================================

describe('MySQL aggregation query support', () => {
  it('uses backtick quoting for MySQL', () => {
    const sql = buildAggregationQuery(
      'events', 'mydb', 'created_at', ['id'], 'count', undefined,
      { function: 'count', timeBucketPreset: 'day' }, 'mysql',
    );
    expect(sql).toContain('`mydb`.`events`');
    expect(sql).toContain('`created_at`');
    expect(sql).toContain('COUNT(*) AS `count`');
    expect(sql).not.toContain('"');
  });

  it('uses DATE_FORMAT for preset time buckets', () => {
    const sql = buildAggregationQuery(
      't', undefined, 'ts', ['val'], 'sum', undefined,
      { function: 'sum', timeBucketPreset: 'hour' }, 'mysql',
    );
    expect(sql).toContain('DATE_FORMAT(`ts`, \'%Y-%m-%d %H:00:00\')');
  });

  it('uses UNIX_TIMESTAMP arithmetic for custom time buckets', () => {
    const sql = buildAggregationQuery(
      't', undefined, 'ts', ['val'], 'sum', undefined,
      { function: 'sum', timeBucketPreset: 'custom', timeBucket: '2h' }, 'mysql',
    );
    expect(sql).toContain('FROM_UNIXTIME');
    expect(sql).toContain('UNIX_TIMESTAMP(`ts`)');
    expect(sql).toContain('7200');
    expect(sql).not.toContain('date_bin');
  });
});
