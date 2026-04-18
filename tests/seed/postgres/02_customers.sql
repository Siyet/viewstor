-- customers: PII-heavy table for anonymization / masking tests (PR #97).
-- Columns intentionally include obvious-PII names (email, phone, ssn).

CREATE TABLE IF NOT EXISTS customers (
  id          SERIAL PRIMARY KEY,
  full_name   TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  ssn         TEXT,
  dob         DATE,
  country     TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO customers (id, full_name, email, phone, ssn, dob, country) VALUES
  (1, 'Alice Johnson',  'alice.johnson@example.com',   '+1-202-555-0101', '123-45-6789', '1988-03-12', 'US'),
  (2, 'Bob Martinez',   'bob.martinez@example.com',    '+1-415-555-0178', '987-65-4321', '1975-07-04', 'US'),
  (3, 'Carol Schmidt',  'carol.schmidt@example.de',    '+49-30-555-0199', NULL,           '1992-11-23', 'DE'),
  (4, 'Dmitry Ivanov',  NULL,                          '+7-495-555-0144', NULL,           '1980-05-30', 'RU'),
  (5, 'Eve White',      'eve.white@example.co.uk',     NULL,              NULL,           NULL,         'GB'),
  (6, 'Frank Lee',      '',                            '',                '',             '2000-01-01', ''),
  (7, 'Grace Kim',      'grace.kim@example.kr',        '+82-2-555-0123',  NULL,           '1996-09-17', 'KR')
ON CONFLICT (id) DO NOTHING;

-- Keep the SERIAL in sync so future INSERTs don't collide with the seeded PKs.
SELECT setval(pg_get_serial_sequence('customers', 'id'), COALESCE((SELECT MAX(id) FROM customers), 1));

CREATE INDEX IF NOT EXISTS idx_customers_email ON customers (email);
CREATE INDEX IF NOT EXISTS idx_customers_country ON customers (country);
