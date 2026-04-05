import * as vscode from 'vscode';

declare const __DEV__: boolean;

let _channel: vscode.LogOutputChannel | undefined;

/** Bind the output channel once during activation */
export function setDebugChannel(channel: vscode.LogOutputChannel) {
  _channel = channel;
}

/**
 * Log a debug message — only emitted in development builds (F5 / npm run dev).
 * Completely tree-shaken in production builds (__DEV__ === false).
 */
export function dbg(tag: string, ...args: unknown[]) {
  if (!__DEV__) return;
  if (!_channel) return;
  const parts = args.map(a =>
    typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a),
  );
  _channel.debug(`[${tag}] ${parts.join(' ')}`);
}
