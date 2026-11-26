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

function initializeParams(protocolVersion = '2025-03-26') {
  return {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1.0.0' },
  };
}

function initializeRequest(id: number, protocolVersion?: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: initializeParams(protocolVersion) });
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

interface ReleaseFixture {
  directory: string;
  manifestPath: string;
  gitLogPath: string;
}

function writeExecutable(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function createReleaseFixture(failSync = false): ReleaseFixture {
  const tempParent = path.join(root, 'tmp');
  fs.mkdirSync(tempParent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(tempParent, 'viewstor codex release '));
  const releaseScript = path.join(directory, '.github', 'scripts', 'prepare-release.sh');
  const syncScript = path.join(directory, 'scripts', 'sync-codex-plugin-version.mjs');
  const manifestPath = path.join(directory, 'plugins', 'codex-local', '.codex-plugin', 'plugin.json');
  const bin = path.join(directory, 'bin');
  const gitLogPath = path.join(directory, 'git.log');
  fs.mkdirSync(path.dirname(releaseScript), { recursive: true });
  fs.mkdirSync(path.dirname(syncScript), { recursive: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  fs.copyFileSync(path.join(root, '.github', 'scripts', 'prepare-release.sh'), releaseScript);
  if (failSync) {
    fs.writeFileSync(syncScript, 'throw new Error(\'forced sync failure\');\n');
  } else {
    fs.copyFileSync(path.join(root, 'scripts', 'sync-codex-plugin-version.mjs'), syncScript);
  }
  fs.writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({ name: 'fixture', version: '0.5.4' }, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(directory, 'CHANGELOG.md'), '## [Unreleased]\n');
  fs.writeFileSync(manifestPath, `${JSON.stringify({ name: 'viewstor', version: '0.0.1' }, null, 2)}\n`);

  writeExecutable(path.join(bin, 'gh'), `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":1,"labels":[],"body":""}]'
  exit 0
fi
exit 1
`);
  writeExecutable(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(bin, 'sed'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> "$VIEWSTOR_TEST_GIT_LOG"
case "$1" in
  describe|log) exit 1 ;;
esac
if [ "$1" = "add" ]; then
  PACKAGE_VERSION=$(node -p "require('./package.json').version")
  MANIFEST_VERSION=$(node -p "require('./plugins/codex-local/.codex-plugin/plugin.json').version")
  [ "$PACKAGE_VERSION" = "$MANIFEST_VERSION" ] || exit 1
fi
exit 0
`);

  return { directory, manifestPath, gitLogPath };
}

function runReleaseFixture(fixture: ReleaseFixture) {
  const env = {
    ...process.env,
    PATH: `${path.join(fixture.directory, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
    VIEWSTOR_TEST_GIT_LOG: fixture.gitLogPath,
  };
  delete env.GITHUB_ENV;
  return spawnSync('bash', ['.github/scripts/prepare-release.sh'], {
    cwd: fixture.directory,
    env,
    encoding: 'utf8',
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
    const fixture = createReleaseFixture();
    try {
      const result = runReleaseFixture(fixture);
      expect(result.status, result.stderr).toBe(0);
      expect(readJson(fixture.manifestPath).version).toBe('0.5.5');
      expect(readJson(path.join(fixture.directory, 'package.json')).version).toBe('0.5.5');

      const gitCalls = fs.readFileSync(fixture.gitLogPath, 'utf8').trim().split('\n');
      const stageIndex = gitCalls.indexOf('add package.json package-lock.json CHANGELOG.md plugins/codex-local/.codex-plugin/plugin.json');
      const commitIndex = gitCalls.findIndex(call => call.startsWith('commit -m '));
      const tagIndex = gitCalls.findIndex(call => call.startsWith('tag '));
      const pushIndex = gitCalls.findIndex(call => call.startsWith('push '));
      expect(stageIndex).toBeGreaterThanOrEqual(0);
      expect(commitIndex).toBeGreaterThan(stageIndex);
      expect(tagIndex).toBeGreaterThan(commitIndex);
      expect(pushIndex).toBeGreaterThan(tagIndex);
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('stops the release before staging when plugin synchronization fails', () => {
    const fixture = createReleaseFixture(true);
    try {
      const result = runReleaseFixture(fixture);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('forced sync failure');
      const gitCalls = fs.existsSync(fixture.gitLogPath)
        ? fs.readFileSync(fixture.gitLogPath, 'utf8').trim().split('\n')
        : [];
      expect(gitCalls.some(call => /^(add|commit|tag|push) /.test(call))).toBe(false);
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
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
      initializeRequest(1),
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
    const { messages, stderr } = await runAdapter([initializeRequest(1, '1900-01-01')]);

    expect(stderr).toBe('');
    expect(messages).toHaveLength(1);
    expect(messages[0].result).toMatchObject({ protocolVersion: '2025-03-26' });
  });

  it('allows ping after the initialize response and before initialized', async () => {
    const { messages, stderr } = await runAdapter([
      initializeRequest(1),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    ]);

    expect(stderr).toBe('');
    expect(messages.find(message => message.id === 2)?.result).toEqual({});
    expect(messages.find(message => message.id === 3)?.result).toEqual({ tools: [] });
  });

  it('rejects malformed requests without committing initialization state', async () => {
    const { messages, stderr } = await runAdapter([
      JSON.stringify({ id: 1, method: 'initialize', params: initializeParams() }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize' }),
      JSON.stringify({ jsonrpc: '2.0', id: { invalid: true }, method: 'initialize', params: initializeParams() }),
      initializeRequest(3),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: 'invalid' }),
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
    ]);

    expect(stderr).toBe('');
    expect(messages).toHaveLength(6);
    expect(messages[0].error).toMatchObject({ code: -32600 });
    expect(messages[1].error).toMatchObject({ code: -32602 });
    expect(messages[2]).toMatchObject({ id: null, error: { code: -32600 } });
    expect(messages[3]).toMatchObject({ id: 3 });
    expect(messages[3].result).toBeDefined();
    expect(messages[4].error).toMatchObject({ code: -32602 });
    expect(messages[5].result).toEqual({ tools: [] });
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
      initializeRequest(1),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    ]);

    expect(messages[0].error).toMatchObject({ code: -32700 });
    expect(messages[1].result).toBeDefined();
    expect(messages[2].result).toEqual({ tools: [] });
  });
});
