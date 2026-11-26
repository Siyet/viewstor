const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.getExtension('Siyet.viewstor');
  if (!extension) throw new Error('Installed production Viewstor extension was not found');
  const api = await extension.activate();
  const manager = api?.connectionManager;
  if (!manager) throw new Error('Production ConnectionManager API is unavailable');

  const id = 'production-native-vsix-smoke';
  await manager.add({
    id,
    name: 'Production native VSIX smoke',
    type: 'sqlite',
    host: '',
    port: 0,
    username: '',
    password: '',
    database: ':memory:',
    ssl: false,
    options: {},
    scope: 'user',
  });
  try {
    await manager.connect(id);
    const driver = await manager.ensureDriver(id);
    await driver.execute('CREATE TABLE smoke (id INTEGER PRIMARY KEY, value INTEGER)');
    await driver.execute('INSERT INTO smoke VALUES (1, 42)');
    const result = await driver.execute('SELECT value, sqlite_version() AS version FROM smoke WHERE id = 1');
    if (result.error) throw new Error(result.error);
    if (result.rows.length !== 1 || result.rows[0].value !== 42) {
      throw new Error(`Unexpected production SQLite result: ${JSON.stringify(result)}`);
    }

    const nativeBinary = path.join(
      extension.extensionPath,
      'node_modules',
      'better-sqlite3',
      'prebuilds',
      `${process.platform}-${process.arch}.node`,
    );
    const { version } = require(path.join(extension.extensionPath, 'node_modules', 'better-sqlite3', 'package.json'));
    writeFileSync(process.env.VIEWSTOR_PRODUCTION_NATIVE_EVIDENCE, `${JSON.stringify({
      type: 'production-vsix-native-smoke',
      extensionId: extension.id,
      extensionPath: extension.extensionPath,
      hostVersion: vscode.version,
      version,
      runtime: {
        node: process.versions.node,
        electron: process.versions.electron,
        modules: process.versions.modules,
        napi: process.versions.napi,
        platform: process.platform,
        arch: process.arch,
        execPath: process.execPath,
      },
      nativeBinary: path.basename(nativeBinary),
      binarySha256: createHash('sha256').update(readFileSync(nativeBinary)).digest('hex'),
      sqlite: { version: result.rows[0].version },
      value: result.rows[0].value,
    }, null, 2)}\n`);
  } finally {
    await manager.disconnect(id);
    await manager.remove(id);
  }
}

module.exports = { run };
