#!/usr/bin/env node
/**
 * Manages better-sqlite3 native binaries for both Electron (VS Code extension)
 * and Node.js (tests). Keeps cached copies in node_modules/.cache/sqlite-builds/.
 *
 * For Electron: uses prebuild-install to download prebuilt binary from GitHub.
 *   electron-rebuild v3.x is broken (reports success but doesn't change the binary),
 *   so we call prebuild-install directly with --runtime electron --target <version>.
 *
 * For Node.js: uses npm rebuild (or prebuild-install for node runtime).
 *
 * Cache invalidation: a .meta JSON file stores the Electron version and binary hash.
 * If VS Code updates (new Electron version), the cache is invalidated automatically.
 *
 * Usage:
 *   node scripts/sqlite-rebuild.js electron   — install prebuild for Electron (VS Code)
 *   node scripts/sqlite-rebuild.js node        — rebuild for Node.js (tests)
 */
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SQLITE_DIR = path.join(ROOT, 'node_modules', 'better-sqlite3');
const BINARY = path.join(SQLITE_DIR, 'build', 'Release', 'better_sqlite3.node');
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'sqlite-builds');
const ELECTRON_CACHE = path.join(CACHE_DIR, 'better_sqlite3.electron.node');
const ELECTRON_META = path.join(CACHE_DIR, 'better_sqlite3.electron.meta');
const NODE_CACHE = path.join(CACHE_DIR, 'better_sqlite3.node.node');
const NODE_META = path.join(CACHE_DIR, 'better_sqlite3.node.meta');

