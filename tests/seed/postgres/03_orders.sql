-- orders: numeric / enum / status data for diff + chart aggregation tests.

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS orders (
  id            SERIAL PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  amount        NUMERIC(10, 2) NOT NULL,
  currency      CHAR(3) NOT NULL DEFAULT 'USD',
  status        order_status NOT NULL DEFAULT 'pending',
  metadata      JSONB,
  placed_at     TIMESTAMP NOT NULL
);

INSERT INTO orders (id, customer_id, amount, currency, status, metadata, placed_at) VALUES
  (1, 1, 99.95,  'USD', 'paid',      '{"channel": "web", "promo": null}',   '2025-01-10 12:00:00'),
  (2, 1, 42.00,  'USD', 'shipped',   '{"channel": "mobile"}',                '2025-01-22 09:15:00'),
  (3, 2, 150.00, 'USD', 'cancelled', '{"channel": "web", "reason": "OOS"}',  '2025-02-03 18:42:00'),
  (4, 3, 220.50, 'EUR', 'paid',      '{"channel": "web"}',                   '2025-02-14 11:05:00'),
  (5, 3, 18.75,  'EUR', 'pending',   NULL,                                    '2025-03-01 08:00:00'),
  (6, 4, 5000.00,'RUB', 'paid',      '{"channel": "phone"}',                 '2025-03-05 14:30:00'),
  (7, 7, 0.00,   'USD', 'pending',   '{}',                                   '2025-03-20 10:00:00')
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('orders', 'id'), COALESCE((SELECT MAX(id) FROM orders), 1));

CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_placed_at   ON orders (placed_at);
