import { describe, it, expect } from 'vitest';
import {
  classifyQuery,
  classifyStatement,
  needsApproval,
  describeRisk,
  splitStatements,
} from '../mcp/queryRisk';

describe('classifyStatement', () => {
  it.each([
    ['SELECT 1', 'read', 'SELECT'],
    ['  \n\t SELECT * FROM t', 'read', 'SELECT'],
    ['WITH cte AS (SELECT 1) SELECT * FROM cte', 'read', 'WITH'],
    ['EXPLAIN SELECT * FROM t', 'read', 'EXPLAIN'],
    ['EXPLAIN ANALYZE SELECT * FROM t', 'read', 'EXPLAIN'],
    ['SHOW TABLES', 'read', 'SHOW'],
    ['DESCRIBE users', 'read', 'DESCRIBE'],
    ['DESC users', 'read', 'DESCRIBE'],
    ['PRAGMA table_info(users)', 'read', 'PRAGMA'],
  ])('reads: %s -> %s/%s', (sql, kind, verb) => {
    const r = classifyStatement(sql);
    expect(r.kind).toBe(kind);
    if (r.kind === 'read') expect(r.verb).toBe(verb);
  });

  it.each([
    ['INSERT INTO t VALUES (1)', 'INSERT'],
    ['UPDATE t SET x = 1', 'UPDATE'],
    ['DELETE FROM t', 'DELETE'],
    ['MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET x = 1', 'MERGE'],
    ['REPLACE INTO t VALUES (1)', 'REPLACE'],
    ['COPY t FROM STDIN', 'COPY'],
  ])('writes: %s -> write/%s', (sql, verb) => {
    const r = classifyStatement(sql);
    expect(r.kind).toBe('write');
    if (r.kind === 'write') expect(r.verb).toBe(verb);
  });

  it.each([
    ['CREATE TABLE t (id int)', 'CREATE'],
    ['ALTER TABLE t ADD COLUMN x int', 'ALTER'],
    ['DROP TABLE t', 'DROP'],
    ['TRUNCATE TABLE t', 'TRUNCATE'],
    ['RENAME TABLE t TO t2', 'RENAME'],
  ])('ddl: %s -> ddl/%s', (sql, verb) => {
    const r = classifyStatement(sql);
    expect(r.kind).toBe('ddl');
    if (r.kind === 'ddl') expect(r.verb).toBe(verb);
  });

  it.each([
    ['GRANT SELECT ON t TO r', 'GRANT'],
    ['REVOKE ALL ON t FROM r', 'REVOKE'],
    ['VACUUM ANALYZE t', 'VACUUM'],
    ['ANALYZE t', 'ANALYZE'],
    ['REINDEX TABLE t', 'REINDEX'],
    ['CLUSTER t', 'CLUSTER'],
    ['OPTIMIZE TABLE t', 'OPTIMIZE'],
    ['ATTACH DATABASE \'f.db\' AS aux', 'ATTACH'],
    ['DETACH DATABASE aux', 'DETACH'],
    ['SET statement_timeout = 1000', 'SET'],
    ['RESET statement_timeout', 'RESET'],
  ])('admin: %s -> admin/%s', (sql, verb) => {
    const r = classifyStatement(sql);
    expect(r.kind).toBe('admin');
    if (r.kind === 'admin') expect(r.verb).toBe(verb);
  });

  it.each([
    '',
    '   ',
    '-- just a comment',
    '/* block */',
    'MAKE TEA',
    '42',
  ])('unknown: %s', (sql) => {
    expect(classifyStatement(sql).kind).toBe('unknown');
  });

  it('strips leading line comments before classifying', () => {
    const r = classifyStatement('-- note\n-- more\nSELECT 1');
    expect(r.kind).toBe('read');
  });

  it('strips leading block comments before classifying', () => {
    const r = classifyStatement('/* hello */ DELETE FROM users');
    expect(r.kind).toBe('write');
    if (r.kind === 'write') expect(r.verb).toBe('DELETE');
  });

  it('case-insensitive verb', () => {
    expect(classifyStatement('select 1').kind).toBe('read');
    expect(classifyStatement('Update t set x=1').kind).toBe('write');
  });
});

