import { DatabaseDriver, CompletionItem } from '../types/driver';
import { ConnectionConfig } from '../types/connection';
import { QueryResult, QueryColumn, MAX_RESULT_ROWS } from '../types/query';
import { SchemaObject, TableInfo, ColumnInfo } from '../types/schema';
import { wrapError } from '../utils/errors';

interface QdrantClientType {
  getCollections(): Promise<{ collections: Array<{ name: string }> }>;
  getCollection(name: string): Promise<{
    points_count: number | null;
    vectors_count: number | null;
    config: {
      params: {
        vectors?: Record<string, { size: number; distance: string }> | { size: number; distance: string };
      };
    };
    payload_schema?: Record<string, { data_type: string; points?: number }>;
    status: string;
  }>;
  scroll(name: string, opts: {
    limit: number;
    offset?: string | number | null;
    with_payload: boolean;
    with_vector: boolean;
  }): Promise<{
    points: Array<{
      id: string | number;
      payload?: Record<string, unknown>;
      vector?: number[] | Record<string, number[]>;
    }>;
    next_page_offset: string | number | null;
  }>;
  search(name: string, opts: {
    vector: number[] | { name: string; vector: number[] };
    limit: number;
    with_payload: boolean;
    filter?: unknown;
  }): Promise<Array<{
    id: string | number;
    score: number;
    payload?: Record<string, unknown>;
    vector?: number[] | Record<string, number[]>;
  }>>;
  upsert(name: string, opts: { points: Array<unknown> }): Promise<unknown>;
  delete(name: string, opts: { points: Array<string | number> }): Promise<unknown>;
  count(name: string, opts?: { exact: boolean }): Promise<{ count: number }>;
  retrieve(name: string, opts: {
    ids: Array<string | number>;
    with_payload: boolean;
    with_vector: boolean;
  }): Promise<Array<{
    id: string | number;
    payload?: Record<string, unknown>;
    vector?: number[] | Record<string, number[]>;
  }>>;
  collectionExists(name: string): Promise<{ exists: boolean }>;
}

export class QdrantDriver implements DatabaseDriver {
  private client: QdrantClientType | undefined;

  async connect(config: ConnectionConfig): Promise<void> {
    const { QdrantClient } = await loadQdrant();
    const url = `${config.ssl ? 'https' : 'http'}://${config.host}:${config.port}`;
    this.client = new QdrantClient({
      url,
      apiKey: config.password || undefined,
      checkCompatibility: false,
    }) as unknown as QdrantClientType;
  }

  async disconnect(): Promise<void> {
    this.client = undefined;
  }

  async ping(): Promise<boolean> {
    await this.client!.getCollections();
    return true;
  }

