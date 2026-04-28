import { DatabaseType } from '../types/connection';
import { DatabaseDriver } from '../types/driver';
import { PostgresDriver } from './postgres';
import { MysqlDriver } from './mysql';
import { RedisDriver } from './redis';
import { ClickHouseDriver } from './clickhouse';
import { SqliteDriver } from './sqlite';

export function createDriver(type: DatabaseType): DatabaseDriver {
  switch (type) {
    case 'postgresql':
      return new PostgresDriver();
    case 'mysql':
      return new MysqlDriver();
    case 'redis':
      return new RedisDriver();
    case 'clickhouse':
      return new ClickHouseDriver();
    case 'sqlite':
      return new SqliteDriver();
    default:
      throw new Error(`Unsupported database type: ${type}`);
  }
}
