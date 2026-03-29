import { DatabaseType } from '../types/connection';
import { DatabaseDriver } from '../types/driver';
import { PostgresDriver } from './postgres';
import { RedisDriver } from './redis';
import { ClickHouseDriver } from './clickhouse';

export function createDriver(type: DatabaseType): DatabaseDriver {
  switch (type) {
    case 'postgresql':
      return new PostgresDriver();
    case 'redis':
      return new RedisDriver();
    case 'clickhouse':
      return new ClickHouseDriver();
    default:
      throw new Error(`Unsupported database type: ${type}`);
  }
}
