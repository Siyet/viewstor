import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'dist/test/test/vscode/**/*.vscode.test.js',
  mocha: {
    ui: 'tdd',
    timeout: 30000,
    color: true,
  },
  launchArgs: [
    '--disable-extensions',
  ],
});
