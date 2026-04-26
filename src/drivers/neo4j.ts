import neo4j, { type Driver, type Session, type Record as Neo4jRecord, Integer } from 'neo4j-driver';
import { DatabaseDriver, CompletionItem } from '../types/driver';
import { ConnectionConfig } from '../types/connection';
import { QueryResult, QueryColumn, SortColumn, MAX_RESULT_ROWS } from '../types/query';
import { SchemaObject, TableInfo, ColumnInfo, TableObjects, IndexInfo, ConstraintInfo } from '../types/schema';
import { wrapError } from '../utils/errors';

export class Neo4jDriver implements DatabaseDriver {
  private driver: Driver | undefined;
  private database: string | undefined;

  async connect(config: ConnectionConfig): Promise<void> {
    const scheme = config.ssl ? 'neo4j+s' : 'neo4j';
    const uri = `${scheme}://${config.host}:${config.port}`;
    this.database = config.database || undefined;
    this.driver = neo4j.driver(
      uri,
      config.username ? neo4j.auth.basic(config.username, config.password || '') : undefined,
    );
    await this.driver.verifyConnectivity({ database: this.database });
  }

  async disconnect(): Promise<void> {
    await this.driver?.close();
    this.driver = undefined;
  }

  async ping(): Promise<boolean> {
    try {
      await this.driver!.verifyConnectivity({ database: this.database });
      return true;
    } catch {
      return false;
    }
  }

