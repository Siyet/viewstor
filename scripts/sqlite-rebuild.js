#!/usr/bin/env node
/**
 * Validates the platform prebuild shipped by better-sqlite3 v13+.
 *
 * better-sqlite3 v13 uses N-API, so the same binary supports Node.js and
 * Electron without an ABI-specific rebuild. The historical `electron` and
 * `node` targets remain for npm-script compatibility; both run the same check.
 *
 * Usage:
 *   node scripts/sqlite-rebuild.js electron
 *   node scripts/sqlite-rebuild.js node
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SQLITE_DIR = path.join(ROOT, 'node_modules', 'better-sqlite3');
const target = process.argv[2];

if (!target || !['electron', 'node'].includes(target)) {
  console.error('Usage: node scripts/sqlite-rebuild.js <electron|node>');
  process.exit(1);
}

const { version } = require(path.join(SQLITE_DIR, 'package.json'));
const binaryName = `${process.platform}-${process.arch}.node`;
const binary = path.join(SQLITE_DIR, 'prebuilds', binaryName);

if (!fs.existsSync(binary)) {
  console.error(`ERROR: better-sqlite3 ${version} has no bundled prebuild: ${binary}`);
  process.exit(1);
}

// Instantiate through the public API: require() alone does not prove that the
// native binding loads. Execute a query as a loadability smoke, not just a file check.
const Database = require(SQLITE_DIR);
const db = new Database(':memory:');
try {
  const row = db.prepare('SELECT 40 + 2 AS value').get();
  if (row.value !== 42) throw new Error(`Unexpected SQLite smoke result: ${row.value}`);
} finally {
  db.close();
}

console.log(
  `better-sqlite3 ${version} N-API prebuild validated for ${target}: ${binaryName} `
  + `(Node ${process.version}, N-API ${process.versions.napi || 'unknown'})`,
);