  async execute(query: string): Promise<QueryResult> {
    const start = Date.now();
    try {
      const parsed = parseQdrantCommand(query);
      if (!parsed) {
        return {
          columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start,
          error: `Unknown Qdrant command: ${query.trim().split(/\s+/)[0]?.toUpperCase() || query}. Supported: LIST COLLECTIONS, DESCRIBE <collection>, SEARCH <collection> vector=[...] limit=N, SCROLL <collection> [limit=N], COUNT <collection>, UPSERT <collection> id=<id> vector=[...] [key=value ...], DELETE <collection> id1 id2 ...`,
        };
      }

      switch (parsed.command) {
        case 'LIST': return await this.execList(start);
        case 'DESCRIBE': return await this.execDescribe(parsed.collection!, start);
        case 'SCROLL': return await this.execScroll(parsed.collection!, parsed.options, start);
        case 'SEARCH': return await this.execSearch(parsed.collection!, parsed.options, start);
        case 'COUNT': return await this.execCount(parsed.collection!, start);
        case 'UPSERT': return await this.execUpsert(parsed.collection!, parsed.options, start);
        case 'DELETE': return await this.execDelete(parsed.collection!, parsed.options, start);
        default:
          return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: `Unsupported command: ${parsed.command}` };
      }
    } catch (err) {
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: wrapError(err) };
    }
  }

  async getSchema(): Promise<SchemaObject[]> {
    const { collections } = await this.client!.getCollections();
    const result: SchemaObject[] = [];

    for (const col of collections) {
      try {
        const info = await this.client!.getCollection(col.name);
        const children: SchemaObject[] = [];

        const vectors = info.config.params.vectors;
        if (vectors) {
          if ('size' in vectors && 'distance' in vectors) {
            children.push({ name: 'vector', type: 'column', detail: `vector(${vectors.size}) ${vectors.distance}` });
          } else {
            for (const [vecName, vecConf] of Object.entries(vectors)) {
              children.push({ name: vecName, type: 'column', detail: `vector(${vecConf.size}) ${vecConf.distance}` });
            }
          }
        }

        if (info.payload_schema) {
          for (const [fieldName, fieldInfo] of Object.entries(info.payload_schema)) {
            children.push({ name: fieldName, type: 'column', detail: fieldInfo.data_type });
          }
        }

        result.push({
          name: col.name,
          type: 'table',
          children,
          detail: `${info.points_count ?? 0} points`,
        });
      } catch {
        result.push({ name: col.name, type: 'table', inaccessible: true });
      }
    }

    return result;
  }

  async getTableInfo(name: string): Promise<TableInfo> {
    const info = await this.client!.getCollection(name);
    const columns: ColumnInfo[] = [
      { name: 'id', dataType: 'uuid/integer', nullable: false, isPrimaryKey: true },
    ];

    const vectors = info.config.params.vectors;
    if (vectors) {
      if ('size' in vectors && 'distance' in vectors) {
        columns.push({ name: 'vector', dataType: `vector(${vectors.size})`, nullable: false, isPrimaryKey: false, comment: `Distance: ${vectors.distance}` });
      } else {
        for (const [vecName, vecConf] of Object.entries(vectors)) {
          columns.push({ name: vecName, dataType: `vector(${vecConf.size})`, nullable: true, isPrimaryKey: false, comment: `Distance: ${vecConf.distance}` });
        }
      }
    }

    if (info.payload_schema) {
      for (const [fieldName, fieldInfo] of Object.entries(info.payload_schema)) {
        columns.push({ name: fieldName, dataType: fieldInfo.data_type, nullable: true, isPrimaryKey: false });
      }
    }

    return {
      name,
      columns,
      rowCount: info.points_count ?? undefined,
    };
  }

  async getTableData(name: string, _schema?: string, limit?: number, offset?: number): Promise<QueryResult> {
    const start = Date.now();
    const pageSize = Math.min(limit || 100, MAX_RESULT_ROWS);

    const scrollResult = await this.client!.scroll(name, {
      limit: pageSize,
      offset: offset && offset > 0 ? offset : null,
      with_payload: true,
      with_vector: false,
    });

    return this.formatPoints(scrollResult.points, Date.now() - start);
  }

  async getEstimatedRowCount(name: string): Promise<number> {
    const info = await this.client!.getCollection(name);
    return info.points_count ?? 0;
  }

  async getTableRowCount(name: string): Promise<number> {
    const result = await this.client!.count(name, { exact: true });
    return result.count;
  }

  async getDDL(name: string): Promise<string> {
    const info = await this.client!.getCollection(name);
    return JSON.stringify(info, null, 2);
  }

  async getCompletions(): Promise<CompletionItem[]> {
    const items: CompletionItem[] = [];
    try {
      const { collections } = await this.client!.getCollections();
      for (const col of collections) {
        items.push({ label: col.name, kind: 'table', detail: 'collection' });
      }
    } catch {
      // Ignore errors during completion
    }

    for (const cmd of ['LIST COLLECTIONS', 'DESCRIBE', 'SCROLL', 'SEARCH', 'COUNT', 'UPSERT', 'DELETE']) {
      items.push({ label: cmd, kind: 'keyword', detail: 'Qdrant command' });
    }

    return items;
  }

  private async execList(start: number): Promise<QueryResult> {
    const { collections } = await this.client!.getCollections();
    const columns: QueryColumn[] = [
      { name: 'collection', dataType: 'string' },
      { name: 'points', dataType: 'integer' },
      { name: 'status', dataType: 'string' },
    ];
    const rows: Record<string, unknown>[] = [];
    for (const col of collections) {
      try {
        const info = await this.client!.getCollection(col.name);
        rows.push({ collection: col.name, points: info.points_count ?? 0, status: info.status });
      } catch {
        rows.push({ collection: col.name, points: null, status: 'error' });
      }
    }
    return { columns, rows, rowCount: rows.length, executionTimeMs: Date.now() - start };
  }

  private async execDescribe(collection: string, start: number): Promise<QueryResult> {
    const info = await this.client!.getCollection(collection);
    const columns: QueryColumn[] = [
      { name: 'property', dataType: 'string' },
      { name: 'value', dataType: 'string' },
    ];
    const rows: Record<string, unknown>[] = [
      { property: 'points_count', value: info.points_count },
      { property: 'vectors_count', value: info.vectors_count },
      { property: 'status', value: info.status },
    ];

    const vectors = info.config.params.vectors;
    if (vectors) {
      if ('size' in vectors && 'distance' in vectors) {
        rows.push({ property: 'vector_size', value: vectors.size });
        rows.push({ property: 'distance', value: vectors.distance });
      } else {
        for (const [vecName, vecConf] of Object.entries(vectors)) {
          rows.push({ property: `vector.${vecName}.size`, value: vecConf.size });
          rows.push({ property: `vector.${vecName}.distance`, value: vecConf.distance });
        }
      }
    }

    if (info.payload_schema) {
      for (const [fieldName, fieldInfo] of Object.entries(info.payload_schema)) {
        rows.push({ property: `payload.${fieldName}`, value: fieldInfo.data_type });
      }
    }

    return { columns, rows, rowCount: rows.length, executionTimeMs: Date.now() - start };
  }

  private async execScroll(collection: string, options: Record<string, string>, start: number): Promise<QueryResult> {
    const limit = Math.min(parseInt(options.limit || '100', 10), MAX_RESULT_ROWS);
    const scrollResult = await this.client!.scroll(collection, {
      limit,
      offset: options.offset || null,
      with_payload: true,
      with_vector: options.with_vector === 'true',
    });
    return this.formatPoints(scrollResult.points, Date.now() - start);
  }

  private async execSearch(collection: string, options: Record<string, string>, start: number): Promise<QueryResult> {
    if (!options.vector) {
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: 'SEARCH requires vector=[...] parameter' };
    }

    let vector: number[];
    try {
      vector = JSON.parse(options.vector);
    } catch {
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: 'Invalid vector format. Use vector=[0.1,0.2,...]' };
    }

    const limit = Math.min(parseInt(options.limit || '10', 10), MAX_RESULT_ROWS);

    const searchOpts: { vector: number[] | { name: string; vector: number[] }; limit: number; with_payload: boolean } = {
      vector: options.vector_name ? { name: options.vector_name, vector } : vector,
      limit,
      with_payload: true,
    };

    const results = await this.client!.search(collection, searchOpts);

    const columns: QueryColumn[] = [
      { name: 'id', dataType: 'string' },
      { name: 'score', dataType: 'float' },
    ];

    const payloadKeys = new Set<string>();
    for (const r of results) {
      if (r.payload) Object.keys(r.payload).forEach(k => payloadKeys.add(k));
    }
    for (const key of payloadKeys) {
      columns.push({ name: key, dataType: 'json' });
    }

    const rows = results.map(r => {
      const row: Record<string, unknown> = { id: r.id, score: r.score };
      if (r.payload) {
        for (const [k, v] of Object.entries(r.payload)) {
          row[k] = typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
        }
      }
      return row;
    });

    return { columns, rows, rowCount: rows.length, executionTimeMs: Date.now() - start };
  }

  private async execCount(collection: string, start: number): Promise<QueryResult> {
    const result = await this.client!.count(collection, { exact: true });
    return {
      columns: [{ name: 'count', dataType: 'integer' }],
      rows: [{ count: result.count }],
      rowCount: 1,
      executionTimeMs: Date.now() - start,
    };
  }

  private async execUpsert(collection: string, options: Record<string, string>, start: number): Promise<QueryResult> {
    if (!options.id) {
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: 'UPSERT requires id=<id>' };
    }
    if (!options.vector) {
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: 'UPSERT requires vector=[...]' };
    }

    let vector: number[];
    try {
      vector = JSON.parse(options.vector);
    } catch {
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: 'Invalid vector format' };
    }

    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(options)) {
      if (k !== 'id' && k !== 'vector') {
        payload[k] = tryParseJson(v);
      }
    }

    const id = /^\d+$/.test(options.id) ? parseInt(options.id, 10) : options.id;
    await this.client!.upsert(collection, {
      points: [{ id, vector, payload: Object.keys(payload).length > 0 ? payload : undefined }],
    });

    return {
      columns: [{ name: 'result', dataType: 'string' }],
      rows: [{ result: `upserted 1 point to ${collection}` }],
      rowCount: 1,
      executionTimeMs: Date.now() - start,
    };
  }

  private async execDelete(collection: string, options: Record<string, string>, start: number): Promise<QueryResult> {
    const idList = options._args;
    if (!idList) {
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: 'DELETE requires at least one point ID' };
    }

    const ids: (string | number)[] = idList.split(/\s+/).map(s => /^\d+$/.test(s) ? parseInt(s, 10) : s);
    await this.client!.delete(collection, { points: ids });

    return {
      columns: [{ name: 'result', dataType: 'string' }],
      rows: [{ result: `deleted ${ids.length} point(s) from ${collection}` }],
      rowCount: 1,
      executionTimeMs: Date.now() - start,
    };
  }

  private formatPoints(
    points: Array<{ id: string | number; payload?: Record<string, unknown>; vector?: number[] | Record<string, number[]>; score?: number }>,
    executionTimeMs: number,
  ): QueryResult {
    const columns: QueryColumn[] = [{ name: 'id', dataType: 'string' }];

    const payloadKeys = new Set<string>();
    let hasVector = false;
    let hasScore = false;

    for (const p of points) {
      if (p.payload) Object.keys(p.payload).forEach(k => payloadKeys.add(k));
      if (p.vector) hasVector = true;
      if (p.score !== undefined) hasScore = true;
    }

    if (hasScore) columns.push({ name: 'score', dataType: 'float' });
    for (const key of payloadKeys) {
      columns.push({ name: key, dataType: 'json' });
    }
    if (hasVector) columns.push({ name: 'vector', dataType: 'vector' });

    const rows = points.map(p => {
      const row: Record<string, unknown> = { id: p.id };
      if (hasScore) row.score = p.score;
      if (p.payload) {
        for (const [k, v] of Object.entries(p.payload)) {
          row[k] = typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
        }
      }
      if (hasVector && p.vector) {
        row.vector = Array.isArray(p.vector) ? truncateVector(p.vector) : JSON.stringify(p.vector);
      }
      return row;
    });

    return { columns, rows, rowCount: rows.length, executionTimeMs };
  }
}

