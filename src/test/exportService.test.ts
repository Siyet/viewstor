import { describe, it, expect } from 'vitest';
import { ExportService } from '../services/exportService';
import { QueryResult } from '../types/query';

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

describe('ExportService', () => {
  describe('toCsv', () => {
    it('should produce valid CSV with headers', () => {
      const csv = ExportService.toCsv(sampleResult);
      const lines = csv.split('\n');
      expect(lines[0]).toBe('id,name,email');
      expect(lines.length).toBe(4); // header + 3 rows
    });

    it('should escape commas in values', () => {
      const csv = ExportService.toCsv(sampleResult);
      expect(csv.split('\n')[2]).toContain('"Bob, Jr."');
    });

    it('should escape double quotes in values', () => {
      const csv = ExportService.toCsv(sampleResult);
      expect(csv.split('\n')[3]).toContain('"Carol ""C"""');
    });

    it.each([
      ['semicolon delimiter', { delimiter: ';' }, (lines: string[]) => expect(lines[0]).toBe('id;name;email')],
      ['no header', { includeHeader: false }, (lines: string[]) => {
        expect(lines.length).toBe(3);
        expect(lines[0]).not.toContain('id');
      }],
    ])('supports %s', (_desc, opts, assertion) => {
      const csv = ExportService.toCsv(sampleResult, opts);
      assertion(csv.split('\n'));
    });

    it('should support custom null value', () => {
      const result: QueryResult = {
        columns: [{ name: 'val', dataType: 'text' }],
        rows: [{ val: null }],
        rowCount: 1,
        executionTimeMs: 0,
      };
      expect(ExportService.toCsv(result, { nullValue: 'N/A' })).toContain('N/A');
    });
  });

  it('toTsv uses tab delimiter', () => {
    const lines = ExportService.toTsv(sampleResult).split('\n');
    expect(lines[0]).toBe('id\tname\temail');
    expect(lines[1]).toBe('1\tAlice\talice@example.com');
  });

  it('toJson produces valid JSON array', () => {
    const parsed = JSON.parse(ExportService.toJson(sampleResult));
    expect(parsed).toHaveLength(3);
    expect(parsed[0].name).toBe('Alice');
  });

  it.each([
    ['toMarkdownTable', (r: QueryResult) => ExportService.toMarkdownTable(r), /^\|[-|]+\|$/],
    ['toPlainTextTable', (r: QueryResult) => ExportService.toPlainTextTable(r), /^-+/],
  ])('%s produces aligned table with header and separator', (_name, fn, sepPattern) => {
    const lines = fn(sampleResult).split('\n');
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('name');
    expect(lines[1]).toMatch(sepPattern);
    expect(lines.length).toBe(5); // header + separator + 3 rows
  });
});
