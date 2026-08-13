-- geo_points: coordinate data in every format Map View (#78) is expected to parse.
-- No PostGIS dependency — drivers return TEXT/JSONB that the extractor parses in JS.

CREATE TABLE IF NOT EXISTS geo_points (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL,
  -- pair of separate columns
  lat       DOUBLE PRECISION,
  lng       DOUBLE PRECISION,
  -- single-column variants, intentionally covering each supported shape
  geojson   JSONB,
  wkt       TEXT,
  pg_array  DOUBLE PRECISION[],
  obj_json  JSONB
);

INSERT INTO geo_points (id, name, lat, lng, geojson, wkt, pg_array, obj_json) VALUES
  (1, 'London',    51.5074,  -0.1278,
      '{"type":"Point","coordinates":[-0.1278, 51.5074]}'::jsonb,
      'POINT(-0.1278 51.5074)',
      ARRAY[-0.1278, 51.5074]::DOUBLE PRECISION[],
      '{"lat": 51.5074, "lng": -0.1278}'::jsonb),
  (2, 'Tokyo',     35.6762,  139.6503,
      '{"type":"Point","coordinates":[139.6503, 35.6762]}'::jsonb,
      'POINT(139.6503 35.6762)',
      ARRAY[139.6503, 35.6762]::DOUBLE PRECISION[],
      '{"lat": 35.6762, "lng": 139.6503}'::jsonb),
  (3, 'New York',  40.7128,  -74.0060,
      '{"type":"Point","coordinates":[-74.0060, 40.7128]}'::jsonb,
      'POINT(-74.0060 40.7128)',
      ARRAY[-74.0060, 40.7128]::DOUBLE PRECISION[],
      '{"lat": 40.7128, "lng": -74.0060}'::jsonb),
  -- intentionally null / malformed row for negative-path tests
  (4, 'No coords', NULL, NULL, NULL, NULL, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('geo_points', 'id'), COALESCE((SELECT MAX(id) FROM geo_points), 1));
