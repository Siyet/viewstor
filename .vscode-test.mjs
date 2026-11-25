import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'dist/test/test/vscode/**/*.vscode.test.js',
  useInstallation: process.env.VIEWSTOR_VSCODE_EXECUTABLE
    ? { fromPath: process.env.VIEWSTOR_VSCODE_EXECUTABLE }
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
