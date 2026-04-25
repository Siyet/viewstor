import { MongoClient, Db, type Document } from 'mongodb';
import { DatabaseDriver, CompletionItem } from '../types/driver';
import { ConnectionConfig } from '../types/connection';
import { QueryResult, QueryColumn, SortColumn, MAX_RESULT_ROWS } from '../types/query';
import { SchemaObject, TableInfo, ColumnInfo, TableObjects, IndexInfo, TableStatistic } from '../types/schema';
import { wrapError } from '../utils/errors';

const SAMPLE_SIZE = 100;

export class MongoDriver implements DatabaseDriver {
  private client: MongoClient | undefined;
  private db: Db | undefined;
  private config: ConnectionConfig | undefined;

  async connect(config: ConnectionConfig): Promise<void> {
    this.config = config;
    const authSource = config.options?.authSource || 'admin';
    const opts: Record<string, unknown> = {
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
    };
    if (config.ssl) {
      opts.tls = true;
    }
    if (config.username) {
      opts.auth = { username: config.username, password: config.password || '' };
      opts.authSource = authSource;
    }

    const host = config.host || 'localhost';
    const port = config.port || 27017;
    const uri = config.options?.connectionString || `mongodb://${host}:${port}`;

    this.client = new MongoClient(uri, opts);
    await this.client.connect();
    this.db = this.client.db(config.database || undefined);
  }

  async disconnect(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = undefined;
    this.db = undefined;
  }

  async ping(): Promise<boolean> {
    const result = await this.db!.command({ ping: 1 });
    return result.ok === 1;
  }

