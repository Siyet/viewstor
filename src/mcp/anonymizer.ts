/**
 * Anonymizer — best-effort PII masking at the MCP boundary.
 *
 * Runs after drivers return rows, before the MCP response is serialized, so
 * drivers stay agnostic and any new tool picks the filter up as long as it
 * pipes rows through {@link anonymizeRows}.
 *
 * Pure, vscode-independent, fully unit-tested. Covers issue #72.
 */
import * as crypto from 'crypto';
import { QueryColumn } from '../types/query';
import { ConnectionConfig, ConnectionFolder } from '../types/connection';

/** Policy mode: how aggressively to mask. */
export type AgentAnonymizationMode = 'off' | 'heuristic' | 'strict';

/** Transformation applied to masked cells. */
export type AgentAnonymizationStrategy = 'hash' | 'shape' | 'null' | 'redacted';

/** Resolved policy after folder inheritance. */
export interface AnonymizationPolicy {
  mode: AgentAnonymizationMode;
  strategy: AgentAnonymizationStrategy;
}

/**
 * Column-name patterns flagged as sensitive in heuristic mode.
 *
 * Matching is case-insensitive. Names are normalized (underscores / hyphens →
 * spaces) before matching, so `email` / `Email` / `user_email` / `user-email`
 * all match `\bemail\b`, while `emaciated` does not.
 */
export const DEFAULT_SENSITIVE_COLUMN_PATTERNS: RegExp[] = [
  /\bemail\b/i,
  /\be ?mail\b/i,
  /\bphone\b/i,
  /\btel(ephone)?\b/i,
  /\bmobile\b/i,
  /\bssn\b/i,
  /\bpassport\b/i,
  /\bpassword\b/i,
  /\biban\b/i,
  /\bcard\b/i,
  /\bcvv\b/i,
  /\btoken\b/i,
  /\bsecret\b/i,
  /\bapi ?key\b/i,
  /\bauth\b/i,
  /\baddr(ess)?\b/i,
  /\bfirst ?name\b/i,
  /\blast ?name\b/i,
  /\bfull ?name\b/i,
  /\bdob\b/i,
  /\bbirth(day|date)?\b/i,
];

/** Database types that strict mode masks regardless of column name. */
const STRICT_MODE_SENSITIVE_TYPES = new Set([
  'text',
  'character varying',
  'varchar',
  'char',
  'character',
  'citext',
  'json',
  'jsonb',
  'bytea',
  'blob',
  'nvarchar',
  'nchar',
  'string',
  'longtext',
  'mediumtext',
  'tinytext',
]);

const EMAIL_REGEX = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_REGEX = /(\+?\d[\d\s\-()]{6,})/;
/**
 * Digit run of 13-19 — widest plausible card range before Luhn. Global flag
 * is load-bearing: `String.replace(regex, fn)` without `/g` replaces only the
 * first match, so a non-Luhn digit run earlier in the message would shadow a
 * later real card number and leak it unchanged.
 */
const CARD_DIGIT_REGEX = /\d{13,19}/g;

/**
 * Resolve the effective anonymization policy for a connection, applying folder
 * inheritance with a cycle guard (matches the `readonly` / `color` lookup
 * pattern).
 */
export function resolveAnonymizationPolicy(
  connection: Pick<ConnectionConfig, 'agentAnonymization' | 'agentAnonymizationStrategy' | 'folderId'>,
  getFolder: (id: string) => ConnectionFolder | undefined,
): AnonymizationPolicy {
  let mode = connection.agentAnonymization;
  let strategy = connection.agentAnonymizationStrategy;

  if ((mode === undefined || strategy === undefined) && connection.folderId) {
    const seen = new Set<string>();
    let current: string | undefined = connection.folderId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const folder = getFolder(current);
      if (!folder) break;
      if (mode === undefined && folder.agentAnonymization !== undefined) mode = folder.agentAnonymization;
      if (strategy === undefined && folder.agentAnonymizationStrategy !== undefined) {
        strategy = folder.agentAnonymizationStrategy;
      }
      if (mode !== undefined && strategy !== undefined) break;
      current = folder.parentFolderId;
    }
  }

  return {
    mode: mode ?? 'off',
    strategy: strategy ?? 'hash',
  };
}

/**
 * Apply the policy to a batch of rows. Returns a new array of rows when any
 * column is masked; passes the original reference through when nothing needs
 * to change (important for `off` / no-op cases — zero allocation on the hot
 * path).
 */
export function anonymizeRows(
  columns: QueryColumn[],
  rows: Record<string, unknown>[],
  policy: AnonymizationPolicy,
): Record<string, unknown>[] {
  if (policy.mode === 'off' || rows.length === 0 || columns.length === 0) return rows;

  const maskedColumns = pickMaskedColumns(columns, policy);
  if (maskedColumns.length === 0) return rows;

  return rows.map(row => {
    const out = { ...row };
    for (const col of maskedColumns) {
      out[col.name] = maskCell(out[col.name], col, policy.strategy);
    }
    return out;
  });
}

/**
 * Decide which columns to mask for the given policy.
 *
 * Exposed for tests — callers normally go through {@link anonymizeRows}.
 */
export function pickMaskedColumns(
  columns: QueryColumn[],
  policy: AnonymizationPolicy,
): QueryColumn[] {
  if (policy.mode === 'off') return [];
  if (policy.mode === 'strict') return columns.filter(isStrictTextColumn);
  // heuristic: match column names against patterns
  return columns.filter(col => isSensitiveColumnName(col.name));
}

