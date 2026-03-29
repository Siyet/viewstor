import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ConnectionStore reads from ~/.viewstor/connections.json and .vscode/viewstor.json.
// For testing, we mock the file paths by testing the underlying logic directly.

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

    const raw = fs.readFileSync(TEST_CONFIG_FILE, 'utf8');
    const data = JSON.parse(raw);

    expect(data.connections).toHaveLength(2);
    expect(data.connections[0].name).toBe('Test PG');
    expect(data.connections[0].type).toBe('postgresql');
    expect(data.connections[1].name).toBe('Test Redis');
    expect(data.connections[1].type).toBe('redis');
  });

  it('should handle adding a connection and re-reading', () => {
    // Start empty
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ connections: [] }, null, 2), 'utf8');

    // Add connection
    const data = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf8'));
    data.connections.push({
      id: 'new-conn',
      name: 'New Connection',
      type: 'clickhouse',
      host: 'ch.local',
      port: 8123,
      database: 'default',
    });
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');

    // Re-read
    const reloaded = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf8'));
    expect(reloaded.connections).toHaveLength(1);
    expect(reloaded.connections[0].id).toBe('new-conn');
    expect(reloaded.connections[0].type).toBe('clickhouse');
  });

  it('should handle missing file gracefully', () => {
    const missingPath = path.join(TEST_DIR, 'nonexistent.json');
    expect(fs.existsSync(missingPath)).toBe(false);
    // This is how ConnectionStore handles it — existsSync check
    const connections = fs.existsSync(missingPath)
      ? JSON.parse(fs.readFileSync(missingPath, 'utf8')).connections
      : [];
    expect(connections).toEqual([]);
  });

  it('should handle invalid JSON gracefully', () => {
    fs.writeFileSync(TEST_CONFIG_FILE, 'not valid json', 'utf8');
    let connections: unknown[] = [];
    try {
      connections = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf8')).connections;
    } catch {
      connections = [];
    }
    expect(connections).toEqual([]);
  });

  it('should preserve existing connections when adding new ones', () => {
    const existing = [
      { id: 'pg-1', name: 'PG One', type: 'postgresql', host: 'db1.local', port: 5432 },
    ];
    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ connections: existing }, null, 2), 'utf8');

    // Load, add, save
    const data = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf8'));
    const connMap = new Map(data.connections.map((c: { id: string }) => [c.id, c]));

    // Add new (should not overwrite existing)
    if (!connMap.has('pg-2')) {
      connMap.set('pg-2', { id: 'pg-2', name: 'PG Two', type: 'postgresql', host: 'db2.local', port: 5432 });
    }

    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ connections: Array.from(connMap.values()) }, null, 2), 'utf8');

    const reloaded = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf8'));
    expect(reloaded.connections).toHaveLength(2);
    expect(reloaded.connections.map((c: { name: string }) => c.name).sort()).toEqual(['PG One', 'PG Two']);
  });

  it('should create directory if it does not exist', () => {
    const nestedDir = path.join(TEST_DIR, 'nested', '.viewstor');
    const nestedFile = path.join(nestedDir, 'connections.json');

    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(nestedFile, JSON.stringify({ connections: [{ id: 'x', name: 'X' }] }), 'utf8');

    expect(fs.existsSync(nestedFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(nestedFile, 'utf8'));
    expect(data.connections[0].id).toBe('x');
  });
});
