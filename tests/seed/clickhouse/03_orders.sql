-- orders: ReplacingMergeTree. Used by diff tests to check cross-DB compare (PG <-> CH).
-- Columns match tests/seed/postgres/03_orders.sql so "common keys" intersect for the stats diff.

CREATE TABLE IF NOT EXISTS viewstor_test.orders (
  id            UInt64,
  customer_id   UInt32,
  amount        Decimal(10, 2),
  currency      FixedString(3),
  status        LowCardinality(String),
  placed_at     DateTime
) ENGINE = ReplacingMergeTree()
ORDER BY id;

INSERT INTO viewstor_test.orders (id, customer_id, amount, currency, status, placed_at) VALUES
  (1, 1, toDecimal64( 99.95, 2), 'USD', 'paid',      toDateTime('2025-01-10 12:00:00')),
  (2, 1, toDecimal64( 42.00, 2), 'USD', 'shipped',   toDateTime('2025-01-22 09:15:00')),
  (3, 2, toDecimal64(150.00, 2), 'USD', 'cancelled', toDateTime('2025-02-03 18:42:00')),
  (4, 3, toDecimal64(220.50, 2), 'EUR', 'paid',      toDateTime('2025-02-14 11:05:00')),
  (5, 3, toDecimal64( 18.75, 2), 'EUR', 'pending',   toDateTime('2025-03-01 08:00:00')),
  (6, 4, toDecimal64(5000.00, 2),'RUB', 'paid',      toDateTime('2025-03-05 14:30:00')),
  (7, 7, toDecimal64(  0.00, 2), 'USD', 'pending',   toDateTime('2025-03-20 10:00:00'));
