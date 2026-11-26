import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(root, 'plugins', 'codex-local');
const codex = process.env.CODEX_CLI || 'codex';
const tempParent = path.join(root, 'tmp');
mkdirSync(tempParent, { recursive: true });
const work = mkdtempSync(path.join(tempParent, 'viewstor codex '));

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} timed out`));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
  await exited;
  clearTimeout(timer);
}

async function hostSmoke({ project, env }) {
  const child = spawn(codex, ['app-server', '--stdio'], {
    cwd: project,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 0;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out\n${stderr}`));
      }, 45_000);
      pending.set(id, { resolve, reject, timer, method });
      send({ id, method, params });
    });
  }

  input.on('line', line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined || message.method !== undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(new Error(`${request.method}: ${JSON.stringify(message.error)}\n${stderr}`));
    } else {
      request.resolve(message.result);
    }
  });
  child.on('error', error => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  });

  try {
    await request('initialize', {
      clientInfo: { name: 'viewstor-plugin-smoke', title: 'Viewstor Plugin Smoke', version: '1.0.0' },
    });
    send({ method: 'initialized', params: {} });
    const thread = await request('thread/start', { cwd: project, ephemeral: true });
    assert.equal(typeof thread.thread?.id, 'string');
    const status = await request('mcpServerStatus/list', {
      threadId: thread.thread.id,
      detail: 'toolsAndAuthOnly',
    });
    assert.equal(status.nextCursor, null);
    const servers = status.data.filter(server => server.name === 'viewstor');
    assert.equal(servers.length, 1, `Expected one Viewstor server, got ${JSON.stringify(status.data)}`);
    const [server] = servers;
    assert.equal(server.runtimeStatus, 'connected', JSON.stringify(server));
    assert.equal(server.toolsError, null, JSON.stringify(server));
    assert.deepEqual(server.tools, {});
    return { serverInfo: server.serverInfo, pluginId: server.pluginId };
  } finally {
    input.close();
    child.stdin.end();
    await stop(child);
  }
}

function findInstalledPlugin(cacheRoot) {
  const matches = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && entry.name === 'plugin.json' && path.basename(directory) === '.codex-plugin') {
        const manifest = JSON.parse(readFileSync(absolute, 'utf8'));
        if (manifest.name === 'viewstor') matches.push(path.dirname(directory));
      }
    }
  }
  visit(cacheRoot);
  assert.equal(matches.length, 1, `Expected one installed Viewstor plugin, found ${matches.length}`);
  return matches[0];
}

async function main() {
  const marketplace = path.join(work, 'marketplace');
  const installedSource = path.join(marketplace, 'plugins', 'viewstor');
  const home = path.join(work, 'home');
  const codexHome = path.join(work, 'codex-home');
  const project = path.join(work, 'project with spaces');
  mkdirSync(path.dirname(installedSource), { recursive: true });
  mkdirSync(path.join(marketplace, '.agents', 'plugins'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(project, { recursive: true });
  cpSync(pluginRoot, installedSource, { recursive: true });

  const manifest = JSON.parse(readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  writeFileSync(path.join(marketplace, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify({
    name: 'viewstor-test',
    interface: { displayName: 'Viewstor Isolated Test' },
    plugins: [{
      name: 'viewstor',
      source: { source: 'local', path: './plugins/viewstor' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    }],
  }, null, 2)}\n`);

  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    HOME: home,
    CODEX_HOME: codexHome,
    TMPDIR: work,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    NODE_NO_WARNINGS: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.ELECTRON_RUN_AS_NODE;

  await run(codex, ['plugin', 'marketplace', 'add', marketplace, '--json'], { cwd: project, env });
  await run(codex, ['plugin', 'add', 'viewstor@viewstor-test', '--json'], { cwd: project, env });

  const installed = findInstalledPlugin(path.join(codexHome, 'plugins', 'cache'));
  const cacheVersion = path.basename(installed);
  assert.ok(cacheVersion === 'local' || cacheVersion === manifest.version, `Unexpected Codex cache version: ${cacheVersion}`);
  const installedManifest = JSON.parse(readFileSync(path.join(installed, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(installedManifest.version, manifest.version);
  assert.equal(readFileSync(path.join(installed, 'adapter', 'entry.mjs'), 'utf8'), readFileSync(path.join(pluginRoot, 'adapter', 'entry.mjs'), 'utf8'));

  // Prove the host loads the installed cache rather than the marketplace source.
  rmSync(installedSource, { recursive: true, force: true });
  const host = await hostSmoke({ project, env });
  assert.equal(host.serverInfo?.name, 'viewstor');
  assert.equal(host.serverInfo?.version, manifest.version);
  assert.equal(typeof host.pluginId, 'string');

  process.stdout.write(`${JSON.stringify({
    result: 'pass',
    plugin: 'viewstor',
    version: manifest.version,
    host: 'codex app-server',
    tools: [],
  }, null, 2)}\n`);
}

main()
  .catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(work, { recursive: true, force: true });
  });
