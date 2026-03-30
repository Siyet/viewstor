import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { PostgresDriver } from '../../drivers/postgres';
import { ConnectionConfig } from '../../types/connection';
import { isDockerAvailable, describeIf } from './helpers/dockerCheck';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildMetadataComment,
  parseMetadataFromLine,
  parseMetadataFromFile,
  stripMetadataFromContent,
  buildQueryFileContent,
  listSqlFiles,
} from '../../utils/queryFileHelpers';

const TEST_DIR = path.join(os.tmpdir(), `viewstor-qf-e2e-${Date.now()}`);
const TMP_DIR = path.join(TEST_DIR, 'tmp');
const QUERIES_DIR = path.join(TEST_DIR, 'queries');

describeIf(isDockerAvailable)('Unified Query Editor E2E', () => {
  let container: StartedTestContainer;
  let driver: PostgresDriver;
  let config: ConnectionConfig;

  beforeAll(async () => {
    // Create test dirs
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.mkdirSync(QUERIES_DIR, { recursive: true });

    // Start PostgreSQL container
    container = await new GenericContainer('postgres:16-alpine')
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_USER: 'test',
        POSTGRES_PASSWORD: 'test',
        POSTGRES_DB: 'testdb',
      })
      .start();

    config = {
      id: 'test-qf',
      name: 'Test QF',
      type: 'postgresql',
      host: container.getHost(),
      port: container.getMappedPort(5432),
      username: 'test',
      password: 'test',
      database: 'testdb',
    };

    driver = new PostgresDriver();
    await driver.connect(config);

    // Seed test data
    await driver.execute(`
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price NUMERIC(10,2) NOT NULL,
        category VARCHAR(50)
      )
    `);
    await driver.execute(`
      INSERT INTO products (name, price, category) VALUES
        ('Widget', 9.99, 'gadgets'),
        ('Gizmo', 24.50, 'gadgets'),
        ('Doohickey', 4.75, 'tools')
    `);
  });

  afterAll(async () => {
    await driver?.disconnect();
    await container?.stop();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('query file creation and metadata', () => {
    it('should create a temp query file with metadata header', () => {
      const sql = 'SELECT * FROM products;';
      const content = buildQueryFileContent(config.id, config.database, sql);
      const filePath = path.join(TMP_DIR, 'query_test1.sql');
      fs.writeFileSync(filePath, content, 'utf-8');

      expect(fs.existsSync(filePath)).toBe(true);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const firstLine = raw.split('\n')[0];
      expect(firstLine.startsWith('-- viewstor:')).toBe(true);

      const metadata = parseMetadataFromLine(firstLine);
      expect(metadata).toEqual({
        connectionId: config.id,
        databaseName: config.database,
      });
    });

    it('should create a confirmation query file with metadata', () => {
      const sql = 'UPDATE products SET price = 19.99 WHERE id = 1;';
      const header = buildMetadataComment(config.id, config.database);
      const content = header + '\n' + sql;
      const filePath = path.join(TMP_DIR, 'confirm_test1.sql');
      fs.writeFileSync(filePath, content, 'utf-8');

      const metadata = parseMetadataFromFile(filePath);
      expect(metadata?.connectionId).toBe(config.id);
      expect(metadata?.databaseName).toBe(config.database);

      const strippedSql = stripMetadataFromContent(fs.readFileSync(filePath, 'utf-8'));
      expect(strippedSql).toBe(sql);
    });
  });

  describe('query execution from file content', () => {
    it('should execute SELECT query stripped from file content', async () => {
      const sql = 'SELECT name, price FROM products ORDER BY id';
      const content = buildQueryFileContent(config.id, config.database, sql);
      const strippedQuery = stripMetadataFromContent(content);

      const result = await driver.execute(strippedQuery);
      expect(result.error).toBeUndefined();
      expect(result.rowCount).toBe(3);
      expect(result.columns.map(c => c.name)).toEqual(['name', 'price']);
      expect(result.rows[0]).toMatchObject({ name: 'Widget', price: '9.99' });
    });

    it('should execute INSERT from confirmation file content', async () => {
      const sql = 'INSERT INTO products (name, price, category) VALUES (\'Thingamajig\', 15.00, \'tools\');';
      const content = buildQueryFileContent(config.id, config.database, sql);
      const strippedQuery = stripMetadataFromContent(content);

      const result = await driver.execute(strippedQuery);
      expect(result.error).toBeUndefined();

      // Verify the row was inserted
      const check = await driver.execute('SELECT * FROM products WHERE name = \'Thingamajig\'');
      expect(check.rowCount).toBe(1);
      expect(check.rows[0]).toMatchObject({ name: 'Thingamajig', price: '15.00', category: 'tools' });
    });

    it('should execute UPDATE from confirmation file content', async () => {
      const sql = 'UPDATE products SET price = 5.99 WHERE name = \'Doohickey\';';
      const content = buildQueryFileContent(config.id, config.database, sql);
      const strippedQuery = stripMetadataFromContent(content);

      const result = await driver.execute(strippedQuery);
      expect(result.error).toBeUndefined();

      const check = await driver.execute('SELECT price FROM products WHERE name = \'Doohickey\'');
      expect(check.rows[0].price).toBe('5.99');
    });

    it('should execute DELETE from confirmation file content', async () => {
      // Insert a row to delete
      await driver.execute('INSERT INTO products (name, price) VALUES (\'ToDelete\', 1.00)');
      const sql = 'DELETE FROM products WHERE name = \'ToDelete\';';
      const content = buildQueryFileContent(config.id, config.database, sql);
      const strippedQuery = stripMetadataFromContent(content);

      const result = await driver.execute(strippedQuery);
      expect(result.error).toBeUndefined();

      const check = await driver.execute('SELECT * FROM products WHERE name = \'ToDelete\'');
      expect(check.rowCount).toBe(0);
    });
  });

  describe('pin workflow (file move from tmp to queries)', () => {
    it('should move a query file from tmp to queries directory', () => {
      const sql = 'SELECT * FROM products WHERE category = \'gadgets\';';
      const content = buildQueryFileContent(config.id, config.database, sql);
      const tmpFile = path.join(TMP_DIR, 'query_pin_test.sql');
      fs.writeFileSync(tmpFile, content, 'utf-8');

      // Simulate pin: move file from tmp/ to queries/
      const pinnedFile = path.join(QUERIES_DIR, 'query_pin_test.sql');
      fs.renameSync(tmpFile, pinnedFile);

      expect(fs.existsSync(tmpFile)).toBe(false);
      expect(fs.existsSync(pinnedFile)).toBe(true);

      // Metadata should be preserved
      const metadata = parseMetadataFromFile(pinnedFile);
      expect(metadata).toEqual({
        connectionId: config.id,
        databaseName: config.database,
      });

      // Query should still be executable
      const strippedQuery = stripMetadataFromContent(fs.readFileSync(pinnedFile, 'utf-8'));
      expect(strippedQuery).toBe(sql);
    });

    it('should list pinned queries in queries directory', () => {
      // Write two pinned queries
      fs.writeFileSync(
        path.join(QUERIES_DIR, 'users_report.sql'),
        buildQueryFileContent(config.id, config.database, 'SELECT * FROM products;'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(QUERIES_DIR, 'admin_query.sql'),
        buildQueryFileContent(config.id, undefined, 'SELECT 1;'),
        'utf-8',
      );

      const queries = listSqlFiles(QUERIES_DIR);
      const names = queries.map(q => q.name).sort();
      expect(names).toContain('users_report.sql');
      expect(names).toContain('admin_query.sql');

      const usersReport = queries.find(q => q.name === 'users_report.sql')!;
      expect(usersReport.metadata?.connectionId).toBe(config.id);
      expect(usersReport.metadata?.databaseName).toBe(config.database);

      const adminQuery = queries.find(q => q.name === 'admin_query.sql')!;
      expect(adminQuery.metadata?.connectionId).toBe(config.id);
      expect(adminQuery.metadata?.databaseName).toBeUndefined();
    });
  });

  describe('rename workflow', () => {
    it('should rename a pinned query file preserving metadata', () => {
      const sql = 'SELECT COUNT(*) FROM products;';
      const content = buildQueryFileContent(config.id, config.database, sql);
      const oldPath = path.join(QUERIES_DIR, 'old_name.sql');
      fs.writeFileSync(oldPath, content, 'utf-8');

      // Simulate rename
      const newPath = path.join(QUERIES_DIR, 'product_count.sql');
      fs.renameSync(oldPath, newPath);

      expect(fs.existsSync(oldPath)).toBe(false);
      expect(fs.existsSync(newPath)).toBe(true);

      const metadata = parseMetadataFromFile(newPath);
      expect(metadata?.connectionId).toBe(config.id);

      const strippedSql = stripMetadataFromContent(fs.readFileSync(newPath, 'utf-8'));
      expect(strippedSql).toBe(sql);
    });
  });

  describe('multi-database metadata', () => {
    it('should preserve database name through file operations', () => {
      const connectionId = 'multi-db-conn';
      const databases = ['analytics', 'reporting', 'staging'];

      for (const db of databases) {
        const content = buildQueryFileContent(connectionId, db, `SELECT * FROM ${db}.data;`);
        const filePath = path.join(TMP_DIR, `query_${db}.sql`);
        fs.writeFileSync(filePath, content, 'utf-8');

        const metadata = parseMetadataFromFile(filePath);
        expect(metadata).toEqual({ connectionId, databaseName: db });
      }
    });
  });

  describe('cleanup workflow', () => {
    it('should clean up tmp directory', () => {
      // Write some tmp files
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(
          path.join(TMP_DIR, `cleanup_${i}.sql`),
          buildQueryFileContent(config.id, config.database, `SELECT ${i};`),
          'utf-8',
        );
      }

      const before = fs.readdirSync(TMP_DIR).filter(f => f.startsWith('cleanup_'));
      expect(before.length).toBe(5);

      // Simulate cleanup (like deactivate)
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
      expect(fs.existsSync(TMP_DIR)).toBe(false);

      // Pinned queries should be unaffected
      expect(fs.existsSync(QUERIES_DIR)).toBe(true);
    });
  });
});
