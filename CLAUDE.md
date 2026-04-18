# CLAUDE.md

Guidance for Claude Code when working with this repository.

## What is Viewstor

VS Code extension for database management. Supports PostgreSQL, Redis, ClickHouse, SQLite. Free, open-source (AGPL-3.0) alternative to DBeaver/DataGrip. Follows [ZeroVer](https://0ver.org) — version 0.x until API is stable.

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

Optional: `getTableRowCount`, `getEstimatedRowCount` (pg_class.reltuples / system.tables), `getDDL`, `cancelQuery` (PG: pg_cancel_backend, CH: AbortController), `getCompletions` (structured: table/view/column/schema with parent), `getIndexedColumns` (pg_index query), `getTableObjects` (indexes, constraints, triggers, sequences — used by data diff), `getTableStatistics` (row count, sizes, vacuum info, scan counters — used by stats diff tab; PG uses `pg_table_size`/`pg_indexes_size` + `pg_stat_user_tables`, CH uses `system.tables` + `system.parts`, SQLite uses `COUNT(*)` + optional `dbstat` vtable).

Drivers: `postgres.ts` (pg), `redis.ts` (ioredis), `clickhouse.ts` (@clickhouse/client), `sqlite.ts` (better-sqlite3).

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

### Webview UI foundations
All form / panel webviews share a common UI stack (issue #86):

- **`@vscode-elements/elements`** — VS Code Web Components (`<vscode-textfield>`, `<vscode-single-select>`, `<vscode-checkbox>`, `<vscode-button>`, `<vscode-collapsible>`, `<vscode-icon>`, `<vscode-tabs>`, `<vscode-textarea>`, etc.). Bundled file copied to `dist/scripts/vscode-elements.js`; loaded as `<script type="module">`. Custom elements expose `.value` / `.checked` properties and emit `change` / `input` events just like native form controls.
- **`@vscode/codicons`** — icon font copied to `dist/styles/codicon.css` + `codicon.ttf`. Use via `<vscode-icon name="..." />` (slot `content-before` / `content-after` for buttons) or directly with `<i class="codicon codicon-..."></i>`.
- **`src/webview/scripts/webview-shell.js`** — loaded first in every webview HEAD; sets `window.__viewstorShellLoaded` marker. Centralizes the bundle path in case the loading strategy changes.
- **`src/webview/scripts/context-menu.js` + `src/webview/styles/context-menu.css`** — shared right-click menu primitive (#94). IIFE installs `window.ViewstorContextMenu` with `open({x, y, items}) → { el, close }` and `close()`. Items are `{ label, onClick, destructive? }` or `{ separator: true }`. Handles viewport clamping, click-outside (mousedown capture), and Escape. Opening a second menu closes the first. Also exports via `module.exports` for Node-side tests (see `src/test/contextMenu.test.ts`, loaded in `node:vm`). Diff Panel loads it via `<link>`+`<script src>`; Result Panel inlines the same source via `fs.readFileSync` on first `buildResultHtml` call (triple-path resolution: bundled `dist/scripts/…`, source `src/webview/scripts/…`, or tsc-compiled `dist/test/views/` climbing back to source) and caches the result for the rest of the session — lazy so extension activation never touches disk.
- **`src/webview/scripts/color-picker.js`** — shared color-picker widget used by the Connection and Folder forms (#94). Installs `window.ViewstorColorPicker` with `hslToHex(h,s,l)`, a `COLOR_PALETTE` of the 12 VS Code terminal ANSI theme colors, and `attach({ textEl, pickerEl, swatchEl, clearBtn?, randomBtn?, paletteEl? }) → { setValue, getValue }`. Keeps the hex↔picker↔swatch sync, palette population, and Random/Clear handlers in one place so the two forms don't drift.
- **`src/webview/styles/tokens.css`** — design tokens. Typography scale, spacing grid, semantic colors (`--viewstor-row-added/removed/changed/zebra`, `--viewstor-text-dimmed`, `--viewstor-border-subtle`, `--viewstor-badge-bg-*`, `--viewstor-form-max-width`). All derived from `--vscode-*` so themes apply automatically; high-contrast theme overrides via `@media (forced-colors: active)`.
- **CSP** — every panel sets `Content-Security-Policy` allowing only `cspSource` for img/style/font/script. Inline styles allowed (`style-src 'unsafe-inline'`) so per-element inline `style=` works.

Component patterns (#84 § 1.4):
- **Data grid** — zebra striping, monospace data, resizable columns, sticky header. Used in Result Grid + diff tables.
- **Toolbar** — grouped items with visual separators, consistent icon size (16px). Used in Result Grid + diff toolbar.
- **Badge** — rounded pill, semantic color, count + label. Used in diff summary, filter counts.
- **Empty state** — dimmed text + icon, no blank space. Used for zero-value charts and empty diff sections.
- **Collapsible section** — chevron + header + count badge, smooth toggle. Used for Schema Diff sections + Advanced settings.

### Forms
`src/views/connectionForm.ts` — webview panel built on `vscode-elements`. Field order (edit-flow optimized, #84 § 4.1): Name → DB Type → Host/Port → Username/Password → Databases (chips with server autocomplete — uses `postgres` as default DB to fetch list) → Database Number (Redis) / Database File (SQLite) → SSL → Proxy (SSH/SOCKS5/HTTP) → Color (picker + palette + random) → Read-only → **Advanced** (`vscode-collapsible`, collapsed by default): Safe mode override (block/warn/off), Store in (user/project), Hidden schemas. Hidden folderId. Footer: Test Connection (left, secondary) — spacer — Cancel / Save (right). Form is `max-width: 480px` centered. Webview script: `src/webview/scripts/connection-form.js`. Messages: save, testConnection, fetchDatabases, cancel.

`src/views/folderForm.ts` — webview panel using the same elements + tokens. Fields: name, color (picker + palette + random), Store in (user/project), readonly. Accepts parentFolderId for nested creation. Webview script: `src/webview/scripts/folder-form.js`.

### Result Panel
`src/views/resultPanel.ts` — webview. Server-side pagination (LIMIT/OFFSET). `ShowOptions`: connectionId, tableName, schema, pkColumns, color, readonly, pageSize, currentPage, totalRowCount, isEstimatedCount, orderBy.

Page sizes: [50, 100, 500, 1000], default 100.

Messages: changePage, changePageSize, reloadWithSort, saveEdits, openJsonInTab, exportAllData, refreshCount, cancelQuery, runCustomQuery.

Webview JS features: row numbers (sticky left), column sorting, drag-select with resize handle, unified selection border (sel-top/bottom/left/right), search with Enter navigation, context menu (copy as CSV/TSV/MD/JSON), JSON editor popup, export dialog, loading overlay with cancel button, PG array display with `{curly braces}`.

Table mode (connectionId + tableName) → server-side pagination + export all from DB.
Query mode → client-side data + export in-memory rows.

`safeJsonForScript()` escapes `</script>` and `<!--` in inline JSON.

"Visualize" button (`visualizeBtn`) sends `{ type: 'visualize', columns, rows }` → opens Chart Panel.

### Chart Panel
`src/chart/chartPanel.ts` — ChartPanelManager, webview panel for chart visualization. Uses Apache ECharts (loaded from `dist/scripts/echarts.min.js`).

`src/types/chart.ts` — EChartsChartType (12 types), GrafanaChartType (6 compatible), ChartConfig, AxisMapping, CategoryMapping, etc. `buildAggregationQuery()` generates DB-specific time bucketing: `date_trunc()` for PostgreSQL, `toStartOf*()` for ClickHouse, `strftime()` for SQLite. Custom buckets: `date_bin()` (PG), `toStartOfInterval()` (CH), `unixepoch` arithmetic (SQLite).

`src/chart/chartDataTransform.ts` — pure functions: `buildEChartsOption()` transforms QueryResult + ChartConfig into ECharts option. `suggestChartConfig()` auto-detects best chart type from column types. Builder registry per chart type. No vscode dependency, fully unit-tested.

`src/chart/grafanaExport.ts` — pure functions: `buildGrafanaDashboard()` converts ChartConfig to Grafana JSON (returns null for incompatible types). `pushToGrafana()` POSTs to Grafana HTTP API.

Chart types and Grafana mapping:
- axis charts: line → timeseries, bar → barchart, scatter → xychart, heatmap → heatmap
- category charts: pie → piechart, funnel/treemap/sunburst → no Grafana equivalent
- gauge → gauge, boxplot/candlestick/radar → no Grafana equivalent

Webview: `src/webview/scripts/chart-panel.js` (config sidebar + ECharts init), `src/webview/styles/chart-panel.css` (design tokens from `tokens.css`). Built on `@vscode-elements/elements` (`vscode-single-select` / `vscode-checkbox` / `vscode-textfield` / `vscode-button` / `vscode-icon`) + codicons + shared `tokens.css`, matching the connection form and diff panel patterns.

Messages: buildOption (webview → host, triggers `buildEChartsOption` or `buildMultiSourceEChartsOption`), setOption (host → webview), exportGrafana, copyGrafanaJson, saveGrafanaJson, pushToGrafana, showGrafanaJson, requestPinnedQueries, pinnedQueries, requestDataSourceColumns, dataSourceColumns.

Multi-source: `ChartDataSource` in config, resolved via `PinnedQueryProvider` (injected from `QueryHistoryProvider`). Merge modes: `join` (left join by key column via `joinByColumn()`) and `separate` (independent series). Webview manages data sources list, toolbar "+" button opens pinned query picker → config popup → adds to sidebar.

Settings: `viewstor.grafanaUrl`, `viewstor.grafanaApiKey` for direct Grafana push.

### Data Diff
`src/diff/diffEngine.ts` — pure functions: `computeRowDiff()` matches rows by key columns (PK or user-specified), compares all non-key columns by stringifying values. `computeSchemaDiff()` compares column names, types, nullability, PK status. `computeObjectsDiff()` compares indexes, constraints, triggers, sequences. `computeStatsDiff()` compares table-level statistics key-by-key, computes numeric delta + percent, preserves `badWhen` hint for red/green coloring. `formatStatValue()` formats bytes/count/percent/date. `buildDefaultDiffQuery()` generates the initial `SELECT * FROM <table> LIMIT <rowLimit>` for the editable-query UI. `exportDiffAsCsv()` / `exportDiffAsJson()` for diff export. No vscode dependency, fully unit-tested.

`src/diff/diffTypes.ts` — `DiffSource`, `DiffOptions`, `RowDiffResult`, `MatchedRow`, `SchemaDiffResult`, `ColumnCompare`, `ObjectsDiffResult`, `ObjectDiffItem`, `StatsDiffResult`, `StatsDiffItem`.

`src/diff/diffPanel.ts` — `DiffPanelManager`, webview panel for side-by-side diff visualization. Built on `@vscode-elements/elements` (`vscode-tabs` / `vscode-tab-header` / `vscode-tab-panel` / `vscode-collapsible` / `vscode-button` / `vscode-checkbox` / `vscode-icon`) + codicons + shared `tokens.css`. Tab headers carry custom `tab-badge` count chips that tint warn-color when the tab has real differences. Row Diff tab (added/removed/changed rows with cell-level highlighting; zebra striping via `--viewstor-row-zebra` on every tbody row, status classes win), Schema Diff tab (column comparison + objects, rendered as card blocks with the same zebra striping), Statistics tab (horizontal bar chart built with ECharts — each row normalized to its own max; zero-on-both-sides metrics collapse into an inline summary line rather than rendering empty cells; non-numeric "Other" metrics render as a card matching the chart/schema cards). Sticky `diff-source-bar` under the tabs labels Left / Right once so per-column sub-headers don't repeat source labels. All filter chips default to active so the diff opens with the complete picture; click to solo / Shift+click to toggle. Filter chips use shared `--viewstor-badge-bg-*` tokens. CSS rule `vscode-tab-panel[hidden] { display: none }` is load-bearing — without it the `display: flex` on `vscode-tab-panel` overrides the native hidden attribute and inactive tabs render stacked. Export as CSV/JSON. Swap sides button (preserves edited queries). Loads `dist/scripts/echarts.min.js` only when stats are present. Row Diff tab has a `vscode-collapsible` titled "SQL" with per-side `<textarea>` + `vscode-checkbox` Synced toggle (with visible `lock` codicon while on) + "Run Diff" button — when both connections are the same type, sync defaults ON and mirrors edits between panes. `runDiffQuery` message re-executes both queries via the drivers (`DiffPanelManager` takes an optional `ConnectionManager`) and recomputes only the row diff; schema / objects / stats tabs stay bound to the original tables. Rejects with inline errors if the new result sets don't carry the key columns.

`src/commands/diffCommands.ts` — `viewstor.compareWith` (context menu on tables), `viewstor.compareData` (command palette). Auto-detects PK columns; prompts user if no PK found. Fetches data + objects + statistics from both sources (stats only when both connections are the same `type`), computes diff, opens panel.

Settings: `viewstor.diffRowLimit` (default 10000, max 100000).

### Map View
`src/map/mapDataTransform.ts` — pure functions: `detectCoordMode()` picks single-column (by type/name hint) or `lat`/`lng` pair; `parseGeoValue()` decodes GeoJSON Point, WKT `POINT(lng lat)`, `{lat,lng}` objects, `[lng,lat]` arrays, PG brace arrays `{lng,lat}`, JSON strings of the above; `extractPoints()` runs rows through the configured mode; `suggestLabelColumn()` picks a marker label column by priority (`name > title > label > description > code > id`). No vscode dependency, fully unit-tested.

`src/map/mapPanel.ts` — `MapPanelManager`, webview panel for Leaflet map. Bundles `leaflet.js` + `leaflet.css` + marker images via webpack `CopyPlugin` into `dist/scripts/` and `dist/styles/images/`. Patches `L.Icon.Default` paths to `webview.asWebviewUri(...)` so markers render under the `vscode-webview:` scheme. CSP allows `https:` for OpenStreetMap tiles. Messages: `setPoints` (host → webview), `ready`/`changeMode`/`changeLabel` (webview → host). Limits rendering to 10,000 points (configurable via `MapShowOptions.pointLimit`).

`src/commands/mapCommands.ts` — `viewstor.showOnMap`. Triggered by the 🗺 button in the result panel toolbar. Shows a warning if no coordinate format is detected.

Webview: `src/webview/scripts/map-panel.js` (Leaflet init, OpenStreetMap tiles, marker tooltips + row popups), `src/webview/styles/map-panel.css` (VS Code theme vars for popups).

Binary WKB (PostGIS hex) is **not** parsed — drivers should return WKT or GeoJSON when possible. Clustering and "color by value" are not implemented yet.

### SQL Autocomplete
`src/editors/completionProvider.ts` — CompletionItemProvider triggered on `.`. Caches per connection (60s TTL, tracked timers for cleanup). Context-aware: after FROM/JOIN → tables only, after `table.` → that table's columns, general context → columns from query's referenced tables + tables + keywords. Aliases resolved from `FROM table AS alias`. Enum value suggestions after `=`/`!=`/`<>`/`IN` operators (PG: fetches from `pg_enum`).

### SQL Diagnostics
`src/editors/sqlDiagnosticProvider.ts` — DiagnosticProvider. Debounced 500ms. Validates table references after FROM/JOIN against cached schema — Error for non-existent tables, Warning for unknown columns with `table.column` prefix. Shares schema cache pattern with CompletionProvider. Only fires for connected SQL documents.

### Index Hints
`src/editors/indexHintProvider.ts` — DiagnosticProvider. Debounced 500ms. Parses WHERE/ORDER BY columns, queries `getIndexedColumns()`, shows Warning diagnostic. Handles aliases and multi-table queries. Only fires for connected SQL documents. Skips small tables (below configurable `indexHintThreshold`, default 100k rows).

### Safe Mode
`src/commands/index.ts` — before executing SELECT queries, runs EXPLAIN to detect full table scans. Three modes: `block` (prevents execution, shows EXPLAIN), `warn` (shows warning with Run Anyway/See EXPLAIN/Cancel), `off` (no checks). Configurable globally via `viewstor.safeMode` setting or per connection. Auto-adds `LIMIT` to SELECTs missing it. Multi-DB support: PostgreSQL (`EXPLAIN` + `Seq Scan`), SQLite (`EXPLAIN QUERY PLAN` + `SCAN TABLE`), ClickHouse (`EXPLAIN` + `Full`).

### Tunnels
`src/connections/tunnel.ts` — SSH tunnel via `ssh2` library (port forwarding). SOCKS5 proxy via raw socket negotiation. Used by PostgreSQL driver when `config.proxy` is set. Tunnel cleaned up on disconnect or connect failure.

### Chat Participant
`src/chat/participant.ts` — Copilot Chat participant `@viewstor`. Registered via `vscode.chat.createChatParticipant()`. Slash commands: `/schema` (dump schema), `/describe <table>` (table info), `/query` (generate SQL), `/chart` (generate SQL + open chart visualization). Resolves active connection from query editor URI or first connected connection. Injects schema context (tables + columns + types) as system prompt. Uses `vscode.lm.selectChatModels()` to forward to Copilot LLM. Respects readonly mode in system prompt. Requires VS Code 1.93+.

### MCP
`src/mcp/server.ts` — 7 VS Code commands for AI agents:
- `viewstor.mcp.listConnections` → connection list with status
- `viewstor.mcp.getSchema` → flattened schema (name, type, path, detail)
- `viewstor.mcp.executeQuery` → SQL execution (readonly enforced: only SELECT/EXPLAIN/SHOW/WITH)
- `viewstor.mcp.getTableData` → rows with column metadata
- `viewstor.mcp.getTableInfo` → column details with PK/nullable
- `viewstor.mcp.visualize` → execute query and open chart panel
- `viewstor.mcp.exportGrafana` → generate Grafana dashboard JSON
- `viewstor.mcp.openQuery` → open SQL editor with query text (optionally execute)
- `viewstor.mcp.openTableData` → open table data view with optional custom query

All auto-connect. Returns structured JSON or `{ error }`.

### Standalone MCP Server
`src/mcp-server/index.ts` — stdio-based MCP server for CLI agents (Claude Code, etc.). Built as separate webpack entry → `dist/mcp-server.js`. Uses `@modelcontextprotocol/sdk`. Does NOT import `vscode`.

`src/mcp-server/connectionStore.ts` — reads connections from `~/.viewstor/connections.json` (user) and `.vscode/viewstor.json` (project). Manages driver lifecycle.

9 tools: `list_connections`, `get_schema`, `execute_query`, `get_table_data`, `get_table_info`, `add_connection`, `reload_connections`, `build_chart`, `export_grafana_dashboard`.

Data-oriented tools (`execute_query`, `get_schema`, `get_table_data`, `get_table_info`, `build_chart`) accept an optional `database` parameter. `ConnectionStore.ensureDriverForDatabase()` mirrors `ConnectionManager.getDriverForDatabase()` — caches per `connectionId:database`, reuses host/user/password/ssl. VS Code MCP commands accept `database` as a trailing optional arg.

Usage in Claude Code config:
```json
{ "mcpServers": { "viewstor": { "command": "node", "args": ["/path/to/viewstor/dist/mcp-server.js"] } } }
```

### Services
`src/services/exportService.ts` — ExportService static methods: toCsv (configurable delimiter/quotes/null/header/lineEnding), toTsv, toJson, toMarkdownTable, toPlainTextTable.

`src/services/importService.ts` — parseDBeaver (data-sources.json), parseDataGrip (dataSources.xml, regex XML), parsePgAdmin (servers.json). Maps providers to DatabaseType, skips unsupported with warnings. No password import.

### Utilities
`src/utils/queryHelpers.ts` — pure functions for SQL generation and error enhancement: `levenshtein`, `parseTablesFromQuery`, `enhanceColumnError`, `buildUpdateSql`, `buildDeleteSql`, `buildInsertDefaultSql`, `quoteTable`, `sqlValue`. All vscode-independent, fully unit-tested.

### Commands
`src/commands/` — split into focused modules to prevent regressions:

| File | Scope |
|---|---|
| `index.ts` | Orchestrator: registers CodeLens, document handlers, delegates to modules |
| `shared.ts` | `CommandContext` interface, shared state (queryResults, historyDocMap), helpers |
| `queryCommands.ts` | `runQuery`, `executeTempSql`, `cancelQuery`, safe mode, TempFileManager callbacks |
| `tableCommands.ts` | `showTableData`, `_fetchPage`, `_saveEdits`, `_insertRow`, `_deleteRows`, `_runCustomTableQuery`, MCP table |
| `connectionCommands.ts` | Connection/folder CRUD, import, schema visibility |
| `historyCommands.ts` | Query history: open, pin, unpin, rename, clear |
| `schemaCommands.ts` | `showDDL`, `copyName`, rename/create/drop objects, `reportIssue` |
| `exportCommands.ts` | Export (CSV/TSV/JSON/Markdown), visualize, Grafana, MCP query |
| `diffCommands.ts` | `compareWith` (context menu), `compareData` (command palette) |

All commands support `databaseName` parameter for multi-DB connections.

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
- SQLite: file-based connection (`config.database` = file path or `:memory:`), no host/port/auth. Uses `sqlite_master` + `PRAGMA table_info()` for schema. `getEstimatedRowCount()` falls back to exact `COUNT(*)`. WAL journal mode enabled on connect (skipped for readonly). Foreign keys always enabled. Connection form shows file picker instead of host/port fields. `inferTypeFromValue()` detects column types for computed expressions (COUNT→INTEGER, SUM→REAL).
- SQLite native module: `better-sqlite3` requires different prebuilds for Node.js (tests) and Electron (Extension Host). `scripts/sqlite-rebuild.js` manages dual builds with `prebuild-install` (NOT `electron-rebuild` which is broken). Cache in `node_modules/.cache/sqlite-builds/` with `.meta` files. `npm run dev/build/watch` auto-restores Electron binary; `npm test` switches to Node.js binary.