  async execute(query: string): Promise<QueryResult> {
    const start = Date.now();
    const session = this.openSession();
    try {
      const result = await session.run(query);
      const executionTimeMs = Date.now() - start;

      if (result.records.length === 0) {
        const counters = result.summary.counters.updates();
        const affectedRows = Object.values(counters).reduce((a: number, b) => a + (b as number), 0);
        if (affectedRows > 0) {
          return {
            columns: [{ name: 'status', dataType: 'string' }],
            rows: [{ status: `OK — ${formatCounters(counters)}` }],
            rowCount: 1,
            affectedRows,
            executionTimeMs,
          };
        }
        return { columns: [], rows: [], rowCount: 0, executionTimeMs };
      }

      const columns = extractColumns(result.records);
      const rows = result.records.slice(0, MAX_RESULT_ROWS).map(r => recordToRow(r));
      const truncated = result.records.length > MAX_RESULT_ROWS;

      return { columns, rows, rowCount: result.records.length, executionTimeMs, truncated };
    } catch (err) {
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: wrapError(err) };
    } finally {
      await session.close();
    }
  }

  async getSchema(): Promise<SchemaObject[]> {
    const session = this.openSession();
    try {
      const labelsRes = await session.run('CALL db.labels() YIELD label RETURN label ORDER BY label');
      const labels = labelsRes.records.map(r => String(r.get('label')));

      const relTypesRes = await session.run('CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType');
      const relTypes = relTypesRes.records.map(r => String(r.get('relationshipType')));

      let propsMap: Map<string, SchemaObject[]>;
      try {
        const propsRes = await session.run(
          'CALL db.schema.nodeTypeProperties() YIELD nodeType, propertyName, propertyTypes ' +
          'RETURN nodeType, propertyName, propertyTypes',
        );
        propsMap = new Map();
        for (const rec of propsRes.records) {
          const nodeType = String(rec.get('nodeType'));
          const label = nodeType.replace(/^:`/, '').replace(/`$/, '');
          const propName = String(rec.get('propertyName'));
          const propTypes = rec.get('propertyTypes') as string[];
          if (!propsMap.has(label)) propsMap.set(label, []);
          propsMap.get(label)!.push({
            name: propName,
            type: 'column',
            detail: propTypes?.join(' | ') || 'Any',
          });
        }
      } catch {
        propsMap = new Map();
      }

      const labelNodes: SchemaObject[] = labels.map(label => ({
        name: label,
        type: 'table' as const,
        children: propsMap.get(label) || [],
      }));

      const relTypeNodes: SchemaObject[] = relTypes.map(rt => ({
        name: rt,
        type: 'table' as const,
        detail: 'relationship',
        children: [],
      }));

      const schema: SchemaObject[] = [];

      if (labelNodes.length > 0) {
        schema.push({
          name: 'Node Labels',
          type: 'schema',
          children: labelNodes,
        });
      }

      if (relTypeNodes.length > 0) {
        schema.push({
          name: 'Relationship Types',
          type: 'schema',
          children: relTypeNodes,
        });
      }

      return schema;
    } finally {
      await session.close();
    }
  }

  async getTableInfo(name: string): Promise<TableInfo> {
    const session = this.openSession();
    try {
      let columns: ColumnInfo[];
      try {
        const propsRes = await session.run(
          'CALL db.schema.nodeTypeProperties() YIELD nodeType, propertyName, propertyTypes ' +
          'WHERE nodeType = $nodeType ' +
          'RETURN propertyName, propertyTypes',
          { nodeType: `:\`${name}\`` },
        );
        columns = propsRes.records.map(r => ({
          name: String(r.get('propertyName')),
          dataType: (r.get('propertyTypes') as string[])?.join(' | ') || 'Any',
          nullable: true,
          isPrimaryKey: false,
        }));
      } catch {
        columns = await this.inferColumnsFromSample(session, name);
      }

      return { name, columns };
    } finally {
      await session.close();
    }
  }

  async getTableData(name: string, _schema?: string, limit = MAX_RESULT_ROWS, offset = 0, orderBy?: SortColumn[]): Promise<QueryResult> {
    let query = `MATCH (n:\`${escapeCypherLabel(name)}\`) RETURN n`;
    if (orderBy && orderBy.length > 0) {
      const clauses = orderBy.map(s => `n.\`${escapeCypherLabel(s.column)}\` ${s.direction === 'desc' ? 'DESC' : 'ASC'}`);
      query += ` ORDER BY ${clauses.join(', ')}`;
    }
    query += ` SKIP ${offset} LIMIT ${limit}`;
    const result = await this.execute(query);
    result.query = query;
    return result;
  }

  async getEstimatedRowCount(name: string): Promise<number> {
    const session = this.openSession();
    try {
      const res = await session.run(
        'MATCH (n:`' + escapeCypherLabel(name) + '`) RETURN count(n) AS cnt',
      );
      return toJsNumber(res.records[0]?.get('cnt'));
    } finally {
      await session.close();
    }
  }

  async getTableRowCount(name: string): Promise<number> {
    return this.getEstimatedRowCount(name);
  }

  async getDDL(name: string, type: string): Promise<string> {
    const session = this.openSession();
    try {
      if (type === 'index') {
        const res = await session.run('SHOW INDEXES YIELD name, type, labelsOrTypes, properties WHERE name = $name RETURN *', { name });
        if (res.records.length > 0) {
          const r = res.records[0];
          return `// Index: ${r.get('name')}\n// Type: ${r.get('type')}\n// Labels: ${JSON.stringify(r.get('labelsOrTypes'))}\n// Properties: ${JSON.stringify(r.get('properties'))}`;
        }
      }
      if (type === 'constraint') {
        const res = await session.run('SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties WHERE name = $name RETURN *', { name });
        if (res.records.length > 0) {
          const r = res.records[0];
          return `// Constraint: ${r.get('name')}\n// Type: ${r.get('type')}\n// Labels: ${JSON.stringify(r.get('labelsOrTypes'))}\n// Properties: ${JSON.stringify(r.get('properties'))}`;
        }
      }
      const res = await session.run('SHOW INDEXES YIELD name, type, labelsOrTypes, properties RETURN *');
      const indexLines = res.records
        .filter(r => {
          const labels = r.get('labelsOrTypes') as string[];
          return labels?.includes(name);
        })
        .map(r => `// Index: ${r.get('name')} (${r.get('type')}) on ${JSON.stringify(r.get('properties'))}`);

      const cRes = await session.run('SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties RETURN *');
      const constraintLines = cRes.records
        .filter(r => {
          const labels = r.get('labelsOrTypes') as string[];
          return labels?.includes(name);
        })
        .map(r => `// Constraint: ${r.get('name')} (${r.get('type')}) on ${JSON.stringify(r.get('properties'))}`);

      const lines = [...indexLines, ...constraintLines];
      return lines.length > 0 ? lines.join('\n') : `// No indexes or constraints for label "${name}"`;
    } catch (err) {
      return `// Error fetching DDL: ${wrapError(err)}`;
    } finally {
      await session.close();
    }
  }

  async getTableObjects(name: string): Promise<TableObjects> {
    const session = this.openSession();
    try {
      const indexes: IndexInfo[] = [];
      const constraints: ConstraintInfo[] = [];

      try {
        const idxRes = await session.run('SHOW INDEXES YIELD name, type, labelsOrTypes, properties RETURN *');
        for (const r of idxRes.records) {
          const labels = r.get('labelsOrTypes') as string[];
          if (!labels?.includes(name)) continue;
          indexes.push({
            name: String(r.get('name')),
            columns: (r.get('properties') as string[]) || [],
            unique: String(r.get('type')).includes('UNIQUE'),
            type: String(r.get('type')),
          });
        }
      } catch { /* SHOW INDEXES requires admin in some editions */ }

      try {
        const cRes = await session.run('SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties RETURN *');
        for (const r of cRes.records) {
          const labels = r.get('labelsOrTypes') as string[];
          if (!labels?.includes(name)) continue;
          const cType = String(r.get('type'));
          let mappedType: ConstraintInfo['type'] = 'UNIQUE';
          if (cType.includes('UNIQUE')) mappedType = 'UNIQUE';
          else if (cType.includes('KEY')) mappedType = 'PRIMARY KEY';
          else if (cType.includes('EXIST')) mappedType = 'CHECK';
          constraints.push({
            name: String(r.get('name')),
            type: mappedType,
            columns: (r.get('properties') as string[]) || [],
          });
        }
      } catch { /* SHOW CONSTRAINTS requires admin in some editions */ }

      return { indexes, constraints, triggers: [], sequences: [] };
    } finally {
      await session.close();
    }
  }

  async getCompletions(): Promise<CompletionItem[]> {
    const session = this.openSession();
    try {
      const items: CompletionItem[] = [];

      const labelsRes = await session.run('CALL db.labels() YIELD label RETURN label');
      for (const r of labelsRes.records) {
        items.push({ label: String(r.get('label')), kind: 'table' });
      }

      const relRes = await session.run('CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType');
      for (const r of relRes.records) {
        items.push({ label: String(r.get('relationshipType')), kind: 'table', detail: 'relationship' });
      }

      try {
        const propsRes = await session.run(
          'CALL db.schema.nodeTypeProperties() YIELD nodeType, propertyName, propertyTypes RETURN nodeType, propertyName, propertyTypes',
        );
        for (const r of propsRes.records) {
          const nodeType = String(r.get('nodeType'));
          const parent = nodeType.replace(/^:`/, '').replace(/`$/, '');
          items.push({
            label: String(r.get('propertyName')),
            kind: 'column',
            detail: (r.get('propertyTypes') as string[])?.join(' | '),
            parent,
          });
        }
      } catch { /* nodeTypeProperties not available in all editions */ }

      return items;
    } finally {
      await session.close();
    }
  }

  private openSession(): Session {
    return this.driver!.session({ database: this.database });
  }

  private async inferColumnsFromSample(session: Session, label: string): Promise<ColumnInfo[]> {
    const res = await session.run(
      `MATCH (n:\`${escapeCypherLabel(label)}\`) RETURN n LIMIT 100`,
    );
    const propSet = new Map<string, Set<string>>();
    for (const rec of res.records) {
      const node = rec.get('n');
      if (node && node.properties) {
        for (const [key, val] of Object.entries(node.properties)) {
          if (!propSet.has(key)) propSet.set(key, new Set());
          propSet.get(key)!.add(neo4jTypeOf(val));
        }
      }
    }
    return Array.from(propSet.entries()).map(([name, types]) => ({
      name,
      dataType: Array.from(types).join(' | '),
      nullable: true,
      isPrimaryKey: false,
    }));
  }
}

