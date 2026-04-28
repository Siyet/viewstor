import { describe, it, expect } from 'vitest';
import { parseDBeaver, parseDataGrip, parsePgAdmin, parseImportFile } from '../services/importService';

describe('ImportService', () => {
  describe('parseDBeaver', () => {
    it('should parse PostgreSQL connections', () => {
      const input = JSON.stringify({
        connections: {
          'postgres-jdbc-abc123': {
            provider: 'postgresql',
            driver: 'postgres-jdbc',
            name: 'My Postgres',
            'read-only': true,
            configuration: {
              host: 'db.example.com',
              port: '5433',
              database: 'mydb',
              user: 'admin',
            },
          },
        },
      });

      const result = parseDBeaver(input);
      expect(result.connections).toHaveLength(1);
      expect(result.warnings).toHaveLength(0);

      const conn = result.connections[0];
      expect(conn.name).toBe('My Postgres');
      expect(conn.type).toBe('postgresql');
      expect(conn.host).toBe('db.example.com');
      expect(conn.port).toBe(5433);
      expect(conn.database).toBe('mydb');
      expect(conn.username).toBe('admin');
      expect(conn.readonly).toBe(true);
    });

    it('should parse host/port from JDBC URL when fields are missing', () => {
      const input = JSON.stringify({
        connections: {
          'pg-1': {
            provider: 'postgresql',
            name: 'URL Only',
            configuration: {
              url: 'jdbc:postgresql://remote-host:5434/prod_db',
            },
          },
        },
      });

      const result = parseDBeaver(input);
      expect(result.connections).toHaveLength(1);
      expect(result.connections[0].host).toBe('remote-host');
      expect(result.connections[0].port).toBe(5434);
      expect(result.connections[0].database).toBe('prod_db');
    });

    it('should skip unsupported providers with warning', () => {
      const input = JSON.stringify({
        connections: {
          'oracle-1': {
            provider: 'oracle',
            name: 'Oracle DB',
            configuration: { host: 'localhost', port: '1521' },
          },
        },
      });

      const result = parseDBeaver(input);
      expect(result.connections).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('unsupported provider');
    });

    it('should parse Redis, ClickHouse, and SQLite connections', () => {
      const input = JSON.stringify({
        connections: {
          'redis-1': {
            provider: 'redis',
            name: 'Redis Cache',
            configuration: { host: 'redis.local', port: '6380' },
          },
          'ch-1': {
            provider: 'clickhouse',
            name: 'ClickHouse Analytics',
            configuration: { host: 'ch.local', port: '8123' },
          },
          'sqlite-1': {
            provider: 'sqlite',
            name: 'SQLite Local',
            configuration: { database: '/tmp/test.db' },
          },
        },
      });

      const result = parseDBeaver(input);
      expect(result.connections).toHaveLength(3);
      expect(result.connections[0].type).toBe('redis');
      expect(result.connections[1].type).toBe('clickhouse');
      expect(result.connections[2].type).toBe('sqlite');
    });

    it('should handle invalid JSON', () => {
      const result = parseDBeaver('not json');
      expect(result.connections).toHaveLength(0);
      expect(result.warnings[0]).toContain('Invalid JSON');
    });

    it('should handle empty connections', () => {
      const result = parseDBeaver(JSON.stringify({}));
      expect(result.connections).toHaveLength(0);
      expect(result.warnings[0]).toContain('No connections found');
    });
  });

  describe('parseDataGrip', () => {
    it('should parse PostgreSQL data sources from XML', () => {
      const xml = `<?xml version="1.0"?>
<application>
  <component name="dataSourceStorage">
    <data-source source="LOCAL" name="Prod DB" uuid="abc-123">
      <driver-ref>postgresql</driver-ref>
      <jdbc-url>jdbc:postgresql://prod.db.com:5432/production</jdbc-url>
      <user-name>deploy</user-name>
    </data-source>
  </component>
</application>`;

      const result = parseDataGrip(xml);
      expect(result.connections).toHaveLength(1);

      const conn = result.connections[0];
      expect(conn.name).toBe('Prod DB');
      expect(conn.type).toBe('postgresql');
      expect(conn.host).toBe('prod.db.com');
      expect(conn.port).toBe(5432);
      expect(conn.database).toBe('production');
      expect(conn.username).toBe('deploy');
    });

    it('should detect SSL from JDBC URL', () => {
      const xml = `<application>
  <component name="dataSourceStorage">
    <data-source source="LOCAL" name="SSL DB" uuid="x">
      <driver-ref>postgresql</driver-ref>
      <jdbc-url>jdbc:postgresql://host:5432/db?sslmode=require</jdbc-url>
    </data-source>
  </component>
</application>`;

      const result = parseDataGrip(xml);
      expect(result.connections[0].ssl).toBe(true);
    });

    it('should skip unsupported drivers', () => {
      const xml = `<application>
  <component name="dataSourceStorage">
    <data-source source="LOCAL" name="Oracle" uuid="x">
      <driver-ref>oracle.thin</driver-ref>
      <jdbc-url>jdbc:oracle:thin:@localhost:1521/test</jdbc-url>
    </data-source>
  </component>
</application>`;

      const result = parseDataGrip(xml);
      expect(result.connections).toHaveLength(0);
      expect(result.warnings[0]).toContain('unsupported driver');
    });

    it('should parse SQLite data sources', () => {
      const xml = `<application>
  <component name="dataSourceStorage">
    <data-source source="LOCAL" name="Local SQLite" uuid="x">
      <driver-ref>sqlite.xerial</driver-ref>
      <jdbc-url>jdbc:sqlite:/path/to/db.sqlite</jdbc-url>
    </data-source>
  </component>
</application>`;

      const result = parseDataGrip(xml);
      expect(result.connections).toHaveLength(1);
      expect(result.connections[0].type).toBe('sqlite');
    });

    it('should handle empty/invalid XML', () => {
      const result = parseDataGrip('<root></root>');
      expect(result.connections).toHaveLength(0);
      expect(result.warnings[0]).toContain('No data sources found');
    });
  });

  describe('parsePgAdmin', () => {
    it('should parse servers.json', () => {
      const input = JSON.stringify({
        Servers: {
          '1': {
            Name: 'Production',
            Group: 'Servers',
            Host: 'db.prod.com',
            Port: 5432,
            Username: 'postgres',
            MaintenanceDB: 'postgres',
            SSLMode: 'require',
          },
          '2': {
            Name: 'Staging',
            Host: 'db.staging.com',
            Port: 5433,
            Username: 'app',
            SSLMode: 'disable',
          },
        },
      });

      const result = parsePgAdmin(input);
      expect(result.connections).toHaveLength(2);

      expect(result.connections[0].name).toBe('Production');
      expect(result.connections[0].host).toBe('db.prod.com');
      expect(result.connections[0].port).toBe(5432);
      expect(result.connections[0].username).toBe('postgres');
      expect(result.connections[0].database).toBe('postgres');
      expect(result.connections[0].ssl).toBe(true);
      expect(result.connections[0].type).toBe('postgresql');

      expect(result.connections[1].ssl).toBeUndefined();
    });

    it('should use HostAddr when Host is missing', () => {
      const input = JSON.stringify({
        Servers: {
          '1': { Name: 'IP Server', HostAddr: '192.168.1.100', Port: 5432, Username: 'u' },
        },
      });

      const result = parsePgAdmin(input);
      expect(result.connections[0].host).toBe('192.168.1.100');
    });

    it('should handle invalid JSON', () => {
      const result = parsePgAdmin('{bad');
      expect(result.connections).toHaveLength(0);
      expect(result.warnings[0]).toContain('Invalid JSON');
    });
  });

  describe('parseImportFile', () => {
    it('should dispatch to correct parser', () => {
      const dbeaver = parseImportFile('dbeaver', JSON.stringify({}));
      expect(dbeaver.warnings[0]).toContain('No connections found');

      const pgadmin = parseImportFile('pgadmin', JSON.stringify({}));
      expect(pgadmin.warnings[0]).toContain('No servers found');

      const datagrip = parseImportFile('datagrip', '<root/>');
      expect(datagrip.warnings[0]).toContain('No data sources found');
    });
  });
});
