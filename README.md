# Viewstor

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="resources/banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="resources/banner-light.png">
    <img src="resources/banner-dark.png" alt="Viewstor" width="100%">
  </picture>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License"></a>
  <a href="https://code.visualstudio.com/"><img src="https://img.shields.io/badge/VS%20Code-%5E1.93.0-007ACC" alt="VS Code"></a>
  <a href="https://0ver.org"><img src="https://img.shields.io/badge/zerover-0.x-blue" alt="ZeroVer"></a>
</p>

<p align="center">
  <b>PostgreSQL + Redis + ClickHouse + SQLite in one extension.<br>Free. Open source. No paywalls.</b>
</p>

---

## Why Viewstor?

Database extensions for VS Code are either locked to one database, or freemium with crippled free tiers (limited connections, no export, closed source). Switching between DBeaver and VS Code breaks flow. DataGrip costs money.

Viewstor is a free, open-source extension that covers PostgreSQL, Redis, ClickHouse, and SQLite in a single tool — with features you won't find elsewhere:

| | Viewstor | Database Client | SQLTools | DBCode |
|---|---|---|---|---|
| **Price** | Free forever | Freemium | Free | Freemium |
| **Open source** | AGPL-3.0 | Closed (since v4.7) | MIT | Closed |
| **PG + Redis + CH + SQLite** | All free | Free tier limits | No Redis | Redis/CH paid |
| **Safe mode** | Block / Warn / Off | No | No | No |
| **Copilot Chat participant** | `@viewstor` | No | No | No |
| **MCP for AI agents** | Built-in, free | No | No | Paid tier |
| **Import from DBeaver/DataGrip/pgAdmin** | Yes | No | No | No |
| **Index hints** | Yes | No | No | No |
| **Chart visualization** | 12 chart types, free | No | No | No |
| **Data diff** | Row + schema diff, free | No | No | No |
| **Map view** | Built-in (Leaflet), free | No | No | No |
| **Color-coded folders** | Nested, inherited | No | No | No |
| **Localization** | 12 languages | English only | English only | English only |

## Get Started

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Siyet.viewstor):

```
ext install Siyet.viewstor
```

Or search **Viewstor** in the Extensions panel (`Ctrl+Shift+X`).

### Migrating from another tool?

