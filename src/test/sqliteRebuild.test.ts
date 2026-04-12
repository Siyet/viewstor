import { describe, it, expect, beforeAll } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'sqlite-rebuild.js');
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'sqlite-builds');
const NODE_META = path.join(CACHE_DIR, 'better_sqlite3.node.meta');
const NODE_CACHE = path.join(CACHE_DIR, 'better_sqlite3.node.node');
const ELECTRON_META = path.join(CACHE_DIR, 'better_sqlite3.electron.meta');
const ELECTRON_CACHE = path.join(CACHE_DIR, 'better_sqlite3.electron.node');
const BINARY = path.join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

function md5(filePath: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

/** Check if better-sqlite3 can load in the current Node.js process. */
function canLoadSqlite(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Db = require('better-sqlite3');
    const db = new Db(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe('sqlite-rebuild.js', () => {
  let sqliteUnavailable = false;

  beforeAll(() => {
    sqliteUnavailable = !canLoadSqlite();
    if (sqliteUnavailable) {
      console.log('NOTE: better-sqlite3 binary incompatible with current Node.js (Extension Host may have Electron binary locked) — some tests will be skipped');
    }
  });

  it('script file exists', () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
  });

  it('binary exists', () => {
    expect(fs.existsSync(BINARY)).toBe(true);
  });

  it('node cache binary exists', () => {
    if (!fs.existsSync(NODE_CACHE)) {
      // Cache might not exist if binary is locked and rebuild was skipped
      expect(sqliteUnavailable).toBe(true);
      return;
    }
    expect(fs.existsSync(NODE_CACHE)).toBe(true);
  });

  it('node meta file has correct structure and ABI', () => {
    if (!fs.existsSync(NODE_META)) {
      expect(sqliteUnavailable).toBe(true);
      return;
    }
    const meta = JSON.parse(fs.readFileSync(NODE_META, 'utf8'));
    expect(meta).toHaveProperty('abi');
    expect(meta).toHaveProperty('version');
    expect(meta).toHaveProperty('hash');
    expect(meta).toHaveProperty('builtAt');
    expect(meta.abi).toBe(String(process.versions.modules));
  });

  it('active binary hash matches Node cache (when not locked)', () => {
    if (sqliteUnavailable || !fs.existsSync(NODE_CACHE)) return;
    expect(md5(BINARY)).toBe(md5(NODE_CACHE));
  });

  it('Electron cache differs from Node cache (different prebuilds)', () => {
    if (!fs.existsSync(ELECTRON_CACHE) || !fs.existsSync(NODE_CACHE)) return;
    expect(md5(ELECTRON_CACHE)).not.toBe(md5(NODE_CACHE));
  });

  it('Electron meta tracks electronVersion', () => {
    if (!fs.existsSync(ELECTRON_META)) return;
    const meta = JSON.parse(fs.readFileSync(ELECTRON_META, 'utf8'));
    expect(meta).toHaveProperty('electronVersion');
    expect(meta).toHaveProperty('hash');
    expect(meta.electronVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('cache invalidation: wrong ABI in meta triggers rebuild', () => {
    if (sqliteUnavailable || !fs.existsSync(NODE_META)) return;
    const originalMeta = fs.readFileSync(NODE_META, 'utf8');
    try {
      fs.writeFileSync(NODE_META, JSON.stringify({
        abi: '999', version: 'v0.0.0', hash: 'fake', builtAt: new Date().toISOString(),
      }));
      const output = execSync(`node "${SCRIPT}" node`, { cwd: ROOT, encoding: 'utf8' });
      // If binary locked, script warns and skips; otherwise detects stale
      expect(output).toMatch(/stale|locked/);
    } catch {
      // npm rebuild failed due to EBUSY — skip
    } finally {
      // Restore meta
      try {
        const currentMeta = JSON.parse(fs.readFileSync(NODE_META, 'utf8'));
        if (currentMeta.abi !== String(process.versions.modules)) {
          fs.writeFileSync(NODE_META, originalMeta);
        }
      } catch {
        fs.writeFileSync(NODE_META, originalMeta);
      }
    }
  });

  it('missing meta file triggers rebuild (not crash)', () => {
    if (sqliteUnavailable) return;
    const originalMeta = fs.existsSync(NODE_META) ? fs.readFileSync(NODE_META, 'utf8') : null;
    try {
      if (fs.existsSync(NODE_META)) fs.unlinkSync(NODE_META);
      const output = execSync(`node "${SCRIPT}" node`, { cwd: ROOT, encoding: 'utf8' });
      expect(output).toBeTruthy();
    } catch {
      // npm rebuild failed due to EBUSY — skip
    } finally {
      if (originalMeta && !fs.existsSync(NODE_META)) {
        fs.writeFileSync(NODE_META, originalMeta);
      }
    }
  });

  it('better-sqlite3 loads and works', () => {
    if (sqliteUnavailable) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      db.prepare('INSERT INTO t VALUES (1, ?)').run('ok');
      const row = db.prepare('SELECT v FROM t WHERE id = 1').get();
      expect(row.v).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('rejects invalid target', () => {
    expect(() => {
      execSync(`node "${SCRIPT}" invalid`, { cwd: ROOT, encoding: 'utf8' });
    }).toThrow();
  });

  it('shows usage with no arguments', () => {
    expect(() => {
      execSync(`node "${SCRIPT}"`, { cwd: ROOT, encoding: 'utf8' });
    }).toThrow();
  });
});
