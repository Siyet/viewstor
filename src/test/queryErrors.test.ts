import { describe, it, expect } from 'vitest';
import {
  levenshtein,
  parseTablesFromQuery,
  enhanceColumnError,
  buildUpdateSql,
  buildDeleteSql,
  buildInsertDefaultSql,
  quoteTable,
  quoteIdentifier,
  sqlValue,
  splitStatements,
  getStatementAtOffset,
} from '../utils/queryHelpers';

describe('levenshtein', () => {
  it('should return 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
  });

  it('should return length of other string when one is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('should handle single character difference', () => {
    expect(levenshtein('cat', 'car')).toBe(1);
    expect(levenshtein('cat', 'bat')).toBe(1);
  });

  it('should handle insertion', () => {
    expect(levenshtein('cat', 'cats')).toBe(1);
  });

  it('should handle deletion', () => {
    expect(levenshtein('cats', 'cat')).toBe(1);
  });

  it('should handle transposition-like edits', () => {
    // "ab" → "ba" requires 2 edits (not 1, since Levenshtein doesn't count transposition as 1)
    expect(levenshtein('ab', 'ba')).toBe(2);
  });

  it('should handle real column name typos', () => {
    expect(levenshtein('product_acces', 'product_access')).toBe(1);
    expect(levenshtein('prodcut_access', 'product_access')).toBe(2);
    expect(levenshtein('username', 'user_name')).toBe(1);
  });

  it('should return high distance for completely different strings', () => {
    expect(levenshtein('abc', 'xyz')).toBe(3);
    expect(levenshtein('hello', 'world')).toBeGreaterThan(3);
  });
});

describe('parseTablesFromQuery', () => {
  it('should parse simple FROM clause', () => {
    expect(parseTablesFromQuery('SELECT * FROM users')).toEqual([{ table: 'users' }]);
  });

  it('should parse schema-qualified table', () => {
    expect(parseTablesFromQuery('SELECT * FROM public.users')).toEqual([
      { schema: 'public', table: 'users' },
    ]);
  });

  it('should parse quoted identifiers', () => {
    expect(parseTablesFromQuery('SELECT * FROM "public"."users"')).toEqual([
      { schema: 'public', table: 'users' },
    ]);
  });

  it('should parse JOIN clauses', () => {
    const result = parseTablesFromQuery(
      'SELECT * FROM users JOIN orders ON users.id = orders.user_id',
    );
    expect(result).toEqual([{ table: 'users' }, { table: 'orders' }]);
  });

  it('should parse multiple JOINs with schemas', () => {
    const result = parseTablesFromQuery(
      'SELECT * FROM public.users JOIN public.orders ON 1=1 LEFT JOIN audit.logs ON 1=1',
    );
    expect(result).toEqual([
      { schema: 'public', table: 'users' },
      { schema: 'public', table: 'orders' },
      { schema: 'audit', table: 'logs' },
    ]);
  });

  it('should return empty for queries without FROM', () => {
    expect(parseTablesFromQuery('SELECT 1')).toEqual([]);
    expect(parseTablesFromQuery('SHOW TABLES')).toEqual([]);
  });

  it('should be case-insensitive for FROM/JOIN keywords', () => {
    expect(parseTablesFromQuery('select * from Users')).toEqual([{ table: 'Users' }]);
    expect(parseTablesFromQuery('SELECT * From users join orders on 1=1')).toEqual([
      { table: 'users' },
      { table: 'orders' },
    ]);
  });
});

