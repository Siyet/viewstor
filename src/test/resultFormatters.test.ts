import { describe, it, expect } from 'vitest';
import {
  isNumericType,
  formatOneRow,
  applySortToQuery,
  tokenizeSql,
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

  it('formats NULL and empty values as NULL', () => {
    const result = formatOneRow(
      [['NULL', '', 'null', 'test']],
      ['varchar', 'varchar', 'varchar', 'varchar'],
      '\'',
    );
    expect(result).toBe('NULL, NULL, NULL, \'test\'');
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

  it('NULL is uppercase in SQL mode (single quotes)', () => {
    const result = formatOneRow(
      [['NULL', '', 'test']],
      ['varchar', 'varchar', 'varchar'],
      '\'',
    );
    expect(result).toBe('NULL, NULL, \'test\'');
  });

  it('null is lowercase in JSON mode (double quotes)', () => {
    const result = formatOneRow(
      [['NULL', '', 'test']],
      ['varchar', 'varchar', 'varchar'],
      '"',
    );
    expect(result).toBe('null, null, "test"');
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

describe('tokenizeSql', () => {
  it('tokenizes SELECT keyword', () => {
    const tokens = tokenizeSql('SELECT');
    expect(tokens).toEqual([{ type: 'keyword', value: 'SELECT' }]);
  });

  it('tokenizes a simple query', () => {
    const tokens = tokenizeSql('SELECT * FROM users');
    const types = tokens.filter(t => t.type !== 'text').map(t => [t.type, t.value]);
    expect(types).toEqual([
      ['keyword', 'SELECT'],
      ['operator', '*'],
      ['keyword', 'FROM'],
    ]);
  });

  it('tokenizes string literals', () => {
    const tokens = tokenizeSql('\'hello world\'');
    expect(tokens).toEqual([{ type: 'string', value: '\'hello world\'' }]);
  });

  it('tokenizes numbers', () => {
    const tokens = tokenizeSql('42');
    expect(tokens).toEqual([{ type: 'number', value: '42' }]);
  });

  it('tokenizes negative numbers', () => {
    const tokens = tokenizeSql('-3.14');
    expect(tokens).toEqual([{ type: 'number', value: '-3.14' }]);
  });

  it('tokenizes comments', () => {
    const tokens = tokenizeSql('-- this is a comment');
    expect(tokens).toEqual([{ type: 'comment', value: '-- this is a comment' }]);
  });

  it('tokenizes operators', () => {
    const tokens = tokenizeSql('>=');
    expect(tokens).toEqual([{ type: 'operator', value: '>=' }]);
  });

  it('tokenizes identifiers as text', () => {
    const tokens = tokenizeSql('my_table');
    expect(tokens).toEqual([{ type: 'text', value: 'my_table' }]);
  });

  it('tokenizes complex query with all token types', () => {
    const tokens = tokenizeSql('SELECT name FROM users WHERE id = 1 -- filter');
    const keywords = tokens.filter(t => t.type === 'keyword').map(t => t.value);
    expect(keywords).toEqual(['SELECT', 'FROM', 'WHERE']);

    const numbers = tokens.filter(t => t.type === 'number').map(t => t.value);
    expect(numbers).toEqual(['1']);

    const comments = tokens.filter(t => t.type === 'comment').map(t => t.value);
    expect(comments).toEqual(['-- filter']);

    const operators = tokens.filter(t => t.type === 'operator').map(t => t.value);
    expect(operators).toEqual(['=']);
  });

  it('handles case-insensitive keywords', () => {
    const tokens = tokenizeSql('select from where');
    const keywords = tokens.filter(t => t.type === 'keyword').map(t => t.value);
    expect(keywords).toEqual(['select', 'from', 'where']);
  });

  it('tokenizes parentheses and commas as operators', () => {
    const tokens = tokenizeSql('(a, b)');
    const operators = tokens.filter(t => t.type === 'operator').map(t => t.value);
    expect(operators).toEqual(['(', ',', ')']);
  });
});
