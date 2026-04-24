import { describe, it, expect } from 'vitest';
import { parseQdrantCommand } from '../drivers/qdrant';

describe('parseQdrantCommand', () => {
  describe('LIST', () => {
    it('parses LIST COLLECTIONS', () => {
      const result = parseQdrantCommand('LIST COLLECTIONS');
      expect(result).toEqual({ command: 'LIST', options: {} });
    });

    it('parses LIST shorthand', () => {
      const result = parseQdrantCommand('LIST');
      expect(result).toEqual({ command: 'LIST', options: {} });
    });

    it('is case-insensitive', () => {
      const result = parseQdrantCommand('list collections');
      expect(result).toEqual({ command: 'LIST', options: {} });
    });

    it('trims whitespace and trailing semicolons', () => {
      const result = parseQdrantCommand('  LIST COLLECTIONS ;  ');
      expect(result).toEqual({ command: 'LIST', options: {} });
    });
  });

  describe('DESCRIBE', () => {
    it('parses DESCRIBE <collection>', () => {
      const result = parseQdrantCommand('DESCRIBE my_collection');
      expect(result).toEqual({ command: 'DESCRIBE', collection: 'my_collection', options: {} });
    });

    it('is case-insensitive on command', () => {
      const result = parseQdrantCommand('describe MyCollection');
      expect(result).toEqual({ command: 'DESCRIBE', collection: 'MyCollection', options: {} });
    });
  });

  describe('SCROLL', () => {
    it('parses SCROLL with default options', () => {
      const result = parseQdrantCommand('SCROLL docs');
      expect(result).toEqual({ command: 'SCROLL', collection: 'docs', options: {} });
    });

    it('parses SCROLL with limit', () => {
      const result = parseQdrantCommand('SCROLL docs limit=50');
      expect(result).toEqual({ command: 'SCROLL', collection: 'docs', options: { limit: '50' } });
    });

    it('parses SCROLL with offset', () => {
      const result = parseQdrantCommand('SCROLL docs limit=10 offset=abc-123');
      expect(result).toEqual({ command: 'SCROLL', collection: 'docs', options: { limit: '10', offset: 'abc-123' } });
    });

    it('parses SCROLL with with_vector', () => {
      const result = parseQdrantCommand('SCROLL docs with_vector=true');
      expect(result).toEqual({ command: 'SCROLL', collection: 'docs', options: { with_vector: 'true' } });
    });
  });

  describe('SEARCH', () => {
    it('parses SEARCH with vector and limit', () => {
      const result = parseQdrantCommand('SEARCH docs vector=[0.1,0.2,0.3] limit=5');
      expect(result).toEqual({
        command: 'SEARCH',
        collection: 'docs',
        options: { vector: '[0.1,0.2,0.3]', limit: '5' },
      });
    });

    it('parses SEARCH with named vector', () => {
      const result = parseQdrantCommand('SEARCH docs vector=[0.1,0.2] vector_name=dense limit=10');
      expect(result).toEqual({
        command: 'SEARCH',
        collection: 'docs',
        options: { vector: '[0.1,0.2]', vector_name: 'dense', limit: '10' },
      });
    });
  });

  describe('COUNT', () => {
    it('parses COUNT <collection>', () => {
      const result = parseQdrantCommand('COUNT my_collection');
      expect(result).toEqual({ command: 'COUNT', collection: 'my_collection', options: {} });
    });
  });

  describe('UPSERT', () => {
    it('parses UPSERT with id and vector', () => {
      const result = parseQdrantCommand('UPSERT docs id=1 vector=[0.1,0.2,0.3]');
      expect(result).toEqual({
        command: 'UPSERT',
        collection: 'docs',
        options: { id: '1', vector: '[0.1,0.2,0.3]' },
      });
    });

    it('parses UPSERT with payload', () => {
      const result = parseQdrantCommand('UPSERT docs id=abc vector=[0.1,0.2] title="hello world"');
      expect(result).toEqual({
        command: 'UPSERT',
        collection: 'docs',
        options: { id: 'abc', vector: '[0.1,0.2]', title: 'hello world' },
      });
    });
  });

  describe('DELETE', () => {
    it('parses DELETE with point IDs', () => {
      const result = parseQdrantCommand('DELETE docs 1 2 3');
      expect(result).toEqual({
        command: 'DELETE',
        collection: 'docs',
        options: { _args: '1 2 3' },
      });
    });

    it('parses DELETE with UUID IDs', () => {
      const result = parseQdrantCommand('DELETE docs abc-123 def-456');
      expect(result).toEqual({
        command: 'DELETE',
        collection: 'docs',
        options: { _args: 'abc-123 def-456' },
      });
    });

    it('parses DELETE with no IDs (empty _args)', () => {
      const result = parseQdrantCommand('DELETE docs');
      expect(result).toEqual({
        command: 'DELETE',
        collection: 'docs',
        options: { _args: '' },
      });
    });
  });

  describe('invalid commands', () => {
    it('returns null for empty input', () => {
      expect(parseQdrantCommand('')).toBeNull();
    });

    it('returns null for whitespace-only', () => {
      expect(parseQdrantCommand('   ')).toBeNull();
    });

    it('returns null for unknown command', () => {
      expect(parseQdrantCommand('SELECT 1')).toBeNull();
    });

    it('returns null for INSERT command', () => {
      expect(parseQdrantCommand('INSERT INTO docs VALUES (1)')).toBeNull();
    });
  });
});
