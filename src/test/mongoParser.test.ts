import { describe, it, expect } from 'vitest';
import { parseMongoCommand } from '../drivers/mongodb';

describe('parseMongoCommand', () => {
  it('parses db.collection.find()', () => {
    const result = parseMongoCommand('db.users.find()');
    expect(result).toEqual({ collection: 'users', operation: 'find', args: [] });
  });

  it('parses db.collection.find({}) with empty filter', () => {
    const result = parseMongoCommand('db.users.find({})');
    expect(result).toEqual({ collection: 'users', operation: 'find', args: [{}] });
  });

  it('parses find with filter', () => {
    const result = parseMongoCommand('db.users.find({"age": 25})');
    expect(result).toEqual({ collection: 'users', operation: 'find', args: [{ age: 25 }] });
  });

  it('parses find with filter and projection', () => {
    const result = parseMongoCommand('db.users.find({"age": 25}, {"name": 1})');
    expect(result).toEqual({
      collection: 'users',
      operation: 'find',
      args: [{ age: 25 }, { name: 1 }],
    });
  });

  it('parses aggregate with pipeline', () => {
    const result = parseMongoCommand('db.orders.aggregate([{"$match": {"status": "A"}}])');
    expect(result).toEqual({
      collection: 'orders',
      operation: 'aggregate',
      args: [[{ $match: { status: 'A' } }]],
    });
  });

  it('parses insertOne', () => {
    const result = parseMongoCommand('db.users.insertOne({"name": "Alice", "age": 30})');
    expect(result).toEqual({
      collection: 'users',
      operation: 'insertOne',
      args: [{ name: 'Alice', age: 30 }],
    });
  });

  it('parses updateOne with filter and update', () => {
    const result = parseMongoCommand('db.users.updateOne({"name": "Alice"}, {"$set": {"age": 31}})');
    expect(result).toEqual({
      collection: 'users',
      operation: 'updateOne',
      args: [{ name: 'Alice' }, { $set: { age: 31 } }],
    });
  });

  it('parses deleteOne', () => {
    const result = parseMongoCommand('db.users.deleteOne({"name": "Alice"})');
    expect(result).toEqual({
      collection: 'users',
      operation: 'deleteOne',
      args: [{ name: 'Alice' }],
    });
  });

  it('parses countDocuments with filter', () => {
    const result = parseMongoCommand('db.users.countDocuments({"active": true})');
    expect(result).toEqual({
      collection: 'users',
      operation: 'countDocuments',
      args: [{ active: true }],
    });
  });

  it('handles shorthand collection name', () => {
    const result = parseMongoCommand('users');
    expect(result).toEqual({ collection: 'users', operation: 'find', args: [{}] });
  });

  it('handles collection names with underscores and dollars', () => {
    const result = parseMongoCommand('db.my_collection$1.find()');
    expect(result).toEqual({ collection: 'my_collection$1', operation: 'find', args: [] });
  });

  it('handles whitespace around command', () => {
    const result = parseMongoCommand('  db.users.find({})  ');
    expect(result).toEqual({ collection: 'users', operation: 'find', args: [{}] });
  });

  it('throws on empty input', () => {
    expect(() => parseMongoCommand('')).toThrow('Empty command');
  });

  it('throws on invalid format', () => {
    expect(() => parseMongoCommand('SELECT * FROM users')).toThrow('Invalid command format');
  });

  it('parses nested JSON objects', () => {
    const result = parseMongoCommand('db.users.find({"address": {"city": "NYC"}})');
    expect(result).toEqual({
      collection: 'users',
      operation: 'find',
      args: [{ address: { city: 'NYC' } }],
    });
  });

  it('parses distinct with field name', () => {
    const result = parseMongoCommand('db.users.distinct("city")');
    expect(result).toEqual({
      collection: 'users',
      operation: 'distinct',
      args: ['city'],
    });
  });

  it('parses createIndex', () => {
    const result = parseMongoCommand('db.users.createIndex({"email": 1}, {"unique": true})');
    expect(result).toEqual({
      collection: 'users',
      operation: 'createIndex',
      args: [{ email: 1 }, { unique: true }],
    });
  });

  it('parses admin listDatabases', () => {
    const result = parseMongoCommand('db._admin.listDatabases()');
    expect(result).toEqual({ collection: '_admin', operation: 'listDatabases', args: [] });
  });
});
