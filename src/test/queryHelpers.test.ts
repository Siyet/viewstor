import { describe, it, expect } from 'vitest';
import { splitCustomQueryLimit } from '../utils/queryHelpers';

describe('splitCustomQueryLimit', () => {
  it('returns query unchanged when no LIMIT present', () => {
    const result = splitCustomQueryLimit('SELECT * FROM users');
    expect(result.baseQuery).toBe('SELECT * FROM users');
    expect(result.userLimit).toBeUndefined();
  });

  it('strips trailing LIMIT and reports user limit', () => {
    const result = splitCustomQueryLimit('SELECT * FROM users LIMIT 50');
    expect(result.baseQuery).toBe('SELECT * FROM users');
    expect(result.userLimit).toBe(50);
  });

  it('strips trailing LIMIT + OFFSET', () => {
    const result = splitCustomQueryLimit('SELECT * FROM users LIMIT 50 OFFSET 100');
    expect(result.baseQuery).toBe('SELECT * FROM users');
    expect(result.userLimit).toBe(50);
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
});
