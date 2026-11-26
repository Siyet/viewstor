import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const manifest = JSON.parse(readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
const SUPPORTED_PROTOCOL_VERSION = '2025-03-26';
const serverInfo = { name: manifest.name, version: manifest.version };
let initializeReceived = false;
let initialized = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleRequest(message) {
  const { id, method } = message;
  if (typeof method !== 'string') {
    sendError(id, -32600, 'Invalid Request: method must be a string');
    return;
  }

  if (method === 'initialize') {
    if (initializeReceived) {
      sendError(id, -32600, 'Server is already initialized');
      return;
    }
    initializeReceived = true;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        // If the requested version differs, the client decides whether to continue.
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo,
      },
    });
    return;
  }

  if (!initialized) {
    sendError(id, -32002, 'Server is not initialized');
    return;
  }

  switch (method) {
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      // No database surface is exposed until the shared local-agent runtime is integrated.
      send({ jsonrpc: '2.0', id, result: { tools: [] } });
      return;
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

function handleMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    sendError(null, -32600, 'Invalid Request: expected a JSON object');
    return;
  }
  if (message.id === undefined) {
    if (message.method === 'notifications/initialized' && initializeReceived) initialized = true;
    return;
  }
  handleRequest(message);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handleMessage(JSON.parse(line));
  } catch {
    sendError(null, -32700, 'Parse error: expected newline-delimited JSON');
  }
});

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});
