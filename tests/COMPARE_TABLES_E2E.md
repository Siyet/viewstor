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

The remaining items below are the planned Compare Tables coverage backlog. They
are not claimed as automated by PR #110.

## P0 backlog — next required Compare Tables test slice

- Entry points: `Compare With...` and `Viewstor: Compare Data`; cancel at either
  picker; tables and views from every connected PostgreSQL, ClickHouse, and
  SQLite connection; duplicate names remain distinguishable by source/schema.
- Row diff, all six driver pairs: PG↔PG, CH↔CH, SQLite↔SQLite, PG↔CH,
  PG↔SQLite, and CH↔SQLite. Fixtures contain unchanged, changed, added, and
  removed rows; decimal forms such as `716.90` and `716.9`; `NULL` and empty
  strings; Unicode; dates; and values beyond JavaScript's safe integer range.
- Keys: automatic single-column PK, explicit key selection when there is no PK,
  composite PK order, cancel with no key selection, and a rerun whose result no
  longer contains the key column.
- Schema diff: common/left-only/right-only columns, native type differences,
  nullability, PK flags, comments, indexes, constraints, triggers, and sequences.
- Statistics, same type: complete driver metric set, zero and missing values,
  and PostgreSQL views never exposing the `-1` catalog sentinel.
- Statistics, cross type: only the semantic allowlist (currently `row_count`),
  incompatible `total_size` hidden, branded banner, hidden metric counts, and
  the PostgreSQL estimated-count disclosure.
- Degradation: unavailable objects/statistics do not suppress row/schema diff;
  required data or table-info failures show one error and do not open a panel.
- Panel lifecycle: swap stays in one panel, latest SQL rerun wins, dispose drops
  pending results, readonly preflight blocks writes, reconnect uses
  `ensureDriver`, and missing keys/errors keep the previous successful diff.

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
