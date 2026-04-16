import { DatabaseDriver } from '../types/driver';
import { ConnectionConfig } from '../types/connection';
import { QueryResult, QueryColumn, MAX_RESULT_ROWS } from '../types/query';
import { SchemaObject, TableInfo } from '../types/schema';

/**
 * Kafka driver — treats topics as "tables" under a single "cluster" keyspace.
 *
 * Schema shape:
 *   cluster (keyspace)
 *     topics (group)
 *       <topic> (topic)
 *         <partition N> (partition)
 *     consumer groups (group)
 *       <group-id> (consumer-group)
 *
 * Query language is a small command DSL — see parseKafkaCommand:
 *   LIST TOPICS
 *   LIST GROUPS
 *   DESCRIBE <topic>
 *   CONSUME <topic> [N] [from-beginning]
 *   PRODUCE <topic> <key> <value...>
 *
 * Readonly connections reject PRODUCE.
 */
export class KafkaDriver implements DatabaseDriver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private admin: any;
  private readonlyMode = false;

  async connect(config: ConnectionConfig): Promise<void> {
    // Lazy-load kafkajs so it's only resolved on first kafka connect.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Kafka } = require('kafkajs');

    this.readonlyMode = !!config.readonly;

    const brokers = parseBrokerList(config.host, config.port);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kafkaConfig: any = {
      clientId: 'viewstor',
      brokers,
      connectionTimeout: 10000,
      requestTimeout: 15000,
    };
    if (config.ssl) kafkaConfig.ssl = true;
    if (config.username) {
      kafkaConfig.sasl = {
        mechanism: (config.options?.saslMechanism as 'plain' | 'scram-sha-256' | 'scram-sha-512') || 'plain',
        username: config.username,
        password: config.password || '',
      };
    }

    this.client = new Kafka(kafkaConfig);
    this.admin = this.client.admin();
    await this.admin.connect();
  }

  async disconnect(): Promise<void> {
    try {
      await this.admin?.disconnect();
    } catch { /* noop */ }
    this.admin = undefined;
    this.client = undefined;
  }

  async ping(): Promise<boolean> {
    try {
      await this.admin.listTopics();
      return true;
    } catch {
      return false;
    }
  }

  async execute(query: string): Promise<QueryResult> {
    const start = Date.now();
    try {
      const cmd = parseKafkaCommand(query);
      if (!cmd) {
        return { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
      }

      switch (cmd.kind) {
        case 'list-topics': {
          const topics = await this.admin.listTopics();
          const metadata = await this.admin.fetchTopicMetadata({ topics });
          const rows = metadata.topics.map((t: { name: string; partitions: unknown[] }) => ({
            topic: t.name,
            partitions: t.partitions.length,
          }));
          return {
            columns: [
              { name: 'topic', dataType: 'string' },
              { name: 'partitions', dataType: 'integer' },
            ],
            rows,
            rowCount: rows.length,
            executionTimeMs: Date.now() - start,
          };
        }
        case 'list-groups': {
          const res = await this.admin.listGroups();
          const rows = (res.groups || []).map((g: { groupId: string; protocolType: string }) => ({
            groupId: g.groupId,
            protocolType: g.protocolType,
          }));
          return {
            columns: [
              { name: 'groupId', dataType: 'string' },
              { name: 'protocolType', dataType: 'string' },
            ],
            rows,
            rowCount: rows.length,
            executionTimeMs: Date.now() - start,
          };
        }
        case 'describe': {
          const metadata = await this.admin.fetchTopicMetadata({ topics: [cmd.topic] });
          const topic = metadata.topics[0];
          if (!topic) {
            return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: `Topic not found: ${cmd.topic}` };
          }
          const rows = topic.partitions.map((p: { partitionId: number; leader: number; replicas: number[]; isr: number[] }) => ({
            partition: p.partitionId,
            leader: p.leader,
            replicas: JSON.stringify(p.replicas),
            isr: JSON.stringify(p.isr),
          }));
          return {
            columns: [
              { name: 'partition', dataType: 'integer' },
              { name: 'leader', dataType: 'integer' },
              { name: 'replicas', dataType: 'string' },
              { name: 'isr', dataType: 'string' },
            ],
            rows,
            rowCount: rows.length,
            executionTimeMs: Date.now() - start,
          };
        }
        case 'consume': {
          const rows = await this.consumeMessages(cmd.topic, cmd.limit, cmd.fromBeginning);
          return {
            columns: CONSUME_COLUMNS,
            rows,
            rowCount: rows.length,
            executionTimeMs: Date.now() - start,
          };
        }
        case 'produce': {
          if (this.readonlyMode) {
            return {
              columns: [], rows: [], rowCount: 0,
              executionTimeMs: Date.now() - start,
              error: 'PRODUCE is not allowed on a read-only Kafka connection',
            };
          }
          const producer = this.client.producer();
          await producer.connect();
          try {
            await producer.send({
              topic: cmd.topic,
              messages: [{ key: cmd.key ?? null, value: cmd.value }],
            });
          } finally {
            await producer.disconnect();
          }
          return {
            columns: [{ name: 'result', dataType: 'string' }],
            rows: [{ result: `produced 1 message to ${cmd.topic}` }],
            rowCount: 1,
            executionTimeMs: Date.now() - start,
          };
        }
      }
    } catch (err) {
      return {
        columns: [], rows: [], rowCount: 0,
        executionTimeMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getSchema(): Promise<SchemaObject[]> {
    const topics = await this.admin.listTopics();
    topics.sort();
    const metadata = await this.admin.fetchTopicMetadata({ topics });

    const topicNodes: SchemaObject[] = metadata.topics.map((t: { name: string; partitions: unknown[] }) => ({
      name: t.name,
      type: 'topic' as const,
      detail: `${t.partitions.length} partition${t.partitions.length === 1 ? '' : 's'}`,
      children: (t.partitions as { partitionId: number }[]).map(p => ({
        name: `partition ${p.partitionId}`,
        type: 'partition' as const,
      })),
    }));

    let groupNodes: SchemaObject[] = [];
    try {
      const listed = await this.admin.listGroups();
      groupNodes = (listed.groups || []).map((g: { groupId: string; protocolType: string }) => ({
        name: g.groupId,
        type: 'consumer-group' as const,
        detail: g.protocolType || undefined,
      }));
    } catch {
      // listGroups may fail on some broker configurations — treat as no groups
    }

    const cluster: SchemaObject = {
      name: 'cluster',
      type: 'keyspace',
      children: [
        { name: 'topics', type: 'group', children: topicNodes },
        { name: 'consumer groups', type: 'group', children: groupNodes },
      ],
    };
    return [cluster];
  }

  async getTableInfo(name: string): Promise<TableInfo> {
    // For a topic, expose synthetic "columns" that describe the message shape.
    // rowCount is intentionally omitted — a topic has no meaningful row count
    // (computing it would require summing latest-minus-earliest offsets per
    // partition) and returning partition count is misleading.
    return {
      name,
      columns: [
        { name: 'offset', dataType: 'bigint', nullable: false, isPrimaryKey: true },
        { name: 'partition', dataType: 'integer', nullable: false, isPrimaryKey: true },
        { name: 'key', dataType: 'string', nullable: true, isPrimaryKey: false },
        { name: 'value', dataType: 'string', nullable: true, isPrimaryKey: false },
        { name: 'timestamp', dataType: 'timestamp', nullable: true, isPrimaryKey: false },
        { name: 'headers', dataType: 'json', nullable: true, isPrimaryKey: false },
      ],
    };
  }

  async getTableData(name: string, _schema?: string, limit?: number): Promise<QueryResult> {
    const start = Date.now();
    const rows = await this.consumeMessages(name, limit ?? MAX_RESULT_ROWS, false);
    return {
      columns: CONSUME_COLUMNS,
      rows,
      rowCount: rows.length,
      executionTimeMs: Date.now() - start,
    };
  }

  private async consumeMessages(topic: string, limit: number, fromBeginning: boolean): Promise<Record<string, unknown>[]> {
    const cap = Math.max(1, Math.min(limit, MAX_RESULT_ROWS));
    const groupId = `viewstor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const consumer = this.client.consumer({ groupId, sessionTimeout: 10000 });
    await consumer.connect();
    // Everything past `connect()` must run inside the finally block so we
    // always disconnect the consumer — otherwise a `subscribe`/`run` failure
    // leaks a connected consumer and its throwaway group on the broker.
    try {
      // kafkajs 2.x replaced single `topic` with `topics[]`; the old shape still works
      // but logs a deprecation warning on every consume.
      await consumer.subscribe({ topics: [topic], fromBeginning });

      const collected: Record<string, unknown>[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 5000);
        consumer
          .run({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            eachMessage: async ({ topic: t, partition, message }: any) => {
              if (collected.length >= cap) return;
              collected.push({
                offset: message.offset,
                partition,
                key: message.key ? message.key.toString() : null,
                value: message.value ? message.value.toString() : null,
                timestamp: message.timestamp ? new Date(Number(message.timestamp)).toISOString() : null,
                headers: message.headers ? JSON.stringify(normalizeHeaders(message.headers)) : null,
                topic: t,
              });
              if (collected.length >= cap) {
                clearTimeout(timer);
                resolve();
              }
            },
          })
          .catch((err: unknown) => {
            clearTimeout(timer);
            reject(err);
          });
      });

      return collected.slice(0, cap);
    } finally {
      try {
        await consumer.disconnect();
      } catch { /* noop */ }
    }
  }
}

const CONSUME_COLUMNS: QueryColumn[] = [
  { name: 'offset', dataType: 'bigint' },
  { name: 'partition', dataType: 'integer' },
  { name: 'key', dataType: 'string' },
  { name: 'value', dataType: 'string' },
  { name: 'timestamp', dataType: 'timestamp' },
  { name: 'headers', dataType: 'json' },
];

export type KafkaCommand =
  | { kind: 'list-topics' }
  | { kind: 'list-groups' }
  | { kind: 'describe'; topic: string }
  | { kind: 'consume'; topic: string; limit: number; fromBeginning: boolean }
  | { kind: 'produce'; topic: string; key: string | null; value: string };

/**
 * Parse a Kafka command from the SQL editor. Returns null for empty input or
 * pure comments. Throws Error for syntactically bad commands.
 */
export function parseKafkaCommand(input: string): KafkaCommand | null {
  const trimmed = stripLineComments(input).trim().replace(/;+\s*$/, '');
  if (!trimmed) return null;

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return null;

  const verb = tokens[0].toUpperCase();

  if (verb === 'LIST') {
    const what = (tokens[1] || '').toUpperCase();
    if (what === 'TOPICS') return { kind: 'list-topics' };
    if (what === 'GROUPS' || what === 'CONSUMER' || what === 'CONSUMERS') return { kind: 'list-groups' };
    throw new Error(`Unknown LIST target: ${tokens[1] || '(missing)'}`);
  }

  if (verb === 'DESCRIBE' || verb === 'DESC') {
    const topic = tokens[1];
    if (!topic) throw new Error('DESCRIBE requires a topic name');
    return { kind: 'describe', topic };
  }

  if (verb === 'CONSUME') {
    const topic = tokens[1];
    if (!topic) throw new Error('CONSUME requires a topic name');
    let limit = 100;
    let fromBeginning = false;
    for (let i = 2; i < tokens.length; i++) {
      const tok = tokens[i].toLowerCase();
      if (tok === 'from-beginning' || tok === 'from_beginning' || tok === 'beginning') {
        fromBeginning = true;
      } else if (tok === 'latest') {
        fromBeginning = false;
      } else if (/^\d+$/.test(tok)) {
        limit = parseInt(tok, 10);
      } else {
        throw new Error(`Unknown CONSUME option: ${tokens[i]}`);
      }
    }
    return { kind: 'consume', topic, limit, fromBeginning };
  }

  if (verb === 'PRODUCE') {
    const topic = tokens[1];
    if (!topic) throw new Error('PRODUCE requires a topic name');
    if (tokens.length < 3) throw new Error('PRODUCE requires at least a value: PRODUCE <topic> [key] <value>');
    if (tokens.length === 3) {
      return { kind: 'produce', topic, key: null, value: tokens[2] };
    }
    const key = tokens[2];
    const value = tokens.slice(3).join(' ');
    return { kind: 'produce', topic, key, value };
  }

  throw new Error(`Unknown Kafka command: ${verb}`);
}

/** Split a broker-list string like "b1:9092, b2:9092" into kafkajs brokers[]. */
export function parseBrokerList(host: string | undefined, port: number | undefined): string[] {
  const raw = (host || 'localhost').trim();
  const defaultPort = port && port > 0 ? port : 9092;
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  // Whitespace-only input leaves `parts` empty — fall back to localhost so we
  // give kafkajs a usable broker rather than an opaque "empty brokers" error.
  if (parts.length === 0) return [`localhost:${defaultPort}`];
  return parts.map(p => (p.includes(':') ? p : `${p}:${defaultPort}`));
}

function stripLineComments(input: string): string {
  return input
    .split('\n')
    .map(line => line.replace(/(^|\s)--.*$/, ''))
    .join('\n');
}

function tokenize(input: string): string[] {
  const DOUBLE = '"';
  const SINGLE = '\'';
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === DOUBLE || ch === SINGLE) {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Normalize kafkajs message headers (Buffer values → strings) for JSON serialization. */
export function normalizeHeaders(headers: Record<string, unknown>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      // kafkajs IHeaders values can be arrays (multi-valued headers).
      const mapped = v.map(normalizeHeaderValue).filter((x): x is string => x != null);
      if (mapped.length > 0) out[k] = mapped;
    } else {
      const mapped = normalizeHeaderValue(v);
      if (mapped != null) out[k] = mapped;
    }
  }
  return out;
}

function normalizeHeaderValue(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8');
  return String(v);
}
