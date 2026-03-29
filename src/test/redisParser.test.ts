import { describe, it, expect } from 'vitest';
import { parseRedisCommand } from '../drivers/redis';

describe('parseRedisCommand', () => {
  it('should parse simple commands', () => {
    expect(parseRedisCommand('GET mykey')).toEqual(['GET', 'mykey']);
  });

  it.each([
    ['double-quoted', 'SET mykey "hello world"'],
    ['single-quoted', 'SET mykey \'hello world\''],
  ])('should handle %s strings', (_desc, input) => {
    expect(parseRedisCommand(input)).toEqual(['SET', 'mykey', 'hello world']);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('should return empty for %s', (_desc, input) => {
    expect(parseRedisCommand(input)).toEqual([]);
  });

  it('should handle multiple spaces between args', () => {
    expect(parseRedisCommand('HSET  key  field  value')).toEqual(['HSET', 'key', 'field', 'value']);
  });
});
