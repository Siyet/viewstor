import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'sqlite-rebuild.js');
const PACKAGE_DIR = path.join(ROOT, 'node_modules', 'better-sqlite3');
const BINARY = path.join(PACKAGE_DIR, 'prebuilds', `${process.platform}-${process.arch}.node`);

function runScript(target?: string): string {
  return execFileSync(process.execPath, [SCRIPT, ...(target ? [target] : [])], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

describe('better-sqlite3 package.json consistency', () => {
  it('better-sqlite3 must be in dependencies (not only devDependencies)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies).toHaveProperty('better-sqlite3');
    expect(pkg.dependencies['better-sqlite3']).toMatch(/^\^13\./);
  });

  it('better-sqlite3 must NOT appear in devDependencies (avoids version mismatch in VSIX)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.devDependencies).not.toHaveProperty('better-sqlite3');
  });

  it('ships the N-API prebuild for the current platform and architecture', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
    expect(pkg.version).toMatch(/^13\./);
    expect(Number(process.versions.napi)).toBeGreaterThan(0);
    expect(fs.existsSync(BINARY)).toBe(true);
  });

  it('require("better-sqlite3") returns a constructor function', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    expect(typeof Database).toBe('function');
    expect(Database).toHaveProperty('prototype');
  });
});

describe('sqlite-rebuild.js N-API compatibility validator', () => {
  it('script file exists', () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
  });

  it.each(['node', 'electron'])('validates the same prebuild for %s', (target) => {
    const output = runScript(target);
    expect(output).toContain(`N-API prebuild validated for ${target}`);
    expect(output).toContain(`${process.platform}-${process.arch}.node`);
  });

  it('better-sqlite3 loads and executes real writes and reads', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      db.prepare('INSERT INTO t VALUES (1, ?)').run('ok');
      const row = db.prepare('SELECT v FROM t WHERE id = 1').get() as { v: string };
      expect(row.v).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('rejects invalid target', () => {
    expect(() => runScript('invalid')).toThrow();
  });

  it('shows usage with no arguments', () => {
    expect(() => runScript()).toThrow();
  });
});
