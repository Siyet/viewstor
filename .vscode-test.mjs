import { defineConfig } from '@vscode/test-cli';

const vscodeExecutable = process.env.VIEWSTOR_VSCODE_EXECUTABLE || process.env.VSCODE_EXECUTABLE_PATH;

export default defineConfig({
  files: 'dist/test/test/vscode/**/*.vscode.test.js',
  useInstallation: vscodeExecutable
    ? { fromPath: vscodeExecutable }
    : undefined,
  mocha: {
    ui: 'tdd',
    timeout: 30000,
    color: true,
  },
  launchArgs: [
    '--disable-extensions',
  ],
});
