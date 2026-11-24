# Compare Tables E2E matrix

This matrix separates deterministic merge-gate coverage from checks that still
need a real VS Code UI. It covers PostgreSQL, ClickHouse, and SQLite. Redis keys
are not Compare Tables sources today, so Redis is covered by direct statistics
tests until a dedicated source adapter is designed.

## Automated in PR #110

- Driver statistics contracts for PostgreSQL, ClickHouse, SQLite, and Redis.
- Real PostgreSQL↔ClickHouse, PostgreSQL↔SQLite, and ClickHouse↔SQLite
  statistics comparisons against seeded data.
- The cross-type semantic allowlist contains only `row_count`; storage metrics
  remain hidden and contribute to hidden-metric counts.
- SQLite indexed-table size and view `null` storage behavior.
- ClickHouse active-part timestamp and non-MergeTree fallback.
- Redis string/list/set/zset/hash/stream cardinality, missing keys, TTL sentinels,
  and ACL degradation for TYPE/cardinality/MEMORY/TTL/OBJECT commands.
- Existing unit/host tests cover numeric normalization, Statistics banner/empty
  state, in-place swap, SQL rerun races/disposal, and the SQLite picker regression.
- Real-driver row and schema comparisons cover all six PostgreSQL, ClickHouse,
  and SQLite pairs with deterministic unchanged/changed/added/removed fixtures,
  decimal normalization, `NULL` versus empty strings, Unicode, ISO date strings,
  and large text identifiers beyond JavaScript's safe integer range.
- Real PostgreSQL, ClickHouse, and SQLite table/view fixtures cover the production
  column-selection model: exact `id`/`name` pairs, the suggested differently named
  `lifetime_value ↔ total_value` mapping, and visible unchecked `email`/`order_count`
  side-only fields. Applying the selection produces unchanged rows on all engines.
- The same real `customers` fixtures verify PostgreSQL boolean/timestamptz values
  against SQLite INTEGER/TEXT and ClickHouse UInt8/DateTime representations, including
  both true/false rows; equivalent rows remain unchanged.
- Command-level tests cover both entry points, cancellation at either table/key
  picker, automatic and manually selected keys, flat SQLite tables/views, required
  load failures, optional metadata degradation, and the no-connections path.
- Panel lifecycle tests cover both completion orders for competing SQL reruns,
  reconnect de-duplication, disposal during a run, readonly preflight, one-sided
  execution errors, missing key columns, and in-place side swapping.

The remaining items below are the planned Compare Tables coverage backlog. They
are not claimed as automated by PR #110.

## Remaining P0 backlog

- Picker labels for duplicate names across multiple connections/schemas remain
  distinguishable, including multi-database connections.
- Keys: automatic single-column PK, explicit key selection when there is no PK,
  composite PK order, and duplicate-key warning/rejection. Cancellation and a
  rerun whose result no longer contains the key column are already automated.
- Schema diff: common/left-only/right-only columns, native type differences,
  nullability, PK flags, and comments are automated; real cross-driver indexes,
  constraints, triggers, and sequences remain to cover.
- Statistics, same type: complete driver metric set, zero and missing values,
  and PostgreSQL views never exposing the `-1` catalog sentinel.
- Statistics, cross type: only the semantic allowlist (currently `row_count`),
  incompatible `total_size` hidden, branded banner, hidden metric counts, and
  the PostgreSQL estimated-count disclosure.
- Degradation and panel lifecycle scenarios listed above are automated at the
  command/host boundary; a real-driver permission/network variant remains.

## P1 — nightly or Extension Host suite

- Real Extension Host smoke with two temporary SQLite files through the same
  command/coordinator path used in production; assert panel state and generated
  HTML, then remove connections, database files, WAL, and SHM files.
- PostgreSQL↔ClickHouse Extension Host smoke through real ConnectionManager
  instances; verify Row, Schema, and Statistics tabs.
- Views without PK; composite and duplicate keys; multi-database connections;
  same table name in multiple schemas; quoted/reserved/Unicode identifiers.
- Large inputs and `diffRowLimit`: visible truncation, responsive filter/search,
  deterministic ordering, and no unbounded memory growth.
- Permission and network degradation: dropped table, statistics ACL failure,
  disconnect during rerun, and one source completing much later than the other.
- CSV/JSON export contents, escaping, cancel, write failure, and whether export
  intentionally includes the full diff rather than the active visual filter.

## P2 — release manual checks

- Search both panes: case-insensitive matches, live count, Enter/Shift+Enter
  cycling, Escape clear, Ctrl/Cmd+F focus, and recalculation after filters/rerun.
- Filter chips: default active state, click-to-solo, Shift+click toggle, and
  prevention of an all-disabled state on Row, Schema, and Statistics tabs.
- Synced SQL default for same-type sources and independent SQL for cross-type;
  Ctrl/Cmd+Enter, inline side-specific errors, and preserved table-bound tabs.
- Sticky headers/source bar, synchronized scrolling, wide schemas and long cell
  values, drag selection, clipboard/context-menu formats, and narrow panes.
- Light, dark, and high-contrast themes; 100–200% scaling; keyboard-only and
  screen-reader navigation; save dialog and clipboard denial.
- Repeated open/close/swap/rerun, panel restoration after VS Code reload, and
  a basic memory/driver leak check.

## Stable assertion rules

- Assert semantic structures (`summary`, row IDs, `changedColumns`, schema flags,
  metric keys/units), not whole HTML or screenshots.
- Never assert exact storage sizes across engines or wall-clock timestamps.
- PostgreSQL estimates must be non-negative; ClickHouse asynchronous stats use
  bounded polling, never fixed sleeps.
- Keep UI clicks and ECharts pixels out of the required CI job until a dedicated
  VS Code browser harness exists.
