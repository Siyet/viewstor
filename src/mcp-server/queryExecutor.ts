import { anonymizeRows, scrubErrorMessage } from '../mcp/anonymizer';
import { formatExecuteQuery } from '../mcp/mcpFormatters';
import { isReadOnlyQuery } from '../utils/queryHelpers';
import type { ConnectionStore } from './connectionStore';

export interface ExecuteQueryInput {
  connectionId: string;
  query: string;
  database?: string;
}

export async function handleExecuteQuery(store: ConnectionStore, args: ExecuteQueryInput) {
  const { connectionId, query, database } = args;
  const config = store.get(connectionId);
  if (config?.readonly && !isReadOnlyQuery(query)) {
    return errorResponse('Connection is read-only. Only SELECT, EXPLAIN, SHOW, and WITH queries are allowed.');
  }
  const policy = store.getAnonymizationPolicy(connectionId);
  const driver = database
    ? await store.ensureDriverForDatabase(connectionId, database)
    : await store.ensureDriver(connectionId);
  const result = await driver.execute(query);
  const payload = formatExecuteQuery(result);
  payload.rows = anonymizeRows(result.columns, result.rows, policy);
  if (payload.error) payload.error = scrubErrorMessage(payload.error, policy);
  return jsonResponse(payload);
}

function jsonResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResponse(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}