function truncateVector(v: number[], maxDisplay: number = 8): string {
  if (v.length <= maxDisplay) return `[${v.join(', ')}]`;
  return `[${v.slice(0, maxDisplay).join(', ')}, ... (${v.length} dims)]`;
}

function tryParseJson(v: string): unknown {
  try { return JSON.parse(v); } catch { return v; }
}

interface ParsedCommand {
  command: string;
  collection?: string;
  options: Record<string, string>;
}

export function parseQdrantCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim().replace(/;$/, '').trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();

  if (upper === 'LIST COLLECTIONS' || upper === 'LIST') {
    return { command: 'LIST', options: {} };
  }

  const match = trimmed.match(/^(\w+)\s+(.+)$/s);
  if (!match) return null;

  const cmd = match[1].toUpperCase();
  const rest = match[2].trim();

  if (!['DESCRIBE', 'SCROLL', 'SEARCH', 'COUNT', 'UPSERT', 'DELETE'].includes(cmd)) {
    return null;
  }

  const parts = rest.match(/^(\S+)(?:\s+(.*))?$/s);
  if (!parts) return null;

  const collection = parts[1];
  const optionsStr = parts[2]?.trim() || '';

  if (cmd === 'DELETE') {
    return { command: cmd, collection, options: { _args: optionsStr } };
  }

  const options = parseOptions(optionsStr);
  return { command: cmd, collection, options };
}

function parseOptions(str: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!str) return result;

  const re = /(\w+)\s*=\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
      val = val.slice(1, -1);
    }
    result[m[1]] = val;
  }
  return result;
}

async function loadQdrant(): Promise<{ QdrantClient: new (opts: { url: string; apiKey?: string; checkCompatibility?: boolean }) => unknown }> {
  return await import('@qdrant/js-client-rest');
}
