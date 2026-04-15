import { describe, it, expect } from 'vitest';
import { formatVectorType, pgVectorCompletionItems } from '../drivers/pgvector';

describe('formatVectorType', () => {
  it('returns null for non-vector types', () => {
    expect(formatVectorType('int4', 1536)).toBeNull();
    expect(formatVectorType('text', 100)).toBeNull();
    expect(formatVectorType('', 10)).toBeNull();
    expect(formatVectorType(null, 10)).toBeNull();
    expect(formatVectorType(undefined, 10)).toBeNull();
  });

  it('includes the dimension when typmod is a positive integer', () => {
    expect(formatVectorType('vector', 1536)).toBe('vector(1536)');
    expect(formatVectorType('vector', 1)).toBe('vector(1)');
    expect(formatVectorType('vector', 3)).toBe('vector(3)');
  });

  it('falls back to bare "vector" when typmod is unspecified (-1 or null)', () => {
    expect(formatVectorType('vector', -1)).toBe('vector');
    expect(formatVectorType('vector', 0)).toBe('vector');
    expect(formatVectorType('vector', null)).toBe('vector');
    expect(formatVectorType('vector', undefined)).toBe('vector');
    expect(formatVectorType('vector', NaN)).toBe('vector');
  });
});

describe('pgVectorCompletionItems', () => {
  const items = pgVectorCompletionItems();

  it('includes the four distance operators as keyword-kind items', () => {
    const operators = items.filter(i => i.kind === 'keyword').map(i => i.label);
    expect(operators).toEqual(expect.arrayContaining(['<->', '<#>', '<=>', '<+>']));
  });

  it('includes the core distance and math functions', () => {
    const functions = items.filter(i => i.kind === 'function').map(i => i.label);
    expect(functions).toEqual(expect.arrayContaining([
      'l2_distance',
      'l1_distance',
      'cosine_distance',
      'inner_product',
      'vector_dims',
      'vector_norm',
      'l2_normalize',
    ]));
  });

  it('tags every item with a descriptive detail string', () => {
    for (const item of items) {
      expect(item.detail).toBeTruthy();
      expect(item.detail).toMatch(/pgvector/i);
    }
  });

  it('only returns keyword- or function-kind items', () => {
    for (const item of items) {
      expect(['keyword', 'function']).toContain(item.kind);
    }
  });
});