/** Returns true if `name` matches any known sensitive column-name pattern. */
export function isSensitiveColumnName(name: string): boolean {
  const normalized = name.replace(/[_-]+/g, ' ');
  return DEFAULT_SENSITIVE_COLUMN_PATTERNS.some(re => re.test(normalized));
}

function isStrictTextColumn(col: QueryColumn): boolean {
  const t = (col.dataType || '').toLowerCase().trim();
  if (!t) return true; // unknown type → treat as sensitive under strict
  // Match the raw base type (PG reports "character varying", CH reports "String", etc.)
  if (STRICT_MODE_SENSITIVE_TYPES.has(t)) return true;
  // Also catch parameterized text types: `varchar(255)`, `character varying(32)`, etc.
  const base = t.replace(/\s*\(.*\)\s*$/, '');
  return STRICT_MODE_SENSITIVE_TYPES.has(base);
}

/** Apply the strategy to a single cell. Exposed for tests. */
export function maskCell(
  value: unknown,
  column: QueryColumn,
  strategy: AgentAnonymizationStrategy,
): unknown {
  if (value === null || value === undefined) return value;
  switch (strategy) {
    case 'null':
      return null;
    case 'redacted':
      return '';
    case 'hash':
      return hashValue(value);
    case 'shape':
      return shapeMask(value, column);
  }
}

/**
 * Deterministic SHA-256 truncated to 8 hex chars — stable across calls so
 * JOINs on masked keys still work for the agent. Non-string values are
 * stringified via JSON so complex cells (arrays, objects) still hash.
 */
export function hashValue(value: unknown): string {
  const str = typeof value === 'string' ? value : safeStringify(value);
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 8);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Shape-preserving mask: tries to keep the visual format of the value so
 * formatting-sensitive downstream code (e.g. a chart axis label) doesn't
 * fall over. Emails become `x@y.z`, phones become `+0 000-00-00`, credit
 * cards become all-x, anything else becomes `x` per character preserving
 * non-alphanumeric separators.
 */
export function shapeMask(value: unknown, column?: QueryColumn): unknown {
  if (typeof value !== 'string') {
    // Non-string: shape-mask doesn't apply cleanly, fall back to hash.
    return hashValue(value);
  }
  if (column && isEmailColumn(column)) return shapeEmail(value);
  if (column && isPhoneColumn(column)) return shapePhone(value);

  // Try content detection when no column hint
  if (EMAIL_REGEX.test(value)) return shapeEmail(value);
  if (looksLikeCard(value)) return shapeCard(value);
  if (PHONE_REGEX.test(value) && !/\s{2,}/.test(value)) return shapePhone(value);

  return shapeGeneric(value);
}

function isEmailColumn(col: QueryColumn): boolean {
  return /\be ?mail\b/i.test(col.name.replace(/[_-]+/g, ' '));
}

function isPhoneColumn(col: QueryColumn): boolean {
  return /\b(phone|tel(ephone)?|mobile)\b/i.test(col.name.replace(/[_-]+/g, ' '));
}

function shapeEmail(value: string): string {
  const match = value.match(/^([^@]+)@([^.@]+)\.([^@]+)$/);
  if (!match) {
    // preserve the `@` if any, mask everything else
    return value.replace(/[A-Za-z0-9]/g, 'x');
  }
  const tldMask = match[3].replace(/[A-Za-z0-9]/g, 'x');
  return `x@y.${tldMask}`;
}

function shapePhone(value: string): string {
  return value.replace(/\d/g, '0');
}

function shapeCard(value: string): string {
  return value.replace(/\d/g, 'x');
}

function shapeGeneric(value: string): string {
  // Preserve separators (whitespace, punctuation) so the mask still looks like
  // the original shape.
  return value.replace(/[A-Za-z0-9]/g, 'x');
}

function looksLikeCard(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  return luhn(digits);
}

/** Luhn checksum for credit-card detection. Exposed for tests. */
export function luhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/**
 * Scrub well-known PII shapes out of an error message so constraint errors
 * like `duplicate key (alice@example.com) violates...` don't leak raw values
 * to agents. Non-destructive — anything not matching a known pattern is
 * passed through verbatim.
 */
export function scrubErrorMessage(message: string, policy: AnonymizationPolicy): string {
  if (policy.mode === 'off' || !message) return message;
  let scrubbed = message;
  // Emails
  scrubbed = scrubbed.replace(/[^\s@'"`()<>]+@[^\s@'"`()<>]+\.[^\s@'"`()<>]+/g, '[redacted-email]');
  // Credit-card-like digit runs (Luhn-validated)
  scrubbed = scrubbed.replace(CARD_DIGIT_REGEX, match => (luhn(match) ? '[redacted-card]' : match));
  return scrubbed;
}

/**
 * Convenience wrapper — apply the anonymizer when `columns` is a subset of
 * rich metadata (e.g. `{ name, dataType }`). Separate entry point so MCP
 * handlers don't have to rebuild the metadata shape twice.
 */
export function anonymizeQueryResult(
  columns: QueryColumn[],
  rows: Record<string, unknown>[],
  policy: AnonymizationPolicy,
): { columns: QueryColumn[]; rows: Record<string, unknown>[] } {
  return { columns, rows: anonymizeRows(columns, rows, policy) };
}
