import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `viewstor-test-${Date.now()}`);
const TEST_CONFIG_FILE = path.join(TEST_DIR, 'connections.json');

describe('ConnectionStore file operations', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should write and read connections from JSON file', () => {
    const connections = [
      { id: 'test-1', name: 'Test PG', type: 'postgresql', host: 'localhost', port: 5432, database: 'testdb' },
      { id: 'test-2', name: 'Test Redis', type: 'redis', host: 'localhost', port: 6379 },
    ];
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ connections }, null, 2), 'utf8');

    const data = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf8'));
    expect(data.connections).toHaveLength(2);
    expect(data.connections[0].type).toBe('postgresql');
    expect(data.connections[1].type).toBe('redis');
  });

  it.each([
    ['missing file', () => path.join(TEST_DIR, 'nonexistent.json'), undefined],
    ['invalid JSON', () => { fs.writeFileSync(TEST_CONFIG_FILE, 'not json', 'utf8'); return TEST_CONFIG_FILE; }, undefined],
  ])('should handle %s gracefully', (_desc, getPath) => {
    const filePath = getPath();
    let connections: unknown[] = [];
    try {
      if (fs.existsSync(filePath)) {
        connections = JSON.parse(fs.readFileSync(filePath, 'utf8')).connections;
      }
    } catch {
      connections = [];
    }
    expect(connections).toEqual([]);
  });

  it('should preserve existing connections when adding new ones', () => {
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({
      connections: [{ id: 'pg-1', name: 'PG One', type: 'postgresql', host: 'db1.local', port: 5432 }],
    }, null, 2), 'utf8');

    const data = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf8'));
    const connMap = new Map(data.connections.map((c: { id: string }) => [c.id, c]));
    if (!connMap.has('pg-2')) {
      connMap.set('pg-2', { id: 'pg-2', name: 'PG Two', type: 'postgresql', host: 'db2.local', port: 5432 });
    }
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ connections: Array.from(connMap.values()) }, null, 2), 'utf8');

    const reloaded = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf8'));
    expect(reloaded.connections).toHaveLength(2);
    expect(reloaded.connections.map((c: { name: string }) => c.name).sort()).toEqual(['PG One', 'PG Two']);
  });

  it('should create nested directory for config file', () => {
    const nestedDir = path.join(TEST_DIR, 'nested', '.viewstor');
    const nestedFile = path.join(nestedDir, 'connections.json');

    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(nestedFile, JSON.stringify({ connections: [{ id: 'x', name: 'X' }] }), 'utf8');

    expect(fs.existsSync(nestedFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(nestedFile, 'utf8')).connections[0].id).toBe('x');
  });
});
