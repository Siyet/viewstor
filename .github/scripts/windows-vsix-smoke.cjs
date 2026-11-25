const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const vscodeRoot = process.env.VSCODE_ROOT || path.join(repositoryRoot, '.vscode-win');
const electron = path.join(vscodeRoot, 'Code.exe');
const code = path.join(vscodeRoot, 'bin', 'code.cmd');
const vsix = process.env.VIEWSTOR_PRODUCTION_VSIX || path.join(repositoryRoot, 'viewstor-0.5.3.vsix');
const report = process.env.VIEWSTOR_PRODUCTION_NATIVE_REPORT || path.join(repositoryRoot, 'windows-native-report.json');
const expectedVersion = process.env.VSCODE_EXPECT_VERSION || '1.147.0';

(async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'viewstor-windows-smoke-'));
  try {
    const userData = path.join(work, 'user-data');
    const extensions = path.join(work, 'extensions');
    const install = spawnSync(code, [
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      '--install-extension', vsix,
      '--force',
    ], {
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, HOME: work },
      timeout: 60000,
    });
    assert.equal(install.status, 0, `VSIX installation failed: ${install.error || install.status}`);

    const harness = path.join(work, 'harness');
    mkdirSync(harness, { recursive: true });
    copyFileSync(path.join(__dirname, 'windows-vsix-runner.cjs'), path.join(harness, 'runner.cjs'));
    writeFileSync(path.join(harness, 'package.json'), `${JSON.stringify({
      name: 'production-native-vsix-smoke-runner',
      publisher: 'viewstor-spike',
      version: '1.0.0',
      private: true,
      engines: { vscode: '^1.101.0' },
      main: './runner.cjs',
    }, null, 2)}\n`);

    const evidenceFile = path.join(work, 'evidence.json');
    await runTests({
      vscodeExecutablePath: electron,
      extensionDevelopmentPath: harness,
      extensionTestsPath: path.join(harness, 'runner.cjs'),
      extensionTestsEnv: {
        ...process.env,
        HOME: work,
        VIEWSTOR_PRODUCTION_NATIVE_EVIDENCE: evidenceFile,
      },
      launchArgs: [`--user-data-dir=${userData}`, `--extensions-dir=${extensions}`],
    });

    const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'));
    assert.equal(evidence.type, 'production-vsix-native-smoke');
    assert.equal(evidence.extensionId, 'Siyet.viewstor');
    assert.equal(evidence.hostVersion, expectedVersion);
    assert.equal(evidence.version, '13.2.0');
    assert.equal(evidence.value, 42);
    assert.match(evidence.sqlite.version, /^\d+\.\d+\.\d+$/);
    assert.ok(Number(evidence.runtime.napi) >= 10, `N-API 10+ required, got ${evidence.runtime.napi}`);
    assert.equal(evidence.runtime.platform, 'win32');
    assert.equal(evidence.runtime.arch, 'x64');
    assert.match(evidence.runtime.execPath, /Code\.exe$/i);
    const relativeExtensionPath = path.relative(extensions, evidence.extensionPath);
    assert.ok(
      relativeExtensionPath
      && relativeExtensionPath !== '..'
      && !relativeExtensionPath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativeExtensionPath),
      `Extension loaded outside isolated directory: ${evidence.extensionPath}`,
    );
    const sourceBinary = path.join(
      repositoryRoot, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node',
    );
    const expectedDigest = createHash('sha256').update(readFileSync(sourceBinary)).digest('hex');
    assert.equal(evidence.binarySha256, expectedDigest);

    writeFileSync(report, `${JSON.stringify({
      format: 1,
      type: evidence.type,
      generatedAt: new Date().toISOString(),
      status: 'PASS',
      vsix,
      evidence,
      limitations: [
        `The smoke covers the installed production VSIX on Windows x64 with VS Code ${evidence.hostVersion} / Electron ${evidence.runtime.electron} only.`,
        'It does not prove other platforms, other runtimes, production signing/notarization, or the complete section 13.2 acceptance gate.',
      ],
    }, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
