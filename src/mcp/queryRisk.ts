/**
 * Query classification for the agent-facing MCP surface.
 *
 * Pure, vscode-independent. Parses the leading keyword of each SQL
 * statement (after comments and whitespace) to decide the risk class.
 * Multi-statement scripts return the most-severe kind.
 *
 * The goal is a coarse safety gate, not a SQL parser. When in doubt,
 * classify as `unknown` so the caller treats it as the most dangerous
 * category.
 */

export type QueryRiskKind = 'read' | 'write' | 'ddl' | 'admin' | 'unknown';

export type ReadVerb = 'SELECT' | 'EXPLAIN' | 'SHOW' | 'WITH' | 'DESCRIBE' | 'PRAGMA';
export type WriteVerb = 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'UPSERT' | 'REPLACE' | 'COPY';
export type DdlVerb = 'CREATE' | 'ALTER' | 'DROP' | 'TRUNCATE' | 'RENAME';
export type AdminVerb = 'GRANT' | 'REVOKE' | 'VACUUM' | 'ANALYZE' | 'REINDEX' | 'CLUSTER' | 'OPTIMIZE' | 'ATTACH' | 'DETACH' | 'SET' | 'RESET';

export type QueryRisk =
  | { kind: 'read'; verb: ReadVerb }
  | { kind: 'write'; verb: WriteVerb }
  | { kind: 'ddl'; verb: DdlVerb }
  | { kind: 'admin'; verb: AdminVerb }
  | { kind: 'unknown' };

const READ_VERBS = new Set<string>(['SELECT', 'EXPLAIN', 'SHOW', 'WITH', 'DESCRIBE', 'DESC', 'PRAGMA']);
const WRITE_VERBS = new Set<string>(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'REPLACE', 'COPY']);
const DDL_VERBS = new Set<string>(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME']);
const ADMIN_VERBS = new Set<string>(['GRANT', 'REVOKE', 'VACUUM', 'ANALYZE', 'REINDEX', 'CLUSTER', 'OPTIMIZE', 'ATTACH', 'DETACH', 'SET', 'RESET']);

/**
 * Keywords that appear inside the `EXPLAIN` options list (either free-form,
 * `EXPLAIN ANALYZE VERBOSE ...`, or inside parens, `EXPLAIN (ANALYZE, VERBOSE) ...`).
 * Skipped while looking for the actual inner statement verb.
 */
const EXPLAIN_OPTION_WORDS = new Set<string>([
  'ANALYZE', 'VERBOSE', 'BUFFERS', 'COSTS', 'FORMAT', 'WAL', 'TIMING',
  'SUMMARY', 'SETTINGS', 'GENERIC_PLAN', 'MEMORY', 'SERIALIZE',
  'JSON', 'YAML', 'XML', 'TEXT',
  'TRUE', 'FALSE', 'ON', 'OFF',
]);

/** Strip leading SQL line (`-- ...`) and block (`/* ... *\/`) comments + whitespace. */
function stripLeadingCommentsAndWhitespace(sql: string): string {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '');
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1);
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2);
    }
    if (s === before) return s;
  }
}

/** Split a SQL script into top-level statements on `;` boundaries. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      buf += c;
      if (c === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      buf += c;
      if (c === '*' && next === '/') {
        buf += next;
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inSingle) {
      buf += c;
      if (c === '\'' && next === '\'') { buf += next; i += 2; continue; }
      if (c === '\\' && next !== undefined) { buf += next; i += 2; continue; }
      if (c === '\'') inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      buf += c;
      if (c === '"' && next === '"') { buf += next; i += 2; continue; }
      if (c === '"') inDouble = false;
      i++;
      continue;
    }
    if (inBacktick) {
      buf += c;
      if (c === '`') inBacktick = false;
      i++;
      continue;
    }
    if (c === '-' && next === '-') { inLineComment = true; buf += c; i++; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; buf += c; i++; continue; }
    if (c === '\'') { inSingle = true; buf += c; i++; continue; }
    if (c === '"') { inDouble = true; buf += c; i++; continue; }
    if (c === '`') { inBacktick = true; buf += c; i++; continue; }
    if (c === ';') {
      const t = buf.trim();
      if (t) out.push(t);
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/** Classify a single SQL statement (no `;` splitting). */
export function classifyStatement(sql: string): QueryRisk {
  const s = stripLeadingCommentsAndWhitespace(sql);
  if (!s) return { kind: 'unknown' };
  const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  if (!m) return { kind: 'unknown' };
  const verb = m[1].toUpperCase();
  // EXPLAIN ANALYZE (and in some dialects EXPLAIN with other execute-mode
  // options) actually runs the inner statement. Reclassify under the inner
  // verb so destructive operations can't be laundered through EXPLAIN.
  if (verb === 'EXPLAIN') {
    const inner = parseExplainInner(s.slice(m[1].length));
    if (inner) {
      const innerRisk = classifyStatement(inner);
      if (innerRisk.kind !== 'read' && innerRisk.kind !== 'unknown') return innerRisk;
    }
    return { kind: 'read', verb: 'EXPLAIN' };
  }
  // WITH <cte> AS (INSERT/UPDATE/DELETE/MERGE ...) SELECT ... — the DML in
  // the CTE actually executes. Promote to the most severe inner DML/DDL.
  if (verb === 'WITH') {
    const hazard = scanForHazard(s);
    if (hazard) return hazard;
    return { kind: 'read', verb: 'WITH' };
  }
  if (READ_VERBS.has(verb)) {
    const v = (verb === 'DESC' ? 'DESCRIBE' : verb) as ReadVerb;
    return { kind: 'read', verb: v };
  }
  if (WRITE_VERBS.has(verb)) return { kind: 'write', verb: verb as WriteVerb };
  if (DDL_VERBS.has(verb)) return { kind: 'ddl', verb: verb as DdlVerb };
  if (ADMIN_VERBS.has(verb)) return { kind: 'admin', verb: verb as AdminVerb };
  return { kind: 'unknown' };
}