`Ctrl+Shift+P` → **Viewstor: Import Connections** → pick your format:
- **[DBeaver](https://github.com/Siyet/viewstor/wiki/Migrating-from-DBeaver)** — `data-sources.json`
- **[DataGrip](https://github.com/Siyet/viewstor/wiki/Migrating-from-DataGrip)** — `dataSources.xml`
- **[pgAdmin](https://github.com/Siyet/viewstor/wiki/Migrating-from-pgAdmin)** — `servers.json`

Passwords are excluded for security — you'll enter them on first connect. See the [Wiki](https://github.com/Siyet/viewstor/wiki) for detailed migration guides.

---

## Features

### Safe Mode

Production databases deserve guardrails. Safe mode runs `EXPLAIN` before every `SELECT` and catches full table scans:

| Mode | Behavior |
|---|---|
| **Block** | Blocks queries with full scans. Shows EXPLAIN plan |
| **Warn** | Warning with "Run Anyway" / "See EXPLAIN" / "Cancel" |
| **Off** | No checks |

Supports PostgreSQL (`Seq Scan`), SQLite (`SCAN TABLE` via `EXPLAIN QUERY PLAN`), and ClickHouse. Set globally in settings or per connection. Auto-adds `LIMIT` to SELECTs that don't have one.

### Read-only Mode

Mark a connection or an entire folder as read-only. Child connections inherit the setting. Mutations are blocked in the query editor, result grid, and MCP commands.

### Connections

- **Nested folders** with drag-and-drop for connections and folders
- **Multi-database** — list several databases in one connection, each as a separate tree node
- **Color coding** — theme-aware palette or hex picker, tints icons; folders pass color to children
- **SSL** and **SSH tunnel** / **SOCKS5 proxy** support
- **Native VS Code form chrome** — Connection / Folder forms built on `@vscode-elements/elements` with `@vscode/codicons`; render correctly in light, dark, and high-contrast themes. Power-user settings (Safe mode override, Store in, Hidden schemas) tucked under a collapsible **Advanced** section so the default form stays short

### Schema Browser

- Tree: databases → schemas → tables, views, indexes, triggers, sequences
- Auto-collapse single-database and single-schema levels
- Hide schemas/databases from context menu
- Inaccessible objects (no permissions) rendered in error color

### Query Editor

- Per-connection SQL tabs (`Ctrl+Enter` to execute)
- **SQL autocomplete** — context-aware: tables after `FROM`/`JOIN`, columns from referenced tables, `table.column` dot trigger, alias resolution, **enum value suggestions** after `=`/`IN`
- **SQL diagnostics** — error underline for non-existent tables, warning for unknown columns
- **Index hints** — warning diagnostics on `WHERE`/`ORDER BY` columns without an index
- Cancel running queries (PG: `pg_cancel_backend`, CH: `AbortController`)

### Result Grid

- Server-side pagination (50 / 100 / 500 / 1000 rows)
- Estimated row count from statistics, exact count via refresh
- **CodeMirror 6 SQL editor** in the table query bar and diff panel — dialect-aware syntax highlighting, schema-aware autocomplete, inline table-name validation, undo/redo history, `Ctrl/Cmd+Enter` to execute
- **Editable SQL bar above the table** — edit the query in place, pagination stays live (host re-applies `LIMIT N OFFSET p*N` and fetches an exact `COUNT(*)` for the user's query); your explicit `LIMIT` acts as a ceiling across pages; only read-only SQL (`SELECT` / `WITH` / `EXPLAIN` / `SHOW` / `VALUES`) runs from the bar
- Inline editing with PK-based `UPDATE`, type-aware SQL (numeric PKs without quotes, `::jsonb` cast)
- **Add / delete rows** — insert with DEFAULT values, delete from toolbar or right-click context menu
- **Resizable columns** — drag column header edge to adjust width
- **Refresh button** — re-run current query without page reload
- Column sorting (shift-click for multi-column); manual `ORDER BY` in the SQL bar syncs back to the header indicators
- Cell selection with drag, Shift+Click range, resize handle
- Search with `Ctrl+F`, Enter to cycle matches

### Export & Copy

- Export all rows (not just current page) — CSV, TSV, JSON, Markdown
- Right-click cells → Copy as CSV / TSV / Markdown / JSON
- `Ctrl+C` copies selected cells as TSV

### Chart Visualization

Visualize query results as interactive charts — powered by [Apache ECharts](https://echarts.apache.org/):

- **12 chart types** — line, bar, scatter, pie, heatmap, radar, funnel, gauge, boxplot, candlestick, treemap, sunburst
- Click the **chart button** in the Result Panel toolbar to open the chart panel
- **Config sidebar** — axis mapping, aggregation, group by, area fill, legend
- **Auto-detection** — suggests the best chart type based on column types (time → line, categorical → pie, etc.)

**Multi-source charts** — overlay data from multiple queries on one chart:

1. Execute and **pin** queries you want to combine (pin icon in Query History)
2. Open a chart from any result set
3. Click **+ Data Source** in the chart toolbar, pick a pinned query
4. Choose merge mode:
   - **Separate series** — each source rendered as independent series (different X values are fine)
   - **Join by column** — rows matched by a key column (like SQL LEFT JOIN), additional Y columns merged into the primary dataset
5. Select which numeric columns to include, set a label — done

Example: pin `SELECT ts, cpu FROM metrics` and `SELECT ts, mem FROM metrics`, open chart from CPU, add Memory as data source with join on `ts` — both metrics on the same time axis.

### Data Diff

Compare data between tables — even across different connections (dev vs staging):

- Right-click a table → **Compare With...** → pick another table from any connected database
- **Row diff** — matches rows by primary key, highlights added/removed/changed cells side-by-side, zebra-striped rows
- **Schema diff** — compare column names, types, nullability, PK status, plus indexes, constraints, triggers, and sequences
- **Statistics diff** — side-by-side row count, table/index/total size, dead tuples, last vacuum/analyze, scan counters (PostgreSQL); row count, compressed/uncompressed size, compression ratio, parts, engine (ClickHouse); row count, table size, index/trigger counts (SQLite). Only shown when both sides are the same database type
- **Custom SQL** — editable queries per side under the collapsible "SQL" block, with Synced toggle + lock indicator for mirrored edits
- Tab headers show colored count badges (e.g. `Schema Diff •6`); filter chips per tab (click to solo, Shift+click to toggle)
- Export diff as CSV or JSON
- Configure max rows in settings (`viewstor.diffRowLimit`, default 10,000)

Also available via Command Palette: `Viewstor: Compare Data`.

### Map View

Plot geographic data on an interactive map — powered by [Leaflet](https://leafletjs.com/) with CARTO basemap tiles (© OpenStreetMap contributors, © CARTO), light/dark variant picked to match your VS Code theme:

- Click the **🗺 map button** in the Result Panel toolbar to open the map for the current result set
- **Auto-detects** coordinate columns:
  - GeoJSON Point (`{"type":"Point","coordinates":[lng,lat]}`)
  - WKT (`POINT(lng lat)`)
  - `{lat, lng}` / `{latitude, longitude}` objects
  - `[lng, lat]` arrays or PG array strings (`{lng,lat}`)
  - Separate `lat` / `lng` columns
- **Manual column picker** — toolbar has a **Mode** toggle (Single column / Lat + Lng) and selects for picking the coordinate and label columns by hand when auto-detection doesn't match; hover a field label for a tooltip with format hints
- **Circle markers** tinted with the VS Code accent color, with a popup (click) that shows the full row
- **Labels** — when the result contains ≤50 points the chosen label column is rendered permanently on each marker; otherwise it shows on hover
- Auto-zoom to fit all points; up to 10,000 points rendered per view

### Copilot Chat (`@viewstor`)

Ask questions about your database in natural language:

- `@viewstor describe the users table`
- `@viewstor write a query to find orders without payments`
- `@viewstor what indexes are missing for this query?`
- `@viewstor /chart show request latency over the last hour grouped by endpoint`

Schema context is injected automatically from the active connection. Slash commands: `/schema`, `/query`, `/describe`, `/chart`. Requires GitHub Copilot.

### AI Agent Integration (MCP)

Two MCP interfaces — pick the one that fits your workflow:

**VS Code MCP commands** (for Copilot, Cursor — agents running inside VS Code):

| Command | What it does |
|---|---|
| `viewstor.mcp.listConnections` | List connections with status |
| `viewstor.mcp.getSchema` | Flattened schema (tables, columns, types) |
| `viewstor.mcp.executeQuery` | Run SQL (read-only enforced) |
| `viewstor.mcp.getTableData` | Fetch rows with limit |
| `viewstor.mcp.getTableInfo` | Column metadata, PKs, nullability |
| `viewstor.mcp.visualize` | Execute query and open chart panel |
| `viewstor.mcp.openQuery` | Open SQL editor with query text (optionally execute) |
| `viewstor.mcp.openTableData` | Open table data view with optional custom query |

**Standalone MCP server** (for Claude Code, Cline — CLI agents running outside VS Code):

The extension installs a launcher at `~/.viewstor/mcp-server.js` that auto-updates on each activation — no manual path changes needed when the extension updates.

**Quick setup:** `Ctrl+Shift+P` → **Viewstor: Setup MCP** → **Copy Config** → paste into your agent's MCP config.

Or add manually:

```json
{
  "mcpServers": {
    "viewstor": {
      "command": "node",
      "args": ["~/.viewstor/mcp-server.js"]
    }
  }
}
```

9 tools: `list_connections`, `get_schema`, `execute_query`, `get_table_data`, `get_table_info`, `add_connection`, `reload_connections`, `build_chart`. Reads connections from `~/.viewstor/connections.json` and `.vscode/viewstor.json`. Connections sync bidirectionally with the VS Code extension. See the [MCP Server wiki page](https://github.com/Siyet/viewstor/wiki/MCP-Server) for setup instructions.

All MCP interfaces auto-connect and respect read-only mode.

Data-oriented tools (`execute_query`, `get_schema`, `get_table_data`, `get_table_info`, `build_chart`) accept an optional `database` parameter — query another database on the same server without creating a new connection or re-entering the password.

### Other

- Query history with execution time and row count — **click to re-execute**
- DDL viewer for tables, views, indexes, triggers, sequences
- JSON/JSONB cell editor with **syntax highlighting** (double-click to open)
- PostgreSQL arrays displayed with `{curly braces}`
- Redis — inspect strings, lists, sets, sorted sets, hashes
- SQLite — open `.sqlite`/`.db` files directly, file-based connection (no server needed)

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` / `Cmd+Enter` | Run query (or selected text) |
| `Ctrl+F` / `Cmd+F` | Search in result grid |
| `Enter` (in search) | Next match |
| `Ctrl+C` / `Cmd+C` | Copy selected cells |
| `Esc` | Close popups |

All shortcuts use physical key codes — work on any keyboard layout.

## Supported Databases

| Database | Protocol | Library |
|---|---|---|
| PostgreSQL | TCP | [pg](https://www.npmjs.com/package/pg) |
| Redis | TCP | [ioredis](https://www.npmjs.com/package/ioredis) |
| ClickHouse | HTTP | [@clickhouse/client](https://www.npmjs.com/package/@clickhouse/client) |
| SQLite | File | [better-sqlite3](https://www.npmjs.com/package/better-sqlite3) |

## Development

### Prerequisites

- Node.js 18+
- VS Code 1.93+
- Docker (for e2e tests)

### Commands

```bash
npm run dev          # development build
npm run watch        # rebuild on changes
npm run build        # production build
npm run lint         # ESLint check
npm run lint:fix     # auto-fix
npm test             # unit tests (vitest)
npm run test:e2e     # e2e tests (Docker required)
npm run package      # .vsix package
```

### Testing

700+ tests across three layers:

| Layer | Runner | Coverage |
|---|---|---|
| Unit tests | [vitest](https://vitest.dev/) | Pure logic: diff engine, chart transforms, query helpers, export/import, ConnectionManager, driver contracts, workflows |
| VS Code tests | Mocha + `@vscode/test-cli` | Extension activation, command registration, CodeLens, query editor |
| E2E tests | vitest + [testcontainers](https://www.npmjs.com/package/testcontainers) | Real PG/Redis/CH/SQLite drivers (Docker required, auto-skipped otherwise) |

### CI/CD

- **CI** (on PR, trunk push, tags): lint → unit tests → e2e tests → build → security audit → changeset size check
- **Changeset size** — warns when a PR changes 30+ files (historically the threshold for cascading regressions)
- **Release** (on `v*` tag): build → test → publish to Marketplace → GitHub Release with `.vsix`

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a full list of changes per version.

## License

[AGPL-3.0](LICENSE)
