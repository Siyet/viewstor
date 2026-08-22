import { describe, it, expect } from 'vitest';
import { splitCustomQueryLimit, isReadOnlyQuery } from '../utils/queryHelpers';

describe('splitCustomQueryLimit', () => {
  it('returns query unchanged when no LIMIT present', () => {
    const result = splitCustomQueryLimit('SELECT * FROM users');
    expect(result.baseQuery).toBe('SELECT * FROM users');
    expect(result.userLimit).toBeUndefined();
    expect(result.userOffset).toBeUndefined();
  });

  it('strips trailing LIMIT and reports user limit', () => {
    const result = splitCustomQueryLimit('SELECT * FROM users LIMIT 50');
    expect(result.baseQuery).toBe('SELECT * FROM users');
    expect(result.userLimit).toBe(50);
    expect(result.userOffset).toBeUndefined();
  });

  it('strips trailing LIMIT + OFFSET and reports both', () => {
    const result = splitCustomQueryLimit('SELECT * FROM users LIMIT 50 OFFSET 100');
    expect(result.baseQuery).toBe('SELECT * FROM users');
    expect(result.userLimit).toBe(50);
    expect(result.userOffset).toBe(100);
  });

  it('is case-insensitive', () => {
    const result = splitCustomQueryLimit('select * from users limit 10');
    expect(result.baseQuery).toBe('select * from users');
    expect(result.userLimit).toBe(10);
  });

  it('keeps LIMIT inside a subquery intact', () => {
    const result = splitCustomQueryLimit('SELECT * FROM (SELECT * FROM t LIMIT 5) _s');
    expect(result.baseQuery).toBe('SELECT * FROM (SELECT * FROM t LIMIT 5) _s');
    expect(result.userLimit).toBeUndefined();
  });

  it('strips only the last LIMIT when subquery has its own', () => {
    const result = splitCustomQueryLimit('SELECT * FROM (SELECT * FROM t LIMIT 5) _s LIMIT 100');
    expect(result.baseQuery).toBe('SELECT * FROM (SELECT * FROM t LIMIT 5) _s');
    expect(result.userLimit).toBe(100);
  });

  it('preserves ORDER BY before LIMIT', () => {
    const result = splitCustomQueryLimit('SELECT * FROM users ORDER BY id DESC LIMIT 20');
    expect(result.baseQuery).toBe('SELECT * FROM users ORDER BY id DESC');
    expect(result.userLimit).toBe(20);
  });

  it('reports userOffset=0 explicitly when present', () => {
    const result = splitCustomQueryLimit('SELECT * FROM users LIMIT 10 OFFSET 0');
    expect(result.userLimit).toBe(10);
    expect(result.userOffset).toBe(0);
  });
});

describe('isReadOnlyQuery — happy path', () => {
  it.each([
    'SELECT 1',
    'SELECT * FROM users',
    'WITH cte AS (SELECT 1) SELECT * FROM cte',
    'EXPLAIN SELECT * FROM users',
    'EXPLAIN (FORMAT JSON) SELECT * FROM t',
    'SHOW TABLES',
    'SHOW search_path',
    'VALUES (1, 2), (3, 4)',
    'TABLE users',
    'DESCRIBE users',
    'DESC users',
    '  SELECT 1  ',
    'QUERY my-index vector=[0.1,0.2] topK=5',
    'STATS my-index',
    'LIST my-index namespace=ns1',
  ])('accepts %s', (sql) => {
    expect(isReadOnlyQuery(sql)).toBe(true);
  });

  it('accepts read-only chain of statements', () => {
    expect(isReadOnlyQuery('SELECT 1; SELECT 2')).toBe(true);
  });

  it('ignores trailing semicolon', () => {
    expect(isReadOnlyQuery('SELECT 1;')).toBe(true);
  });
});

