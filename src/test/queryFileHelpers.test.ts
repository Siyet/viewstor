import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildMetadataComment,
  parseMetadataFromLine,
  parseMetadataFromFile,
  stripMetadataFromContent,
  isUnderDir,
  buildQueryFileContent,
  listSqlFiles,
} from '../utils/queryFileHelpers';

const TEST_DIR = path.join(os.tmpdir(), `viewstor-qfh-test-${Date.now()}`);

describe('queryFileHelpers', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('buildMetadataComment', () => {
    it('should build comment with connectionId only', () => {
      const result = buildMetadataComment('conn-123');
      expect(result).toBe('-- viewstor:connectionId=conn-123');
    });

    it('should build comment with connectionId and database', () => {
      const result = buildMetadataComment('conn-456', 'mydb');
      expect(result).toBe('-- viewstor:connectionId=conn-456&database=mydb');
    });

    it('should encode special characters in connectionId', () => {
      const result = buildMetadataComment('conn&id=1');
      expect(result).toContain('-- viewstor:');
      const parsed = parseMetadataFromLine(result);
      expect(parsed?.connectionId).toBe('conn&id=1');
    });

    it('should not include database param when undefined', () => {
      const result = buildMetadataComment('conn-1', undefined);
      expect(result).not.toContain('database');
    });
  });

  describe('parseMetadataFromLine', () => {
    it('should parse connectionId from metadata line', () => {
      const result = parseMetadataFromLine('-- viewstor:connectionId=abc-123');
      expect(result).toEqual({ connectionId: 'abc-123', databaseName: undefined });
    });

    it('should parse connectionId and database', () => {
      const result = parseMetadataFromLine('-- viewstor:connectionId=abc-123&database=mydb');
      expect(result).toEqual({ connectionId: 'abc-123', databaseName: 'mydb' });
    });

    it('should return undefined for non-metadata line', () => {
      expect(parseMetadataFromLine('SELECT * FROM users')).toBeUndefined();
    });

    it('should return undefined for regular SQL comment', () => {
      expect(parseMetadataFromLine('-- This is a comment')).toBeUndefined();
    });

    it('should return undefined for empty line', () => {
      expect(parseMetadataFromLine('')).toBeUndefined();
    });

    it('should return undefined for metadata without connectionId', () => {
      expect(parseMetadataFromLine('-- viewstor:database=mydb')).toBeUndefined();
    });

    it('should roundtrip with buildMetadataComment', () => {
      const comment = buildMetadataComment('test-conn', 'testdb');
      const parsed = parseMetadataFromLine(comment);
      expect(parsed).toEqual({ connectionId: 'test-conn', databaseName: 'testdb' });
    });

    it('should roundtrip without database', () => {
      const comment = buildMetadataComment('test-conn');
      const parsed = parseMetadataFromLine(comment);
      expect(parsed).toEqual({ connectionId: 'test-conn', databaseName: undefined });
    });
  });

  describe('parseMetadataFromFile', () => {
    it('should parse metadata from a file with metadata header', () => {
      const filePath = path.join(TEST_DIR, 'query.sql');
      const content = buildMetadataComment('file-conn', 'filedb') + '\nSELECT 1;\n';
      fs.writeFileSync(filePath, content, 'utf-8');

      const result = parseMetadataFromFile(filePath);
      expect(result).toEqual({ connectionId: 'file-conn', databaseName: 'filedb' });
    });

    it('should return undefined for file without metadata', () => {
      const filePath = path.join(TEST_DIR, 'plain.sql');
      fs.writeFileSync(filePath, 'SELECT * FROM users;\n', 'utf-8');

      expect(parseMetadataFromFile(filePath)).toBeUndefined();
    });

    it('should return undefined for nonexistent file', () => {
      expect(parseMetadataFromFile(path.join(TEST_DIR, 'nope.sql'))).toBeUndefined();
    });

    it('should handle file with only metadata (no query)', () => {
      const filePath = path.join(TEST_DIR, 'empty.sql');
      fs.writeFileSync(filePath, buildMetadataComment('x') + '\n', 'utf-8');

      const result = parseMetadataFromFile(filePath);
      expect(result).toEqual({ connectionId: 'x', databaseName: undefined });
    });
  });

  describe('stripMetadataFromContent', () => {
    it('should strip metadata line and return query', () => {
      const content = '-- viewstor:connectionId=abc\nSELECT * FROM users;';
      expect(stripMetadataFromContent(content)).toBe('SELECT * FROM users;');
    });

    it('should return content as-is if no metadata', () => {
      const content = 'SELECT * FROM users;';
      expect(stripMetadataFromContent(content)).toBe('SELECT * FROM users;');
    });

    it('should handle metadata-only content (no newline)', () => {
      expect(stripMetadataFromContent('-- viewstor:connectionId=abc')).toBe('');
    });

    it('should handle metadata with empty query after newline', () => {
      expect(stripMetadataFromContent('-- viewstor:connectionId=abc\n')).toBe('');
    });

    it('should preserve multiline query after metadata', () => {
      const content = '-- viewstor:connectionId=abc\nSELECT *\nFROM users\nWHERE id = 1;';
      expect(stripMetadataFromContent(content)).toBe('SELECT *\nFROM users\nWHERE id = 1;');
    });

    it('should not strip non-viewstor comments', () => {
      const content = '-- regular comment\nSELECT 1;';
      expect(stripMetadataFromContent(content)).toBe(content);
    });
  });

  describe('isUnderDir', () => {
    it('should return true for file under directory', () => {
      expect(isUnderDir('/home/user/.viewstor/tmp/query.sql', '/home/user/.viewstor/tmp')).toBe(true);
    });

    it('should return false for file outside directory', () => {
      expect(isUnderDir('/home/user/other/file.sql', '/home/user/.viewstor/tmp')).toBe(false);
    });

    it('should handle Windows paths with backslashes', () => {
      expect(isUnderDir('C:\\Users\\user\\.viewstor\\tmp\\q.sql', 'C:\\Users\\user\\.viewstor\\tmp')).toBe(true);
    });

    it('should handle mixed slashes', () => {
      expect(isUnderDir('C:\\Users\\user/.viewstor/tmp/q.sql', 'C:\\Users\\user\\.viewstor\\tmp')).toBe(true);
    });

    it('should not match partial directory names', () => {
      expect(isUnderDir('/home/user/.viewstor/tmp2/q.sql', '/home/user/.viewstor/tmp')).toBe(false);
    });
  });

  describe('buildQueryFileContent', () => {
    it('should combine metadata and SQL', () => {
      const content = buildQueryFileContent('conn-1', 'db1', 'SELECT 1;');
      expect(content).toBe('-- viewstor:connectionId=conn-1&database=db1\nSELECT 1;');
    });

    it('should work without database', () => {
      const content = buildQueryFileContent('conn-1', undefined, 'SELECT 1;');
      expect(content).toBe('-- viewstor:connectionId=conn-1\nSELECT 1;');
    });

    it('content should roundtrip through strip', () => {
      const sql = 'SELECT * FROM users WHERE id = 1;';
      const content = buildQueryFileContent('c1', 'db', sql);
      expect(stripMetadataFromContent(content)).toBe(sql);
    });
  });

  describe('listSqlFiles', () => {
    it('should list .sql files with metadata', () => {
      const content1 = buildMetadataComment('conn-1', 'db1') + '\nSELECT 1;';
      const content2 = buildMetadataComment('conn-2') + '\nSELECT 2;';
      fs.writeFileSync(path.join(TEST_DIR, 'a.sql'), content1, 'utf-8');
      fs.writeFileSync(path.join(TEST_DIR, 'b.sql'), content2, 'utf-8');
      fs.writeFileSync(path.join(TEST_DIR, 'readme.txt'), 'not sql', 'utf-8');

      const result = listSqlFiles(TEST_DIR);
      expect(result).toHaveLength(2);

      const names = result.map(r => r.name).sort();
      expect(names).toEqual(['a.sql', 'b.sql']);

      const a = result.find(r => r.name === 'a.sql')!;
      expect(a.metadata).toEqual({ connectionId: 'conn-1', databaseName: 'db1' });

      const b = result.find(r => r.name === 'b.sql')!;
      expect(b.metadata).toEqual({ connectionId: 'conn-2', databaseName: undefined });
    });

    it('should return empty array for nonexistent directory', () => {
      expect(listSqlFiles(path.join(TEST_DIR, 'nope'))).toEqual([]);
    });

    it('should return empty array for directory with no .sql files', () => {
      fs.writeFileSync(path.join(TEST_DIR, 'data.json'), '{}', 'utf-8');
      expect(listSqlFiles(TEST_DIR)).toEqual([]);
    });

    it('should handle files without metadata', () => {
      fs.writeFileSync(path.join(TEST_DIR, 'plain.sql'), 'SELECT 1;', 'utf-8');
      const result = listSqlFiles(TEST_DIR);
      expect(result).toHaveLength(1);
      expect(result[0].metadata).toBeUndefined();
    });
  });
});
