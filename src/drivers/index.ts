import { DatabaseType } from '../types/connection';
import { DatabaseDriver } from '../types/driver';
import { PostgresDriver } from './postgres';
import { RedisDriver } from './redis';
import { ClickHouseDriver } from './clickhouse';
import { SqliteDriver } from './sqlite';
import { Neo4jDriver } from './neo4j';

export function createDriver(type: DatabaseType): DatabaseDriver {
  switch (type) {
    case 'postgresql':
      return new PostgresDriver();
    case 'redis':
      return new RedisDriver();
    case 'clickhouse':
      return new ClickHouseDriver();
    case 'sqlite':
      return new SqliteDriver();
    case 'neo4j':
      return new Neo4jDriver();
    default:
      throw new Error(`Unsupported database type: ${type}`);
  }
}