describe('isReadOnlyQuery — bypass rejection (review item #1)', () => {
  it('rejects WITH ... INSERT', () => {
    expect(isReadOnlyQuery('WITH x AS (SELECT 1) INSERT INTO t VALUES (1)')).toBe(false);
  });

  it('rejects WITH ... UPDATE in CTE body', () => {
    expect(isReadOnlyQuery('WITH upd AS (UPDATE t SET x = 1 RETURNING *) SELECT * FROM upd')).toBe(false);
  });

  it('rejects WITH ... DELETE in CTE body', () => {
    expect(isReadOnlyQuery('WITH del AS (DELETE FROM t RETURNING *) SELECT count(*) FROM del')).toBe(false);
  });

  it('rejects EXPLAIN ANALYZE UPDATE (PG executes it)', () => {
    expect(isReadOnlyQuery('EXPLAIN ANALYZE UPDATE t SET x = 1')).toBe(false);
  });

  it('rejects EXPLAIN (ANALYZE) UPDATE in option list', () => {
    expect(isReadOnlyQuery('EXPLAIN (ANALYZE, FORMAT JSON) UPDATE t SET x = 1')).toBe(false);
  });

  it('rejects EXPLAIN UPDATE even without ANALYZE (caller-side defense)', () => {
    expect(isReadOnlyQuery('EXPLAIN UPDATE t SET x = 1')).toBe(false);
  });

  it('rejects multi-statement chain ending in DROP', () => {
    expect(isReadOnlyQuery('SELECT 1; DROP TABLE t')).toBe(false);
  });

  it('rejects multi-statement chain ending in TRUNCATE', () => {
    expect(isReadOnlyQuery('SELECT count(*) FROM t; TRUNCATE TABLE t')).toBe(false);
  });

  it('rejects bare DML', () => {
    expect(isReadOnlyQuery('INSERT INTO t VALUES (1)')).toBe(false);
    expect(isReadOnlyQuery('UPDATE t SET x = 1')).toBe(false);
    expect(isReadOnlyQuery('DELETE FROM t')).toBe(false);
    expect(isReadOnlyQuery('DROP TABLE t')).toBe(false);
    expect(isReadOnlyQuery('TRUNCATE t')).toBe(false);
    expect(isReadOnlyQuery('CREATE TABLE t (x int)')).toBe(false);
    expect(isReadOnlyQuery('GRANT ALL ON t TO public')).toBe(false);
    expect(isReadOnlyQuery('VACUUM t')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(isReadOnlyQuery('')).toBe(false);
    expect(isReadOnlyQuery('   ')).toBe(false);
    expect(isReadOnlyQuery(';')).toBe(false);
  });
});

describe('isReadOnlyQuery — false-positive avoidance (literals/identifiers)', () => {
  it('does not flag write verbs hidden inside string literals', () => {
    expect(isReadOnlyQuery('SELECT * FROM logs WHERE message = \'INSERT INTO failed\'')).toBe(true);
    expect(isReadOnlyQuery('SELECT \'DROP TABLE x\' AS sample')).toBe(true);
  });

  it('does not flag write verbs in double-quoted identifiers', () => {
    expect(isReadOnlyQuery('SELECT * FROM "delete_log"')).toBe(true);
    expect(isReadOnlyQuery('SELECT "INSERT_TIME" FROM events')).toBe(true);
  });

  it('does not flag write verbs in backtick identifiers (MySQL)', () => {
    expect(isReadOnlyQuery('SELECT `delete_count` FROM `audit`')).toBe(true);
  });

  it('does not flag write verbs inside comments', () => {
    expect(isReadOnlyQuery('SELECT 1 -- INSERT INTO t')).toBe(true);
    expect(isReadOnlyQuery('SELECT 1 /* DROP TABLE t */')).toBe(true);
  });

  it('does not flag substrings of identifiers (INSERT_LOG, DELETED_AT)', () => {
    expect(isReadOnlyQuery('SELECT INSERT_LOG, DELETED_AT FROM t')).toBe(true);
  });

  it('handles dollar-quoted PG strings', () => {
    expect(isReadOnlyQuery('SELECT $body$DROP TABLE evil$body$')).toBe(true);
  });
});
