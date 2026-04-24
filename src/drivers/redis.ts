import type Redis from 'ioredis';
import { DatabaseDriver } from '../types/driver';
import { ConnectionConfig } from '../types/connection';
import { QueryResult, QueryColumn, MAX_RESULT_ROWS } from '../types/query';
import { SchemaObject, TableInfo } from '../types/schema';
import { wrapError } from '../utils/errors';
import { requireAdapter } from '../adapters/adapterManager';

function loadRedis(): typeof Redis {
  const mod = requireAdapter('ioredis') as { default: typeof Redis };
  return mod.default;
}

export class RedisDriver implements DatabaseDriver {
  private client: Redis | undefined;

  async connect(config: ConnectionConfig): Promise<void> {
    const RedisClient = loadRedis();
    this.client = new RedisClient({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.database ? parseInt(config.database, 10) : 0,
      tls: config.ssl ? {} : undefined,
      connectTimeout: 10000,
      lazyConnect: true,
    });
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client?.quit().catch(() => {});
    this.client = undefined;
  }

  async ping(): Promise<boolean> {
    const res = await this.client!.ping();
    return res === 'PONG';
  }

  async execute(query: string): Promise<QueryResult> {
    const start = Date.now();
    try {
      const parts = parseRedisCommand(query);
      if (parts.length === 0) {
        return { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
      }

      const [cmd, ...args] = parts;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (this.client as any).call(cmd, ...args);
      const executionTimeMs = Date.now() - start;

      return formatRedisResult(result, executionTimeMs);
    } catch (err) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs: Date.now() - start,
        error: wrapError(err),
      };
    }
  }

  async getSchema(): Promise<SchemaObject[]> {
    const info = await this.client!.info('keyspace');
    const databases: SchemaObject[] = [];

    const lines = info.split('\n').filter(l => l.startsWith('db'));
    for (const line of lines) {
      const match = line.match(/^(db\d+):keys=(\d+)/);
      if (match) {
        databases.push({
          name: match[1],
          type: 'keyspace',
          children: [],
        });
      }
    }

    // Also scan keys in current db (limited)
    const keys = await this.scanKeys(200);
    const keyObjects: SchemaObject[] = keys.map(k => ({
      name: k,
      type: 'key' as const,
    }));

    if (databases.length === 0) {
      databases.push({ name: 'db0', type: 'keyspace', children: keyObjects });
    } else {
      // Add keys to current db
      if (databases[0]) {
        databases[0].children = keyObjects;
      }
    }

    return databases;
  }

  async getTableInfo(name: string): Promise<TableInfo> {
    const type = await this.client!.type(name);
    const ttl = await this.client!.ttl(name);

    return {
      name,
      columns: [
        { name: 'key', dataType: 'string', nullable: false, isPrimaryKey: true },
        { name: 'type', dataType: type, nullable: false, isPrimaryKey: false },
        { name: 'ttl', dataType: 'integer', nullable: true, isPrimaryKey: false, defaultValue: String(ttl) },
      ],
    };
  }

  async getTableData(name: string): Promise<QueryResult> {
    const start = Date.now();
    const type = await this.client!.type(name);

    let rows: Record<string, unknown>[] = [];
    const columns: QueryColumn[] = [];

    switch (type) {
      case 'string': {
        const val = await this.client!.get(name);
        columns.push({ name: 'value', dataType: 'string' });
        rows = [{ value: val }];
        break;
      }
      case 'list': {
        const vals = await this.client!.lrange(name, 0, MAX_RESULT_ROWS - 1);
        columns.push({ name: 'index', dataType: 'integer' }, { name: 'value', dataType: 'string' });
        rows = vals.map((v, i) => ({ index: i, value: v }));
        break;
      }
      case 'set': {
        const vals = await this.client!.smembers(name);
        columns.push({ name: 'member', dataType: 'string' });
        rows = vals.slice(0, MAX_RESULT_ROWS).map(v => ({ member: v }));
        break;
      }
      case 'zset': {
        const vals = await this.client!.zrange(name, 0, MAX_RESULT_ROWS - 1, 'WITHSCORES');
        columns.push({ name: 'member', dataType: 'string' }, { name: 'score', dataType: 'float' });
        for (let i = 0; i < vals.length; i += 2) {
          rows.push({ member: vals[i], score: vals[i + 1] });
        }
        break;
      }
      case 'hash': {
        const vals = await this.client!.hgetall(name);
        columns.push({ name: 'field', dataType: 'string' }, { name: 'value', dataType: 'string' });
        rows = Object.entries(vals).map(([field, value]) => ({ field, value }));
        break;
      }
      default:
        columns.push({ name: 'info', dataType: 'string' });
        rows = [{ info: `Unsupported type: ${type}` }];
    }

    return {
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs: Date.now() - start,
    };
  }

  private async scanKeys(limit: number): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [newCursor, batch] = await this.client!.scan(cursor, 'COUNT', 100);
      cursor = newCursor;
      keys.push(...batch);
      if (keys.length >= limit) break;
    } while (cursor !== '0');
    return keys.slice(0, limit);
  }
}

export function parseRedisCommand(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === '\'') {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);

  return parts;
}

function formatRedisResult(result: unknown, executionTimeMs: number): QueryResult {
  if (result === null || result === undefined) {
    return {
      columns: [{ name: 'result', dataType: 'null' }],
      rows: [{ result: '(nil)' }],
      rowCount: 1,
      executionTimeMs,
    };
  }

  if (Array.isArray(result)) {
    return {
      columns: [
        { name: 'index', dataType: 'integer' },
        { name: 'value', dataType: 'string' },
      ],
      rows: result.map((v, i) => ({ index: i, value: String(v) })),
      rowCount: result.length,
      executionTimeMs,
    };
  }

  return {
    columns: [{ name: 'result', dataType: typeof result }],
    rows: [{ result: String(result) }],
    rowCount: 1,
    executionTimeMs,
  };
}
