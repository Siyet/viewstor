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
  <a href="https://code.visualstudio.com/"><img src="https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC" alt="VS Code"></a>
</p>

<p align="center">
  Browse schemas, write queries, inspect data — across PostgreSQL, Redis, and ClickHouse.
</p>

## Supported Databases

| Database | Protocol | Library |
|---|---|---|
| PostgreSQL | TCP | [pg](https://www.npmjs.com/package/pg) |
| Redis | TCP | [ioredis](https://www.npmjs.com/package/ioredis) |
| ClickHouse | HTTP | [@clickhouse/client](https://www.npmjs.com/package/@clickhouse/client) |

## Features

### Connections
- Nested folders with drag-and-drop for connections and folders
- Multi-database — list several databases in one connection, each shown as a separate node
- Color coding — theme-aware palette (ANSI terminal colors) or random generator, tints folder/connection icons
- Read-only mode — per connection or folder (inherited by child connections)
- Import from **DBeaver** (`data-sources.json`), **DataGrip** (`dataSources.xml`), **pgAdmin** (`servers.json`)
- Database field autocomplete — fetches available databases from the server on focus

### Schema Browser
- Tree view: databases → schemas → tables, views, indexes, triggers, sequences
- Auto-collapse single-database and single-schema levels
- Hide schemas and databases from context menu, restore with "Show All Hidden"
- Inaccessible objects (no permissions) rendered in error color

### Query Editor
- Per-connection SQL tabs (`Ctrl+Enter` / `Cmd+Enter` to execute)
- **SQL autocomplete** — tables after `FROM`/`JOIN`, columns from referenced tables only, `table.column` dot trigger, alias support, SQL keywords
- **Index hints** — warning underline when `WHERE` or `ORDER BY` columns lack an index
- Cancel running queries (PostgreSQL: `pg_cancel_backend`, ClickHouse: `AbortController`)

### Result Grid
- Server-side pagination (50 / 100 / 500 / 1000 rows per page)
- Estimated row count from statistics (`~N rows`), exact count via refresh button
- Inline editing with PK-based `UPDATE` (disabled in read-only mode)
- Column sorting (click header, shift-click for multi-column)
- Search with `Ctrl+F`, Enter to cycle matches (`i / N`)
- Cell selection — click, drag, Shift+Click range, resize handle on bottom-right corner
- Unified selection border (group outline, not per-cell)
- Row numbers pinned to the left

### Export & Copy
- Export dialog — CSV, TSV, JSON, Markdown — exports **all** rows (not just current page)
- Right-click cells → Copy / Copy as CSV / Copy as TSV / Copy as Markdown / Copy as JSON
- `Ctrl+C` copies selected cells as TSV

### JSON
- Double-click JSON/JSONB cells to open editable popup
- PostgreSQL arrays displayed with `{curly braces}`

### DDL
- Right-click table/view/index/trigger/sequence → Show DDL

### AI Agent Integration (MCP)

Commands for Claude Code, Cursor, Copilot, and other AI tools:

| Command | Description |
|---|---|
| `viewstor.mcp.listConnections` | List all connections with status |
| `viewstor.mcp.getSchema` | Flattened schema tree (tables, columns, types) |
| `viewstor.mcp.executeQuery` | Execute SQL (read-only mode enforced) |
| `viewstor.mcp.getTableData` | Fetch rows with configurable limit |
| `viewstor.mcp.getTableInfo` | Column metadata, types, primary keys |

All commands auto-connect and return structured JSON. Read-only connections block mutations.

### Other
- Query history with execution time, row count, errors
- Report Issue — opens GitHub issue with pre-filled environment info
- Redis — inspect strings, lists, sets, sorted sets, hashes

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` / `Cmd+Enter` | Run query (or selected text) |
| `Ctrl+F` / `Cmd+F` | Focus search in data table |
| `Enter` (in search) | Next match |
| `Ctrl+C` / `Cmd+C` | Copy selected cells |
| `Esc` | Close popups |

All shortcuts work on any keyboard layout (uses physical key codes).

## Installation

> Not yet on the VS Code Marketplace. Install from source or `.vsix`.

```bash
git clone https://github.com/Siyet/viewstor.git
cd viewstor
npm install
npm run package
code --install-extension viewstor-0.1.0.vsix
```

## Development

### Prerequisites

- Node.js 18+
- VS Code 1.85+
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

Press **F5** to launch Extension Development Host.

### Testing

Unit tests use [vitest](https://vitest.dev/). E2E tests use [testcontainers](https://www.npmjs.com/package/testcontainers) to spin up PostgreSQL, Redis, and ClickHouse in Docker. Auto-skipped if Docker is unavailable.

### CI/CD

- **CI** (on PR, trunk push, tags): lint → unit tests → build → `npm audit`
- **Release** (on `v*` tag): build → test → publish to Marketplace → GitHub Release with `.vsix`

## Project Structure

```
src/
├── commands/          # All viewstor.* command handlers
├── connections/       # ConnectionManager (globalState, drivers, folders)
├── drivers/           # PostgreSQL, Redis, ClickHouse implementations
├── editors/           # Query editor, SQL autocomplete, index hints
├── mcp/               # AI agent integration (MCP commands)
├── services/          # Export (CSV/TSV/JSON/MD) and import (DBeaver/DataGrip/pgAdmin)
├── types/             # ConnectionConfig, DatabaseDriver, QueryResult, SchemaObject
├── views/             # Tree provider, result panel, connection/folder forms
├── webview/           # Static CSS/JS for webview panels
├── test/              # Unit tests + e2e/ (testcontainers)
└── extension.ts       # Entry point
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[AGPL-3.0](LICENSE)
