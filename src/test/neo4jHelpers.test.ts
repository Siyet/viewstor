import { describe, it, expect } from 'vitest';
import { escapeCypherLabel, toJsNumber, toJsValue, neo4jTypeOf, formatCounters } from '../drivers/neo4j';

describe('escapeCypherLabel', () => {
  it('returns plain labels unchanged', () => {
    expect(escapeCypherLabel('Person')).toBe('Person');
  });

  it('doubles backticks', () => {
    expect(escapeCypherLabel('My`Label')).toBe('My``Label');
  });

  it('handles multiple backticks', () => {
    expect(escapeCypherLabel('a`b`c')).toBe('a``b``c');
  });

  it('handles empty string', () => {
    expect(escapeCypherLabel('')).toBe('');
  });
});

describe('toJsNumber', () => {
  it('converts plain numbers', () => {
    expect(toJsNumber(42)).toBe(42);
  });

  it('converts Neo4j Integer-like objects', () => {
    expect(toJsNumber({ low: 5, high: 0, toNumber: () => 5 })).toBe(5);
  });

  it('converts bigint', () => {
    expect(toJsNumber(BigInt(99))).toBe(99);
  });

  it('converts string numbers', () => {
    expect(toJsNumber('123')).toBe(123);
  });

  it('returns 0 for non-numeric strings', () => {
    expect(toJsNumber('abc')).toBe(0);
  });

  it('returns 0 for null/undefined', () => {
    expect(toJsNumber(null)).toBe(0);
    expect(toJsNumber(undefined)).toBe(0);
  });
});

describe('toJsValue', () => {
  it('returns null for null/undefined', () => {
    expect(toJsValue(null)).toBeNull();
    expect(toJsValue(undefined)).toBeNull();
  });

  it('converts Neo4j Integer-like objects', () => {
    expect(toJsValue({ low: 7, high: 0, toNumber: () => 7 })).toBe(7);
  });

  it('converts bigint', () => {
    expect(toJsValue(BigInt(42))).toBe(42);
  });

  it('passes through plain strings', () => {
    expect(toJsValue('hello')).toBe('hello');
  });

  it('passes through plain numbers', () => {
    expect(toJsValue(3.14)).toBe(3.14);
  });

  it('recursively converts arrays', () => {
    const input = [1, 'two', { low: 3, high: 0, toNumber: () => 3 }];
    expect(toJsValue(input)).toEqual([1, 'two', 3]);
  });

  it('flattens node-like objects with properties', () => {
    const node = { labels: ['Person'], properties: { name: 'Alice', age: { low: 30, high: 0, toNumber: () => 30 } } };
    expect(toJsValue(node)).toEqual({ name: 'Alice', age: 30 });
  });
});

describe('neo4jTypeOf', () => {
  it('returns Null for null/undefined', () => {
    expect(neo4jTypeOf(null)).toBe('Null');
    expect(neo4jTypeOf(undefined)).toBe('Null');
  });

  it('detects Integer for Neo4j Integer-like', () => {
    expect(neo4jTypeOf({ low: 1, high: 0, toNumber: () => 1 })).toBe('Integer');
  });

  it('detects Integer for whole numbers', () => {
    expect(neo4jTypeOf(42)).toBe('Integer');
  });

  it('detects Float for decimals', () => {
    expect(neo4jTypeOf(3.14)).toBe('Float');
  });

  it('detects String', () => {
    expect(neo4jTypeOf('hello')).toBe('String');
  });

  it('detects Boolean', () => {
    expect(neo4jTypeOf(true)).toBe('Boolean');
  });

  it('detects List for arrays', () => {
    expect(neo4jTypeOf([1, 2])).toBe('List');
  });

  it('detects Node for objects with properties', () => {
    expect(neo4jTypeOf({ properties: { name: 'Alice' } })).toBe('Node');
  });

  it('returns Object for plain objects', () => {
    expect(neo4jTypeOf({ foo: 'bar' })).toBe('Object');
  });

  it('detects bigint as Integer', () => {
    expect(neo4jTypeOf(BigInt(5))).toBe('Integer');
  });
});

describe('formatCounters', () => {
  it('formats non-zero counters', () => {
    expect(formatCounters({ nodesCreated: 2, propertiesSet: 3, nodesDeleted: 0 }))
      .toBe('nodesCreated: 2, propertiesSet: 3');
  });

  it('returns empty string when all zero', () => {
    expect(formatCounters({ nodesCreated: 0, nodesDeleted: 0 })).toBe('');
  });

  it('handles empty object', () => {
    expect(formatCounters({})).toBe('');
  });
});
