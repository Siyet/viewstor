import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(root, 'plugins', 'codex-local');
const marketplaceManifestPath = path.join(root, '.agents', 'plugins', 'marketplace.json');
const codex = process.env.CODEX_CLI || 'codex';
const tempParent = path.join(root, 'tmp');
mkdirSync(tempParent, { recursive: true });
const work = mkdtempSync(path.join(tempParent, 'viewstor codex '));

function observeClose(child) {
  const state = { closed: false, promise: null };
  state.promise = new Promise(resolve => {
    child.once('close', (code, signal) => {
      state.closed = true;
      resolve({ code, signal });
    });
  });
  return state;
}

function signalChild(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    try {
      child.kill(signal);
    } catch (fallbackError) {
      if (fallbackError.code !== 'ESRCH') throw fallbackError;
    }
  }
}

function waitForClose(state, timeoutMs) {
  if (state.closed) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    state.promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stop(child, closeState) {
  if (closeState.closed) return;
  if (child.pid === undefined) {
    await waitForClose(closeState, 2_000);
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    signalChild(child, 'SIGTERM');
    if (await waitForClose(closeState, 2_000)) return;
  }
  if (!closeState.closed) {
    signalChild(child, 'SIGKILL');
    await waitForClose(closeState, 2_000);
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closeState = observeClose(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer;
    const timeoutError = () => new Error(`${command} ${args.join(' ')} timed out\n${stdout}\n${stderr}`);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        signalChild(child, 'SIGKILL');
      } catch (error) {
        finish(reject, error);
        return;
      }
      killTimer = setTimeout(() => finish(reject, timeoutError()), 2_000);
    }, 45_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish(reject, error));
    closeState.promise.then(({ code }) => {
      if (timedOut) {
        finish(reject, timeoutError());
      } else if (code === 0) {
        finish(resolve, { stdout, stderr });
      } else {
        finish(reject, new Error(`${command} ${args.join(' ')} exited with ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function hostSmoke({ project, env, expectedVersion, pluginId }) {
  const child = spawn(codex, ['app-server', '--stdio'], {
    cwd: project,
    env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closeState = observeClose(child);
  const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  const methods = [];
  let nextId = 0;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  function send(message) {
    methods.push(message.method);
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

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
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
  child.on('error', rejectPending);
  child.stdin.on('error', rejectPending);
  closeState.promise.then(({ code, signal }) => {
    rejectPending(new Error(`Codex app-server closed before responding (code ${code}, signal ${signal})\n${stderr}`));
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
    assert.equal(server.serverInfo?.name, 'viewstor');
    assert.equal(server.serverInfo?.version, expectedVersion);
    assert.equal(server.pluginId, pluginId);
    assert.equal(methods.includes('turn/start'), false, 'The smoke must not invoke a model');
    return { serverInfo: server.serverInfo, pluginId: server.pluginId, methods };
  } finally {
    input.close();
    child.stdin.end();
    await stop(child, closeState);
  }
}

function createGitServer({ env, projectRoot }) {
  const gitBackend = path.join(
    execFileSync('git', ['--exec-path'], { env, encoding: 'utf8' }).trim(),
    'git-http-backend',
  );
  const backends = new Set();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const output = [];
    const errors = [];
    const child = spawn(gitBackend, [], {
      env: {
        ...env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers['content-type'] || '',
        CONTENT_LENGTH: request.headers['content-length'] || '',
        REMOTE_ADDR: '127.0.0.1',
        SERVER_PROTOCOL: 'HTTP/1.1',
        SERVER_NAME: '127.0.0.1',
        SERVER_PORT: String(server.address().port),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    backends.add(child);
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', error => {
      if (response.writableEnded) return;
      response.statusCode = 500;
      response.end(String(error));
    });
    child.on('close', code => {
      backends.delete(child);
      if (response.writableEnded) return;
      if (code !== 0) {
        response.statusCode = 500;
        response.end(Buffer.concat(errors));
        return;
      }
      const body = Buffer.concat(output);
      const separator = body.indexOf('\r\n\r\n');
      if (separator < 0) {
        response.statusCode = 500;
        response.end('Invalid git-http-backend response');
        return;
      }
      for (const line of body.subarray(0, separator).toString('utf8').split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === 'status') response.statusCode = Number(value.split(' ')[0]);
        else response.setHeader(name, value);
      }
      response.end(body.subarray(separator + 4));
    });
    request.pipe(child.stdin);
  });

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      return `http://127.0.0.1:${server.address().port}/remote.git`;
    },
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      const exiting = [...backends].map(child => new Promise(resolve => {
        child.once('close', resolve);
        child.kill('SIGKILL');
      }));
      await closed;
      await Promise.all(exiting);
    },
  };
}

async function main() {
  const source = path.join(work, 'source');
  const remote = path.join(work, 'remote.git');
  const home = path.join(work, 'home');
  const codexHome = path.join(work, 'codex-home');
  const project = path.join(work, 'project with spaces');
  const fixturePlugin = path.join(source, 'plugins', 'codex-local');
  const fixtureManifest = path.join(fixturePlugin, '.codex-plugin', 'plugin.json');
  const fixtureMarketplace = path.join(source, '.agents', 'plugins', 'marketplace.json');
  mkdirSync(path.dirname(fixtureMarketplace), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(project, { recursive: true });
  cpSync(pluginRoot, fixturePlugin, { recursive: true });
  copyFileSync(marketplaceManifestPath, fixtureMarketplace);
  assert.ok(readFileSync(marketplaceManifestPath).equals(readFileSync(fixtureMarketplace)));

  const gitConfig = path.join(work, 'gitconfig');
  writeFileSync(gitConfig, '');
  const env = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    HOME: home,
    CODEX_HOME: codexHome,
    TMPDIR: work,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    NODE_NO_WARNINGS: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  };
  const git = (args, cwd = source) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  const setVersion = version => {
    const manifest = JSON.parse(readFileSync(fixtureManifest, 'utf8'));
    manifest.version = version;
    writeFileSync(fixtureManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const commitAndPush = message => {
    git(['add', '.agents/plugins/marketplace.json', 'plugins/codex-local']);
    git(['-c', 'user.name=Viewstor Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message]);
    git(['push', 'origin', 'main']);
  };

  git(['init', '--bare', '--initial-branch=main', remote], work);
  git(['init', '--initial-branch=main', source], work);
  git(['remote', 'add', 'origin', remote]);
  setVersion('0.0.1');
  commitAndPush('fixture 0.0.1');

  const gitServer = createGitServer({ env, projectRoot: work });
  try {
    const marketplaceUrl = await gitServer.listen();
    const addedMarketplace = JSON.parse((await run(
      codex,
      ['plugin', 'marketplace', 'add', marketplaceUrl, '--ref', 'main', '--json'],
      { cwd: project, env },
    )).stdout);
    assert.equal(addedMarketplace.marketplaceName, 'viewstor');
    const installedMarketplace = addedMarketplace.installedRoot;
    const addedPlugin = JSON.parse((await run(
      codex,
      ['plugin', 'add', 'viewstor@viewstor', '--json'],
      { cwd: project, env },
    )).stdout);
    assert.equal(addedPlugin.pluginId, 'viewstor@viewstor');
    assert.equal(addedPlugin.version, '0.0.1');

    const cacheRoot = path.join(codexHome, 'plugins', 'cache', 'viewstor', 'viewstor');
    const assertInstalledCache = version => {
      const versions = readdirSync(cacheRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
      assert.deepEqual(versions, [version]);
      const installed = path.join(cacheRoot, version);
      const installedManifest = JSON.parse(readFileSync(path.join(installed, '.codex-plugin', 'plugin.json'), 'utf8'));
      assert.equal(installedManifest.version, version);
      assert.ok(readFileSync(path.join(installed, 'adapter', 'entry.mjs'))
        .equals(readFileSync(path.join(fixturePlugin, 'adapter', 'entry.mjs'))));
      return installed;
    };

    const oldInstalled = assertInstalledCache('0.0.1');
    assert.equal(path.resolve(oldInstalled), path.resolve(addedPlugin.installedPath));
    const oldHost = await hostSmoke({
      project,
      env,
      expectedVersion: '0.0.1',
      pluginId: 'viewstor@viewstor',
    });

    setVersion('0.0.2');
    writeFileSync(path.join(fixturePlugin, 'adapter', 'update-marker.txt'), 'updated fixture\n');
    commitAndPush('fixture 0.0.2');
    const upgrade = JSON.parse((await run(
      codex,
      ['plugin', 'marketplace', 'upgrade', 'viewstor', '--json'],
      { cwd: project, env },
    )).stdout);
    assert.deepEqual(upgrade.selectedMarketplaces, ['viewstor']);
    assert.deepEqual(upgrade.upgradedRoots, [installedMarketplace]);
    assert.deepEqual(upgrade.errors, []);

    // Check the direct upgrade result before plugin list can trigger its own refresh.
    assertInstalledCache('0.0.2');
    assert.equal(existsSync(path.join(cacheRoot, '0.0.1')), false);
    const listed = JSON.parse((await run(
      codex,
      ['plugin', 'list', '--marketplace', 'viewstor', '--available', '--json'],
      { cwd: project, env },
    )).stdout);
    assert.equal(listed.installed.length, 1);
    assert.deepEqual(listed.available, []);
    assert.deepEqual(listed.installed[0], {
      ...listed.installed[0],
      pluginId: 'viewstor@viewstor',
      name: 'viewstor',
      marketplaceName: 'viewstor',
      version: '0.0.2',
      installed: true,
      enabled: true,
      installPolicy: 'AVAILABLE',
      authPolicy: 'ON_INSTALL',
    });

    // The final host must use the installed cache without any marketplace source.
    rmSync(installedMarketplace, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
    const newHost = await hostSmoke({
      project,
      env,
      expectedVersion: '0.0.2',
      pluginId: 'viewstor@viewstor',
    });
    assert.equal(existsSync(installedMarketplace), false);
    assert.equal(existsSync(remote), false);
    assert.equal(existsSync(source), false);
    assert.equal(readFileSync(path.join(cacheRoot, '0.0.2', 'adapter', 'update-marker.txt'), 'utf8'), 'updated fixture\n');

    process.stdout.write(`${JSON.stringify({
      result: 'pass',
      plugin: 'viewstor@viewstor',
      from: oldHost.serverInfo.version,
      to: newHost.serverInfo.version,
      host: 'codex app-server',
      tools: [],
      modelCalls: 0,
    }, null, 2)}\n`);
  } finally {
    await gitServer.close();
  }
}

main()
  .catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(work, { recursive: true, force: true });
  });
