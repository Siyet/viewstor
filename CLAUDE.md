# CLAUDE.md

Guidance for Claude Code when working with this repository.

## What is Viewstor

VS Code extension for database management. Supports PostgreSQL, Redis, ClickHouse. Free, open-source (AGPL-3.0) alternative to DBeaver/DataGrip. Follows [ZeroVer](https://0ver.org) — version 0.x until API is stable.

## Commands

```bash
npm run dev          # webpack development build
npm run watch        # rebuild on changes
npm run build        # production build
npm run lint         # ESLint
npm run lint:fix     # auto-fix
npm test             # unit tests (vitest)
npm run test:e2e     # e2e tests (Docker + testcontainers)
npm run package      # .vsix
```

F5 in VS Code → Extension Development Host. Reload Window picks up new `dist/`.

## Architecture

### Entry point
`src/extension.ts` — activates on `viewstor.connections` view. Creates ConnectionManager, tree providers, form panels, completion/index providers, MCP commands.

### Drivers
`src/types/driver.ts` → `DatabaseDriver` interface. Factory in `src/drivers/index.ts`.

Required methods: `connect`, `disconnect`, `ping`, `execute`, `getSchema`, `getTableInfo`, `getTableData`.

Optional: `getTableRowCount`, `getEstimatedRowCount` (pg_class.reltuples / system.tables), `getDDL`, `cancelQuery` (PG: pg_cancel_backend, CH: AbortController), `getCompletions` (structured: table/view/column/schema with parent), `getIndexedColumns` (pg_index query).

Drivers: `postgres.ts` (pg), `redis.ts` (ioredis), `clickhouse.ts` (@clickhouse/client).

### Connections
`src/connections/connectionManager.ts` — persists in VS Code `globalState` (keys: `viewstor.connections`, `viewstor.connectionFolders`).

`ConnectionConfig` fields: id, name, type, host, port, username, password, database, databases (multi-DB array), ssl, options, folderId, color (hex or CSS var like `var(--vscode-terminal-ansiRed)`), readonly, hiddenSchemas (Record per DB), hiddenDatabases, safeMode (`'off' | 'warn' | 'block'`), scope (`'user' | 'project'`), proxy (SSH/SOCKS5/HTTP).

`ConnectionFolder` fields: id, name, color, readonly, sortOrder, parentFolderId (nested folders), scope.

Color inheritance: `getConnectionColor()` falls back to folder color. Readonly inheritance: `isConnectionReadonly()` checks connection then folder. Icons tinted via `colorToThemeColor()` which maps CSS vars to ThemeColor IDs.

`getSchemaForDatabase(connectionId, database)` creates temporary driver for multi-DB tree expansion.

Storage scopes: `user` → globalState, `project` → `.vscode/viewstor.json` (passwords stripped for security). File watcher auto-reloads project connections on change.

### Tree
`src/views/connectionTree.ts` — TreeDataProvider + DragAndDropController. Supports: nested folders, connections, database nodes (multi-DB), schema objects. MIME type `application/vnd.code.tree.viewstor.connections`.

Level collapsing: single DB → skip to schemas, single schema → skip to tables.

Filtering: `filterSchema()` removes hidden schemas/databases recursively.

`contextValue` controls menus: `folder`, `connection-connected`, `connection-disconnected`, `database`, `schema`, `table`, `view`, `column`, `index`, `trigger`, `sequence`, `group`.

### Forms
`src/views/connectionForm.ts` — webview panel. Fields: DB type, name, host:port, username, password, database (custom dropdown with server autocomplete — uses `postgres` as default DB to fetch list), additional databases (toggle tags), SSL, color (picker + palette + random), readonly, safe mode (block/warn/off), proxy (SSH tunnel / SOCKS5). Hidden folderId. Messages: save, testConnection, fetchDatabases, cancel.

`src/views/folderForm.ts` — webview panel. Fields: name, color (picker + palette + random), readonly, scope. Accepts parentFolderId for nested creation.

### Result Panel
`src/views/resultPanel.ts` — webview. Server-side pagination (LIMIT/OFFSET). `ShowOptions`: connectionId, tableName, schema, pkColumns, color, readonly, pageSize, currentPage, totalRowCount, isEstimatedCount, orderBy.

Page sizes: [50, 100, 500, 1000], default 100.

Messages: changePage, changePageSize, reloadWithSort, saveEdits, openJsonInTab, exportAllData, refreshCount, cancelQuery, runCustomQuery.

Webview JS features: row numbers (sticky left), column sorting, drag-select with resize handle, unified selection border (sel-top/bottom/left/right), search with Enter navigation, context menu (copy as CSV/TSV/MD/JSON), JSON editor popup, export dialog, loading overlay with cancel button, PG array display with `{curly braces}`.

Table mode (connectionId + tableName) → server-side pagination + export all from DB.
Query mode → client-side data + export in-memory rows.

`safeJsonForScript()` escapes `</script>` and `<!--` in inline JSON.

### SQL Autocomplete
`src/editors/completionProvider.ts` — CompletionItemProvider triggered on `.`. Caches per connection (60s TTL, tracked timers for cleanup). Context-aware: after FROM/JOIN → tables only, after `table.` → that table's columns, general context → columns from query's referenced tables + tables + keywords. Aliases resolved from `FROM table AS alias`.

### Index Hints
`src/editors/indexHintProvider.ts` — DiagnosticProvider. Debounced 500ms. Parses WHERE/ORDER BY columns, queries `getIndexedColumns()`, shows Warning diagnostic. Handles aliases and multi-table queries. Only fires for connected SQL documents. Skips small tables (below configurable `indexHintThreshold`, default 100k rows).

### Safe Mode
`src/commands/index.ts` — before executing SELECT queries, runs `EXPLAIN` to detect Seq Scans (PostgreSQL only). Three modes: `block` (prevents execution, shows EXPLAIN), `warn` (shows warning with Run Anyway/See EXPLAIN/Cancel), `off` (no checks). Configurable globally via `viewstor.safeMode` setting or per connection. Auto-adds `LIMIT` to SELECTs missing it.

### Tunnels
`src/connections/tunnel.ts` — SSH tunnel via `ssh2` library (port forwarding). SOCKS5 proxy via raw socket negotiation. Used by PostgreSQL driver when `config.proxy` is set. Tunnel cleaned up on disconnect or connect failure.

### Chat Participant
`src/chat/participant.ts` — Copilot Chat participant `@viewstor`. Registered via `vscode.chat.createChatParticipant()`. Slash commands: `/schema` (dump schema), `/describe <table>` (table info), `/query` (generate SQL). Resolves active connection from query editor URI or first connected connection. Injects schema context (tables + columns + types) as system prompt. Uses `vscode.lm.selectChatModels()` to forward to Copilot LLM. Respects readonly mode in system prompt. Requires VS Code 1.93+.

### MCP
`src/mcp/server.ts` — 5 VS Code commands for AI agents:
- `viewstor.mcp.listConnections` → connection list with status
- `viewstor.mcp.getSchema` → flattened schema (name, type, path, detail)
- `viewstor.mcp.executeQuery` → SQL execution (readonly enforced: only SELECT/EXPLAIN/SHOW/WITH)
- `viewstor.mcp.getTableData` → rows with column metadata
- `viewstor.mcp.getTableInfo` → column details with PK/nullable

All auto-connect. Returns structured JSON or `{ error }`.

### Services
`src/services/exportService.ts` — ExportService static methods: toCsv (configurable delimiter/quotes/null/header/lineEnding), toTsv, toJson, toMarkdownTable, toPlainTextTable.

`src/services/importService.ts` — parseDBeaver (data-sources.json), parseDataGrip (dataSources.xml, regex XML), parsePgAdmin (servers.json). Maps providers to DatabaseType, skips unsupported with warnings. No password import.

### Commands
`src/commands/index.ts` — all `viewstor.*` commands. Notable: `_fetchPage` (server-side pagination), `_exportAllData` (fetches up to 100k rows), `_cancelQuery`, `_refreshCount` (exact COUNT), `reportIssue` (GitHub issue with env info).

## Key Conventions

- State in `context.globalState`, not files (project-scoped in `.vscode/viewstor.json`)
- `viewstor:` URI scheme links query editors to connections via `connectionMap`
- Redis driver parses raw commands (`parseRedisCommand`, exported), not SQL
- Webpack externalizes `vscode` — never bundle it
- `pg-native` build warning is expected
- Tests: vitest (unit `src/test/`, e2e `src/test/e2e/`), separate configs
- Estimated row count for fast table open; exact via refresh button
- Export fetches all rows independently of pagination (up to 100k)
- CSS var colors mapped to ThemeColor via regex: `var(--vscode-terminal-ansiRed)` → `terminal.ansiRed`
- Inaccessible tables/views (no columns): `inaccessible: true` → errorForeground icon
- Multi-DB: main `database` + `databases[]`, shown as nodes when >1
- DB autocomplete connects to `postgres` DB when main field empty
- Keyboard shortcuts use `e.code` (KeyF, KeyC) for layout independence
- PG arrays: `pgArrayToString()` renders `{curly braces}` instead of JSON `[brackets]`
- ClickHouse getSchema uses batch queries to `system.tables` and `system.columns` (not per-table DESCRIBE)
- ClickHouse execute uses `JSON` format (not `JSONEachRow`) to get column types from response metadata
