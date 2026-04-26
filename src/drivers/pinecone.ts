import { DatabaseDriver } from '../types/driver';
import { ConnectionConfig } from '../types/connection';
import { QueryResult, QueryColumn, MAX_RESULT_ROWS } from '../types/query';
import { SchemaObject, TableInfo, TableStatistic } from '../types/schema';
import { wrapError } from '../utils/errors';

let PineconeModule: typeof import('@pinecone-database/pinecone') | undefined;

function requirePinecone(): typeof import('@pinecone-database/pinecone') {
  if (!PineconeModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    PineconeModule = require('@pinecone-database/pinecone');
  }
  return PineconeModule!;
}

type PineconeClient = InstanceType<typeof import('@pinecone-database/pinecone').Pinecone>;
type PineconeIndex = ReturnType<PineconeClient['index']>;

export class PineconeDriver implements DatabaseDriver {
  private client: PineconeClient | undefined;
  private indexCache: Map<string, { dimension: number; metric: string; host: string }> = new Map();

  async connect(config: ConnectionConfig): Promise<void> {
    const { Pinecone } = requirePinecone();
    this.client = new Pinecone({ apiKey: config.password || '' });
    const indexes = await this.client.listIndexes();
    if (!indexes.indexes || indexes.indexes.length === 0) {
      return;
    }
    this.indexCache.clear();
    for (const idx of indexes.indexes) {
      this.indexCache.set(idx.name, {
        dimension: idx.dimension ?? 0,
        metric: idx.metric,
        host: idx.host,
      });
    }
  }

  async disconnect(): Promise<void> {
    this.client = undefined;
    this.indexCache.clear();
  }

  async ping(): Promise<boolean> {
    const indexes = await this.client!.listIndexes();
    return Array.isArray(indexes.indexes);
  }