  async execute(query: string): Promise<QueryResult> {
    const start = Date.now();
    try {
      const parsed = parseMongoCommand(query);

      // Admin commands
      if (parsed.collection === '_admin' && parsed.operation === 'listDatabases') {
        const adminDb = this.client!.db().admin();
        const result = await adminDb.listDatabases();
        const rows = result.databases.map((d: { name: string; sizeOnDisk?: number }) => ({
          name: d.name,
          sizeOnDisk: d.sizeOnDisk,
        }));
        return {
          columns: inferColumns(rows),
          rows,
          rowCount: rows.length,
          executionTimeMs: Date.now() - start,
        };
      }

      const collection = this.db!.collection(parsed.collection);
      let rows: Record<string, unknown>[] = [];
      let affectedRows: number | undefined;

      switch (parsed.operation) {
        case 'find': {
          const filter = parsed.args[0] || {};
          const projection = parsed.args[1] || undefined;
          let cursor = collection.find(filter as Document);
          if (projection) cursor = cursor.project(projection as Document);
          rows = (await cursor.limit(MAX_RESULT_ROWS).toArray()).map(flattenDocument);
          break;
        }
        case 'findOne': {
          const doc = await collection.findOne(
            (parsed.args[0] || {}) as Document,
            parsed.args[1] ? { projection: parsed.args[1] as Document } : undefined,
          );
          rows = doc ? [flattenDocument(doc)] : [];
          break;
        }
        case 'aggregate': {
          const pipeline = parsed.args[0];
          if (!Array.isArray(pipeline)) throw new Error('aggregate requires an array pipeline argument');
          rows = (await collection.aggregate(pipeline).toArray()).map(flattenDocument);
          if (rows.length > MAX_RESULT_ROWS) rows = rows.slice(0, MAX_RESULT_ROWS);
          break;
        }
        case 'countDocuments': {
          const cnt = await collection.countDocuments((parsed.args[0] || {}) as Document);
          rows = [{ count: cnt }];
          break;
        }
        case 'distinct': {
          const field = parsed.args[0];
          if (typeof field !== 'string') throw new Error('distinct requires a field name as first argument');
          const values = await collection.distinct(field, (parsed.args[1] || {}) as Document);
          rows = values.map(v => ({ value: v }));
          break;
        }
        case 'insertOne': {
          const res = await collection.insertOne((parsed.args[0] || {}) as Document);
          rows = [{ insertedId: String(res.insertedId), acknowledged: res.acknowledged }];
          affectedRows = res.acknowledged ? 1 : 0;
          break;
        }
        case 'insertMany': {
          const docs = parsed.args[0];
          if (!Array.isArray(docs)) throw new Error('insertMany requires an array argument');
          const res = await collection.insertMany(docs as Document[]);
          rows = [{ insertedCount: res.insertedCount, acknowledged: res.acknowledged }];
          affectedRows = res.insertedCount;
          break;
        }
        case 'updateOne': {
          const res = await collection.updateOne(
            (parsed.args[0] || {}) as Document,
            (parsed.args[1] || {}) as Document,
          );
          rows = [{ matchedCount: res.matchedCount, modifiedCount: res.modifiedCount, acknowledged: res.acknowledged }];
          affectedRows = res.modifiedCount;
          break;
        }
        case 'updateMany': {
          const res = await collection.updateMany(
            (parsed.args[0] || {}) as Document,
            (parsed.args[1] || {}) as Document,
          );
          rows = [{ matchedCount: res.matchedCount, modifiedCount: res.modifiedCount, acknowledged: res.acknowledged }];
          affectedRows = res.modifiedCount;
          break;
        }
        case 'deleteOne': {
          const res = await collection.deleteOne((parsed.args[0] || {}) as Document);
          rows = [{ deletedCount: res.deletedCount, acknowledged: res.acknowledged }];
          affectedRows = res.deletedCount;
          break;
        }
        case 'deleteMany': {
          const res = await collection.deleteMany((parsed.args[0] || {}) as Document);
          rows = [{ deletedCount: res.deletedCount, acknowledged: res.acknowledged }];
          affectedRows = res.deletedCount;
          break;
        }
        case 'createIndex': {
          const name = await collection.createIndex(
            (parsed.args[0] || {}) as Document,
            (parsed.args[1] || {}) as Document,
          );
          rows = [{ indexName: name }];
          break;
        }
        case 'dropIndex': {
          const idxName = parsed.args[0];
          if (typeof idxName !== 'string') throw new Error('dropIndex requires an index name');
          await collection.dropIndex(idxName);
          rows = [{ status: 'OK' }];
          break;
        }
        default:
          throw new Error(`Unsupported operation: ${parsed.operation}. Supported: find, findOne, aggregate, countDocuments, distinct, insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany, createIndex, dropIndex`);
      }

      const columns = inferColumns(rows);

      return {
        columns,
        rows,
        rowCount: rows.length,
        affectedRows,
        executionTimeMs: Date.now() - start,
      };
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
    const collections = await this.db!.listCollections().toArray();

    const schema: SchemaObject[] = [];
    for (const col of collections) {
      const fields = await this.sampleFields(col.name);
      schema.push({
        name: col.name,
        type: col.type === 'view' ? 'view' : 'table',
        children: fields.map(f => ({
          name: f.name,
          type: 'column' as const,
          detail: f.dataType,
          notNullable: !f.nullable,
        })),
      });
    }

    return schema;
  }

  async getTableInfo(name: string): Promise<TableInfo> {
    const fields = await this.sampleFields(name);
    const count = await this.db!.collection(name).estimatedDocumentCount();

    const columns: ColumnInfo[] = fields.map(f => ({
      name: f.name,
      dataType: f.dataType,
      nullable: f.nullable,
      isPrimaryKey: f.name === '_id',
    }));

    return { name, columns, rowCount: count };
  }

  async getTableData(name: string, _schema?: string, limit = MAX_RESULT_ROWS, offset = 0, orderBy?: SortColumn[]): Promise<QueryResult> {
    const start = Date.now();
    const collection = this.db!.collection(name);

    let cursor = collection.find();
    if (orderBy && orderBy.length > 0) {
      const sort: Record<string, 1 | -1> = {};
      for (const s of orderBy) {
        sort[s.column] = s.direction === 'desc' ? -1 : 1;
      }
      cursor = cursor.sort(sort);
    }

    const docs = await cursor.skip(offset).limit(limit).toArray();
    const rows = docs.map(flattenDocument);
    const columns = inferColumns(rows);
    const sql = `db.${name}.find()`;

    return {
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs: Date.now() - start,
      query: sql,
    };
  }

  async getTableRowCount(name: string): Promise<number> {
    return this.db!.collection(name).countDocuments();
  }

  async getEstimatedRowCount(name: string): Promise<number> {
    return this.db!.collection(name).estimatedDocumentCount();
  }

  async getDDL(name: string): Promise<string> {
    const collection = this.db!.collection(name);
    const indexes = await collection.indexes();

    const parts: string[] = [];
    parts.push(`// Collection: ${name}`);

    // Validation rules
    const colInfo = (await this.db!.listCollections({ name }).toArray())[0] as Document | undefined;
    if (colInfo?.options?.validator) {
      parts.push('');
      parts.push('// Schema Validation');
      parts.push(`db.createCollection("${name}", ${JSON.stringify({ validator: colInfo.options.validator }, null, 2)})`);
    }

    // Indexes
    if (indexes.length > 0) {
      parts.push('');
      parts.push('// Indexes');
      for (const idx of indexes) {
        if (idx.name === '_id_') continue;
        const opts: Record<string, unknown> = {};
        if (idx.unique) opts.unique = true;
        if (idx.sparse) opts.sparse = true;
        if (idx.expireAfterSeconds !== undefined) opts.expireAfterSeconds = idx.expireAfterSeconds;
        if (idx.name) opts.name = idx.name;
        const optsStr = Object.keys(opts).length > 0 ? `, ${JSON.stringify(opts)}` : '';
        parts.push(`db.${name}.createIndex(${JSON.stringify(idx.key)}${optsStr})`);
      }
    }

    return parts.join('\n');
  }

  async getCompletions(): Promise<CompletionItem[]> {
    const items: CompletionItem[] = [];

    const collections = await this.db!.listCollections().toArray();
    for (const col of collections) {
      items.push({
        label: col.name,
        kind: col.type === 'view' ? 'view' : 'table',
      });
    }

    for (const col of collections) {
      const fields = await this.sampleFields(col.name);
      for (const f of fields) {
        items.push({
          label: f.name,
          kind: 'column',
          detail: f.dataType,
          parent: col.name,
        });
      }
    }

    return items;
  }

  async getTableObjects(name: string): Promise<TableObjects> {
    const rawIndexes = await this.db!.collection(name).indexes();

    const indexes: IndexInfo[] = rawIndexes
      .filter(idx => idx.name !== '_id_')
      .map(idx => ({
        name: idx.name || 'unnamed',
        columns: Object.keys(idx.key),
        unique: !!idx.unique,
        type: detectIndexType(idx),
      }));

    return { indexes, constraints: [], triggers: [], sequences: [] };
  }

  async getTableStatistics(name: string): Promise<TableStatistic[]> {
    const stats = await this.db!.command({ collStats: name }) as Document;

    const toNumber = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = typeof v === 'number' ? v : parseInt(String(v), 10);
      return Number.isFinite(n) ? n : null;
    };

    return [
      { key: 'row_count', label: 'Document count', value: toNumber(stats.count), unit: 'count' },
      { key: 'total_size', label: 'Total size', value: toNumber(stats.size), unit: 'bytes' },
      { key: 'storage_size', label: 'Storage size', value: toNumber(stats.storageSize), unit: 'bytes' },
      { key: 'avg_obj_size', label: 'Avg document size', value: toNumber(stats.avgObjSize), unit: 'bytes' },
      { key: 'index_count', label: 'Index count', value: toNumber(stats.nindexes), unit: 'count' },
      { key: 'index_size', label: 'Total index size', value: toNumber(stats.totalIndexSize), unit: 'bytes' },
    ];
  }

