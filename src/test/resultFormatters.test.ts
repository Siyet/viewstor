import { describe, it, expect } from 'vitest';
import {
  isNumericType,
  formatOneRow,
  applySortToQuery,
} from '../utils/resultFormatters';

describe('isNumericType', () => {
  it.each([
    'integer', 'bigint', 'smallint', 'numeric', 'decimal', 'real',
    'float', 'double', 'money', 'serial', 'bigserial', 'oid',
    'Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64',
    'Float32', 'Float64', 'INTEGER', 'BIGINT',
  ])('returns true for %s', (type) => {
    expect(isNumericType(type)).toBe(true);
  });

  it.each(['boolean', 'Bool'])('returns true for boolean type %s', (type) => {
    expect(isNumericType(type)).toBe(true);
  });

  it.each(['varchar', 'text', 'timestamp', 'jsonb', 'uuid', 'date'])('returns false for %s', (type) => {
    expect(isNumericType(type)).toBe(false);
  });
});

describe('formatOneRow', () => {
  it('formats numeric values without quotes', () => {
    const result = formatOneRow(
      [['42', 'Alice']],
      ['integer', 'varchar'],
      '\'',
    );
    expect(result).toBe('42, \'Alice\'');
  });

  it('formats empty values and actual null as NULL, but string "NULL" is quoted', () => {
    const result = formatOneRow(
      [['NULL', '', 'null', 'test']],
      ['varchar', 'varchar', 'varchar', 'varchar'],
      '\'',
    );
    expect(result).toBe('\'NULL\', NULL, \'null\', \'test\'');
  });

  it('escapes single quotes in values', () => {
    const result = formatOneRow(
      [['O\'Brien']],
      ['varchar'],
      '\'',
    );
    expect(result).toBe('\'O\'\'Brien\'');
  });

  it('escapes double quotes in values', () => {
    const result = formatOneRow(
      [['say "hello"']],
      ['varchar'],
      '"',
    );
    expect(result).toBe('"say \\"hello\\""');
  });

  it('handles multiple rows concatenated', () => {
    const result = formatOneRow(
      [['1', 'Alice'], ['2', 'Bob']],
      ['integer', 'varchar'],
      '\'',
    );
    expect(result).toBe('1, \'Alice\', 2, \'Bob\'');
  });

  it('handles boolean types as numeric (unquoted)', () => {
    const result = formatOneRow(
      [['true', 'false']],
      ['boolean', 'Bool'],
      '\'',
    );
    expect(result).toBe('true, false');
  });

  it('formats with double quotes', () => {
    const result = formatOneRow(
      [['1', 'Alice', 'alice@test.com']],
      ['integer', 'varchar', 'text'],
      '"',
    );
    expect(result).toBe('1, "Alice", "alice@test.com"');
  });

  it('NULL is uppercase in SQL mode (single quotes) for empty values only', () => {
    const result = formatOneRow(
      [['', 'test']],
      ['varchar', 'varchar'],
      '\'',
    );
    expect(result).toBe('NULL, \'test\'');
  });

  it('null is lowercase in JSON mode (double quotes) for empty values only', () => {
    const result = formatOneRow(
      [['', 'test']],
      ['varchar', 'varchar'],
      '"',
    );
    expect(result).toBe('null, "test"');
  });
});

describe('applySortToQuery', () => {
  it('appends ORDER BY to simple SELECT (no quotes for simple names)', () => {
    const result = applySortToQuery(
      'SELECT * FROM users',
      [{ column: 'name', direction: 'asc' }],
    );
    expect(result).toBe('SELECT * FROM users ORDER BY name ASC');
  });

  it('removes trailing semicolons', () => {
    const result = applySortToQuery(
      'SELECT * FROM users;',
      [{ column: 'id', direction: 'desc' }],
    );
    expect(result).toBe('SELECT * FROM users ORDER BY id DESC');
  });

  it('replaces existing ORDER BY', () => {
    const result = applySortToQuery(
      'SELECT * FROM users ORDER BY name ASC',
      [{ column: 'id', direction: 'desc' }],
    );
    expect(result).toBe('SELECT * FROM users ORDER BY id DESC');
  });

  it('inserts ORDER BY before LIMIT', () => {
    const result = applySortToQuery(
      'SELECT * FROM users LIMIT 100',
      [{ column: 'name', direction: 'asc' }],
    );
    expect(result).toBe('SELECT * FROM users ORDER BY name ASC LIMIT 100');
  });

  it('replaces ORDER BY and preserves LIMIT', () => {
    const result = applySortToQuery(
      'SELECT * FROM users ORDER BY name ASC LIMIT 50',
      [{ column: 'id', direction: 'desc' }],
    );
    expect(result).toBe('SELECT * FROM users ORDER BY id DESC LIMIT 50');
  });

  it('handles multiple sort columns', () => {
    const result = applySortToQuery(
      'SELECT * FROM orders',
      [
        { column: 'user_id', direction: 'asc' },
        { column: 'amount', direction: 'desc' },
      ],
    );
    expect(result).toBe('SELECT * FROM orders ORDER BY user_id ASC, amount DESC');
  });

  it('removes ORDER BY when sorts is empty', () => {
    const result = applySortToQuery(
      'SELECT * FROM users ORDER BY name ASC',
      [],
    );
    expect(result).toBe('SELECT * FROM users');
  });

  it('removes ORDER BY and preserves LIMIT when sorts is empty', () => {
    const result = applySortToQuery(
      'SELECT * FROM users ORDER BY name ASC LIMIT 100',
      [],
    );
    expect(result).toBe('SELECT * FROM users LIMIT 100');
  });

  it('handles OFFSET after LIMIT', () => {
    const result = applySortToQuery(
      'SELECT * FROM users LIMIT 100 OFFSET 50',
      [{ column: 'id', direction: 'asc' }],
    );
    expect(result).toBe('SELECT * FROM users ORDER BY id ASC LIMIT 100 OFFSET 50');
  });

  it('quotes reserved word column names', () => {
    const result = applySortToQuery(
      'SELECT * FROM items',
      [{ column: 'order', direction: 'asc' }],
    );
    expect(result).toBe('SELECT * FROM items ORDER BY "order" ASC');
  });

  it('quotes uppercase column names', () => {
    const result = applySortToQuery(
      'SELECT * FROM t',
      [{ column: 'MyColumn', direction: 'desc' }],
    );
    expect(result).toBe('SELECT * FROM t ORDER BY "MyColumn" DESC');
  });
});