function fileHash(filePath) {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

function detectVSCodeElectronVersion() {
  const candidates = [
    // Windows
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'),
    // macOS
    '/Applications/Visual Studio Code.app/Contents/Frameworks/Electron Framework.framework',
    // Linux
    '/usr/share/code',
  ];
  for (const base of candidates) {
    try {
      const entries = fs.readdirSync(base);
      for (const entry of entries) {
        const versionFile = path.join(base, entry, 'version');
        if (fs.existsSync(versionFile)) {
          const version = fs.readFileSync(versionFile, 'utf8').trim();
          if (/^\d+\.\d+\.\d+$/.test(version)) return version;
        }
      }
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Check if cached binary is valid for the given Electron version.
 */
function isElectronCacheValid(electronVersion) {
  try {
    if (!fs.existsSync(ELECTRON_CACHE) || !fs.existsSync(ELECTRON_META)) return false;
    const meta = JSON.parse(fs.readFileSync(ELECTRON_META, 'utf8'));
    if (meta.electronVersion !== electronVersion) {
      console.log(`Cache stale: cached for Electron ${meta.electronVersion}, need ${electronVersion}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if cached Node binary is valid for the current Node.js ABI.
 */
function isNodeCacheValid() {
  try {
    if (!fs.existsSync(NODE_CACHE) || !fs.existsSync(NODE_META)) return false;
    const meta = JSON.parse(fs.readFileSync(NODE_META, 'utf8'));
    const currentAbi = String(process.versions.modules);
    if (meta.abi !== currentAbi) {
      console.log(`Cache stale: cached ABI ${meta.abi} != current ABI ${currentAbi}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function writeElectronMeta(electronVersion) {
  const hash = fs.existsSync(ELECTRON_CACHE) ? fileHash(ELECTRON_CACHE) : 'unknown';
  fs.writeFileSync(ELECTRON_META, JSON.stringify({
    electronVersion,
    hash,
    builtAt: new Date().toISOString(),
  }));
}

function writeNodeMeta() {
  const hash = fs.existsSync(NODE_CACHE) ? fileHash(NODE_CACHE) : 'unknown';
  fs.writeFileSync(NODE_META, JSON.stringify({
    abi: String(process.versions.modules),
    version: process.version,
    hash,
    builtAt: new Date().toISOString(),
  }));
}

function clearCache(cachePath, metaPath) {
  if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
}

/**
 * Check if the binary file is locked by another process (e.g. Extension Host).
 */
function isBinaryLocked() {
  if (!fs.existsSync(BINARY)) return false;
  try {
    const fd = fs.openSync(BINARY, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (err) {
    return err.code === 'EBUSY' || err.code === 'EPERM';
  }
}

/**
 * Copy file with EBUSY tolerance (Windows file lock from Extension Host).
 * better-sqlite3 Electron prebuilds are binary-compatible with Node.js,
 * so tests pass even when the Electron binary is locked in place.
 */
function copyWithRetry(src, dest) {
  try {
    fs.copyFileSync(src, dest);
  } catch (err) {
    if (err.code === 'EBUSY') {
      console.log('WARNING: Binary locked by another process (Extension Host?) — using existing binary');
    } else {
      throw err;
    }
  }
}

const target = process.argv[2];

if (!target || !['electron', 'node'].includes(target)) {
  console.log('Usage: node scripts/sqlite-rebuild.js <electron|node>');
  process.exit(1);
}

fs.mkdirSync(CACHE_DIR, { recursive: true });

if (target === 'electron') {
  const electronVersion = detectVSCodeElectronVersion();
  if (!electronVersion) {
    console.error('Could not detect VS Code Electron version. Is VS Code installed?');
    process.exit(1);
  }
  console.log(`VS Code Electron: ${electronVersion}`);

  if (isElectronCacheValid(electronVersion)) {
    // Skip copy if the active binary already matches the Electron cache
    if (fs.existsSync(BINARY) && fileHash(BINARY) === fileHash(ELECTRON_CACHE)) {
      console.log('Binary already matches Electron cache, skipping copy');
    } else {
      console.log('Using cached Electron build');
      copyWithRetry(ELECTRON_CACHE, BINARY);
    }
  } else {
    clearCache(ELECTRON_CACHE, ELECTRON_META);
    console.log(`Installing better-sqlite3 prebuild for Electron ${electronVersion}...`);

    // Use prebuild-install directly — electron-rebuild v3.x is broken and
    // reports success without actually changing the binary.
    execSync(
      `npx prebuild-install --runtime electron --target ${electronVersion} --verbose`,
      { cwd: SQLITE_DIR, stdio: 'inherit' },
    );

    if (!fs.existsSync(BINARY)) {
      console.error('prebuild-install did not produce a binary. Falling back to node-gyp...');
      execSync(
        `npx node-gyp rebuild --release --runtime=electron --target=${electronVersion} --arch=x64 --dist-url=https://electronjs.org/headers`,
        { cwd: SQLITE_DIR, stdio: 'inherit' },
      );
    }

    fs.copyFileSync(BINARY, ELECTRON_CACHE);
    writeElectronMeta(electronVersion);
    console.log('Electron build cached');
  }
} else {
  console.log(`Node.js ${process.version} (ABI: ${process.versions.modules})`);

  if (isNodeCacheValid()) {
    if (fs.existsSync(BINARY) && fileHash(BINARY) === fileHash(NODE_CACHE)) {
      console.log('Binary already matches Node cache, skipping copy');
    } else {
      console.log('Using cached Node build');
      copyWithRetry(NODE_CACHE, BINARY);
    }
  } else {
    // Check if binary is locked before attempting rebuild
    if (isBinaryLocked()) {
      console.log('WARNING: Binary locked by another process — skipping rebuild, using existing binary');
    } else {
      clearCache(NODE_CACHE, NODE_META);
      console.log('Rebuilding better-sqlite3 for Node.js...');
      execSync('npm rebuild better-sqlite3', { cwd: ROOT, stdio: 'inherit' });
      fs.copyFileSync(BINARY, NODE_CACHE);
      writeNodeMeta();
      console.log('Node build cached');
    }
  }
}

// Verify the binary exists
if (!fs.existsSync(BINARY)) {
  console.error(`ERROR: Binary not found at ${BINARY}`);
  process.exit(1);
}

console.log(`better-sqlite3 is now built for ${target}`);
