import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifestPath = path.join(root, 'plugins', 'codex-local', '.codex-plugin', 'plugin.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const checkOnly = process.argv.includes('--check');

if (manifest.version !== packageJson.version) {
  if (checkOnly) {
    throw new Error(`Codex plugin version ${manifest.version} does not match product version ${packageJson.version}`);
  }
  manifest.version = packageJson.version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

process.stdout.write(`Codex plugin version: ${manifest.version}\n`);