describe('enhanceColumnError', () => {
  const mockDriver = (columns: string[]) => ({
    getTableInfo: async () => ({
      name: 'test',
      columns: columns.map(name => ({ name, dataType: 'text', nullable: true, isPrimaryKey: false })),
    }),
  }) as any;

  it('should suggest closest column for PG error', async () => {
    const result = await enhanceColumnError(
      'column "product_acces" does not exist',
      'SELECT product_acces FROM public.products',
      mockDriver(['id', 'name', 'product_access', 'price']),
    );
    expect(result).toContain('Did you mean: "product_access"?');
  });

  it('should suggest closest column for ClickHouse error', async () => {
    const result = await enhanceColumnError(
      'Unknown column \'usrname\'',
      'SELECT usrname FROM users',
      mockDriver(['id', 'username', 'email']),
    );
    expect(result).toContain('Did you mean: "username"?');
  });

  it('should not suggest when distance > 3', async () => {
    const result = await enhanceColumnError(
      'column "completely_wrong" does not exist',
      'SELECT completely_wrong FROM users',
      mockDriver(['id', 'username', 'email']),
    );
    expect(result).not.toContain('Did you mean');
  });

  it('should not suggest when column matches exactly (distance 0)', async () => {
    const result = await enhanceColumnError(
      'column "id" does not exist',
      'SELECT id FROM users',
      mockDriver(['id', 'name']),
    );
    // distance 0 means exact match — no suggestion needed
    expect(result).not.toContain('Did you mean');
  });

  it('should return original error for non-column errors', async () => {
    const error = 'relation "users" does not exist';
    const result = await enhanceColumnError(
      error,
      'SELECT * FROM users',
      mockDriver(['id']),
    );
    expect(result).toBe(error);
  });

  it('should return original error when no tables in query', async () => {
    const error = 'column "x" does not exist';
    const result = await enhanceColumnError(error, 'SELECT 1', mockDriver(['id']));
    expect(result).toBe(error);
  });

  it('should handle driver.getTableInfo failure gracefully', async () => {
    const failingDriver = {
      getTableInfo: async () => { throw new Error('no access'); },
    } as any;
    const error = 'column "x" does not exist';
    const result = await enhanceColumnError(error, 'SELECT x FROM users', failingDriver);
    expect(result).toBe(error);
  });

  it('should be case-insensitive for column matching', async () => {
    const result = await enhanceColumnError(
      'column "Usrname" does not exist',
      'SELECT Usrname FROM users',
      mockDriver(['username']),
    );
    expect(result).toContain('Did you mean: "username"?');
  });
});

describe('quoteIdentifier', () => {
  it('should not quote simple lowercase identifiers', () => {
    expect(quoteIdentifier('users')).toBe('users');
    expect(quoteIdentifier('my_table')).toBe('my_table');
    expect(quoteIdentifier('col1')).toBe('col1');
  });

  it('should quote reserved words', () => {
    expect(quoteIdentifier('order')).toBe('"order"');
    expect(quoteIdentifier('select')).toBe('"select"');
    expect(quoteIdentifier('user')).toBe('"user"');
    expect(quoteIdentifier('type')).toBe('"type"');
    expect(quoteIdentifier('table')).toBe('"table"');
  });

  it('should quote identifiers with uppercase', () => {
    expect(quoteIdentifier('Users')).toBe('"Users"');
    expect(quoteIdentifier('MyTable')).toBe('"MyTable"');
  });

  it('should quote identifiers with special characters', () => {
    expect(quoteIdentifier('my-table')).toBe('"my-table"');
    expect(quoteIdentifier('my table')).toBe('"my table"');
  });

  it('should quote identifiers starting with a digit', () => {
    expect(quoteIdentifier('1table')).toBe('"1table"');
  });
});

describe('quoteTable', () => {
  it('should not quote simple names', () => {
    expect(quoteTable('users')).toBe('users');
  });

  it('should not quote simple schema.table', () => {
    expect(quoteTable('users', 'public')).toBe('public.users');
  });

  it('should quote reserved word table name', () => {
    expect(quoteTable('order')).toBe('"order"');
    expect(quoteTable('user', 'public')).toBe('public."user"');
  });

  it('should quote reserved word schema', () => {
    expect(quoteTable('items', 'default')).toBe('"default".items');
  });
});

