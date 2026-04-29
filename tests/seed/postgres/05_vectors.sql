-- vector_items: pgvector column for PR #81 tests.
-- Dimension kept small (8) so the seed stays readable; real embeddings use 384+ but for the schema test
-- the dimension number is what matters, not the values.

CREATE TABLE IF NOT EXISTS vector_items (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  category   TEXT,
  embedding  vector(8) NOT NULL
);

INSERT INTO vector_items (id, title, category, embedding) VALUES
  (1, 'red apple',     'fruit',   '[1.0, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1]'),
  (2, 'green pear',    'fruit',   '[0.9, 0.2, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1]'),
  (3, 'orange carrot', 'veggie',  '[0.2, 0.8, 0.1, 0.0, 0.0, 0.0, 0.0, 0.1]'),
  (4, 'steel bolt',    'tool',    '[0.0, 0.0, 0.0, 1.0, 0.5, 0.0, 0.0, 0.0]'),
  (5, 'python book',   'book',    '[0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.8, 0.0]')
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('vector_items', 'id'), COALESCE((SELECT MAX(id) FROM vector_items), 1));
