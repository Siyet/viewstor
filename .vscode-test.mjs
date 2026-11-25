import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'dist/test/test/vscode/**/*.vscode.test.js',
  useInstallation: process.env.VSCODE_EXECUTABLE_PATH
    ? { fromPath: process.env.VSCODE_EXECUTABLE_PATH }
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
