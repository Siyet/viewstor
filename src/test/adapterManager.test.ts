import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Must mock before import
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import {
  setAdapterDir,
  getAdapterDir,
  getAdapterModulePath,
  isAdapterInstalled,
  listAdapters,
  installAdapter,
  uninstallAdapter,
  requireAdapter,
} from '../adapters/adapterManager';
import {
  getAdapterSpec,
  getAllAdapterSpecs,
  getPackageName,
  getPackageInstallArg,
} from '../adapters/adapterRegistry';
import * as childProcess from 'child_process';

describe('adapterRegistry', () => {
  it('returns specs for all four database types', () => {
    const specs = getAllAdapterSpecs();
    expect(specs).toHaveLength(4);
    const types = specs.map(([type]) => type);
    expect(types).toContain('postgresql');
    expect(types).toContain('redis');
    expect(types).toContain('clickhouse');
    expect(types).toContain('sqlite');
  });

  it('maps postgresql to pg package', () => {
    expect(getPackageName('postgresql')).toBe('pg');
  });

  it('maps redis to ioredis package', () => {
    expect(getPackageName('redis')).toBe('ioredis');
  });

  it('maps clickhouse to @clickhouse/client package', () => {
    expect(getPackageName('clickhouse')).toBe('@clickhouse/client');
  });

  it('maps sqlite to better-sqlite3 package', () => {
    expect(getPackageName('sqlite')).toBe('better-sqlite3');
  });

  it('marks only sqlite as native', () => {
    for (const [type, spec] of getAllAdapterSpecs()) {
      if (type === 'sqlite') {
        expect(spec.isNative).toBe(true);
      } else {
        expect(spec.isNative).toBe(false);
      }
    }
  });

  it('getAdapterSpec returns correct spec', () => {
    const spec = getAdapterSpec('postgresql');
    expect(spec.packageName).toBe('pg');
    expect(spec.version).toBe('^8.11.0');
    expect(spec.isNative).toBe(false);
  });

  it('getPackageInstallArg includes version', () => {
    expect(getPackageInstallArg('postgresql')).toBe('pg@^8.11.0');
    expect(getPackageInstallArg('redis')).toBe('ioredis@^5.3.0');
  });
});

describe('adapterManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewstor-adapter-test-'));
    setAdapterDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('setAdapterDir', () => {
    it('creates adapter directory if missing', () => {
      const newDir = path.join(tmpDir, 'nested', 'adapters');
      setAdapterDir(newDir);
      expect(fs.existsSync(newDir)).toBe(true);
    });

    it('creates package.json in adapter directory', () => {
      const pkgJson = path.join(tmpDir, 'package.json');
      expect(fs.existsSync(pkgJson)).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      expect(pkg.name).toBe('viewstor-adapters');
      expect(pkg.private).toBe(true);
    });

    it('does not overwrite existing package.json', () => {
      const pkgJson = path.join(tmpDir, 'package.json');
      fs.writeFileSync(pkgJson, JSON.stringify({ name: 'custom', version: '1.0.0' }), 'utf8');
      setAdapterDir(tmpDir);
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      expect(pkg.name).toBe('custom');
    });
  });

  describe('getAdapterDir', () => {
    it('returns the set adapter directory', () => {
      expect(getAdapterDir()).toBe(tmpDir);
    });
  });

  describe('getAdapterModulePath', () => {
    it('returns undefined when package not installed', () => {
      expect(getAdapterModulePath('pg')).toBeUndefined();
    });

    it('returns path when package directory exists', () => {
      const pkgDir = path.join(tmpDir, 'node_modules', 'pg');
      fs.mkdirSync(pkgDir, { recursive: true });
      expect(getAdapterModulePath('pg')).toBe(pkgDir);
    });

    it('handles scoped packages', () => {
      const pkgDir = path.join(tmpDir, 'node_modules', '@clickhouse', 'client');
      fs.mkdirSync(pkgDir, { recursive: true });
      expect(getAdapterModulePath('@clickhouse/client')).toBe(pkgDir);
    });
  });

  describe('isAdapterInstalled', () => {
    it('returns true for packages in node_modules (dev fallback)', () => {
      // pg is in devDependencies, so require.resolve should find it
      expect(isAdapterInstalled('postgresql')).toBe(true);
    });

    it('returns true when adapter is in adapter directory', () => {
      const pkgDir = path.join(tmpDir, 'node_modules', 'pg');
      fs.mkdirSync(pkgDir, { recursive: true });
      expect(isAdapterInstalled('postgresql')).toBe(true);
    });
  });

  describe('listAdapters', () => {
    it('returns all four adapters', () => {
      const adapters = listAdapters();
      expect(adapters).toHaveLength(4);
    });

    it('includes type, spec, and installed status', () => {
      const adapters = listAdapters();
      for (const adapter of adapters) {
        expect(adapter).toHaveProperty('type');
        expect(adapter).toHaveProperty('spec');
        expect(adapter).toHaveProperty('installed');
        expect(typeof adapter.installed).toBe('boolean');
      }
    });
  });

  describe('installAdapter', () => {
    it('calls npm install with correct arguments', async () => {
      const execFile = vi.mocked(childProcess.execFile);
      execFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        cb(null, 'ok', '');
        return {} as ReturnType<typeof childProcess.execFile>;
      }) as typeof childProcess.execFile);

      await installAdapter('postgresql');

      expect(execFile).toHaveBeenCalledWith(
        expect.stringContaining('npm'),
        ['install', '--prefix', tmpDir, 'pg@^8.11.0', '--save'],
        expect.objectContaining({ timeout: 120_000 }),
        expect.any(Function),
      );
    });

    it('calls onProgress callback', async () => {
      const execFile = vi.mocked(childProcess.execFile);
      execFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        cb(null, 'ok', '');
        return { stdout: { on: vi.fn() } } as unknown as ReturnType<typeof childProcess.execFile>;
      }) as typeof childProcess.execFile);

      const progress = vi.fn();
      await installAdapter('redis', progress);

      expect(progress).toHaveBeenCalledWith(expect.stringContaining('ioredis'));
    });

    it('rejects on npm failure', async () => {
      const execFile = vi.mocked(childProcess.execFile);
      execFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        cb(new Error('npm failed'), '', 'network error');
        return {} as ReturnType<typeof childProcess.execFile>;
      }) as typeof childProcess.execFile);

      await expect(installAdapter('postgresql')).rejects.toThrow('Failed to install pg');
    });
  });

  describe('uninstallAdapter', () => {
    it('calls npm uninstall with correct arguments', async () => {
      const execFile = vi.mocked(childProcess.execFile);
      execFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        cb(null, 'ok', '');
        return {} as ReturnType<typeof childProcess.execFile>;
      }) as typeof childProcess.execFile);

      await uninstallAdapter('postgresql');

      expect(execFile).toHaveBeenCalledWith(
        expect.stringContaining('npm'),
        ['uninstall', '--prefix', tmpDir, 'pg'],
        expect.objectContaining({ timeout: 60_000 }),
        expect.any(Function),
      );
    });
  });

  describe('requireAdapter', () => {
    it('falls back to normal require for dev packages', () => {
      // pg is available in node_modules (devDependency)
      const mod = requireAdapter('pg');
      expect(mod).toBeDefined();
      expect(mod).toHaveProperty('Client');
    });
  });
});
