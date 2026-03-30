# Changelog

All notable changes to Viewstor are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.6] — 2026-03-30

### Added
- **Native MCP server registration** — extension registers MCP server via `mcpServerDefinitionProviders`, auto-discovered by Copilot/Cursor without any config ([#43](https://github.com/Siyet/viewstor/issues/43))
- **Resizable columns** — drag column header right edge to resize ([#44](https://github.com/Siyet/viewstor/issues/44))
- **Add row** — insert a new row with DEFAULT values from the table data toolbar ([#45](https://github.com/Siyet/viewstor/issues/45))
- **Delete rows** — delete selected rows by PK, from toolbar (enabled on selection) and right-click context menu ([#45](https://github.com/Siyet/viewstor/issues/45))
- **Refresh button** (↻) in toolbar and footer — re-run current query or reload table data
- **Inline table icon** — click eye icon next to table/view name in tree to open data
- **JSON editing via native VS Code tab** — double-click JSON cell opens `.json` file beside with full syntax highlighting, Ctrl+S applies value back to cell
- **SQL confirmation via native VS Code tab** — Save Changes / Insert / Delete opens `.sql` file with ▶ Play button in editor title, Ctrl+Enter or ▶ to execute, Ctrl+S pins query in history
- **Type-aware SQL generation** — numeric PKs without quotes (`WHERE "id" = 244`), boolean as `TRUE`/`FALSE`, `::jsonb`/`::json` casts
- Footer toolbar with all action buttons (refresh, export, add/delete row, save/discard)
- SQL builder utilities extracted to `src/utils/queryHelpers.ts` with 96 unit tests
- 8 new e2e tests: multi-schema dedup, numeric PK, JSONB/JSON cast, boolean update, DELETE, INSERT DEFAULT, multi-database

### Changed
- Custom SQL query and pagination update only the table grid, not the entire page — SQL input, scroll position preserved
- JSON and SQL editing moved from webview popups to native VS Code editor tabs with full syntax highlighting, IntelliSense, and standard keybindings

### Fixed
- SQL editor queries on secondary databases in multi-DB connections now execute against the correct database, not the main one
- Multi-DB driver caching with auto-reconnect — no more temporary drivers discarded after schema fetch
- JSON inline edits generated `[object Object]` in UPDATE SQL — now properly serialized via `JSON.stringify`
- `+ Row` / `− Row` buttons disappeared after changing SQL query in table data view

## [0.2.5] — 2026-03-30

### Added
- **Get Started welcome page** — shown on first install with connection setup guide, import instructions, and MCP config copy button ([#41](https://github.com/Siyet/viewstor/issues/41))
- **MCP launcher at stable path** — `~/.viewstor/mcp-server.js` auto-updated on each activation, no manual path changes on extension update ([#41](https://github.com/Siyet/viewstor/issues/41))
- **`Viewstor: Setup MCP`** command — modal dialog with ready-to-copy MCP config
- **`Viewstor: Get Started`** command — re-open welcome page anytime
- **"Did you mean?" column suggestions** — on typos in column names (Levenshtein distance ≤ 3), suggests closest match from table schema

### Fixed
- Query errors no longer replace result panel content — shown as VS Code notification instead ([#41](https://github.com/Siyet/viewstor/issues/41))
- Duplicate tables in tree view when same table name exists in multiple schemas — fixed `pg_class` JOIN to filter by namespace
- **Show Table Data** on second database in multi-DB connections — was querying main DB instead of the selected one
- Result panel opens in the main editor group instead of creating a side split
- Error notifications now show the error first, then the SQL query (up to 255 chars)
- All errors logged to Output channel ("Viewstor") for diagnostics

## [0.2.4] — 2026-03-30

### Fixed
- Extension crash on startup: `ssh2` native module not included in `.vsix` package ([#38](https://github.com/Siyet/viewstor/issues/38))
- E2E tests for `getCompletions` updated to match structured `CompletionItem[]` return type

### Added
- Output channel "Viewstor" with activation error notification and "Show Logs" button ([#39](https://github.com/Siyet/viewstor/issues/39))
- E2E tests job in CI pipeline

## [0.2.3] — 2026-03-30

### Added
- Query History click — opens query text + cached results without re-executing ([#4](https://github.com/Siyet/viewstor/issues/4))
- Pin/unpin queries in history — pinned entries never auto-evicted ([#4](https://github.com/Siyet/viewstor/issues/4))
- Configurable history retention: `viewstor.queryHistoryLimit` setting (default 200)
- Clear all / delete single history entries
- Enum value autocomplete after `=`, `!=`, `<>`, `IN` operators ([#32](https://github.com/Siyet/viewstor/issues/32))
- SQL diagnostics — error underline for non-existent tables, warning for unknown columns ([#33](https://github.com/Siyet/viewstor/issues/33))
- JSON preview with syntax highlighting in cell editor popup
- Show actual executed query (with auto-LIMIT) in progress notification ([#36](https://github.com/Siyet/viewstor/issues/36))
- ClickHouse table sizes in tree view (`~15k rows · 2.3 MB`)
- PostgreSQL table sizes in tree view (`~15k rows · 2.3 MB`)

### Changed
- Auto-LIMIT uses max(defaultPageSize, 1000) instead of hard-coded 100
- Results panel opens below editor instead of beside
- Schema cached in tree provider — Hide Schema is instant (no network request)

### Fixed
- Result panel empty due to broken regex escapes in webview script

## [0.2.2] — 2026-03-30

### Fixed
- Extension activation failure due to stale NLS files ([#28](https://github.com/Siyet/viewstor/issues/28))

## [0.2.1] — 2026-03-30

### Added
- "What's New" notification after extension update with link to changelog
- `reload_connections` MCP tool for CLI agents to re-read config files
- Bidirectional connection sync between VS Code extension and standalone MCP server via `~/.viewstor/connections.json`

### Fixed
- VS Code extension now reads connections from `~/.viewstor/connections.json` on startup
- VS Code extension now writes user connections to `~/.viewstor/connections.json` on save

## [0.2.0] — 2026-03-29

### Added
- Standalone MCP server for CLI agents (Claude Code, Cline, etc.)
- 6 MCP tools: `list_connections`, `get_schema`, `execute_query`, `get_table_data`, `get_table_info`, `add_connection`
- Connection store reads from `~/.viewstor/connections.json` and `.vscode/viewstor.json`

## [0.1.2] — 2026-03-29

### Added
- Copilot Chat participant (`@viewstor`) with `/schema`, `/describe`, `/query` commands
- Wiki with migration guides for DBeaver, DataGrip, pgAdmin

### Fixed
- Release workflow permissions for GitHub Releases

## [0.1.1] — 2026-03-29

### Added
- Internationalization (i18n) — 12 languages: Chinese, Japanese, Korean, German, French, Spanish, Portuguese, Russian, Arabic, Hindi, Bengali, English
- `.vscodeignore` to reduce package size

### Fixed
- Redis `disconnect()` now properly awaits `quit()`
- ClickHouse SQL injection in `getEstimatedRowCount` — uses parameterized queries
- ClickHouse `AbortController` race condition — local variable per query
- PostgreSQL tunnel leak on connect failure — try-catch with cleanup
- `IndexHintProvider` clears `debounceTimer` in `dispose()`
- `CompletionProvider` tracks and clears cache timeout IDs
- `FolderForm` persists scope on folder creation

### Changed
- ClickHouse `getSchema` uses batch `system.tables` + `system.columns` instead of N+1 DESCRIBE
- ClickHouse `execute` uses `JSON` format for column type metadata
- ExportService precompiles RegExp in `escapeField`
- README rewritten: motivation-first structure with competitor comparison

## [0.1.0] — 2026-03-29

### Added
- Initial release
- PostgreSQL, Redis, ClickHouse drivers
- Schema browser with tree view
- Query editor with SQL autocomplete and index hints
- Result grid with server-side pagination, inline editing, export
- Safe mode (block/warn/off) with EXPLAIN-based Seq Scan detection
- Read-only mode per connection and folder (inherited)
- Connection import from DBeaver, DataGrip, pgAdmin
- Color-coded nested folders with drag-and-drop
- MCP commands for VS Code AI agents
- Query history