  private async sampleFields(collectionName: string): Promise<{ name: string; dataType: string; nullable: boolean }[]> {
    const docs = await this.db!.collection(collectionName)
      .find()
      .limit(SAMPLE_SIZE)
      .toArray();

    if (docs.length === 0) return [{ name: '_id', dataType: 'ObjectId', nullable: false }];

    const fieldTypes = new Map<string, Set<string>>();
    const fieldPresence = new Map<string, number>();

    for (const doc of docs) {
      const flat = flattenDocument(doc);
      for (const [key, value] of Object.entries(flat)) {
        const bsonType = inferBsonType(value);
        if (!fieldTypes.has(key)) fieldTypes.set(key, new Set());
        fieldTypes.get(key)!.add(bsonType);
        fieldPresence.set(key, (fieldPresence.get(key) || 0) + 1);
      }
    }

    const fields: { name: string; dataType: string; nullable: boolean }[] = [];
    for (const [name, types] of fieldTypes) {
      const typesArr = Array.from(types).filter(t => t !== 'null');
      const dataType = typesArr.length === 0 ? 'null' : typesArr.length === 1 ? typesArr[0] : typesArr.join(' | ');
      const presence = fieldPresence.get(name) || 0;
      fields.push({
        name,
        dataType,
        nullable: presence < docs.length || types.has('null'),
      });
    }

    // Sort: _id first, then alphabetically
    fields.sort((a, b) => {
      if (a.name === '_id') return -1;
      if (b.name === '_id') return 1;
      return a.name.localeCompare(b.name);
    });

    return fields;
  }
}