export function escapeCypherLabel(name: string): string {
  return name.replace(/`/g, '``');
}

export function toJsNumber(value: unknown): number {
  if (value instanceof Integer || (value && typeof value === 'object' && 'low' in value && 'high' in value)) {
    return (value as Integer).toNumber();
  }
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' ? value : parseInt(String(value), 10) || 0;
}

export function toJsValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Integer || (value && typeof value === 'object' && 'low' in value && 'high' in value)) {
    return (value as Integer).toNumber();
  }
  if (typeof value === 'bigint') return Number(value);
  if (neo4j.isPoint(value)) {
    const p = value as { x: number; y: number; z?: number };
    return p.z !== undefined ? `POINT(${p.x} ${p.y} ${p.z})` : `POINT(${p.x} ${p.y})`;
  }
  if (neo4j.isDate(value) || neo4j.isDateTime(value) || neo4j.isLocalDateTime(value) ||
      neo4j.isTime(value) || neo4j.isLocalTime(value) || neo4j.isDuration(value)) {
    return value.toString();
  }
  if (Array.isArray(value)) return value.map(toJsValue);
  if (value && typeof value === 'object' && 'properties' in value) {
    const node = value as { labels?: string[]; properties: Record<string, unknown> };
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.properties)) {
      props[k] = toJsValue(v);
    }
    return props;
  }
  return value;
}

function recordToRow(record: Neo4jRecord): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const key of record.keys) {
    const keyStr = String(key);
    const value = record.get(keyStr);
    const jsValue = toJsValue(value);
    if (jsValue && typeof jsValue === 'object' && !Array.isArray(jsValue) && record.keys.length === 1) {
      for (const [k, v] of Object.entries(jsValue)) {
        row[k] = v;
      }
    } else {
      row[keyStr] = jsValue;
    }
  }
  return row;
}

function extractColumns(records: Neo4jRecord[]): QueryColumn[] {
  if (records.length === 0) return [];

  const first = records[0];
  if (first.keys.length === 1) {
    const firstKey = String(first.keys[0]);
    const value = first.get(firstKey);
    if (value && typeof value === 'object' && 'properties' in value) {
      const node = value as { properties: Record<string, unknown> };
      const propNames = new Set<string>();
      for (const rec of records.slice(0, 100)) {
        const v = rec.get(firstKey) as { properties: Record<string, unknown> } | null;
        if (v?.properties) {
          for (const k of Object.keys(v.properties)) propNames.add(k);
        }
      }
      return Array.from(propNames).map(name => ({
        name,
        dataType: neo4jTypeOf(node.properties[name]),
      }));
    }
  }

  return first.keys.map(key => ({
    name: String(key),
    dataType: neo4jTypeOf(first.get(String(key))),
  }));
}

export function neo4jTypeOf(value: unknown): string {
  if (value === null || value === undefined) return 'Null';
  if (value instanceof Integer || (value && typeof value === 'object' && 'low' in value && 'high' in value)) return 'Integer';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Float';
  if (typeof value === 'string') return 'String';
  if (typeof value === 'boolean') return 'Boolean';
  if (typeof value === 'bigint') return 'Integer';
  if (Array.isArray(value)) return 'List';
  if (neo4j.isPoint(value)) return 'Point';
  if (neo4j.isDate(value)) return 'Date';
  if (neo4j.isDateTime(value)) return 'DateTime';
  if (neo4j.isLocalDateTime(value)) return 'LocalDateTime';
  if (neo4j.isTime(value)) return 'Time';
  if (neo4j.isLocalTime(value)) return 'LocalTime';
  if (neo4j.isDuration(value)) return 'Duration';
  if (value && typeof value === 'object' && 'properties' in value) return 'Node';
  return 'Object';
}

export function formatCounters(counters: Record<string, number>): string {
  return Object.entries(counters)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}
