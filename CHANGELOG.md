# Changelog

All notable changes to Viewstor are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Changed
- **Diff panel on @vscode-elements/elements + UX polish** — migrated the Row/Schema/Statistics diff panel to `vscode-tabs` / `vscode-tab-header` / `vscode-tab-panel` / `vscode-collapsible` / `vscode-button` / `vscode-checkbox` / `vscode-icon`; tab headers now show colored count badges (e.g. `Schema Diff •6`) that switch to a warning tint when a side actually differs; filter chips are themed via shared `--viewstor-badge-bg-*` tokens so added/removed/changed colors match the rest of the UI; all filter chips default to active so the diff opens with the complete picture; Row Diff, Schema Diff, objects diff and "Other" stats tables use zebra striping via `--viewstor-row-zebra` with added/removed/changed status tints taking precedence, status rows alternate via `color-mix` so the stripe reads on red/green/yellow rows too, and the per-row border was removed so the 2px header border stands out. Cells in every diff table are now drag-selectable with the same grammar as the Result Grid — click, drag, Shift+click to extend, Ctrl/Cmd+C copies TSV, right-click opens a context menu with Copy / Copy with Headers / Copy as CSV / Markdown / JSON. UX fixes from [#84 § 3](https://github.com/Siyet/viewstor/issues/84): visible `lock` codicon next to the Synced checkbox while sync is on; the SQL editor block renamed to a compact "SQL" collapsible with an info-icon tooltip instead of an inline hint; sticky Left / Right source bar under the tabs so per-column sub-headers no longer repeat the source labels; `— / —` double-empty cells collapse to a single dim `–`; zero-on-both-sides numeric stats collapse into an inline summary line instead of rendering empty chart cells; "Other" non-numeric stats render as a card matching the chart / schema cards ([#87](https://github.com/Siyet/viewstor/issues/87))

### Added
- **Design system foundations + Connection/Folder forms on @vscode-elements/elements** — added `@vscode-elements/elements` (web components) and `@vscode/codicons` (icon font) to the webview bundle; introduced shared `tokens.css` with typography scale (panel title 13/600, section header 12/600, table header 11/600, table data 11/400, type annotation 10/400, meta 10/400/0.6), spacing grid (`4px 8px` cells, `16px` section gap, `8/16px` toolbar groups), and semantic color tokens (`--viewstor-row-added/removed/changed/zebra`, `--viewstor-text-dimmed`, `--viewstor-border-subtle`, `--viewstor-badge-bg-*`); migrated Connection and Folder forms to native `vscode-textfield`/`vscode-single-select`/`vscode-checkbox`/`vscode-button`/`vscode-collapsible`/`vscode-icon` so they render with proper VS Code chrome in light/dark/high-contrast themes; reordered Connection form fields for the edit flow (Name → Type → Host/Port → User/Pass → DBs → SSL/Proxy → Color/RO → Advanced) with Safe mode override / Store in / Hidden schemas tucked under a collapsible Advanced section; Test Connection moved to the left of the footer with secondary style; tooltip on the random-color action; clicking the swatch opens the OS color picker; form constrained to `max-width: 480px` and centered ([#86](https://github.com/Siyet/viewstor/issues/86))
- **Data diff: custom queries** — editable SQL above each side of the Row Diff panel. Pre-filled with `SELECT * FROM <table> LIMIT <rowLimit>`. "Synced" toggle (on by default for same-type connections) mirrors edits between panes; turn off to run independent queries per side. "Run Diff" re-executes both queries and recomputes the row diff; schema / objects / stats tabs stay bound to the original tables. Ctrl/Cmd+Enter runs from either textarea. Errors surface inline per side; the row diff also surfaces when the new query results don't carry the key columns. Swap preserves edited queries ([#68](https://github.com/Siyet/viewstor/issues/68))
- **MCP: query another database on the same server without re-entering credentials** — all data-oriented MCP tools (`execute_query`, `get_schema`, `get_table_data`, `get_table_info`, `build_chart` + VS Code counterparts) now accept an optional `database` parameter that reuses the referenced connection's host/user/password/ssl. `list_connections` also surfaces the `databases` array so agents know what's available. Previously the only workaround was `add_connection` with a re-entered password ([#82](https://github.com/Siyet/viewstor/issues/82))
- **Data diff** — compare data between tables or connections with side-by-side visualization. Row diff matches by PK and highlights added/removed/changed cells; Schema diff compares column types, nullability, and PK status. Export as CSV/JSON. Accessible via right-click "Compare With..." on tables or "Viewstor: Compare Data" command palette ([#5](https://github.com/Siyet/viewstor/issues/5))
- **Schema diff: indexes, constraints, triggers, sequences** — Schema Diff tab now compares indexes (columns, uniqueness, type), constraints (PK, UNIQUE, FK, CHECK), triggers (timing, events), and sequences (start, increment). Supported for PostgreSQL (full), SQLite (indexes, FK, triggers), and ClickHouse (data skipping indices) ([#66](https://github.com/Siyet/viewstor/issues/66))
- **Data diff: statistics tab** — compares table-level stats alongside rows and schema. PostgreSQL: row count, table/index/total size, live/dead tuples (+ dead %), last vacuum/analyze, seq/index scans, tuples inserted/updated/deleted. ClickHouse: row count, compressed/uncompressed size, compression ratio, active/total parts, lifetime rows/bytes, engine, metadata modified. SQLite: row count, table size (when `dbstat` available), index/trigger counts. Rendered as side-by-side horizontal bar chart (ECharts) with each row normalized to its own 100%, so metrics with different units (bytes, counts, percents) are visually comparable at a glance; non-numeric stats (dates, engine) shown in a small table below. Only enabled when both sides are the same database type ([#67](https://github.com/Siyet/viewstor/issues/67))
- **Regression prevention** — split monolithic `commands/index.ts` (1598 lines) into 7 focused modules, added 161 tests (ConnectionManager, driver contracts, integration workflows, activation smoke), connectionMap auto-cleanup, getDriverForDatabase concurrency lock, CI changeset size guard ([#59](https://github.com/Siyet/viewstor/issues/59), [#60](https://github.com/Siyet/viewstor/issues/60), [#61](https://github.com/Siyet/viewstor/issues/61))

## [0.3.2] — 2026-04-13

### Fixed
- **SQLite connection fails in marketplace build** — `better-sqlite3` was in both `dependencies` (^11.9.1) and `devDependencies` (^12.8.0); VSIX shipped v11 while prebuild binary was for v12, causing `r is not a constructor`. Removed from devDependencies, aligned to ^12.8.0 ([#54](https://github.com/Siyet/viewstor/issues/54))
- **PG array values saved with JSON brackets** — editing a `text[]` / `integer[]` column generated `SET col = '[1,2,3]'` instead of `SET col = '{1,2,3}'`. Added `pgArrayLiteral()` for correct PostgreSQL array literal serialization with proper quoting and escaping ([#55](https://github.com/Siyet/viewstor/issues/55))
- **No feedback when cell editing is blocked** — double-clicking a non-JSON cell in a table without primary keys silently did nothing. Added `cursor:text` for editable cells and `console.warn` diagnostic in webview ([#56](https://github.com/Siyet/viewstor/issues/56))
- **Release workflow 401 on marketplace publish** — `vsce` didn't pick up `VSCE_PAT` env var via `npx`; now passes `--pat` explicitly and verifies token before publish

## [0.3.1] — 2026-04-13

### Fixed
- **Extension fails to activate after v0.3.0 update** — top-level `import` of `better-sqlite3` native module crashed the entire bundle when the binary had an ABI mismatch (wrong Electron version), preventing `activate()` from running and making all commands unavailable. Now uses lazy `require()` inside `connect()` so a broken SQLite binary only affects SQLite connections, not the entire extension ([#51](https://github.com/Siyet/viewstor/issues/51))
- **Incomplete command registration test** — expanded from 17 to 50+ commands to catch activation failures like this in CI

## [0.3.0] — 2026-04-12

### Added
- **SQLite driver** — open `.sqlite`/`.db` files directly, file-based connection (no server needed). Schema browser, DDL, autocomplete, index hints, safe mode (`EXPLAIN QUERY PLAN` + `SCAN TABLE` detection), and all standard driver features. Native module managed via `prebuild-install` with Electron/Node dual-build caching ([#11](https://github.com/Siyet/viewstor/issues/11))
- **Chart visualization** — visualize query results as interactive charts (line, bar, scatter, pie, heatmap, radar, funnel, gauge, boxplot, candlestick, treemap, sunburst) powered by Apache ECharts. Per-table chart panels, config sidebar with axis mapping, server-side aggregation with DB-specific time bucketing (`strftime` for SQLite, `toStartOf*` for ClickHouse, `date_trunc` for PostgreSQL), auto-sync with Result Panel ([#31](https://github.com/Siyet/viewstor/issues/31))
- **`/chart` Copilot Chat command** — generate SQL + chart visualization from natural language description ([#31](https://github.com/Siyet/viewstor/issues/31))
- **MCP chart tools** — `build_chart` for standalone MCP server; `viewstor.mcp.visualize` for VS Code MCP commands ([#31](https://github.com/Siyet/viewstor/issues/31))
- **MCP UI commands** — `viewstor.mcp.openQuery` opens SQL editor with query text (optionally executes), `viewstor.mcp.openTableData` opens table data view with optional custom query ([#11](https://github.com/Siyet/viewstor/issues/11))
- **Multi-source charts** — add pinned queries as additional data sources to a chart, with join-by-column or separate-series merge modes ([#31](https://github.com/Siyet/viewstor/issues/31))
- **Safe mode for SQLite and ClickHouse** — full table scan detection for all SQL databases, not just PostgreSQL ([#11](https://github.com/Siyet/viewstor/issues/11))

### Changed
- Query result page size now matches LIMIT from executed query instead of fixed 100

## [0.2.7] — 2026-04-06

### Added
- **Unified query editor** — file-based `.sql` queries (`~/.viewstor/tmp/` for temp, `~/.viewstor/queries/` for pinned) replace untitled documents; all query types share the same editor with play button, Ctrl+Enter, and autocomplete ([#46](https://github.com/Siyet/viewstor/issues/46))
- **Pin on save** — Ctrl+S on a temp query moves it to `~/.viewstor/queries/` (autosave ignored)
- **Multi-statement execution** — cursor position determines which statement to run; CodeLens play buttons per statement with inline result/error indicators
- **SQL syntax highlighting in query bar** — keywords, strings, numbers, comments, operators highlighted in Table Data query editor
- **Copy as One-row** — context menu formats: `'` (SQL) and `"` (JSON); numeric values unquoted, NULL as `NULL`, strings properly escaped
- **Inline row insertion** — add new rows directly in table grid, edit cells before saving, validates required columns
- **Query result gutter icons** — success/error icons in editor gutter after execution
- **Debug logging** — `dbg()` utility for development diagnostics
- Prepare-release GitHub Actions workflow
- VS Code e2e test infrastructure with `@vscode/test-electron`

### Changed
- Query editors use `LogOutputChannel` instead of `OutputChannel` for structured logging
- Confirmation SQL files use metadata headers for connection routing

### Fixed
- **SQL injection via identifier quoting** — `quoteIdentifier()` now escapes embedded double quotes (`"` → `""`) in table/column names ([#46](https://github.com/Siyet/viewstor/issues/46))
- **ORDER BY stripping in subqueries** — `applySortToQuery()` now tracks parenthesis depth, won't corrupt nested queries
- **SQL keyword highlighting flicker** — removed `/g` flag from `SQL_KEYWORDS` regex that caused `lastIndex` state bugs
- **History: pinned file deleted** — no longer silently fails; falls through to create temp editor
- **Cursor on metadata line** — prevented negative offset passed to `getStatementAtOffset`
- **`formatOneRow` data loss** — string values `"null"`/`"NULL"` no longer silently converted to SQL NULL
- **SQL string tokenizer** — handles SQL `''` escape convention alongside backslash escapes
- **Memory leak** — `queryResults` map now cleaned up on document close (was only cleared on edit)
- **Save race condition** — inserts and edits sent as single atomic `saveAll` message instead of two independent messages
- **O(n×m) row lookup** — `_outOfQueryRows` check uses PK-based `Set` for O(1) lookup
- **Tmp cleanup race** — `cleanupTmp()` removes files individually instead of deleting the directory (prevents autosave crash)
- Sorting with custom query applies ORDER BY to the actual query, not the default `SELECT * FROM`
- "No connection associated" error after VS Code restart — metadata parsed from file content

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
