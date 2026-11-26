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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidRequestId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id));
}

function handleRequest(message) {
  const { id, method } = message;
  if (method === 'initialize') {
    if (initializeReceived) {
      sendError(id, -32600, 'Server is already initialized');
      return;
    }
    const params = message.params;
    if (!isObject(params)
      || typeof params.protocolVersion !== 'string'
      || !isObject(params.capabilities)
      || !isObject(params.clientInfo)
      || typeof params.clientInfo.name !== 'string'
      || typeof params.clientInfo.version !== 'string') {
      sendError(id, -32602, 'Invalid params: initialize requires protocolVersion, capabilities, and clientInfo');
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

  // MCP permits ping while initialization is still in progress.
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (!initialized) {
    sendError(id, -32002, 'Server is not initialized');
    return;
  }

  switch (method) {
    case 'tools/list':
      // No database surface is exposed until the shared local-agent runtime is integrated.
      send({ jsonrpc: '2.0', id, result: { tools: [] } });
      return;
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

function handleMessage(message) {
  if (!isObject(message)) {
    sendError(null, -32600, 'Invalid Request: expected a JSON object');
    return;
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    sendError(isValidRequestId(message.id) ? message.id : null, -32600, 'Invalid Request: expected jsonrpc 2.0 and a string method');
    return;
  }
  if (message.id !== undefined && !isValidRequestId(message.id)) {
    sendError(null, -32600, 'Invalid Request: id must be a string or integer');
    return;
  }
  if (message.params !== undefined && !isObject(message.params)) {
    if (message.id !== undefined) sendError(message.id, -32602, 'Invalid params: expected an object');
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
