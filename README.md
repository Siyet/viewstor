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
  <b>PostgreSQL + Redis + ClickHouse in one extension.<br>Free. Open source. No paywalls.</b>
</p>

---

## Why Viewstor?

Database extensions for VS Code are either locked to one database, or freemium with crippled free tiers (limited connections, no export, closed source). Switching between DBeaver and VS Code breaks flow. DataGrip costs money.

Viewstor is a free, open-source extension that covers PostgreSQL, Redis, and ClickHouse in a single tool — with features you won't find elsewhere:

| | Viewstor | Database Client | SQLTools | DBCode |
|---|---|---|---|---|
| **Price** | Free forever | Freemium | Free | Freemium |
| **Open source** | AGPL-3.0 | Closed (since v4.7) | MIT | Closed |
| **PG + Redis + CH** | All free | Free tier limits | No Redis | Redis/CH paid |
| **Safe mode** | Block / Warn / Off | No | No | No |
| **Copilot Chat participant** | `@viewstor` | No | No | No |
| **MCP for AI agents** | Built-in, free | No | No | Paid tier |
| **Import from DBeaver/DataGrip/pgAdmin** | Yes | No | No | No |
| **Index hints** | Yes | No | No | No |
| **Color-coded folders** | Nested, inherited | No | No | No |

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

Production databases deserve guardrails. Safe mode runs `EXPLAIN` before every `SELECT` and catches sequential scans on large tables:

| Mode | Behavior |
|---|---|
| **Block** | Blocks queries with Seq Scan. Shows EXPLAIN plan |
| **Warn** | Warning with "Run Anyway" / "See EXPLAIN" / "Cancel" |
| **Off** | No checks |

Set globally in settings or per connection. Auto-adds `LIMIT` to SELECTs that don't have one.

### Read-only Mode

Mark a connection or an entire folder as read-only. Child connections inherit the setting. Mutations are blocked in the query editor, result grid, and MCP commands.

### Connections

- **Nested folders** with drag-and-drop for connections and folders
- **Multi-database** — list several databases in one connection, each as a separate tree node
- **Color coding** — theme-aware palette or hex picker, tints icons; folders pass color to children
- **SSL** and **SSH tunnel** / **SOCKS5 proxy** support

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
- Inline editing with PK-based `UPDATE` (disabled in read-only)
- Column sorting (shift-click for multi-column)
- Cell selection with drag, Shift+Click range, resize handle
- Search with `Ctrl+F`, Enter to cycle matches

### Export & Copy

- Export all rows (not just current page) — CSV, TSV, JSON, Markdown
- Right-click cells → Copy as CSV / TSV / Markdown / JSON
- `Ctrl+C` copies selected cells as TSV

### Copilot Chat (`@viewstor`)

Ask questions about your database in natural language:

- `@viewstor describe the users table`
- `@viewstor write a query to find orders without payments`
- `@viewstor what indexes are missing for this query?`

Schema context is injected automatically from the active connection. Slash commands: `/schema`, `/query`, `/describe`. Requires GitHub Copilot.

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

**Standalone MCP server** (for Claude Code, Cline — CLI agents running outside VS Code):

```json
{
  "mcpServers": {
    "viewstor": {
      "command": "node",
      "args": ["/path/to/viewstor/dist/mcp-server.js"]
    }
  }
}
```

7 tools: `list_connections`, `get_schema`, `execute_query`, `get_table_data`, `get_table_info`, `add_connection`, `reload_connections`. Reads connections from `~/.viewstor/connections.json` and `.vscode/viewstor.json`. Connections sync bidirectionally with the VS Code extension. See the [MCP Server wiki page](https://github.com/Siyet/viewstor/wiki/MCP-Server) for setup instructions.

All MCP interfaces auto-connect and respect read-only mode.

### Other

- Query history with execution time and row count — **click to re-execute**
- DDL viewer for tables, views, indexes, triggers, sequences
- JSON/JSONB cell editor with **syntax highlighting** (double-click to open)
- PostgreSQL arrays displayed with `{curly braces}`
- Redis — inspect strings, lists, sets, sorted sets, hashes

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

Unit tests use [vitest](https://vitest.dev/). E2E tests use [testcontainers](https://www.npmjs.com/package/testcontainers) to spin up PostgreSQL, Redis, and ClickHouse in Docker. Auto-skipped if Docker is unavailable.

### CI/CD

- **CI** (on PR, trunk push, tags): lint → unit tests → build → `npm audit`
- **Release** (on `v*` tag): build → test → publish to Marketplace → GitHub Release with `.vsix`

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a full list of changes per version.

## License

[AGPL-3.0](LICENSE)