describe('sqlValue', () => {
  it('should return NULL for null/undefined', () => {
    expect(sqlValue(null)).toBe('NULL');
    expect(sqlValue(undefined)).toBe('NULL');
  });

  it('should quote strings', () => {
    expect(sqlValue('hello')).toBe('\'hello\'');
  });

  it('should escape single quotes', () => {
    expect(sqlValue('it\'s')).toBe('\'it\'\'s\'');
  });

  it('should convert numbers to strings', () => {
    expect(sqlValue(42)).toBe('\'42\'');
  });

  it('should JSON.stringify objects', () => {
    expect(sqlValue({ key: 'value' })).toBe('\'{"key":"value"}\'');
  });

  it('should JSON.stringify arrays', () => {
    expect(sqlValue([1, 2, 3])).toBe('\'[1,2,3]\'');
  });

  it('should escape quotes in JSON', () => {
    expect(sqlValue({ name: 'O\'Brien' })).toBe('\'{"name":"O\'\'Brien"}\'');
  });

  it('should output numbers without quotes for numeric types', () => {
    expect(sqlValue(42, 'integer')).toBe('42');
    expect(sqlValue(244, 'bigint')).toBe('244');
    expect(sqlValue(3.14, 'numeric')).toBe('3.14');
    expect(sqlValue('100', 'int4')).toBe('100');
  });

  it('should output booleans as TRUE/FALSE', () => {
    expect(sqlValue(true, 'boolean')).toBe('TRUE');
    expect(sqlValue(false, 'bool')).toBe('FALSE');
    expect(sqlValue('true', 'boolean')).toBe('TRUE');
  });

  it('should still quote numbers without type info', () => {
    expect(sqlValue(42)).toBe('\'42\'');
  });

  it('should quote non-numeric string even with numeric type', () => {
    expect(sqlValue('not-a-number', 'integer')).toBe('\'not-a-number\'');
  });

  it('should handle empty string', () => {
    expect(sqlValue('')).toBe('\'\'');
  });

  it('should handle zero', () => {
    expect(sqlValue(0, 'integer')).toBe('0');
  });

  it('should handle negative numbers', () => {
    expect(sqlValue(-42, 'integer')).toBe('-42');
    expect(sqlValue(-3.14, 'numeric')).toBe('-3.14');
  });

  it('should handle float types', () => {
    expect(sqlValue(1.5, 'float8')).toBe('1.5');
    expect(sqlValue(2.0, 'double precision')).toBe('2');
    expect(sqlValue(0.001, 'real')).toBe('0.001');
  });
});

describe('buildUpdateSql', () => {
  it('should build UPDATE with single column change', () => {
    const sql = buildUpdateSql('users', 'public', ['id'], {
      changes: { name: 'Alice' },
      pkValues: { id: 1 },
      pkTypes: { id: 'bigint' },
    });
    expect(sql).toBe('UPDATE public.users SET name = \'Alice\' WHERE id = 1');
  });

  it('should build UPDATE with multiple changes and composite PK', () => {
    const sql = buildUpdateSql('order_items', undefined, ['order_id', 'item_id'], {
      changes: { quantity: 5, price: null },
      pkValues: { order_id: 10, item_id: 20 },
    });
    expect(sql).toContain('SET quantity = \'5\', price = NULL');
    expect(sql).toContain('WHERE order_id = \'10\' AND item_id = \'20\'');
  });

  it('should escape quotes in values', () => {
    const sql = buildUpdateSql('users', undefined, ['id'], {
      changes: { name: 'O\'Brien' },
      pkValues: { id: 1 },
    });
    expect(sql).toContain('\'O\'\'Brien\'');
  });

  it('should add ::jsonb cast for json/jsonb columns', () => {
    const sql = buildUpdateSql('users', 'public', ['id'], {
      changes: { data: { key: 'value' } },
      columnTypes: { data: 'jsonb' },
      pkValues: { id: 1 },
    });
    expect(sql).toContain('data = \'{"key":"value"}\'::jsonb');
  });

  it('should add ::jsonb cast for json type', () => {
    const sql = buildUpdateSql('t', undefined, ['id'], {
      changes: { config: { a: 1 } },
      columnTypes: { config: 'json' },
      pkValues: { id: 1 },
    });
    expect(sql).toContain('\'{"a":1}\'::json');
  });

  it('should not cast non-json columns', () => {
    const sql = buildUpdateSql('t', undefined, ['id'], {
      changes: { name: 'test' },
      columnTypes: { name: 'text' },
      pkValues: { id: 1 },
    });
    expect(sql).not.toContain('::');
  });

  it('should use numeric PK without quotes when pkTypes provided', () => {
    const sql = buildUpdateSql('credentials', 'public', ['id'], {
      changes: { data: { key: 'val' } },
      columnTypes: { data: 'jsonb' },
      pkValues: { id: 244 },
      pkTypes: { id: 'bigint' },
    });
    expect(sql).toContain('WHERE id = 244');
    expect(sql).toContain('::jsonb');
    expect(sql).not.toContain('\'244\'');
  });

  it('should handle mixed column types in SET clause', () => {
    const sql = buildUpdateSql('t', undefined, ['id'], {
      changes: { count: 10, name: 'Alice', active: true, meta: { a: 1 } },
      columnTypes: { count: 'integer', name: 'varchar', active: 'boolean', meta: 'jsonb' },
      pkValues: { id: 1 },
      pkTypes: { id: 'integer' },
    });
    expect(sql).toContain('count = 10');
    expect(sql).toContain('name = \'Alice\'');
    expect(sql).toContain('active = TRUE');
    expect(sql).toContain('meta = \'{"a":1}\'::jsonb');
    expect(sql).toContain('WHERE id = 1');
  });

  it('should quote reserved word column names', () => {
    const sql = buildUpdateSql('items', undefined, ['id'], {
      changes: { order: 5, type: 'premium' },
      pkValues: { id: 1 },
      pkTypes: { id: 'integer' },
    });
    expect(sql).toContain('"order" = \'5\'');
    expect(sql).toContain('"type" = \'premium\'');
  });
});

