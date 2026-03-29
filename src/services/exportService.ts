import { QueryResult } from '../types/query';

export interface CsvOptions {
  delimiter?: string;
  quoteChar?: string;
  includeHeader?: boolean;
  nullValue?: string;
  lineEnding?: '\n' | '\r\n';
}

export class ExportService {
  static toCsv(result: QueryResult, opts: CsvOptions = {}): string {
    const delim = opts.delimiter ?? ',';
    const quote = opts.quoteChar ?? '"';
    const includeHeader = opts.includeHeader ?? true;
    const nullVal = opts.nullValue ?? '';
    const eol = opts.lineEnding ?? '\n';

    function escapeField(val: string): string {
      if (val.includes(delim) || val.includes(quote) || val.includes('\n') || val.includes('\r')) {
        return quote + val.replace(new RegExp(escapeRegex(quote), 'g'), quote + quote) + quote;
      }
      return val;
    }

    const lines: string[] = [];
    if (includeHeader) {
      lines.push(result.columns.map(c => escapeField(c.name)).join(delim));
    }
    for (const row of result.rows) {
      lines.push(result.columns.map(c => {
        const v = row[c.name];
        if (v === null || v === undefined) return escapeField(nullVal);
        if (typeof v === 'object') return escapeField(JSON.stringify(v));
        return escapeField(String(v));
      }).join(delim));
    }
    return lines.join(eol);
  }

  static toTsv(result: QueryResult, opts: Omit<CsvOptions, 'delimiter'> = {}): string {
    return ExportService.toCsv(result, { ...opts, delimiter: '\t' });
  }

  static toJson(result: QueryResult): string {
    return JSON.stringify(result.rows, null, 2);
  }

  static toMarkdownTable(result: QueryResult): string {
    if (result.columns.length === 0) return '';

    // Calculate column widths
    const widths = result.columns.map(c => c.name.length);
    for (const row of result.rows) {
      result.columns.forEach((c, i) => {
        const v = row[c.name];
        const len = v === null || v === undefined ? 4 : (typeof v === 'object' ? JSON.stringify(v).length : String(v).length);
        widths[i] = Math.max(widths[i], len);
      });
    }

    function pad(str: string, width: number): string {
      return str + ' '.repeat(Math.max(0, width - str.length));
    }

    const header = '| ' + result.columns.map((c, i) => pad(c.name, widths[i])).join(' | ') + ' |';
    const separator = '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|';
    const rows = result.rows.map(row => {
      return '| ' + result.columns.map((c, i) => {
        const v = row[c.name];
        let str: string;
        if (v === null || v === undefined) str = 'NULL';
        else if (typeof v === 'object') str = JSON.stringify(v);
        else str = String(v);
        return pad(str, widths[i]);
      }).join(' | ') + ' |';
    });

    return [header, separator, ...rows].join('\n');
  }

  static toPlainTextTable(result: QueryResult): string {
    if (result.columns.length === 0) return '';

    const widths = result.columns.map(c => c.name.length);
    for (const row of result.rows) {
      result.columns.forEach((c, i) => {
        const v = row[c.name];
        const len = v === null || v === undefined ? 4 : (typeof v === 'object' ? JSON.stringify(v).length : String(v).length);
        widths[i] = Math.max(widths[i], len);
      });
    }

    function pad(str: string, width: number): string {
      return str + ' '.repeat(Math.max(0, width - str.length));
    }

    const header = result.columns.map((c, i) => pad(c.name, widths[i])).join('  ');
    const separator = widths.map(w => '-'.repeat(w)).join('  ');
    const rows = result.rows.map(row => {
      return result.columns.map((c, i) => {
        const v = row[c.name];
        let str: string;
        if (v === null || v === undefined) str = 'NULL';
        else if (typeof v === 'object') str = JSON.stringify(v);
        else str = String(v);
        return pad(str, widths[i]);
      }).join('  ');
    });

    return [header, separator, ...rows].join('\n');
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
