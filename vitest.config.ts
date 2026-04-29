import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __DEV__: 'true',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
    exclude: [
      'node_modules', 'dist', 'src/test/e2e/**', 'src/test/vscode/**',
      // better-sqlite3 native module segfaults on Linux during process teardown
      ...(process.platform === 'linux' ? ['src/test/sqliteRebuild.test.ts'] : []),
    ],
    pool: 'forks',
  },
});