/**
 * Skip EXPLAIN's option clause (either free-form `ANALYZE VERBOSE ...` or
 * parenthesised `(ANALYZE, VERBOSE)`) and return the remaining statement,
 * or null if nothing plausible is left.
 */
function parseExplainInner(rest: string): string | null {
  let s = stripLeadingCommentsAndWhitespace(rest);
  // Paren-style options: EXPLAIN (ANALYZE, VERBOSE, ...) <stmt>
  if (s.startsWith('(')) {
    let depth = 0;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { i++; break; }
      }
      i++;
    }
    if (depth !== 0) return null;
    s = stripLeadingCommentsAndWhitespace(s.slice(i));
  }
  // Free-form options: ANALYZE VERBOSE ... <stmt>. Consume any whitelisted words.
  for (;;) {
    const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (!m) return null;
    const word = m[1].toUpperCase();
    if (!EXPLAIN_OPTION_WORDS.has(word)) return s;
    s = stripLeadingCommentsAndWhitespace(s.slice(m[1].length));
  }
}

/**
 * Scan a statement for any destructive verb, ignoring string literals,
 * quoted identifiers, and comments. Used to promote `WITH ... (DML)` to
 * the severity of the DML inside the CTE. Returns the most-severe hit, or
 * null if none found.
 */
function scanForHazard(sql: string): QueryRisk | null {
  const cleaned = stripStringsAndComments(sql);
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let worst: QueryRisk | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    const w = m[1].toUpperCase();
    // Only look for WRITE / DDL verbs. Admin keywords (`SET`, `RESET`,
    // `ANALYZE`) appear as part of DML syntax (e.g. `UPDATE ... SET x = 1`,
    // `MERGE ... WHEN MATCHED THEN UPDATE SET ...`) and would produce false
    // positives. A genuine `SET` / `ANALYZE` admin command wouldn't appear
    // inside a CTE anyway — the top-level verb would already be `SET`.
    let risk: QueryRisk | null = null;
    if (WRITE_VERBS.has(w)) risk = { kind: 'write', verb: w as WriteVerb };
    else if (DDL_VERBS.has(w)) risk = { kind: 'ddl', verb: w as DdlVerb };
    if (risk && (!worst || KIND_SEVERITY[risk.kind] > KIND_SEVERITY[worst.kind])) {
      worst = risk;
    }
  }
  return worst;
}

/** Remove quoted strings, quoted identifiers, and comments so keyword scans aren't spoofed. */
function stripStringsAndComments(sql: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      if (c === '\n') { inLineComment = false; out += c; }
      i++;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
      i++;
      continue;
    }
    if (inSingle) {
      if (c === '\'' && next === '\'') { i += 2; continue; }
      if (c === '\\' && next !== undefined) { i += 2; continue; }
      if (c === '\'') inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === '"' && next === '"') { i += 2; continue; }
      if (c === '"') inDouble = false;
      i++;
      continue;
    }
    if (inBacktick) {
      if (c === '`') inBacktick = false;
      i++;
      continue;
    }
    if (c === '-' && next === '-') { inLineComment = true; i += 2; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
    if (c === '\'') { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = true; i++; continue; }
    if (c === '`') { inBacktick = true; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

const KIND_SEVERITY: Record<QueryRiskKind, number> = {
  read: 0,
  write: 2,
  admin: 3,
  ddl: 4,
  unknown: 5,
};

/**
 * Classify a SQL script. Multi-statement scripts return the most-severe
 * individual classification; `unknown` wins over everything so unparseable
 * input is always treated as dangerous.
 */
export function classifyQuery(sql: string): QueryRisk {
  const statements = splitStatements(sql);
  if (statements.length === 0) return { kind: 'unknown' };
  let worst: QueryRisk = classifyStatement(statements[0]);
  for (let i = 1; i < statements.length; i++) {
    const r = classifyStatement(statements[i]);
    if (KIND_SEVERITY[r.kind] > KIND_SEVERITY[worst.kind]) worst = r;
  }
  return worst;
}

export function needsApproval(risk: QueryRisk, mode: AgentWriteApproval): boolean {
  if (risk.kind === 'read') return false;
  switch (mode) {
    case 'never':
      return false;
    case 'ddl-and-admin':
      return risk.kind === 'ddl' || risk.kind === 'admin' || risk.kind === 'unknown';
    case 'always':
    default:
      return true;
  }
}

export type AgentWriteApproval = 'always' | 'ddl-and-admin' | 'never';

export const DEFAULT_AGENT_WRITE_APPROVAL: AgentWriteApproval = 'always';

/** Human-readable description used in confirmation UI and structured errors. */
export function describeRisk(risk: QueryRisk): string {
  switch (risk.kind) {
    case 'read': return `Read query (${risk.verb})`;
    case 'write': return `Data modification (${risk.verb})`;
    case 'ddl': return `Schema change (${risk.verb})`;
    case 'admin': return `Admin command (${risk.verb})`;
    case 'unknown': return 'Unclassified query (treated as destructive)';
  }
}