function flattenDocument(doc: Document): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      if (value.constructor?.name === 'ObjectId' || value._bsontype === 'ObjectId') {
        result[key] = String(value);
      } else if (value._bsontype === 'Decimal128' || value._bsontype === 'Long' || value._bsontype === 'Int32') {
        result[key] = Number(value.toString());
      } else if (value instanceof Buffer || value._bsontype === 'Binary') {
        result[key] = `<Binary ${(value as Buffer).length || 0} bytes>`;
      } else {
        result[key] = JSON.stringify(value);
      }
    } else if (Array.isArray(value)) {
      result[key] = JSON.stringify(value);
    } else if (value instanceof Date) {
      result[key] = value.toISOString();
    } else {
      result[key] = value;
    }
  }
  return result;
}

function inferBsonType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    if (/^[0-9a-f]{24}$/i.test(value)) return 'ObjectId';
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'Date';
    return 'String';
  }
  if (typeof value === 'number') return Number.isInteger(value) ? 'Int32' : 'Double';
  if (typeof value === 'boolean') return 'Boolean';
  if (typeof value === 'object') {
    if (value instanceof Date) return 'Date';
    return 'Object';
  }
  return typeof value;
}

function inferColumns(rows: Record<string, unknown>[]): QueryColumn[] {
  if (rows.length === 0) return [];

  const colTypes = new Map<string, string>();
  const colOrder: string[] = [];

  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!colTypes.has(key)) {
        colOrder.push(key);
        colTypes.set(key, inferBsonType(value));
      }
    }
  }

  return colOrder.map(name => ({
    name,
    dataType: colTypes.get(name) || 'String',
  }));
}

function detectIndexType(idx: Document): string {
  const values = Object.values(idx.key as Record<string, unknown>);
  if (values.includes('text')) return 'text';
  if (values.includes('2dsphere')) return '2dsphere';
  if (values.includes('2d')) return '2d';
  if (values.includes('hashed')) return 'hashed';
  return 'btree';
}

interface ParsedMongoCommand {
  collection: string;
  operation: string;
  args: unknown[];
}

export function parseMongoCommand(input: string): ParsedMongoCommand {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Empty command');

  // db.collection.operation(args) or db.collection.operation()
  const match = trimmed.match(/^db\.([a-zA-Z0-9_$]+)\.([a-zA-Z]+)\s*\(([\s\S]*)\)$/);
  if (!match) {
    // Shorthand: just a collection name → find all
    if (/^[a-zA-Z0-9_$]+$/.test(trimmed)) {
      return { collection: trimmed, operation: 'find', args: [{}] };
    }
    throw new Error(
      'Invalid command format. Use db.<collection>.<operation>(<args>) or just <collection> to browse. ' +
      'Example: db.users.find({ age: { $gt: 25 } })',
    );
  }

  const collection = match[1];
  const operation = match[2];
  const argsStr = match[3].trim();

  if (!argsStr) {
    return { collection, operation, args: [] };
  }

  const args = parseArgs(argsStr);
  return { collection, operation, args };
}

function parseArgs(argsStr: string): unknown[] {
  // Wrap in array brackets so JSON.parse can handle multiple args
  const wrapped = `[${argsStr}]`;
  try {
    return JSON.parse(wrapped);
  } catch {
    // Try relaxed JSON: add quotes to unquoted keys
    const relaxed = wrapped.replace(/(['"])?([a-zA-Z_$][a-zA-Z0-9_$]*)\1\s*:/g, '"$2":');
    try {
      return JSON.parse(relaxed);
    } catch {
      throw new Error(
        'Could not parse arguments. Use valid JSON syntax. ' +
        'Example: db.users.find({"name": "Alice"})',
      );
    }
  }
}
