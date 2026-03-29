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

/** @type {import('webpack').Configuration[]} */
module.exports = [
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
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'src/webview/styles', to: 'styles' },
          { from: 'src/webview/scripts', to: 'scripts' },
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
    },
    plugins: [
      new webpack.BannerPlugin({ banner: '#!/usr/bin/env node', raw: true }),
    ],
  },
];
