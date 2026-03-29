import { describe, it, expect } from 'vitest';
import { ExportService } from '../services/exportService';
import { QueryResult } from '../types/query';

describe('ExportService', () => {
  const sampleResult: QueryResult = {
    columns: [
      { name: 'id', dataType: 'integer' },
      { name: 'name', dataType: 'text' },
      { name: 'email', dataType: 'text' },
    ],
    rows: [
      { id: 1, name: 'Alice', email: 'alice@example.com' },
      { id: 2, name: 'Bob, Jr.', email: 'bob@example.com' },
      { id: 3, name: 'Carol "C"', email: 'carol@example.com' },
    ],
    rowCount: 3,
    executionTimeMs: 42,
  };

  describe('toCsv', () => {
    it('should produce valid CSV with headers', () => {
      const csv = ExportService.toCsv(sampleResult);
      const lines = csv.split('\n');
      expect(lines[0]).toBe('id,name,email');
      expect(lines.length).toBe(4); // header + 3 rows
    });

    it('should escape commas in values', () => {
      const csv = ExportService.toCsv(sampleResult);
      const lines = csv.split('\n');
      expect(lines[2]).toContain('"Bob, Jr."');
    });

    it('should escape double quotes in values', () => {
      const csv = ExportService.toCsv(sampleResult);
      const lines = csv.split('\n');
      expect(lines[3]).toContain('"Carol ""C"""');
    });
  });

  describe('toTsv', () => {
    it('should use tab delimiter', () => {
      const tsv = ExportService.toTsv(sampleResult);
      const lines = tsv.split('\n');
      expect(lines[0]).toBe('id\tname\temail');
      expect(lines[1]).toBe('1\tAlice\talice@example.com');
    });
  });

  describe('toCsv with options', () => {
    it('should support semicolon delimiter', () => {
      const csv = ExportService.toCsv(sampleResult, { delimiter: ';' });
      const lines = csv.split('\n');
      expect(lines[0]).toBe('id;name;email');
    });

    it('should support no header', () => {
      const csv = ExportService.toCsv(sampleResult, { includeHeader: false });
      const lines = csv.split('\n');
      expect(lines.length).toBe(3);
      expect(lines[0]).not.toContain('id');
    });

    it('should support custom null value', () => {
      const result: QueryResult = {
        columns: [{ name: 'val', dataType: 'text' }],
        rows: [{ val: null }],
        rowCount: 1,
        executionTimeMs: 0,
      };
      const csv = ExportService.toCsv(result, { nullValue: 'N/A' });
      expect(csv).toContain('N/A');
    });
  });

  describe('toJson', () => {
    it('should produce valid JSON array', () => {
      const json = ExportService.toJson(sampleResult);
      const parsed = JSON.parse(json);
      expect(parsed).toHaveLength(3);
      expect(parsed[0].name).toBe('Alice');
    });
  });

  describe('toMarkdownTable', () => {
    it('should produce markdown table with header and separator', () => {
      const md = ExportService.toMarkdownTable(sampleResult);
      const lines = md.split('\n');
      expect(lines[0]).toContain('| id');
      expect(lines[0]).toContain('name');
      expect(lines[1]).toMatch(/^\|[-|]+\|$/);
      expect(lines.length).toBe(5); // header + separator + 3 rows
    });
  });

  describe('toPlainTextTable', () => {
    it('should produce aligned text table', () => {
      const text = ExportService.toPlainTextTable(sampleResult);
      const lines = text.split('\n');
      expect(lines[0]).toContain('id');
      expect(lines[0]).toContain('name');
      expect(lines[1]).toMatch(/^-+/);
      expect(lines.length).toBe(5); // header + separator + 3 rows
    });
  });
});
