# Changelog

All notable changes to Viewstor are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.1] — 2026-03-30

### Added
- "What's New" notification after extension update with link to changelog

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
