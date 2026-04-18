/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');

const commonConfig = {
  target: 'node',
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [{ test: /\.ts$/, exclude: /node_modules/, use: 'ts-loader' }],
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: { level: 'log' },
};

/** @type {(env: any, argv: { mode?: string }) => import('webpack').Configuration[]} */
module.exports = (_env, argv) => {
  const isDev = argv.mode !== 'production';

  return [
  // VS Code extension
  {
    ...commonConfig,
    entry: './src/extension.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'extension.js',
      libraryTarget: 'commonjs2',
    },
    externals: {
      vscode: 'commonjs vscode',
      ssh2: 'commonjs ssh2',
      'cpu-features': 'commonjs cpu-features',
      'better-sqlite3': 'commonjs better-sqlite3',
    },
    plugins: [
      new webpack.DefinePlugin({ __DEV__: JSON.stringify(isDev) }),
      // `pg` lazily references `pg-native` only when the caller opts in via `pg.native`.
      // We never do — ignore the module so webpack stops warning about the missing peer.
      new webpack.IgnorePlugin({ resourceRegExp: /^pg-native$/ }),
      new CopyPlugin({
        patterns: [
          { from: 'src/webview/styles', to: 'styles' },
          { from: 'src/webview/scripts', to: 'scripts' },
          { from: 'node_modules/echarts/dist/echarts.min.js', to: 'scripts/echarts.min.js' },
          { from: 'node_modules/leaflet/dist/leaflet.js', to: 'scripts/leaflet.js' },
          { from: 'node_modules/leaflet/dist/leaflet.css', to: 'styles/leaflet.css' },
          { from: 'node_modules/leaflet/dist/images', to: 'styles/images' },
          { from: 'node_modules/@vscode-elements/elements/dist/bundled.js', to: 'scripts/vscode-elements.js' },
          { from: 'node_modules/@vscode/codicons/dist/codicon.css', to: 'styles/codicon.css' },
          { from: 'node_modules/@vscode/codicons/dist/codicon.ttf', to: 'styles/codicon.ttf' },
        ],
      }),
    ],
  },
  // Standalone MCP server
  {
    ...commonConfig,
    entry: './src/mcp-server/index.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'mcp-server.js',
      libraryTarget: 'commonjs2',
    },
    externals: {
      ssh2: 'commonjs ssh2',
      'cpu-features': 'commonjs cpu-features',
      'better-sqlite3': 'commonjs better-sqlite3',
    },
    plugins: [
      new webpack.DefinePlugin({ __DEV__: JSON.stringify(isDev) }),
      new webpack.IgnorePlugin({ resourceRegExp: /^pg-native$/ }),
      new webpack.BannerPlugin({ banner: '#!/usr/bin/env node', raw: true }),
    ],
  },
];
};
