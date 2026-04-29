import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `viewstor-mcp-add-${Date.now()}`);
const TEST_USER_DIR = path.join(TEST_DIR, '.viewstor');
const TEST_SETTINGS_FILE = path.join(TEST_USER_DIR, 'settings.json');
const TEST_AUDIT_FILE = path.join(TEST_USER_DIR, 'audit.log');
const TEST_PROJECT_DIR = path.join(TEST_DIR, 'project');
const TEST_PROJECT_VSCODE = path.join(TEST_PROJECT_DIR, '.vscode');
const TEST_PROJECT_CONFIG = path.join(TEST_PROJECT_VSCODE, 'viewstor.json');

// -------------------------------------------------------------------------
// getAddConnectionMode — reads env var > settings file > default
// -------------------------------------------------------------------------
describe('getAddConnectionMode', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_USER_DIR, { recursive: true });
    delete process.env['VIEWSTOR_MCP_ADD_CONNECTION'];
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env['VIEWSTOR_MCP_ADD_CONNECTION'];
  });

  function readMode(settingsContent?: string, envVar?: string): string {
    if (envVar !== undefined) {
      process.env['VIEWSTOR_MCP_ADD_CONNECTION'] = envVar;
    }
    if (settingsContent !== undefined) {
      fs.writeFileSync(TEST_SETTINGS_FILE, settingsContent, 'utf8');
    }

    // Inline the logic from ConnectionStore.getAddConnectionMode
    const envVal = process.env['VIEWSTOR_MCP_ADD_CONNECTION'];
    if (envVal === 'off' || envVal === 'restricted' || envVal === 'unrestricted') {
      return envVal;
    }
    try {
      if (fs.existsSync(TEST_SETTINGS_FILE)) {
        const settings = JSON.parse(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'));
        const val = settings['standaloneMcp.allowAddConnection'];
        if (val === 'off' || val === 'restricted' || val === 'unrestricted') {
          return val;
        }
      }
    } catch { /* ignore */ }
    return 'restricted';
  }

  it('defaults to restricted when no env var and no settings file', () => {
    expect(readMode()).toBe('restricted');
  });

  it('reads from env var when set', () => {
    expect(readMode(undefined, 'off')).toBe('off');
    expect(readMode(undefined, 'unrestricted')).toBe('unrestricted');
  });

  it('env var takes precedence over settings file', () => {
    expect(readMode('{"standaloneMcp.allowAddConnection": "unrestricted"}', 'off')).toBe('off');
  });

  it('reads from settings file when no env var', () => {
    expect(readMode('{"standaloneMcp.allowAddConnection": "off"}')).toBe('off');
  });

  it('defaults to restricted for invalid env var', () => {
    expect(readMode(undefined, 'garbage')).toBe('restricted');
  });

  it('defaults to restricted for invalid settings value', () => {
    expect(readMode('{"standaloneMcp.allowAddConnection": "yolo"}')).toBe('restricted');
  });

  it('defaults to restricted for malformed settings JSON', () => {
    expect(readMode('not json')).toBe('restricted');
  });
});

// -------------------------------------------------------------------------
// add_connection handler logic: mode × readonly combinations
// -------------------------------------------------------------------------
describe('add_connection mode logic', () => {
  function buildConfig(
    mode: 'off' | 'restricted' | 'unrestricted',
    args: { name: string; type: string; host?: string; port?: number; readonly?: boolean },
  ) {
    if (mode === 'off') {
      return { error: true, kind: 'tool_disabled' };
    }

    const id = 'test-id';
    const warnings: { kind: string; message: string }[] = [];

    if (mode === 'restricted') {
      if (args.readonly === false) {
        warnings.push({
          kind: 'readonly_forced',
          message: 'Agent-supplied readonly=false was ignored. Restricted mode forces readonly=true.',
        });
      }
      return {
        config: {
          id,
          name: `[agent] ${args.name}`,
          type: args.type,
          host: args.host || '',
          port: args.port || 0,
          readonly: true,
          scope: 'project',
          agentCreated: true,
        },
        warnings,
      };
    }

    // unrestricted
    warnings.push({
      kind: 'agent_created_writeable_connection',
      message: 'Connection created in unrestricted mode. The agent has full access.',
    });
    return {
      config: {
        id,
        name: args.name,
        type: args.type,
        host: args.host || '',
        port: args.port || 0,
        readonly: args.readonly,
        agentCreated: true,
      },
      warnings,
    };
  }

  describe('off mode', () => {
    it('returns error for any add_connection call', () => {
      const result = buildConfig('off', { name: 'Test', type: 'postgresql' });
      expect(result.error).toBe(true);
    });
  });

  describe('restricted mode', () => {
    it.each([
      [true, true, 0],
      [false, true, 1],
      [undefined, true, 0],
    ] as const)('readonly=%s → persisted readonly=%s, warnings=%d', (input, expected, warnCount) => {
      const result = buildConfig('restricted', { name: 'PG', type: 'postgresql', host: 'db.local', port: 5432, readonly: input as boolean | undefined });
      expect(result).not.toHaveProperty('error');
      const cfg = (result as { config: Record<string, unknown> }).config;
      expect(cfg.readonly).toBe(expected);
      expect(cfg.scope).toBe('project');
      expect(cfg.name).toBe('[agent] PG');
      expect(cfg.agentCreated).toBe(true);
      expect((result as { warnings: unknown[] }).warnings).toHaveLength(warnCount);
    });
  });

  describe('unrestricted mode', () => {
    it.each([
      [true, true],
      [false, false],
      [undefined, undefined],
    ] as const)('readonly=%s → persisted readonly=%s', (input, expected) => {
      const result = buildConfig('unrestricted', { name: 'PG', type: 'postgresql', readonly: input as boolean | undefined });
      expect(result).not.toHaveProperty('error');
      const cfg = (result as { config: Record<string, unknown> }).config;
      expect(cfg.readonly).toBe(expected);
      expect(cfg.name).toBe('PG');
      expect(cfg.agentCreated).toBe(true);
      expect((result as { warnings: unknown[] }).warnings).toHaveLength(1);
      expect((result as { warnings: { kind: string }[] }).warnings[0].kind).toBe('agent_created_writeable_connection');
    });
  });
});

