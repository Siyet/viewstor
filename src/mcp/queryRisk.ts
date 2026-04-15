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
  if (READ_VERBS.has(verb)) {
    const v = (verb === 'DESC' ? 'DESCRIBE' : verb) as ReadVerb;
    return { kind: 'read', verb: v };
  }
  if (WRITE_VERBS.has(verb)) return { kind: 'write', verb: verb as WriteVerb };
  if (DDL_VERBS.has(verb)) return { kind: 'ddl', verb: verb as DdlVerb };
  if (ADMIN_VERBS.has(verb)) return { kind: 'admin', verb: verb as AdminVerb };
  return { kind: 'unknown' };
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
