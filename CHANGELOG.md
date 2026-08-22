# Changelog

All notable changes to Viewstor are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.5.3] — 2026-08-18

### Added
- **Chained (double-hop) SSH tunnels** — an SSH-proxied connection can now hop through an additional jump host before reaching the database, for bastion + private-subnet topologies where the target isn't reachable directly from the first hop. Configure it under Proxy / Tunnel → "Connect through a second SSH hop (jump host)" in the connection form, including a passphrase field for an encrypted private key on that second hop.

### Changed
- SSH-proxied connections in the Connections tree now show the SSH host:port you actually connect through, instead of the tunnel's internal local-forwarded-port address.
- The connection form gained a Private Key Passphrase field for the first SSH hop, alongside the one for the second — an encrypted key could not be used there before.

### Fixed
- **SSH-tunneled connections could fail with "Connection terminated unexpectedly"** — the tunnel could start accepting traffic before the SSH session finished authenticating, occasionally crashing the SSH session outright. This showed up most often on password-authenticated connections, whose slower handshake made the race easier to hit. The tunnel now always waits for the SSH session to be ready first ([#128](https://github.com/Siyet/viewstor/issues/128)).
- Project-scope connections (`.vscode/viewstor.json`) no longer write SSH/proxy passwords or private keys to disk — only the database password was being stripped before.
- Saving a project-scope connection's SSH password or private key no longer wipes it back out of the current session — reloading `.vscode/viewstor.json` (which by design holds no credentials) now restores the ones entered this session instead of dropping them, whether the reload was triggered by the extension's own save or by a genuine outside change. Credentials are only restored to the host and user they were entered for, so a connection repointed at a different server in the shared file asks for its own credentials rather than reusing the previous host's.
- **An SSH-tunneled connection dropping mid-session (query cancellation, DB restart, an idle timeout) could crash the whole extension host**, not just that connection — an ordinary TCP reset reaching the tunnel had no error handling and threw uncaught. The tunnel now closes just the affected connection (both its local side and its actual SSH-forwarded connection to the database) and keeps running.
- **Chained SSH tunnels could hang indefinitely while connecting** if an already-connected hop dropped while the next hop was still connecting through it — that failure mode never raised an error to react to. Connecting now aborts cleanly with an error instead of hanging.
- **An SSH tunnel could go zombie** — still listening locally, but talking to nothing — if a hop's connection closed cleanly (an sshd restart or graceful shutdown, not a reset) once the tunnel was already established; that case never emitted an error either. The tunnel is now torn down correctly either way.
- A connecting SSH hop that lost out to a chain failure elsewhere (see above) could keep running in the background indefinitely instead of being closed along with the rest of the failed connection attempt.
- **Connecting to an SSH-tunneled database could hang forever with no error** if the SSH connection dropped mid-handshake (an sshd hitting its connection/login limits, a network blip during key exchange, a bastion actively rejecting the attempt) — past the very first moment of the handshake, that failure mode only ever closes the connection, it doesn't raise an error. This predates chained tunnels entirely; connecting now always fails with a clear error instead of hanging.

## [0.5.2] — 2026-08-14

### Changed
- **One shared SQL highlighter for Result and Diff panels** — both editable-query surfaces now execute the same shipped `sql-highlight.js` asset instead of maintaining separate tokenizers. The shared scanner preserves arbitrary Unicode text, escapes HTML-like input, handles common PostgreSQL/MySQL/SQL Server quoting and comments, and is covered by multilingual runtime, consumer-order, large-input, and XSS regression tests. Query editors no longer soft-wrap long lines: they use horizontal scrolling and keep line breaks under explicit user control; in the Result table query bar `Shift+Enter` inserts a line while plain `Enter` runs the query ([#94](https://github.com/Siyet/viewstor/issues/94)).

## [0.5.1] — 2026-08-14

### Added
- **Data diff: safe cross-DB-type Statistics tab** — comparisons such as PostgreSQL ↔ ClickHouse and SQLite ↔ PostgreSQL now show statistics when both drivers provide them. Cross-type mode uses an explicit semantic contract instead of trusting matching key names: row count is currently the only common metric (with a visible note that some engines estimate it), while incompatible storage and engine-specific metrics are counted and hidden. The tab includes a clear empty state when no metrics are comparable, branded database names, accessible theme-aware messaging, and in-place Swap Sides behavior ([#74](https://github.com/Siyet/viewstor/issues/74)).
- **Search in Row Diff** — search both sides of a comparison at once with highlighted matches, a live result count, `Enter` / `Shift+Enter` navigation, `Escape` to clear, and `Ctrl/Cmd+F` focus. Search results stay synchronized after status filtering and query reruns.
- **Normalized statistics keys across all drivers** — every driver's `getTableStatistics` emits `row_count`, `total_size`, and `last_modified` when meaningful, with unavailable values represented as `null`. Redis gains key statistics, SQLite reports table-plus-index pages through `dbstat`, and ClickHouse reports the latest active part write. Sharing a key does not imply that differently defined storage metrics are comparable across engines; cross-type Statistics continues to compare only the explicit semantic allowlist ([#74](https://github.com/Siyet/viewstor/issues/74)).

### Changed
- **Result Grid readability and toolbar layout** — added subtle theme-aware zebra striping and grouped status, search, export/visualization, row editing, and pagination controls. The toolbar now wraps cleanly in narrow editor panes, exposes accessible control groups, and keeps dividers visible in high-contrast themes ([#84](https://github.com/Siyet/viewstor/issues/84)).

### Fixed
- Preserved hover, selection, search, validation, and new-row highlights on both odd and even rows so zebra striping never hides a more important state.
- Restored opening table data immediately after editing a connection, including switching Read-only off: cached tree items now reconnect the driver automatically instead of silently closing the loading panel.
- Cross-database row comparisons now treat equivalent numeric representations such as PostgreSQL `716.90` and ClickHouse `716.9` as equal without losing precision for large numeric values; text identifiers with leading zeroes remain distinct.
- Cross-database row comparisons now treat PostgreSQL booleans as equivalent to SQLite/ClickHouse `0`/`1` flags when the column types establish boolean semantics, and normalize equivalent UTC timestamp representations without weakening ordinary text or numeric comparisons.
- PostgreSQL views no longer report the internal `-1` row-estimate sentinel. View statistics fall back to an exact `COUNT(*)`, or show the metric as unavailable when the relation cannot be read.
- ClickHouse views now show their actual row count in Statistics: when `system.tables.total_rows` is unavailable, Viewstor falls back to an exact `COUNT(*)` and preserves an unavailable value instead of reporting a misleading zero if the view cannot be read.
- Development builds now detect the Electron runtime used by current macOS VS Code releases and fall back to an architecture-correct source build when a matching `better-sqlite3` prebuild is unavailable.
- Release packages no longer include local environment setup, agent instructions, test fixtures, or VS Code test-runner configuration.
- SQLite tables and views now appear in the **Compare With...** picker alongside PostgreSQL and ClickHouse objects; the picker supports both flat and namespace-nested driver schemas.
- Compare Tables no longer opens an empty diff when a driver returns a data-loading error as part of its query result; both entry points now surface the original error and leave the current workspace unchanged.
- Stabilized edited-SQL reruns in Diff panels: disconnected sources reconnect once, the latest request wins over stale concurrent responses, closing or swapping a panel invalidates pending work, and readonly, one-sided, or missing-column errors preserve the previous successful diff.
- Table/view comparisons now resolve compatible primary keys from either side and, when schemas differ, show exact matches, suggested similar-name pairs, and one-sided fields in a separate column picker. Exact pairs are selected safely by default; explicit mappings such as `lifetime_value ↔ total_value` are supported, while unchecked side-only fields remain in Schema Diff instead of marking every matched row as changed. ClickHouse primary keys are resolved from `system.columns`.

## [0.5.0] — 2026-08-13

### Added
- **Interactive ER diagrams** — open a diagram from a connected connection, database, or schema and explore tables, views, columns, indexes, and foreign-key relationships on one continuous canvas. PostgreSQL and SQLite provide native relationship metadata; ClickHouse renders its available structure and database regions without inventing unsupported foreign keys ([#6](https://github.com/Siyet/viewstor/issues/6)).
- Namespace regions group PostgreSQL schemas and ClickHouse databases. Complete table cards distinguish views with purple dashed borders and mark `PK`, `FK`, `IDX`, required columns, comments, and index names.
- Search covers tables, views, and columns. Multiple results highlight matching cards; a unique or selected result opens its direct-neighbour graph. Results reuse the legend's blue table and purple view colors.
- Table and view cards expose the same context actions as the Connections tree through a shared action registry.

### Changed
- Zoom and pan use one synchronized camera transform for card frames, text, spacing, edges, regions, and hit-testing. Blank-canvas left-drag, middle-drag, and wheel zoom work across the full canvas.
- Relationship lines stay below cards, are muted below `3×`, and reveal arrowheads, hover emphasis, and tooltips from `3×`. Hover fades unrelated objects with a short transition.
- The compact toolbar provides search plus icon-only Refresh and relationship controls with explanatory tooltips. The relationship icon is crossed out while edges are hidden; internal rendering diagnostics are no longer shown.

### Fixed
- Prevented table-card overlap and relationship lines crossing card contents in both the full diagram and isolated neighbour graphs.
- Restored double-click isolation and blank-canvas/Escape return to the full graph, including correct layout immediately after switching views.
- Made zoomed cards scale as unified graphics so frames and typography no longer resize at different times or produce the previous “jelly” effect.

## [0.4.0] — 2026-04-29

### Added
- **Pinecone vector database driver** — browse indexes and namespaces, query vectors by similarity, upsert/delete vectors, view index statistics. Connection uses API key (no host/port). Custom command syntax: `QUERY <index> vector=[...] topK=N`, `UPSERT`, `DELETE`, `STATS`, `LIST`. Read-only mode disables upsert/delete ([#15](https://github.com/Siyet/viewstor/issues/15))

### Fixed
- **Pagination broken after running a custom query in table mode** — editing the SQL in the table view ran the query once and showed `Page 1/1`; clicking Next silently reverted to the original table. `_runCustomTableQuery` now accepts a `page` parameter, strips the trailing `LIMIT [OFFSET]`, re-applies server-side `LIMIT pageSize OFFSET page*pageSize`, and gets the exact row count via `SELECT COUNT(*) FROM (<user query>) _sub`. Webview forwards the active custom query on every `changePage` / `changePageSize` so the host routes back to the same query instead of falling back to the default table fetch. User's explicit `LIMIT` is respected as a ceiling — e.g. `LIMIT 250` with `pageSize=100` yields exactly `100 + 100 + 50` rows across three pages, not `100 + 100 + 100`. When the count query fails (exotic SQL) pagination falls back to a "page full ⇒ probably more" heuristic. Manual ORDER BY in the SQL bar now syncs back to the header sort icons on Run. Destructive statements (VACUUM / INSERT / UPDATE / DELETE / DROP / …) are blocked at the host — only SELECT / WITH / EXPLAIN / SHOW / VALUES / TABLE are executed. Clearing the SQL bar and pressing Refresh re-populates the field with the default table SELECT so the baseline is always recoverable

### Changed
- **Shared context-menu primitive for Result + Diff panels** — extracted the duplicated right-click menu into a single `src/webview/scripts/context-menu.js` + `src/webview/styles/context-menu.css` module that installs `window.ViewstorContextMenu` with `open({x, y, items}) / close()`. Result Panel's Copy / Select Column / Delete Row(s) menu and Diff Panel's Copy / Copy with Headers / Copy as CSV·TSV·MD·JSON menu now share the same open/close semantics, viewport clamping, click-outside + Escape handling, and destructive-item styling. The Diff Panel loads the module via `<script src>`; the Result Panel inlines the same source at module load. Unit-tested via `node:vm` (see `src/test/contextMenu.test.ts`). Part of ([#94](https://github.com/Siyet/viewstor/issues/94))
- **Shared webview color picker** — extracted the swatch + hex textfield + Random/Clear buttons + theme-color palette shared by the Connection and Folder forms into a single `src/webview/scripts/color-picker.js` widget installed on `window.ViewstorColorPicker`. Both forms now call `ViewstorColorPicker.attach({ textEl, pickerEl, swatchEl, clearBtn, randomBtn, paletteEl })`, replacing two near-identical copies of `hslToHex` + the palette array that had to be kept in sync by hand. New `colorPicker.test.ts` (27 tests) covers `hslToHex` edge cases, the 12-color palette shape, and the full attach/setValue/getValue DOM wiring ([#94](https://github.com/Siyet/viewstor/issues/94))
- **Chart panel on @vscode-elements/elements** — migrated Chart Panel toolbar, config sidebar, and popup dialogs to `vscode-single-select` / `vscode-checkbox` / `vscode-textfield` / `vscode-button` / `vscode-icon`; applied shared `tokens.css` design tokens (typography scale, spacing grid, semantic colors) and codicons (refresh, add, close, copy, save, cloud-upload); toolbar buttons use `vscode-button` with icon slots; sidebar selects use `vscode-single-select` + `vscode-option`; multi-select checkbox lists use `vscode-checkbox`; popup close/action buttons use `vscode-button` with `vscode-icon`; added CSP header matching other panels; ECharts canvas untouched ([#88](https://github.com/Siyet/viewstor/issues/88))
- **Diff panel on @vscode-elements/elements + UX polish** — migrated the Row/Schema/Statistics diff panel to `vscode-tabs` / `vscode-tab-header` / `vscode-tab-panel` / `vscode-collapsible` / `vscode-button` / `vscode-checkbox` / `vscode-icon`; tab headers now show colored count badges (e.g. `Schema Diff •6`) that switch to a warning tint when a side actually differs; filter chips are themed via shared `--viewstor-badge-bg-*` tokens so added/removed/changed colors match the rest of the UI; all filter chips default to active so the diff opens with the complete picture; Row Diff, Schema Diff, objects diff and "Other" stats tables use zebra striping via `--viewstor-row-zebra` with added/removed/changed status tints taking precedence, status rows alternate via `color-mix` so the stripe reads on red/green/yellow rows too, and the per-row border was removed so the 2px header border stands out. Cells in every diff table are now drag-selectable with the same grammar as the Result Grid — click, drag, Shift+click to extend, Ctrl/Cmd+C copies TSV, right-click opens a context menu with Copy / Copy with Headers / Copy as CSV / Markdown / JSON. UX fixes from [#84 § 3](https://github.com/Siyet/viewstor/issues/84): visible `lock` codicon next to the Synced checkbox while sync is on; the SQL editor block renamed to a compact "SQL" collapsible with an info-icon tooltip instead of an inline hint; sticky Left / Right source bar under the tabs so per-column sub-headers no longer repeat the source labels; `— / —` double-empty cells collapse to a single dim `–`; zero-on-both-sides numeric stats collapse into an inline summary line instead of rendering empty chart cells; "Other" non-numeric stats render as a card matching the chart / schema cards ([#87](https://github.com/Siyet/viewstor/issues/87))

### Added
- **Agent anonymization at the MCP boundary** — optional PII masking for rows returned by MCP tools (Claude Code, Cursor, VS Code agents). Three modes: `off`, `heuristic` (mask columns whose names match `email` / `phone` / `ssn` / `iban` / `token` / etc.), and `strict` (mask every text-like column regardless of name). Four strategies: `hash` (deterministic SHA-256 → 8 hex chars, JOIN-safe), `shape` (format-preserving: `alice@example.com` → `x@y.xxx`, Luhn-validated card digits → `x`, phone digits → `0`), `null`, and `redacted` (empty string). Configurable per connection and per folder (folder settings inherit down); defaults to `off`. Error messages from the driver are also scrubbed so constraint violations don't leak raw values. Applied at both MCP surfaces: VS Code in-process commands (`viewstor.mcp.executeQuery` / `getTableData` / `getTableInfo` / `visualize`) and the standalone stdio server (`execute_query` / `get_table_data` / `get_table_info` / `build_chart`). `get_table_info` now also scrubs `defaultValue` so PII embedded in DDL literals (`DEFAULT 'admin@acme.com'::varchar`) does not leak. Covered by a VS Code API e2e suite (`src/test/vscode/mcpAnonymization.vscode.test.ts`, 16 tests against a real Postgres testcontainer) on top of the unit-level `anonymizer.test.ts` ([#72](https://github.com/Siyet/viewstor/issues/72))
- **Map view** — plot geographic points from query results on an interactive Leaflet map. Auto-detects GeoJSON, WKT `POINT(...)`, `{lat,lng}` objects, `[lng,lat]` arrays, PG array strings, and separate `lat`/`lng` column pairs. Accessible via 🗺 button in the result panel toolbar. Markers have a label tooltip and a popup with full row data; auto-zoom fits all points; truncates at 10,000 points ([#7](https://github.com/Siyet/viewstor/issues/7))
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