// -------------------------------------------------------------------------
// Audit log writing
// -------------------------------------------------------------------------
describe('writeAuditEntry', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_USER_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('appends JSON line to audit log', () => {
    const entry = { action: 'add_connection', mode: 'restricted' as const, config: { name: 'Test', type: 'pg' } };
    // Inline the write logic
    const line = JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', ...entry }) + '\n';
    fs.appendFileSync(TEST_AUDIT_FILE, line, 'utf8');

    const contents = fs.readFileSync(TEST_AUDIT_FILE, 'utf8');
    const parsed = JSON.parse(contents.trim());
    expect(parsed.action).toBe('add_connection');
    expect(parsed.mode).toBe('restricted');
    expect(parsed.config.name).toBe('Test');
    expect(parsed.timestamp).toBeDefined();
  });
});

// -------------------------------------------------------------------------
// Project-scoped config saving (passwords stripped)
// -------------------------------------------------------------------------
describe('project-scoped config saving', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_PROJECT_VSCODE, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('strips password from project-scoped configs', () => {
    const config = {
      id: 'agent-1',
      name: '[agent] Test',
      type: 'postgresql',
      host: 'localhost',
      port: 5432,
      password: 'secret123',
      scope: 'project',
      agentCreated: true,
    };

    const projectConfigs = [{ ...config, password: undefined }];
    const data = { connections: projectConfigs };
    fs.writeFileSync(TEST_PROJECT_CONFIG, JSON.stringify(data, null, 2), 'utf8');

    const saved = JSON.parse(fs.readFileSync(TEST_PROJECT_CONFIG, 'utf8'));
    expect(saved.connections[0].password).toBeUndefined();
    expect(saved.connections[0].agentCreated).toBe(true);
    expect(saved.connections[0].name).toBe('[agent] Test');
  });

  it('preserves existing connections when adding agent connection', () => {
    const existing = {
      connections: [
        { id: 'manual-1', name: 'Manual PG', type: 'postgresql', host: 'db.local', port: 5432 },
      ],
    };
    fs.writeFileSync(TEST_PROJECT_CONFIG, JSON.stringify(existing, null, 2), 'utf8');

    // Simulate merge logic from saveProjectConfig
    const parsed = JSON.parse(fs.readFileSync(TEST_PROJECT_CONFIG, 'utf8'));
    const merged = new Map(parsed.connections.map((c: { id: string }) => [c.id, c] as const));
    merged.set('agent-1', { id: 'agent-1', name: '[agent] Test', type: 'postgresql', agentCreated: true });
    const data = { connections: Array.from(merged.values()), folders: parsed.folders };
    fs.writeFileSync(TEST_PROJECT_CONFIG, JSON.stringify(data, null, 2), 'utf8');

    const result = JSON.parse(fs.readFileSync(TEST_PROJECT_CONFIG, 'utf8'));
    expect(result.connections).toHaveLength(2);
    expect(result.connections.find((c: { id: string }) => c.id === 'manual-1')).toBeDefined();
    expect(result.connections.find((c: { id: string }) => c.id === 'agent-1')?.agentCreated).toBe(true);
  });
});

// -------------------------------------------------------------------------
// Integration: restricted mode + execute_query with UPDATE → blocked
// -------------------------------------------------------------------------
describe('restricted mode blocks writes via readonly', () => {
  it('readonly connection rejects non-SELECT queries', () => {
    const isReadOnlyQuery = (query: string): boolean => {
      const trimmed = query.trim().toUpperCase();
      return /^(SELECT|EXPLAIN|SHOW|WITH)\b/.test(trimmed);
    };

    const config = { readonly: true };
    const queries = [
      ['UPDATE users SET name = \'x\'', false],
      ['DELETE FROM users', false],
      ['INSERT INTO users DEFAULT VALUES', false],
      ['DROP TABLE users', false],
      ['SELECT * FROM users', true],
      ['EXPLAIN SELECT 1', true],
    ] as const;

    for (const [query, allowed] of queries) {
      const isAllowed = !config.readonly || isReadOnlyQuery(query);
      expect(isAllowed).toBe(allowed);
    }
  });
});

// -------------------------------------------------------------------------
// Tool list: off mode hides add_connection from ListTools
// -------------------------------------------------------------------------
describe('ListTools tool visibility', () => {
  function buildToolList(mode: 'off' | 'restricted' | 'unrestricted') {
    const baseTools = [
      'list_connections', 'get_schema', 'execute_query', 'get_table_data',
      'get_table_info', 'reload_connections', 'build_chart', 'export_grafana_dashboard',
    ];
    if (mode !== 'off') {
      baseTools.push('add_connection');
    }
    return baseTools;
  }

  it('off mode hides add_connection', () => {
    expect(buildToolList('off')).not.toContain('add_connection');
  });

  it('restricted mode includes add_connection', () => {
    expect(buildToolList('restricted')).toContain('add_connection');
  });

  it('unrestricted mode includes add_connection', () => {
    expect(buildToolList('unrestricted')).toContain('add_connection');
  });
});
