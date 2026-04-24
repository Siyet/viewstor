import { DatabaseType } from '../types/connection';

export interface AdapterSpec {
  packageName: string;
  version: string;
  approxSizeMB: number;
  isNative: boolean;
}

const registry: Record<DatabaseType, AdapterSpec> = {
  postgresql: { packageName: 'pg', version: '^8.11.0', approxSizeMB: 2, isNative: false },
  redis: { packageName: 'ioredis', version: '^5.3.0', approxSizeMB: 3, isNative: false },
  clickhouse: { packageName: '@clickhouse/client', version: '^0.2.0', approxSizeMB: 2, isNative: false },
  sqlite: { packageName: 'better-sqlite3', version: '^12.8.0', approxSizeMB: 8, isNative: true },
};

export function getAdapterSpec(type: DatabaseType): AdapterSpec {
  return registry[type];
}

export function getAllAdapterSpecs(): [DatabaseType, AdapterSpec][] {
  return Object.entries(registry) as [DatabaseType, AdapterSpec][];
}

export function getPackageName(type: DatabaseType): string {
  return registry[type].packageName;
}

export function getPackageInstallArg(type: DatabaseType): string {
  const spec = registry[type];
  return `${spec.packageName}@${spec.version}`;
}