describe('splitStatements', () => {
  it('splits on top-level semicolons', () => {
    expect(splitStatements('SELECT 1; SELECT 2; SELECT 3'))
      .toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
  });

  it('ignores semicolons inside single-quoted strings', () => {
    expect(splitStatements('SELECT \';\';SELECT 1')).toEqual([
      'SELECT \';\'',
      'SELECT 1',
    ]);
  });

  it('ignores semicolons inside double-quoted identifiers', () => {
    expect(splitStatements('SELECT "a;b"; SELECT 1')).toEqual([
      'SELECT "a;b"',
      'SELECT 1',
    ]);
  });

  it('ignores semicolons inside line comments', () => {
    expect(splitStatements('SELECT 1 -- a;b\n; SELECT 2'))
      .toEqual(['SELECT 1 -- a;b', 'SELECT 2']);
  });

  it('ignores semicolons inside block comments', () => {
    expect(splitStatements('SELECT 1 /* a;b */; SELECT 2'))
      .toEqual(['SELECT 1 /* a;b */', 'SELECT 2']);
  });

  it('empty input → empty', () => {
    expect(splitStatements('')).toEqual([]);
    expect(splitStatements('  ;  ;  ')).toEqual([]);
  });
});

describe('classifyQuery (multi-statement severity)', () => {
  it('write + read returns write', () => {
    expect(classifyQuery('SELECT 1; UPDATE t SET x=1').kind).toBe('write');
  });

  it('read + ddl returns ddl', () => {
    expect(classifyQuery('SELECT 1; DROP TABLE t').kind).toBe('ddl');
  });

  it('write + ddl returns ddl', () => {
    expect(classifyQuery('INSERT INTO t VALUES (1); CREATE INDEX i ON t (x)').kind).toBe('ddl');
  });

  it('anything + unknown returns unknown', () => {
    expect(classifyQuery('SELECT 1; ZZZ').kind).toBe('unknown');
    expect(classifyQuery('DROP TABLE t; ZZZ').kind).toBe('unknown');
  });

  it('only read statements returns read', () => {
    expect(classifyQuery('SELECT 1; SELECT 2').kind).toBe('read');
  });

  it('empty input returns unknown', () => {
    expect(classifyQuery('').kind).toBe('unknown');
    expect(classifyQuery('   ').kind).toBe('unknown');
  });
});

describe('needsApproval', () => {
  it('never mode never prompts, but read also never prompts', () => {
    expect(needsApproval({ kind: 'read', verb: 'SELECT' }, 'never')).toBe(false);
    expect(needsApproval({ kind: 'write', verb: 'UPDATE' }, 'never')).toBe(false);
    expect(needsApproval({ kind: 'ddl', verb: 'DROP' }, 'never')).toBe(false);
    expect(needsApproval({ kind: 'unknown' }, 'never')).toBe(false);
  });

  it('always mode prompts for every non-read', () => {
    expect(needsApproval({ kind: 'read', verb: 'SELECT' }, 'always')).toBe(false);
    expect(needsApproval({ kind: 'write', verb: 'INSERT' }, 'always')).toBe(true);
    expect(needsApproval({ kind: 'write', verb: 'DELETE' }, 'always')).toBe(true);
    expect(needsApproval({ kind: 'ddl', verb: 'ALTER' }, 'always')).toBe(true);
    expect(needsApproval({ kind: 'admin', verb: 'GRANT' }, 'always')).toBe(true);
    expect(needsApproval({ kind: 'unknown' }, 'always')).toBe(true);
  });

  it('ddl-and-admin mode auto-approves writes but prompts for ddl/admin/unknown', () => {
    expect(needsApproval({ kind: 'read', verb: 'SELECT' }, 'ddl-and-admin')).toBe(false);
    expect(needsApproval({ kind: 'write', verb: 'INSERT' }, 'ddl-and-admin')).toBe(false);
    expect(needsApproval({ kind: 'write', verb: 'UPDATE' }, 'ddl-and-admin')).toBe(false);
    expect(needsApproval({ kind: 'ddl', verb: 'DROP' }, 'ddl-and-admin')).toBe(true);
    expect(needsApproval({ kind: 'admin', verb: 'VACUUM' }, 'ddl-and-admin')).toBe(true);
    expect(needsApproval({ kind: 'unknown' }, 'ddl-and-admin')).toBe(true);
  });
});

describe('describeRisk', () => {
  it('produces human-readable strings with verbs', () => {
    expect(describeRisk({ kind: 'read', verb: 'SELECT' })).toContain('SELECT');
    expect(describeRisk({ kind: 'write', verb: 'DELETE' })).toContain('DELETE');
    expect(describeRisk({ kind: 'ddl', verb: 'DROP' })).toContain('DROP');
    expect(describeRisk({ kind: 'admin', verb: 'GRANT' })).toContain('GRANT');
    expect(describeRisk({ kind: 'unknown' })).toMatch(/unclassified/i);
  });
});
