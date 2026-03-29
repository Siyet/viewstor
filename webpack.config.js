/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

/** @type {import('webpack').Configuration} */
module.exports = {
  target: 'node',
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
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: 'ts-loader',
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'src/webview/styles', to: 'styles' },
        { from: 'src/webview/scripts', to: 'scripts' },
      ],
    }),
  ],
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log',
  },
};
