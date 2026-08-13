-- events: MergeTree table used by chart-aggregation and diff tests.
-- Seeded with ~10k rows via a numbers() table function.

CREATE TABLE IF NOT EXISTS viewstor_test.events (
  id          UInt64,
  event_type  LowCardinality(String),
  user_id     UInt32,
  payload     String,
  created_at  DateTime
) ENGINE = MergeTree()
ORDER BY (created_at, id);

INSERT INTO viewstor_test.events (id, event_type, user_id, payload, created_at)
SELECT
  number AS id,
  arrayElement(['login', 'view', 'click', 'purchase', 'logout'], (number % 5) + 1) AS event_type,
  (number % 100) + 1 AS user_id,
  concat('{"seq":', toString(number), '}') AS payload,
  toDateTime('2025-01-01 00:00:00') + INTERVAL (number * 30) SECOND AS created_at
FROM numbers(10000)
WHERE (SELECT count() FROM viewstor_test.events) = 0;
