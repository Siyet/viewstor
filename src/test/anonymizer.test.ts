import { describe, it, expect } from 'vitest';
import {
  anonymizeRows,
  anonymizeQueryResult,
  hashValue,
  isSensitiveColumnName,
  luhn,
  maskCell,
  pickMaskedColumns,
  resolveAnonymizationPolicy,
  scrubErrorMessage,
  shapeMask,
  AnonymizationPolicy,
} from '../mcp/anonymizer';
import { QueryColumn } from '../types/query';
import { ConnectionFolder } from '../types/connection';

// --- column-name heuristics ---

describe('isSensitiveColumnName', () => {
  it('matches common PII column names', () => {
    expect(isSensitiveColumnName('email')).toBe(true);
    expect(isSensitiveColumnName('Email')).toBe(true);
    expect(isSensitiveColumnName('user_email')).toBe(true);
    expect(isSensitiveColumnName('phone')).toBe(true);
    expect(isSensitiveColumnName('telephone')).toBe(true);
    expect(isSensitiveColumnName('mobile')).toBe(true);
    expect(isSensitiveColumnName('ssn')).toBe(true);
    expect(isSensitiveColumnName('passport')).toBe(true);
    expect(isSensitiveColumnName('password')).toBe(true);
    expect(isSensitiveColumnName('iban')).toBe(true);
    expect(isSensitiveColumnName('credit_card')).toBe(true);
    expect(isSensitiveColumnName('cvv')).toBe(true);
    expect(isSensitiveColumnName('token')).toBe(true);
    expect(isSensitiveColumnName('api_key')).toBe(true);
    expect(isSensitiveColumnName('first_name')).toBe(true);
    expect(isSensitiveColumnName('last_name')).toBe(true);
    expect(isSensitiveColumnName('dob')).toBe(true);
    expect(isSensitiveColumnName('birthday')).toBe(true);
  });

  it('ignores unrelated names that share substrings', () => {
    expect(isSensitiveColumnName('emaciated')).toBe(false);
    expect(isSensitiveColumnName('teller')).toBe(false);
    expect(isSensitiveColumnName('id')).toBe(false);
    expect(isSensitiveColumnName('created_at')).toBe(false);
    expect(isSensitiveColumnName('amount')).toBe(false);
  });
});

// --- hashValue ---

describe('hashValue', () => {
  it('produces 8-char hex digests', () => {
    const h = hashValue('alice@example.com');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic (JOIN safety)', () => {
    expect(hashValue('abc')).toBe(hashValue('abc'));
    expect(hashValue(42)).toBe(hashValue(42));
    expect(hashValue({ k: 1 })).toBe(hashValue({ k: 1 }));
  });

  it('differs for different inputs', () => {
    expect(hashValue('abc')).not.toBe(hashValue('abd'));
  });
});

// --- shapeMask ---

describe('shapeMask', () => {
  it('masks email with column hint', () => {
    const col: QueryColumn = { name: 'email', dataType: 'text' };
    expect(shapeMask('alice@example.com', col)).toBe('x@y.xxx');
  });

  it('masks phone with column hint', () => {
    const col: QueryColumn = { name: 'phone', dataType: 'text' };
    expect(shapeMask('+1 415-555-1212', col)).toBe('+0 000-000-0000');
  });

  it('detects email by content when no column hint', () => {
    expect(shapeMask('bob@corp.io')).toBe('x@y.xx');
  });

  it('detects credit card by Luhn', () => {
    // Valid test Visa number
    expect(shapeMask('4532015112830366')).toBe('xxxxxxxxxxxxxxxx');
  });

  it('generic alphanumerics become x, separators preserved', () => {
    expect(shapeMask('Hello, World! 123')).toBe('xxxxx, xxxxx! xxx');
  });

  it('non-string falls back to hash', () => {
    const result = shapeMask(42);
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });

  it('masks email that does not match strict pattern', () => {
    // e.g. `foo@bar` (no TLD)
    expect(shapeMask('foo@bar', { name: 'email', dataType: 'text' })).toBe('xxx@xxx');
  });
});