describe('buildDeleteSql', () => {
  it('should build DELETE with single PK', () => {
    const sql = buildDeleteSql('users', 'public', ['id'], { id: 42 }, { id: 'bigint' });
    expect(sql).toBe('DELETE FROM public.users WHERE id = 42');
  });

  it('should quote string PKs', () => {
    const sql = buildDeleteSql('t', undefined, ['code'], { code: 'ABC' }, { code: 'varchar' });
    expect(sql).toBe('DELETE FROM t WHERE code = \'ABC\'');
  });

  it('should build DELETE with composite PK', () => {
    const sql = buildDeleteSql('order_items', undefined, ['order_id', 'item_id'], {
      order_id: 10, item_id: 20,
    });
    expect(sql).toBe('DELETE FROM order_items WHERE order_id = \'10\' AND item_id = \'20\'');
  });

  it('should handle NULL pk values', () => {
    const sql = buildDeleteSql('t', undefined, ['id'], { id: null });
    expect(sql).toContain('WHERE id = NULL');
  });
});

describe('buildInsertDefaultSql', () => {
  it('should build INSERT with DEFAULT values', () => {
    const sql = buildInsertDefaultSql('users', 'public', ['id', 'name', 'email']);
    expect(sql).toBe('INSERT INTO public.users (id, name, email) VALUES (DEFAULT, DEFAULT, DEFAULT) RETURNING *');
  });

  it('should work without schema', () => {
    const sql = buildInsertDefaultSql('logs', undefined, ['id', 'message']);
    expect(sql).toBe('INSERT INTO logs (id, message) VALUES (DEFAULT, DEFAULT) RETURNING *');
  });

  it('should quote reserved word columns', () => {
    const sql = buildInsertDefaultSql('t', undefined, ['id', 'order', 'type']);
    expect(sql).toBe('INSERT INTO t (id, "order", "type") VALUES (DEFAULT, DEFAULT, DEFAULT) RETURNING *');
  });
});

