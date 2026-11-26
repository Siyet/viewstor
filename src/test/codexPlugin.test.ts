import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..', '..');
const pluginRoot = path.join(root, 'plugins', 'codex-local');
const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
const adapterPath = path.join(pluginRoot, 'adapter', 'entry.mjs');

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

interface AdapterResult {
  messages: Array<Record<string, unknown>>;
  stderr: string;
}

function runAdapter(lines: string[]): Promise<AdapterResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [adapterPath], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Codex adapter smoke timed out'));
    }, 10_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      try {
        expect(code).toBe(0);
        const messages = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
        resolve({ messages, stderr });
      } catch (error) {
        reject(error);
      }
    });

    for (const line of lines) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}

describe('Codex local plugin packaging', () => {
  it('keeps the plugin and product versions synchronized', () => {
    const packageJson = readJson(path.join(root, 'package.json'));
    const manifest = readJson(manifestPath);
    expect(manifest.version).toBe(packageJson.version);

    const check = spawnSync(process.execPath, [path.join(root, 'scripts', 'sync-codex-plugin-version.mjs'), '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(check.status, check.stderr).toBe(0);
  });

  it('detects mismatches and updates only the manifest version', () => {
    const tempParent = path.join(root, 'tmp');
    fs.mkdirSync(tempParent, { recursive: true });
    const fixture = fs.mkdtempSync(path.join(tempParent, 'viewstor codex version '));
    try {
      const fixtureScript = path.join(fixture, 'scripts', 'sync-codex-plugin-version.mjs');
      const fixturePackage = path.join(fixture, 'package.json');
      const fixtureManifest = path.join(fixture, 'plugins', 'codex-local', '.codex-plugin', 'plugin.json');
      fs.mkdirSync(path.dirname(fixtureScript), { recursive: true });
      fs.mkdirSync(path.dirname(fixtureManifest), { recursive: true });
      fs.copyFileSync(path.join(root, 'scripts', 'sync-codex-plugin-version.mjs'), fixtureScript);

      const packageContents = `${JSON.stringify({ name: 'fixture', version: '1.2.3', private: true }, null, 2)}\n`;
      const originalManifest = {
        name: 'viewstor',
        version: '0.0.1',
        description: 'fixture',
        interface: { displayName: 'Viewstor Fixture' },
      };
      fs.writeFileSync(fixturePackage, packageContents);
      fs.writeFileSync(fixtureManifest, `${JSON.stringify(originalManifest, null, 2)}\n`);

      const check = spawnSync(process.execPath, [fixtureScript, '--check'], { cwd: fixture, encoding: 'utf8' });
      expect(check.status).not.toBe(0);
      expect(check.stderr).toContain('does not match product version');
      expect(fs.readFileSync(fixturePackage, 'utf8')).toBe(packageContents);
      expect(readJson(fixtureManifest)).toEqual(originalManifest);

      const write = spawnSync(process.execPath, [fixtureScript], { cwd: fixture, encoding: 'utf8' });
      expect(write.status, write.stderr).toBe(0);
      expect(fs.readFileSync(fixturePackage, 'utf8')).toBe(packageContents);
      expect(readJson(fixtureManifest)).toEqual({ ...originalManifest, version: '1.2.3' });
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('synchronizes and stages the plugin manifest before a release commit', () => {
    const releaseScript = fs.readFileSync(path.join(root, '.github', 'scripts', 'prepare-release.sh'), 'utf8');
    const lockIndex = releaseScript.indexOf('npm install --package-lock-only --ignore-scripts');
    const syncIndex = releaseScript.indexOf('node scripts/sync-codex-plugin-version.mjs');
    const stageIndex = releaseScript.indexOf('git add package.json package-lock.json CHANGELOG.md plugins/codex-local/.codex-plugin/plugin.json');
    const commitIndex = releaseScript.indexOf('git commit -m "release: v${NEW_VERSION}"');

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(syncIndex).toBeGreaterThan(lockIndex);
    expect(stageIndex).toBeGreaterThan(syncIndex);
    expect(commitIndex).toBeGreaterThan(stageIndex);
  });

  it('uses one documented local MCP registration with contained paths', () => {
    const manifest = readJson(manifestPath);
    const mcp = readJson(path.join(pluginRoot, '.mcp.json'));

    expect(manifest.name).toBe('viewstor');
    expect(manifest.mcpServers).toBe('./.mcp.json');
    expect(manifest.skills).toBe('./skills/');
    expect(Object.keys(mcp)).toEqual(['viewstor']);
    expect(mcp.viewstor).toEqual({
      command: 'node',
      args: ['./adapter/entry.mjs'],
      cwd: '.',
    });
    expect(fs.existsSync(path.join(pluginRoot, 'adapter', 'entry.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(pluginRoot, 'skills', 'viewstor', 'SKILL.md'))).toBe(true);
  });

  it('contains no symlinks or references to the legacy VS Code launcher', () => {
    const pending = [pluginRoot];
    const textExtensions = new Set(['.json', '.mjs', '.md']);
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        expect(entry.isSymbolicLink(), absolute).toBe(false);
        if (entry.isDirectory()) pending.push(absolute);
        if (entry.isFile() && textExtensions.has(path.extname(entry.name))) {
          const contents = fs.readFileSync(absolute, 'utf8');
          expect(contents).not.toContain('~/.viewstor/mcp-server.js');
          expect(contents).not.toContain('.worktrees/');
          expect(contents).not.toContain('node_modules/');
        }
      }
    }
  });
});

describe('Codex local MCP adapter', () => {
  it('initializes and exposes an intentionally empty tool surface', async () => {
    const { messages, stderr } = await runAdapter([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'add_connection', arguments: {} } }),
    ]);

    expect(stderr).toBe('');
    const initialize = messages.find(message => message.id === 1);
    const tools = messages.find(message => message.id === 2);
    const ping = messages.find(message => message.id === 3);
    const forbiddenCall = messages.find(message => message.id === 4);
    const manifest = readJson(manifestPath);

    expect(initialize?.result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'viewstor', version: manifest.version },
    });
    expect(tools?.result).toEqual({ tools: [] });
    expect(ping?.result).toEqual({});
    expect(forbiddenCall?.error).toMatchObject({ code: -32601 });
  }, 15_000);

  it('offers only the supported protocol version for an unknown request', async () => {
    const { messages, stderr } = await runAdapter([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1900-01-01' } }),
    ]);

    expect(stderr).toBe('');
    expect(messages).toHaveLength(1);
    expect(messages[0].result).toMatchObject({ protocolVersion: '2025-03-26' });
    expect(messages[0].result).not.toMatchObject({ protocolVersion: '1900-01-01' });
  });

  it('rejects calls before initialization without opening a data surface', async () => {
    const { messages } = await runAdapter([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].error).toMatchObject({ code: -32002 });
  });

  it('returns protocol errors for malformed input and remains usable', async () => {
    const { messages } = await runAdapter([
      'not-json',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    ]);

    expect(messages[0].error).toMatchObject({ code: -32700 });
    expect(messages[1].result).toBeDefined();
    expect(messages[2].result).toEqual({ tools: [] });
  });
});
