-- large_events: >100k rows with NO index on the filter column — used by Safe mode
-- EXPLAIN tests (full-scan detection). Kept separate from analytics.events to keep
-- chart-aggregation tests deterministic.

CREATE TABLE IF NOT EXISTS large_events (
  id          BIGSERIAL PRIMARY KEY,
  bucket      INTEGER NOT NULL,
  -- no index here on purpose
  payload     TEXT NOT NULL
);

INSERT INTO large_events (bucket, payload)
SELECT
  (g % 1000)::INTEGER,
  'evt-' || g
FROM generate_series(1, 120000) AS g
WHERE NOT EXISTS (SELECT 1 FROM large_events LIMIT 1);

ANALYZE large_events;
