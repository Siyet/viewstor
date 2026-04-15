import { describe, it, expect } from 'vitest';
import { parseKafkaCommand, parseBrokerList, normalizeHeaders } from '../drivers/kafka';

describe('parseKafkaCommand', () => {
  it('returns null for empty input', () => {
    expect(parseKafkaCommand('')).toBeNull();
    expect(parseKafkaCommand('   ')).toBeNull();
    expect(parseKafkaCommand('-- just a comment')).toBeNull();
  });

  it('parses LIST TOPICS', () => {
    expect(parseKafkaCommand('LIST TOPICS')).toEqual({ kind: 'list-topics' });
    expect(parseKafkaCommand('list topics')).toEqual({ kind: 'list-topics' });
    expect(parseKafkaCommand('LIST TOPICS;')).toEqual({ kind: 'list-topics' });
  });

  it('parses LIST GROUPS / CONSUMERS', () => {
    expect(parseKafkaCommand('LIST GROUPS')).toEqual({ kind: 'list-groups' });
    expect(parseKafkaCommand('LIST CONSUMERS')).toEqual({ kind: 'list-groups' });
    expect(parseKafkaCommand('list consumer')).toEqual({ kind: 'list-groups' });
  });

  it('throws on unknown LIST target', () => {
    expect(() => parseKafkaCommand('LIST BOGUS')).toThrow(/Unknown LIST target/);
    expect(() => parseKafkaCommand('LIST')).toThrow(/Unknown LIST target/);
  });

  it('parses DESCRIBE <topic>', () => {
    expect(parseKafkaCommand('DESCRIBE orders')).toEqual({ kind: 'describe', topic: 'orders' });
    expect(parseKafkaCommand('DESC orders')).toEqual({ kind: 'describe', topic: 'orders' });
  });

  it('throws when DESCRIBE has no topic', () => {
    expect(() => parseKafkaCommand('DESCRIBE')).toThrow(/requires a topic/);
  });

  it('parses CONSUME with defaults', () => {
    expect(parseKafkaCommand('CONSUME orders')).toEqual({
      kind: 'consume', topic: 'orders', limit: 100, fromBeginning: false,
    });
  });

  it('parses CONSUME with limit and from-beginning', () => {
    expect(parseKafkaCommand('CONSUME orders 500 from-beginning')).toEqual({
      kind: 'consume', topic: 'orders', limit: 500, fromBeginning: true,
    });
    expect(parseKafkaCommand('CONSUME orders beginning 25')).toEqual({
      kind: 'consume', topic: 'orders', limit: 25, fromBeginning: true,
    });
  });

  it('rejects unknown CONSUME options', () => {
    expect(() => parseKafkaCommand('CONSUME orders wat')).toThrow(/Unknown CONSUME option/);
  });

  it('parses PRODUCE with value only', () => {
    expect(parseKafkaCommand('PRODUCE orders "hello"')).toEqual({
      kind: 'produce', topic: 'orders', key: null, value: 'hello',
    });
  });

  it('parses PRODUCE with key and value', () => {
    expect(parseKafkaCommand('PRODUCE orders user-42 "hello world"')).toEqual({
      kind: 'produce', topic: 'orders', key: 'user-42', value: 'hello world',
    });
  });

  it('joins remaining tokens as the value when there are more than 3 tokens', () => {
    expect(parseKafkaCommand('PRODUCE t k a b c')).toEqual({
      kind: 'produce', topic: 't', key: 'k', value: 'a b c',
    });
  });

  it('rejects PRODUCE missing value', () => {
    expect(() => parseKafkaCommand('PRODUCE orders')).toThrow(/requires at least a value/);
    expect(() => parseKafkaCommand('PRODUCE')).toThrow(/requires a topic/);
  });

  it('rejects unknown commands', () => {
    expect(() => parseKafkaCommand('SELECT *')).toThrow(/Unknown Kafka command/);
  });

  it('strips trailing semicolons and line comments', () => {
    expect(parseKafkaCommand('LIST TOPICS  -- optional comment')).toEqual({ kind: 'list-topics' });
    expect(parseKafkaCommand('LIST TOPICS;;')).toEqual({ kind: 'list-topics' });
  });
});

describe('parseBrokerList', () => {
  it('uses the explicit port when the host has no port', () => {
    expect(parseBrokerList('broker1', 9092)).toEqual(['broker1:9092']);
    expect(parseBrokerList('broker1', 9093)).toEqual(['broker1:9093']);
  });

  it('preserves explicit host:port pairs', () => {
    expect(parseBrokerList('broker1:9093', 9092)).toEqual(['broker1:9093']);
  });

  it('splits a comma-separated broker list', () => {
    expect(parseBrokerList('b1:9092, b2:9093, b3', 9092)).toEqual([
      'b1:9092', 'b2:9093', 'b3:9092',
    ]);
  });

  it('defaults port to 9092 when none provided', () => {
    expect(parseBrokerList('broker1', 0)).toEqual(['broker1:9092']);
    expect(parseBrokerList('broker1', undefined)).toEqual(['broker1:9092']);
  });

  it('defaults host to localhost when empty', () => {
    expect(parseBrokerList('', 9092)).toEqual(['localhost:9092']);
    expect(parseBrokerList(undefined, 9092)).toEqual(['localhost:9092']);
  });
});

describe('normalizeHeaders', () => {
  it('passes string values through', () => {
    expect(normalizeHeaders({ k: 'v' })).toEqual({ k: 'v' });
  });

  it('decodes Uint8Array values as utf-8 strings', () => {
    expect(normalizeHeaders({ k: new Uint8Array([0x68, 0x69]) })).toEqual({ k: 'hi' });
  });

  it('skips null/undefined values', () => {
    expect(normalizeHeaders({ a: 'v', b: null, c: undefined })).toEqual({ a: 'v' });
  });

  it('stringifies other types', () => {
    expect(normalizeHeaders({ n: 42 as unknown as string })).toEqual({ n: '42' });
  });
});