describe('splitStatements', () => {
  it('should split simple statements', () => {
    const stmts = splitStatements('SELECT 1; SELECT 2;');
    expect(stmts.map(s => s.text)).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  it('should handle statement without trailing semicolon', () => {
    const stmts = splitStatements('SELECT 1');
    expect(stmts.map(s => s.text)).toEqual(['SELECT 1']);
  });

  it('should ignore empty statements', () => {
    const stmts = splitStatements('SELECT 1;; ; SELECT 2');
    expect(stmts.map(s => s.text)).toEqual(['SELECT 1;', 'SELECT 2']);
  });

  it('should not split on semicolons inside string literals', () => {
    const stmts = splitStatements('SELECT \'a;b\'; SELECT 2');
    expect(stmts.map(s => s.text)).toEqual(['SELECT \'a;b\';', 'SELECT 2']);
  });

  it('should handle escaped quotes in strings', () => {
    const stmts = splitStatements('SELECT \'it\'\'s\'; SELECT 2');
    expect(stmts.map(s => s.text)).toEqual(['SELECT \'it\'\'s\';', 'SELECT 2']);
  });

  it('should not split on semicolons inside single-line comments', () => {
    const stmts = splitStatements('-- comment; not a separator\nSELECT 1');
    expect(stmts.map(s => s.text)).toEqual(['-- comment; not a separator\nSELECT 1']);
  });

  it('should not split on semicolons inside block comments', () => {
    const stmts = splitStatements('/* comment; still */ SELECT 1');
    expect(stmts.map(s => s.text)).toEqual(['/* comment; still */ SELECT 1']);
  });

  it('should handle dollar-quoted strings (PostgreSQL)', () => {
    const sql = 'CREATE FUNCTION f() RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql; SELECT 1';
    const stmts = splitStatements(sql);
    expect(stmts.length).toBe(2);
    expect(stmts[0].text).toContain('$$');
    expect(stmts[1].text).toBe('SELECT 1');
  });

  it('should return correct start/end offsets', () => {
    const sql = 'SELECT 1; SELECT 2;';
    const stmts = splitStatements(sql);
    expect(stmts[0].start).toBe(0);
    expect(stmts[0].end).toBe(9); // 'SELECT 1;' ends at index 9
    expect(stmts[1].start).toBe(9); // starts right after ';'
    expect(stmts[1].end).toBe(19);
  });

  it('should handle multiline SQL', () => {
    const sql = 'SELECT *\nFROM users;\n\nUPDATE users SET name = \'test\'\nWHERE id = 1;';
    const stmts = splitStatements(sql);
    expect(stmts.length).toBe(2);
    expect(stmts[0].text).toContain('SELECT');
    expect(stmts[1].text).toContain('UPDATE');
  });

  it('should return empty for empty/whitespace input', () => {
    expect(splitStatements('')).toEqual([]);
    expect(splitStatements('   ')).toEqual([]);
    expect(splitStatements('  ;  ; ')).toEqual([]);
  });
});

describe('getStatementAtOffset', () => {
  it('should return the only statement for single query', () => {
    const stmt = getStatementAtOffset('SELECT 1', 3);
    expect(stmt?.text).toBe('SELECT 1');
  });

  it('should return first statement when cursor is in first statement', () => {
    const sql = 'SELECT 1;\nUPDATE users SET name = \'x\' WHERE id = 1;';
    const stmt = getStatementAtOffset(sql, 3);
    expect(stmt?.text).toContain('SELECT');
  });

  it('should return second statement when cursor is in second statement', () => {
    const sql = 'SELECT 1;\nUPDATE users SET name = \'x\' WHERE id = 1;';
    const stmt = getStatementAtOffset(sql, 15);
    expect(stmt?.text).toContain('UPDATE');
  });

  it('should return nearest statement when cursor is in whitespace between statements', () => {
    const sql = 'SELECT 1;\n\n\nUPDATE users SET name = \'x\';';
    // Cursor in empty lines between statements
    const stmt = getStatementAtOffset(sql, 11);
    expect(stmt).toBeDefined();
    // Should pick the nearest (first or second)
    expect(stmt!.text).toMatch(/SELECT|UPDATE/);
  });

  it('should return undefined for empty input', () => {
    expect(getStatementAtOffset('', 0)).toBeUndefined();
    expect(getStatementAtOffset('  ', 0)).toBeUndefined();
  });

  it('should handle cursor at the very end of the text', () => {
    const sql = 'SELECT 1;\nSELECT 2';
    const stmt = getStatementAtOffset(sql, sql.length);
    expect(stmt?.text).toBe('SELECT 2');
  });

  it('should handle cursor at the very beginning', () => {
    const sql = 'SELECT 1;\nSELECT 2';
    const stmt = getStatementAtOffset(sql, 0);
    expect(stmt?.text).toBe('SELECT 1;');
  });
});
