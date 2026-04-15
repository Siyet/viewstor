import { CompletionItem } from '../types/driver';

/**
 * Pure helpers for pgvector (https://github.com/pgvector/pgvector) support on
 * top of the PostgreSQL driver. No `vscode` or `pg` imports — unit-testable.
 */

/**
 * Format a column type string with optional pgvector dimension.
 * `udtName` is the `information_schema.columns.udt_name` value; for pgvector
 * columns it is always `vector`. `typmod` is `pg_attribute.atttypmod` — for the
 * vector type it holds the dimension directly (-1 when unspecified).
 */
export function formatVectorType(udtName: string | null | undefined, typmod: number | null | undefined): string | null {
  if (udtName !== 'vector') return null;
  if (typmod != null && Number.isFinite(typmod) && typmod >= 1) {
    return `vector(${typmod})`;
  }
  return 'vector';
}

/**
 * Completion items for pgvector distance operators and functions, injected
 * into the PG driver's completion list when the extension is detected.
 * Operators are exposed as keyword-kind so they surface in the keyword mix;
 * distance functions use function-kind so VS Code tags them with the function
 * icon.
 */
export function pgVectorCompletionItems(): CompletionItem[] {
  return [
    // Distance operators (pgvector)
    { label: '<->', kind: 'keyword', detail: 'pgvector: Euclidean (L2) distance' },
    { label: '<#>', kind: 'keyword', detail: 'pgvector: negative inner product' },
    { label: '<=>', kind: 'keyword', detail: 'pgvector: cosine distance' },
    { label: '<+>', kind: 'keyword', detail: 'pgvector: L1 (taxicab) distance' },
    // Distance / math functions
    { label: 'l2_distance', kind: 'function', detail: 'pgvector(a, b) → float8 · L2 distance' },
    { label: 'l1_distance', kind: 'function', detail: 'pgvector(a, b) → float8 · L1 distance' },
    { label: 'cosine_distance', kind: 'function', detail: 'pgvector(a, b) → float8 · cosine distance' },
    { label: 'inner_product', kind: 'function', detail: 'pgvector(a, b) → float8 · inner product' },
    { label: 'vector_dims', kind: 'function', detail: 'pgvector(v) → int · dimension count' },
    { label: 'vector_norm', kind: 'function', detail: 'pgvector(v) → float8 · Euclidean norm' },
    { label: 'l2_normalize', kind: 'function', detail: 'pgvector(v) → vector · unit-length copy' },
  ];
}
