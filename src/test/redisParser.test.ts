import { describe, it, expect } from 'vitest';

// Extract the parser for testing — it's a pure function
function parseRedisCommand(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === '\'') {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);

  return parts;
}

describe('parseRedisCommand', () => {
  it('should parse simple commands', () => {
    expect(parseRedisCommand('GET mykey')).toEqual(['GET', 'mykey']);
  });

  it('should handle quoted strings', () => {
    expect(parseRedisCommand('SET mykey "hello world"')).toEqual(['SET', 'mykey', 'hello world']);
  });

  it('should handle single-quoted strings', () => {
    expect(parseRedisCommand('SET mykey \'hello world\'')).toEqual(['SET', 'mykey', 'hello world']);
  });

  it('should return empty for blank input', () => {
    expect(parseRedisCommand('')).toEqual([]);
    expect(parseRedisCommand('   ')).toEqual([]);
  });

  it('should handle multiple spaces between args', () => {
    expect(parseRedisCommand('HSET  key  field  value')).toEqual(['HSET', 'key', 'field', 'value']);
  });
});