  async execute(query: string): Promise<QueryResult> {
    const start = Date.now();
    try {
      const parsed = parsePineconeCommand(query);
      if (!parsed) {
        return { columns: [], rows: [], rowCount: 0, executionTimeMs: 0, error: 'Unsupported command. Use: QUERY <index> vector=[...] topK=N [namespace=ns] [filter={...}], UPSERT <index> id=... vector=[...] [metadata={...}] [namespace=ns], DELETE <index> ids=[...] [namespace=ns], STATS <index>, LIST <index> [namespace=ns] [prefix=...] [limit=N]' };
      }

      const index = this.getIndex(parsed.index);

      switch (parsed.command) {
        case 'QUERY': return await this.executeQuery(index, parsed, start);
        case 'UPSERT': return await this.executeUpsert(index, parsed, start);
        case 'DELETE': return await this.executeDelete(index, parsed, start);
        case 'STATS': return await this.executeStats(index, start);
        case 'LIST': return await this.executeList(index, parsed, start);
        default:
          return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: `Unknown command: ${parsed.command}` };
      }
    } catch (err) {
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: wrapError(err) };
    }
  }

  async getSchema(): Promise<SchemaObject[]> {
    const indexes = await this.client!.listIndexes();
    const result: SchemaObject[] = [];

    for (const idx of indexes.indexes || []) {
      const indexObj: SchemaObject = {
        name: idx.name,
        type: 'table',
        detail: `${idx.dimension}d ${idx.metric}`,
        children: [],
      };

      try {
        const index = this.client!.index(idx.name);
        const stats = await index.describeIndexStats();
        const namespaces = stats.namespaces || {};
        for (const [nsName, nsInfo] of Object.entries(namespaces)) {
          indexObj.children!.push({
            name: nsName || '(default)',
            type: 'namespace',
            detail: `${nsInfo.recordCount ?? 0} vectors`,
          });
        }
      } catch {
        // If stats fail, show index without namespace details
      }

      result.push(indexObj);
    }

    return result;
  }

  async getTableInfo(name: string): Promise<TableInfo> {
    const meta = this.indexCache.get(name);
    const columns = [
      { name: 'id', dataType: 'string', nullable: false, isPrimaryKey: true },
      { name: 'values', dataType: `float32[${meta?.dimension ?? '?'}]`, nullable: false, isPrimaryKey: false },
      { name: 'metadata', dataType: 'json', nullable: true, isPrimaryKey: false },
    ];

    let rowCount: number | undefined;
    try {
      const index = this.client!.index(name);
      const stats = await index.describeIndexStats();
      rowCount = stats.totalRecordCount;
    } catch {
      // ignore
    }

    return { name, columns, rowCount };
  }

  async getTableData(name: string, schema?: string, limit?: number): Promise<QueryResult> {
    const start = Date.now();
    const ns = schema || '';
    const pageSize = Math.min(limit || 100, MAX_RESULT_ROWS);

    const index = this.client!.index(name);
    const nsIndex = ns ? index.namespace(ns) : index;

    try {
      const listResult = await nsIndex.listPaginated({ limit: pageSize });
      const ids = (listResult.vectors || []).map(v => v.id).filter((id): id is string => !!id);

      if (ids.length === 0) {
        return {
          columns: [
            { name: 'id', dataType: 'string' },
            { name: 'values', dataType: 'float32[]' },
            { name: 'metadata', dataType: 'json' },
          ],
          rows: [],
          rowCount: 0,
          executionTimeMs: Date.now() - start,
        };
      }

      const fetched = await nsIndex.fetch({ ids });
      const columns: QueryColumn[] = [
        { name: 'id', dataType: 'string' },
        { name: 'values', dataType: 'float32[]' },
        { name: 'metadata', dataType: 'json' },
      ];

      const rows: Record<string, unknown>[] = [];
      for (const id of ids) {
        const record = fetched.records[id];
        if (record) {
          rows.push({
            id: record.id,
            values: record.values ? `[${record.values.slice(0, 8).join(', ')}${record.values.length > 8 ? ', ...' : ''}]` : null,
            metadata: record.metadata ? JSON.stringify(record.metadata) : null,
          });
        }
      }

      return { columns, rows, rowCount: rows.length, executionTimeMs: Date.now() - start };
    } catch (err) {
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: wrapError(err) };
    }
  }

  async getEstimatedRowCount(name: string, schema?: string): Promise<number> {
    const index = this.client!.index(name);
    const stats = await index.describeIndexStats();
    if (schema) {
      const nsStats = stats.namespaces?.[schema];
      return nsStats?.recordCount ?? 0;
    }
    return stats.totalRecordCount ?? 0;
  }

  async getTableStatistics(name: string): Promise<TableStatistic[]> {
    const index = this.client!.index(name);
    const stats = await index.describeIndexStats();
    const meta = this.indexCache.get(name);
    const result: TableStatistic[] = [
      { key: 'row_count', label: 'Total vectors', value: stats.totalRecordCount ?? 0, unit: 'count' },
      { key: 'dimension', label: 'Dimension', value: meta?.dimension ?? stats.dimension ?? 0, unit: 'count' },
      { key: 'metric', label: 'Distance metric', value: meta?.metric ?? 'unknown', unit: 'text' },
      { key: 'namespaces', label: 'Namespaces', value: Object.keys(stats.namespaces || {}).length, unit: 'count' },
      { key: 'index_fullness', label: 'Index fullness', value: stats.indexFullness != null ? Math.round(stats.indexFullness * 10000) / 100 : null, unit: 'percent' },
    ];
    return result;
  }

  private getIndex(name: string): PineconeIndex {
    return this.client!.index(name);
  }

  private async executeQuery(index: PineconeIndex, parsed: ParsedCommand, start: number): Promise<QueryResult> {
    const vector = JSON.parse(parsed.params.vector || '[]') as number[];
    const topK = parseInt(parsed.params.topk || parsed.params.topK || '10', 10);
    const ns = parsed.params.namespace;
    const filterStr = parsed.params.filter;
    const includeMetadata = parsed.params.includeMetadata !== 'false';

    const nsIndex = ns ? index.namespace(ns) : index;
    const queryArgs: Parameters<typeof nsIndex.query>[0] = {
      vector,
      topK,
      includeValues: true,
      includeMetadata,
    };
    if (filterStr) {
      queryArgs.filter = JSON.parse(filterStr);
    }
    const result = await nsIndex.query(queryArgs);

    const columns: QueryColumn[] = [
      { name: 'id', dataType: 'string' },
      { name: 'score', dataType: 'float' },
      { name: 'values', dataType: 'float32[]' },
      { name: 'metadata', dataType: 'json' },
    ];

    const rows = result.matches.map(m => ({
      id: m.id,
      score: m.score ?? null,
      values: m.values ? `[${m.values.slice(0, 8).join(', ')}${m.values.length > 8 ? ', ...' : ''}]` : null,
      metadata: m.metadata ? JSON.stringify(m.metadata) : null,
    }));

    return { columns, rows, rowCount: rows.length, executionTimeMs: Date.now() - start };
  }

  private async executeUpsert(index: PineconeIndex, parsed: ParsedCommand, start: number): Promise<QueryResult> {
    const id = parsed.params.id;
    const vector = JSON.parse(parsed.params.vector || '[]');
    const ns = parsed.params.namespace;
    const metadataStr = parsed.params.metadata;

    if (!id) {
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: 'id is required for UPSERT' };
    }

    const record: { id: string; values: number[]; metadata?: Record<string, string | number | boolean | string[]> } = { id, values: vector };
    if (metadataStr) {
      record.metadata = JSON.parse(metadataStr);
    }

    const nsIndex = ns ? index.namespace(ns) : index;
    await nsIndex.upsert({ records: [record] });

    return {
      columns: [{ name: 'result', dataType: 'string' }],
      rows: [{ result: `Upserted vector "${id}"` }],
      rowCount: 1,
      affectedRows: 1,
      executionTimeMs: Date.now() - start,
    };
  }

  private async executeDelete(index: PineconeIndex, parsed: ParsedCommand, start: number): Promise<QueryResult> {
    const idsStr = parsed.params.ids;
    const ns = parsed.params.namespace;
    const deleteAll = parsed.params.deleteAll === 'true' || parsed.params.all === 'true';

    const nsIndex = ns ? index.namespace(ns) : index;

    if (deleteAll) {
      await nsIndex.deleteAll();
      return {
        columns: [{ name: 'result', dataType: 'string' }],
        rows: [{ result: 'Deleted all vectors' + (ns ? ` in namespace "${ns}"` : '') }],
        rowCount: 1,
        executionTimeMs: Date.now() - start,
      };
    }

    if (!idsStr) {
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: 'ids=[...] or all=true is required for DELETE' };
    }

    const ids = JSON.parse(idsStr);
    await nsIndex.deleteMany(ids);

    return {
      columns: [{ name: 'result', dataType: 'string' }],
      rows: [{ result: `Deleted ${ids.length} vector(s)` }],
      rowCount: 1,
      affectedRows: ids.length,
      executionTimeMs: Date.now() - start,
    };
  }

  private async executeStats(index: PineconeIndex, start: number): Promise<QueryResult> {
    const stats = await index.describeIndexStats();
    const columns: QueryColumn[] = [
      { name: 'metric', dataType: 'string' },
      { name: 'value', dataType: 'string' },
    ];

    const rows: Record<string, unknown>[] = [
      { metric: 'Total vectors', value: stats.totalRecordCount },
      { metric: 'Dimension', value: stats.dimension },
      { metric: 'Index fullness', value: stats.indexFullness != null ? `${Math.round(stats.indexFullness * 100)}%` : 'N/A' },
    ];

    for (const [nsName, nsInfo] of Object.entries(stats.namespaces || {})) {
      rows.push({ metric: `Namespace "${nsName || '(default)'}"`, value: `${nsInfo.recordCount ?? 0} vectors` });
    }

    return { columns, rows, rowCount: rows.length, executionTimeMs: Date.now() - start };
  }

  private async executeList(index: PineconeIndex, parsed: ParsedCommand, start: number): Promise<QueryResult> {
    const ns = parsed.params.namespace;
    const prefix = parsed.params.prefix;
    const limit = parseInt(parsed.params.limit || '100', 10);

    const nsIndex = ns ? index.namespace(ns) : index;
    const listArgs: { limit: number; prefix?: string } = { limit: Math.min(limit, MAX_RESULT_ROWS) };
    if (prefix) listArgs.prefix = prefix;

    const result = await nsIndex.listPaginated(listArgs);
    const ids = (result.vectors || []).map(v => v.id).filter((id): id is string => !!id);

    const columns: QueryColumn[] = [{ name: 'id', dataType: 'string' }];
    const rows = ids.map(id => ({ id }));

    return { columns, rows, rowCount: rows.length, executionTimeMs: Date.now() - start };
  }
}

