import { describe, it, expect } from 'vitest';
import { parsePineconeCommand } from '../drivers/pinecone';

describe('parsePineconeCommand', () => {
  it('returns null for empty input', () => {
    expect(parsePineconeCommand('')).toBeNull();
    expect(parsePineconeCommand('   ')).toBeNull();
  });

  it('returns null for single word (no index)', () => {
    expect(parsePineconeCommand('QUERY')).toBeNull();
  });

  it('returns null for unknown commands', () => {
    expect(parsePineconeCommand('SELECT my-index')).toBeNull();
    expect(parsePineconeCommand('INSERT my-index id=1')).toBeNull();
  });

  it('parses QUERY with vector and topK', () => {
    const result = parsePineconeCommand('QUERY my-index vector=[0.1,0.2,0.3] topK=5');
    expect(result).toEqual({
      command: 'QUERY',
      index: 'my-index',
      params: { vector: '[0.1,0.2,0.3]', topK: '5' },
    });
  });

  it('parses QUERY with namespace and filter', () => {
    const result = parsePineconeCommand('QUERY idx vector=[1,2] namespace=ns1 filter={"genre":"comedy"}');
    expect(result).toEqual({
      command: 'QUERY',
      index: 'idx',
      params: { vector: '[1,2]', namespace: 'ns1', filter: '{"genre":"comedy"}' },
    });
  });

  it('parses UPSERT with id, vector, and metadata', () => {
    const result = parsePineconeCommand('UPSERT my-index id=vec1 vector=[0.1,0.2] metadata={"key":"val"}');
    expect(result).toEqual({
      command: 'UPSERT',
      index: 'my-index',
      params: { id: 'vec1', vector: '[0.1,0.2]', metadata: '{"key":"val"}' },
    });
  });

  it('parses DELETE with ids', () => {
    const result = parsePineconeCommand('DELETE my-index ids=["id1","id2"]');
    expect(result).toEqual({
      command: 'DELETE',
      index: 'my-index',
      params: { ids: '["id1","id2"]' },
    });
  });

  it('parses DELETE with all=true', () => {
    const result = parsePineconeCommand('DELETE my-index all=true namespace=ns1');
    expect(result).toEqual({
      command: 'DELETE',
      index: 'my-index',
      params: { all: 'true', namespace: 'ns1' },
    });
  });

  it('parses STATS with index only', () => {
    const result = parsePineconeCommand('STATS my-index');
    expect(result).toEqual({
      command: 'STATS',
      index: 'my-index',
      params: {},
    });
  });

  it('parses LIST with namespace and prefix', () => {
    const result = parsePineconeCommand('LIST my-index namespace=ns1 prefix=doc_ limit=50');
    expect(result).toEqual({
      command: 'LIST',
      index: 'my-index',
      params: { namespace: 'ns1', prefix: 'doc_', limit: '50' },
    });
  });

  it('is case-insensitive for command', () => {
    const result = parsePineconeCommand('query my-index vector=[1]');
    expect(result?.command).toBe('QUERY');
  });

  it('handles extra whitespace', () => {
    const result = parsePineconeCommand('  STATS   my-index  ');
    expect(result).toEqual({
      command: 'STATS',
      index: 'my-index',
      params: {},
    });
  });

  it('handles nested JSON in filter param', () => {
    const result = parsePineconeCommand('QUERY idx vector=[1,2] filter={"$and":[{"genre":"comedy"},{"year":{"$gte":2020}}]}');
    expect(result).toEqual({
      command: 'QUERY',
      index: 'idx',
      params: { vector: '[1,2]', filter: '{"$and":[{"genre":"comedy"},{"year":{"$gte":2020}}]}' },
    });
  });

  it('handles nested arrays in vector param', () => {
    const result = parsePineconeCommand('UPSERT idx id=v1 vector=[0.1,0.2,0.3] metadata={"tags":["a","b"]}');
    expect(result).toEqual({
      command: 'UPSERT',
      index: 'idx',
      params: { id: 'v1', vector: '[0.1,0.2,0.3]', metadata: '{"tags":["a","b"]}' },
    });
  });
});
