-- events: time-series data for chart aggregation + Grafana export tests.
-- Spans multiple months so date_trunc('month', ...) produces >1 bucket.

CREATE TABLE IF NOT EXISTS analytics.events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER,
  event_type  TEXT NOT NULL,
  payload     JSONB,
  occurred_at TIMESTAMPTZ NOT NULL
);

INSERT INTO analytics.events (id, user_id, event_type, payload, occurred_at) VALUES
  ( 1, 1, 'login',    '{"ip": "10.0.0.1"}',              '2025-01-05 08:00:00+00'),
  ( 2, 1, 'view',     '{"path": "/home"}',               '2025-01-05 08:01:23+00'),
  ( 3, 2, 'login',    '{"ip": "10.0.0.2"}',              '2025-01-10 09:00:00+00'),
  ( 4, 2, 'purchase', '{"amount": 42, "currency":"USD"}','2025-01-12 11:30:00+00'),
  ( 5, 3, 'login',    '{"ip": "10.0.0.3"}',              '2025-02-01 10:00:00+00'),
  ( 6, 3, 'view',     '{"path": "/pricing"}',            '2025-02-01 10:05:00+00'),
  ( 7, 3, 'purchase', '{"amount": 220.5}',               '2025-02-14 11:05:00+00'),
  ( 8, 4, 'login',    '{"ip": "10.0.0.4"}',              '2025-03-01 07:00:00+00'),
  ( 9, 4, 'error',    '{"code": 500, "msg": "oops"}',    '2025-03-01 07:02:00+00'),
  (10, 7, 'login',    '{"ip": "10.0.0.7"}',              '2025-03-20 10:00:00+00')
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('analytics.events', 'id'), COALESCE((SELECT MAX(id) FROM analytics.events), 1));

CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON analytics.events (occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_user_id     ON analytics.events (user_id);
