-- logs: Log engine for "every engine type at least once" schema-tree coverage.

CREATE TABLE IF NOT EXISTS viewstor_test.logs (
  ts         DateTime,
  level      String,
  message    String
) ENGINE = Log;

INSERT INTO viewstor_test.logs (ts, level, message) VALUES
  (toDateTime('2025-04-01 10:00:00'), 'INFO',  'app started'),
  (toDateTime('2025-04-01 10:00:01'), 'DEBUG', 'loaded 12 plugins'),
  (toDateTime('2025-04-01 10:00:05'), 'WARN',  'slow query: SELECT ...'),
  (toDateTime('2025-04-01 10:00:10'), 'ERROR', 'connection reset');
