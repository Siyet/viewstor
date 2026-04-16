import { describe, it, expect } from 'vitest';
import {
  sortTopTables,
  maxNumericValue,
  clampTopTablesLimit,
  clampAutoRefreshSeconds,
  isValidDatabaseStatistics,
} from '../stats/databaseStatsFormat';
import { TopTableEntry } from '../types/schema';

function row(overrides: Partial<TopTableEntry>): TopTableEntry {
  return {
    name: 'tbl',
    schema: 'public',
    rowCount: 0,
    sizeBytes: 0,
    indexesSizeBytes: 0,
    deadTuplesPct: 0,
    lastVacuum: null,
    ...overrides,
  };
}

describe('sortTopTables', () => {
  it('sorts by size desc by default', () => {
    const rows = [
      row({ name: 'a', sizeBytes: 100 }),
      row({ name: 'b', sizeBytes: 300 }),
      row({ name: 'c', sizeBytes: 200 }),
    ];
    const sorted = sortTopTables(rows, 'size', 'desc');
    expect(sorted.map(r => r.name)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by rows asc', () => {
    const rows = [
      row({ name: 'a', rowCount: 30 }),
      row({ name: 'b', rowCount: 10 }),
      row({ name: 'c', rowCount: 20 }),
    ];
    const sorted = sortTopTables(rows, 'rows', 'asc');
    expect(sorted.map(r => r.name)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by name alphabetically', () => {
    const rows = [
      row({ name: 'charlie' }),
      row({ name: 'alpha' }),
      row({ name: 'bravo' }),
    ];
    const sorted = sortTopTables(rows, 'name', 'asc');
    expect(sorted.map(r => r.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('puts null values last regardless of direction', () => {
    const rows = [
      row({ name: 'a', sizeBytes: null }),
      row({ name: 'b', sizeBytes: 100 }),
      row({ name: 'c', sizeBytes: null }),
    ];
    expect(sortTopTables(rows, 'size', 'desc').map(r => r.name)).toEqual(['b', 'a', 'c']);
    expect(sortTopTables(rows, 'size', 'asc').map(r => r.name)).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ name: 'a', sizeBytes: 10 }), row({ name: 'b', sizeBytes: 20 })];
    const snapshot = rows.map(r => r.name);
    sortTopTables(rows, 'size', 'desc');
    expect(rows.map(r => r.name)).toEqual(snapshot);
  });

  it('sorts by dead tuples %', () => {
    const rows = [
      row({ name: 'a', deadTuplesPct: 5 }),
      row({ name: 'b', deadTuplesPct: 50 }),
      row({ name: 'c', deadTuplesPct: 15 }),
    ];
    expect(sortTopTables(rows, 'dead', 'desc').map(r => r.name)).toEqual(['b', 'c', 'a']);
  });
});

describe('maxNumericValue', () => {
  it('returns 0 for empty input', () => {
    expect(maxNumericValue([])).toBe(0);
  });

  it('returns max of numeric values', () => {
    expect(maxNumericValue([1, 5, 3])).toBe(5);
  });

  it('ignores null / undefined', () => {
    expect(maxNumericValue([null, 5, undefined, 10, null])).toBe(10);
  });

  it('returns 0 when all values are null', () => {
    expect(maxNumericValue([null, null, undefined])).toBe(0);
  });

  it('returns 0 when max is negative', () => {
    // guardrail for bar normalization: negative sizes don't make sense
    expect(maxNumericValue([-1, -2, -3])).toBe(0);
  });
});

describe('clampTopTablesLimit', () => {
  it('returns fallback for non-numeric', () => {
    expect(clampTopTablesLimit(undefined)).toBe(50);
    expect(clampTopTablesLimit('abc')).toBe(50);
    expect(clampTopTablesLimit(null)).toBe(50);
  });

  it('honours custom fallback', () => {
    expect(clampTopTablesLimit(undefined, 25)).toBe(25);
  });

  it('clamps to [1, 500]', () => {
    expect(clampTopTablesLimit(0)).toBe(1);
    expect(clampTopTablesLimit(-5)).toBe(1);
    expect(clampTopTablesLimit(600)).toBe(500);
    expect(clampTopTablesLimit(NaN)).toBe(50);
  });

  it('floors non-integer values', () => {
    expect(clampTopTablesLimit(10.9)).toBe(10);
  });

  it('passes through valid values', () => {
    expect(clampTopTablesLimit(100)).toBe(100);
  });
});

describe('clampAutoRefreshSeconds', () => {
  it('treats non-numeric as disabled', () => {
    expect(clampAutoRefreshSeconds(undefined)).toBe(0);
    expect(clampAutoRefreshSeconds('abc')).toBe(0);
    expect(clampAutoRefreshSeconds(null)).toBe(0);
  });

  it('treats non-positive as disabled', () => {
    expect(clampAutoRefreshSeconds(0)).toBe(0);
    expect(clampAutoRefreshSeconds(-30)).toBe(0);
  });

  it('caps at 3600 (one hour)', () => {
    expect(clampAutoRefreshSeconds(99999)).toBe(3600);
  });

  it('floors fractional values', () => {
    expect(clampAutoRefreshSeconds(5.9)).toBe(5);
  });

  it('passes through valid values', () => {
    expect(clampAutoRefreshSeconds(30)).toBe(30);
    expect(clampAutoRefreshSeconds(3600)).toBe(3600);
  });
});

describe('isValidDatabaseStatistics', () => {
  it('returns true for fully-populated shape', () => {
    expect(
      isValidDatabaseStatistics({ overview: [], topTables: [], connectionLevel: [] }),
    ).toBe(true);
  });

  it('returns false for missing buckets', () => {
    expect(isValidDatabaseStatistics({ overview: [], topTables: [] })).toBe(false);
    expect(isValidDatabaseStatistics({})).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isValidDatabaseStatistics(null)).toBe(false);
    expect(isValidDatabaseStatistics('x')).toBe(false);
    expect(isValidDatabaseStatistics(42)).toBe(false);
  });

  it('returns false when any bucket is not an array', () => {
    expect(
      isValidDatabaseStatistics({ overview: 'x', topTables: [], connectionLevel: [] }),
    ).toBe(false);
  });
});
