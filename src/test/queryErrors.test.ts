import { describe, it, expect } from 'vitest';
import { levenshtein, parseTablesFromQuery, enhanceColumnError } from '../utils/queryHelpers';

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
      "Unknown column 'usrname'",
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