// --- luhn ---

describe('luhn', () => {
  it('accepts known-good card numbers', () => {
    expect(luhn('4532015112830366')).toBe(true); // Visa test
    expect(luhn('5425233430109903')).toBe(true); // MC test
    expect(luhn('371449635398431')).toBe(true); // Amex test
  });

  it('rejects random digit strings', () => {
    expect(luhn('1234567890123456')).toBe(false);
  });

  it('rejects non-digit input', () => {
    expect(luhn('4532-0151-1283-0366')).toBe(false);
  });
});

// --- maskCell ---

describe('maskCell', () => {
  const col: QueryColumn = { name: 'email', dataType: 'text' };

  it('preserves null/undefined', () => {
    expect(maskCell(null, col, 'hash')).toBeNull();
    expect(maskCell(undefined, col, 'hash')).toBeUndefined();
  });

  it('null strategy returns null', () => {
    expect(maskCell('alice@example.com', col, 'null')).toBeNull();
  });

  it('redacted strategy returns empty string', () => {
    expect(maskCell('alice@example.com', col, 'redacted')).toBe('');
  });

  it('hash strategy returns hex digest', () => {
    expect(maskCell('alice@example.com', col, 'hash')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('shape strategy preserves format', () => {
    expect(maskCell('alice@example.com', col, 'shape')).toBe('x@y.xxx');
  });
});

// --- pickMaskedColumns ---

describe('pickMaskedColumns', () => {
  const columns: QueryColumn[] = [
    { name: 'id', dataType: 'integer' },
    { name: 'email', dataType: 'text' },
    { name: 'bio', dataType: 'text' },
    { name: 'created_at', dataType: 'timestamp' },
  ];

  it('off picks nothing', () => {
    expect(pickMaskedColumns(columns, { mode: 'off', strategy: 'hash' })).toEqual([]);
  });

  it('heuristic picks by name', () => {
    const picked = pickMaskedColumns(columns, { mode: 'heuristic', strategy: 'hash' });
    expect(picked.map(c => c.name)).toEqual(['email']);
  });

  it('strict picks all text-like columns regardless of name', () => {
    const picked = pickMaskedColumns(columns, { mode: 'strict', strategy: 'hash' });
    expect(picked.map(c => c.name).sort()).toEqual(['bio', 'email']);
  });

  it('strict handles parameterized varchar types', () => {
    const cols: QueryColumn[] = [
      { name: 'id', dataType: 'integer' },
      { name: 'username', dataType: 'varchar(64)' },
      { name: 'title', dataType: 'character varying(255)' },
    ];
    const picked = pickMaskedColumns(cols, { mode: 'strict', strategy: 'hash' });
    expect(picked.map(c => c.name).sort()).toEqual(['title', 'username']);
  });

  it('strict treats unknown types as sensitive', () => {
    const cols: QueryColumn[] = [
      { name: 'a', dataType: '' },
    ];
    const picked = pickMaskedColumns(cols, { mode: 'strict', strategy: 'hash' });
    expect(picked.map(c => c.name)).toEqual(['a']);
  });
});

// --- anonymizeRows ---

describe('anonymizeRows', () => {
  const columns: QueryColumn[] = [
    { name: 'id', dataType: 'integer' },
    { name: 'email', dataType: 'text' },
    { name: 'name', dataType: 'text' },
  ];

  it('off returns the same array reference (zero alloc)', () => {
    const rows = [{ id: 1, email: 'a@b.c', name: 'Alice' }];
    const result = anonymizeRows(columns, rows, { mode: 'off', strategy: 'hash' });
    expect(result).toBe(rows);
  });

  it('heuristic masks only sensitive columns', () => {
    const rows = [
      { id: 1, email: 'a@b.c', name: 'Alice' },
      { id: 2, email: 'c@d.e', name: 'Bob' },
    ];
    const result = anonymizeRows(columns, rows, { mode: 'heuristic', strategy: 'redacted' });
    expect(result[0]).toEqual({ id: 1, email: '', name: 'Alice' });
    expect(result[1]).toEqual({ id: 2, email: '', name: 'Bob' });
  });

  it('hash is stable across calls (JOIN safety)', () => {
    const rows1 = [{ id: 1, email: 'alice@example.com', name: 'Alice' }];
    const rows2 = [{ id: 9, email: 'alice@example.com', name: 'Other' }];
    const a = anonymizeRows(columns, rows1, { mode: 'heuristic', strategy: 'hash' });
    const b = anonymizeRows(columns, rows2, { mode: 'heuristic', strategy: 'hash' });
    expect(a[0].email).toBe(b[0].email);
  });

  it('does not mutate input rows', () => {
    const rows = [{ id: 1, email: 'a@b.c', name: 'Alice' }];
    anonymizeRows(columns, rows, { mode: 'heuristic', strategy: 'redacted' });
    expect(rows[0].email).toBe('a@b.c');
  });

  it('empty inputs short-circuit', () => {
    expect(anonymizeRows([], [], { mode: 'strict', strategy: 'hash' })).toEqual([]);
    expect(anonymizeRows(columns, [], { mode: 'strict', strategy: 'hash' })).toEqual([]);
  });

  it('strict masks all text columns', () => {
    const rows = [{ id: 1, email: 'a@b.c', name: 'Alice' }];
    const result = anonymizeRows(columns, rows, { mode: 'strict', strategy: 'redacted' });
    expect(result[0]).toEqual({ id: 1, email: '', name: '' });
  });

  it('preserves nulls under all strategies', () => {
    const rows = [{ id: 1, email: null, name: null }];
    for (const strategy of ['hash', 'shape', 'null', 'redacted'] as const) {
      const result = anonymizeRows(columns, rows, { mode: 'strict', strategy });
      expect(result[0].email).toBeNull();
      expect(result[0].name).toBeNull();
    }
  });
});

// --- anonymizeQueryResult ---

describe('anonymizeQueryResult', () => {
  it('wraps anonymizeRows and returns columns untouched', () => {
    const columns: QueryColumn[] = [
      { name: 'id', dataType: 'integer' },
      { name: 'email', dataType: 'text' },
    ];
    const rows = [{ id: 1, email: 'a@b.c' }];
    const result = anonymizeQueryResult(columns, rows, { mode: 'heuristic', strategy: 'redacted' });
    expect(result.columns).toBe(columns);
    expect(result.rows[0]).toEqual({ id: 1, email: '' });
  });
});

// --- resolveAnonymizationPolicy ---

describe('resolveAnonymizationPolicy', () => {
  it('uses connection-level fields when present', () => {
    const policy = resolveAnonymizationPolicy(
      { agentAnonymization: 'strict', agentAnonymizationStrategy: 'shape', folderId: undefined },
      () => undefined,
    );
    expect(policy).toEqual({ mode: 'strict', strategy: 'shape' });
  });

  it('defaults to off/hash when nothing is set', () => {
    const policy = resolveAnonymizationPolicy(
      { agentAnonymization: undefined, agentAnonymizationStrategy: undefined, folderId: undefined },
      () => undefined,
    );
    expect(policy).toEqual({ mode: 'off', strategy: 'hash' });
  });

  it('inherits from folder when connection is blank', () => {
    const folder: ConnectionFolder = {
      id: 'f1',
      name: 'Prod',
      sortOrder: 0,
      agentAnonymization: 'strict',
      agentAnonymizationStrategy: 'redacted',
    };
    const policy = resolveAnonymizationPolicy(
      { agentAnonymization: undefined, agentAnonymizationStrategy: undefined, folderId: 'f1' },
      id => (id === 'f1' ? folder : undefined),
    );
    expect(policy).toEqual({ mode: 'strict', strategy: 'redacted' });
  });

  it('walks up nested folders', () => {
    const parent: ConnectionFolder = {
      id: 'f-parent',
      name: 'Global',
      sortOrder: 0,
      agentAnonymization: 'heuristic',
      agentAnonymizationStrategy: 'hash',
    };
    const child: ConnectionFolder = {
      id: 'f-child',
      name: 'Team',
      sortOrder: 1,
      parentFolderId: 'f-parent',
    };
    const policy = resolveAnonymizationPolicy(
      { agentAnonymization: undefined, agentAnonymizationStrategy: undefined, folderId: 'f-child' },
      id => ({ 'f-parent': parent, 'f-child': child } as Record<string, ConnectionFolder>)[id],
    );
    expect(policy).toEqual({ mode: 'heuristic', strategy: 'hash' });
  });

  it('connection override wins over folder', () => {
    const folder: ConnectionFolder = {
      id: 'f1',
      name: 'Prod',
      sortOrder: 0,
      agentAnonymization: 'strict',
      agentAnonymizationStrategy: 'redacted',
    };
    const policy = resolveAnonymizationPolicy(
      { agentAnonymization: 'off', agentAnonymizationStrategy: 'hash', folderId: 'f1' },
      () => folder,
    );
    expect(policy).toEqual({ mode: 'off', strategy: 'hash' });
  });

  it('guards against folder cycles', () => {
    const a: ConnectionFolder = { id: 'a', name: 'A', sortOrder: 0, parentFolderId: 'b' };
    const b: ConnectionFolder = { id: 'b', name: 'B', sortOrder: 1, parentFolderId: 'a' };
    const policy = resolveAnonymizationPolicy(
      { agentAnonymization: undefined, agentAnonymizationStrategy: undefined, folderId: 'a' },
      id => ({ a, b } as Record<string, ConnectionFolder>)[id],
    );
    // Neither folder sets anonymization → defaults apply, no infinite loop.
    expect(policy).toEqual({ mode: 'off', strategy: 'hash' });
  });
});

// --- scrubErrorMessage ---

describe('scrubErrorMessage', () => {
  const policy: AnonymizationPolicy = { mode: 'heuristic', strategy: 'hash' };

  it('passes through when mode is off', () => {
    const msg = 'duplicate key (alice@example.com) violates unique constraint';
    expect(scrubErrorMessage(msg, { mode: 'off', strategy: 'hash' })).toBe(msg);
  });

  it('redacts emails', () => {
    expect(scrubErrorMessage('duplicate (alice@example.com) value', policy))
      .toBe('duplicate ([redacted-email]) value');
  });

  it('redacts Luhn-valid card digit runs', () => {
    expect(scrubErrorMessage('value 4532015112830366 rejected', policy))
      .toBe('value [redacted-card] rejected');
  });

  it('leaves non-Luhn digit runs alone', () => {
    expect(scrubErrorMessage('row 1234567890123456 failed', policy))
      .toBe('row 1234567890123456 failed');
  });

  it('handles empty/blank messages', () => {
    expect(scrubErrorMessage('', policy)).toBe('');
  });

  it('redacts multiple emails in the same message', () => {
    expect(scrubErrorMessage('conflict between alice@example.com and bob@corp.io', policy))
      .toBe('conflict between [redacted-email] and [redacted-email]');
  });

  it('redacts a Luhn-valid card even when a non-Luhn digit run comes first', () => {
    // Regression: CARD_DIGIT_REGEX needs the /g flag so the Luhn check runs on
    // every 13-19 digit run, not just the first one.
    expect(scrubErrorMessage('row 1234567890123456 and card 4532015112830366 rejected', policy))
      .toBe('row 1234567890123456 and card [redacted-card] rejected');
  });
});