interface ParsedCommand {
  command: string;
  index: string;
  params: Record<string, string>;
}

export function parsePineconeCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) return null;

  const command = trimmed.substring(0, firstSpace).toUpperCase();
  const rest = trimmed.substring(firstSpace + 1).trim();

  const secondSpace = rest.indexOf(' ');
  const index = secondSpace === -1 ? rest : rest.substring(0, secondSpace);
  const paramsStr = secondSpace === -1 ? '' : rest.substring(secondSpace + 1).trim();

  const params: Record<string, string> = {};
  if (paramsStr) {
    let pos = 0;
    while (pos < paramsStr.length) {
      while (pos < paramsStr.length && paramsStr[pos] === ' ') pos++;
      if (pos >= paramsStr.length) break;
      const eqPos = paramsStr.indexOf('=', pos);
      if (eqPos === -1) break;
      const key = paramsStr.substring(pos, eqPos);
      pos = eqPos + 1;
      if (pos >= paramsStr.length) break;
      const ch = paramsStr[pos];
      if (ch === '[' || ch === '{') {
        const open = ch;
        const close = ch === '[' ? ']' : '}';
        let depth = 0;
        const start = pos;
        let inStr = false;
        while (pos < paramsStr.length) {
          const c = paramsStr[pos];
          if (c === '"' && (pos === 0 || paramsStr[pos - 1] !== '\\')) inStr = !inStr;
          else if (!inStr) {
            if (c === open) depth++;
            else if (c === close) depth--;
          }
          pos++;
          if (depth === 0) break;
        }
        params[key] = paramsStr.substring(start, pos);
      } else if (ch === '"' || ch === '\'') {
        const quote = ch;
        pos++;
        const start = pos;
        while (pos < paramsStr.length && paramsStr[pos] !== quote) pos++;
        params[key] = paramsStr.substring(start, pos);
        if (pos < paramsStr.length) pos++;
      } else {
        const start = pos;
        while (pos < paramsStr.length && paramsStr[pos] !== ' ') pos++;
        params[key] = paramsStr.substring(start, pos);
      }
    }
  }

  const validCommands = ['QUERY', 'UPSERT', 'DELETE', 'STATS', 'LIST'];
  if (!validCommands.includes(command)) return null;

  return { command, index, params };
}
