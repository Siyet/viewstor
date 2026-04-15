import { QueryColumn } from '../types/query';

/** A single geographic point extracted from a table row. */
export interface MapPoint {
  /** Latitude in decimal degrees. */
  lat: number;
  /** Longitude in decimal degrees. */
  lng: number;
  /** Original row data — rendered in the popup. */
  row: Record<string, unknown>;
  /** Original row index (0-based) in the source rows array. */
  rowIndex: number;
}

/** How a row's coordinates should be parsed. */
export type MapCoordMode =
  | { kind: 'single'; column: string }
  | { kind: 'pair'; latColumn: string; lngColumn: string };

export interface MapExtractionResult {
  points: MapPoint[];
  /** Rows that couldn't be parsed (for "N of M rows plotted" messaging). */
  skipped: number;
}

/** Column-name patterns used to auto-detect lat / lng column pairs. */
const LAT_PATTERNS = [/^lat$/i, /^latitude$/i, /_lat$/i, /^y$/i];
const LNG_PATTERNS = [/^lng$/i, /^lon$/i, /^long$/i, /^longitude$/i, /_lng$/i, /_lon$/i, /^x$/i];

/** Column type hints that indicate a single-column coord format (PostGIS, GeoJSON, etc.). */
const SINGLE_TYPE_HINTS = [
  /geometry/i,
  /geography/i,
  /point/i,
  /geojson/i,
];

/** Column-name hints for a single-column coord (fallback when type is unknown). */
const SINGLE_NAME_HINTS = [
  /^geom$/i,
  /^geometry$/i,
  /^geography$/i,
  /^location$/i,
  /^coord(s|inates)?$/i,
  /^position$/i,
  /^point$/i,
  /_geom$/i,
  /_location$/i,
];

/**
 * Auto-detect the best coordinate extraction mode for the given columns and
 * sample rows. Returns `null` if no mode is plausible.
 *
 * Detection priority:
 *   1. Single column whose type or name matches a geo hint AND at least one row
 *      parses into a valid coordinate.
 *   2. A lat / lng column pair where at least one row has finite numeric values
 *      in both columns.
 */
export function detectCoordMode(
  columns: QueryColumn[],
  rows: Record<string, unknown>[],
): MapCoordMode | null {
  // 1. Single-column detection
  for (const col of columns) {
    const typeHit = SINGLE_TYPE_HINTS.some(rx => rx.test(col.dataType || ''));
    const nameHit = SINGLE_NAME_HINTS.some(rx => rx.test(col.name));
    if (!typeHit && !nameHit) continue;
    if (hasAnyParseableSingle(col.name, rows)) {
      return { kind: 'single', column: col.name };
    }
  }

  // 1b. Even without a name/type hint, accept a column that consistently
  //     parses (e.g. a JSON column literally named "pt").
  for (const col of columns) {
    if (hasAnyParseableSingle(col.name, rows)) {
      return { kind: 'single', column: col.name };
    }
  }

  // 2. lat / lng pair detection
  const latCol = columns.find(c => LAT_PATTERNS.some(rx => rx.test(c.name)));
  const lngCol = columns.find(c => LNG_PATTERNS.some(rx => rx.test(c.name)));
  if (latCol && lngCol && latCol.name !== lngCol.name) {
    if (hasAnyParseablePair(latCol.name, lngCol.name, rows)) {
      return { kind: 'pair', latColumn: latCol.name, lngColumn: lngCol.name };
    }
  }

  return null;
}

function hasAnyParseableSingle(column: string, rows: Record<string, unknown>[]): boolean {
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const v = rows[i][column];
    if (v == null) continue;
    if (parseGeoValue(v) !== null) return true;
  }
  return false;
}

function hasAnyParseablePair(latCol: string, lngCol: string, rows: Record<string, unknown>[]): boolean {
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const lat = toFiniteNumber(rows[i][latCol]);
    const lng = toFiniteNumber(rows[i][lngCol]);
    if (lat !== null && lng !== null && isValidCoord(lat, lng)) return true;
  }
  return false;
}

/**
 * Extract all valid map points from the given rows using the configured mode.
 * Rows that cannot be parsed or contain out-of-range coordinates are skipped.
 */
export function extractPoints(
  rows: Record<string, unknown>[],
  mode: MapCoordMode,
): MapExtractionResult {
  const points: MapPoint[] = [];
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let coords: { lat: number; lng: number } | null;

    if (mode.kind === 'single') {
      coords = parseGeoValue(row[mode.column]);
    } else {
      const lat = toFiniteNumber(row[mode.latColumn]);
      const lng = toFiniteNumber(row[mode.lngColumn]);
      coords = lat !== null && lng !== null ? { lat, lng } : null;
    }

    if (!coords || !isValidCoord(coords.lat, coords.lng)) {
      skipped++;
      continue;
    }

    points.push({ lat: coords.lat, lng: coords.lng, row, rowIndex: i });
  }

  return { points, skipped };
}

/**
 * Parse a single cell value into `{ lat, lng }` if it represents a point.
 *
 * Supported shapes:
 *   - GeoJSON Point: `{ type: 'Point', coordinates: [lng, lat] }`
 *   - Plain object:  `{ lat, lng }`, `{ latitude, longitude }`, `{ lat, lon }`
 *   - Array:         `[lng, lat]` (GeoJSON order) — 2 finite numbers
 *   - PG array text: `"(lng,lat)"`, `"{lng,lat}"`, `"[lng,lat]"`
 *   - WKT Point:     `"POINT(lng lat)"` (case-insensitive)
 *   - JSON string of any of the above
 *
 * Returns `null` for unparseable input. Binary WKB (hex) is intentionally not
 * supported — the driver decodes PostGIS to WKT or GeoJSON before this point.
 */
export function parseGeoValue(value: unknown): { lat: number; lng: number } | null {
  if (value == null) return null;

  // Plain object — check key patterns first
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    // GeoJSON: { type: 'Point', coordinates: [lng, lat] }
    if (obj.type === 'Point' && Array.isArray(obj.coordinates) && obj.coordinates.length >= 2) {
      const lng = toFiniteNumber(obj.coordinates[0]);
      const lat = toFiniteNumber(obj.coordinates[1]);
      if (lat !== null && lng !== null) return { lat, lng };
    }

    // Plain { lat, lng } object
    const lat = toFiniteNumber(obj.lat ?? obj.latitude);
    const lng = toFiniteNumber(obj.lng ?? obj.lon ?? obj.long ?? obj.longitude);
    if (lat !== null && lng !== null) return { lat, lng };

    return null;
  }

  // Array — assume GeoJSON order [lng, lat]
  if (Array.isArray(value) && value.length >= 2) {
    const lng = toFiniteNumber(value[0]);
    const lat = toFiniteNumber(value[1]);
    if (lat !== null && lng !== null) return { lat, lng };
    return null;
  }

  if (typeof value === 'string') {
    return parseGeoString(value);
  }

  return null;
}

function parseGeoString(str: string): { lat: number; lng: number } | null {
  const trimmed = str.trim();
  if (!trimmed) return null;

  // WKT: POINT(lng lat) or POINT Z (lng lat z) — we use the first two numbers
  const wktMatch = /^\s*POINT\s*(?:Z\s*|M\s*|ZM\s*)?\(\s*([-+]?\d+\.?\d*(?:[eE][-+]?\d+)?)\s+([-+]?\d+\.?\d*(?:[eE][-+]?\d+)?)/i.exec(trimmed);
  if (wktMatch) {
    const lng = toFiniteNumber(wktMatch[1]);
    const lat = toFiniteNumber(wktMatch[2]);
    if (lat !== null && lng !== null) return { lat, lng };
  }

  // JSON string (GeoJSON or {lat,lng}) — only attempt if looks like JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    // PG array syntax like `{-0.1,51.5}` isn't valid JSON — special-case it
    if (trimmed.startsWith('{') && !trimmed.includes('"') && !trimmed.includes(':')) {
      const arr = parseNumericBraceList(trimmed);
      if (arr && arr.length >= 2) {
        const lng = arr[0];
        const lat = arr[1];
        if (isFiniteNumber(lat) && isFiniteNumber(lng)) return { lat, lng };
      }
      return null;
    }
    try {
      return parseGeoValue(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  // Parenthesised numeric pair: (lng, lat)
  const parenMatch = /^\(\s*([-+]?\d+\.?\d*(?:[eE][-+]?\d+)?)\s*,\s*([-+]?\d+\.?\d*(?:[eE][-+]?\d+)?)\s*\)$/.exec(trimmed);
  if (parenMatch) {
    const lng = toFiniteNumber(parenMatch[1]);
    const lat = toFiniteNumber(parenMatch[2]);
    if (lat !== null && lng !== null) return { lat, lng };
  }

  // Plain comma-separated numeric pair: "lng, lat"
  const pairMatch = /^([-+]?\d+\.?\d*(?:[eE][-+]?\d+)?)\s*,\s*([-+]?\d+\.?\d*(?:[eE][-+]?\d+)?)$/.exec(trimmed);
  if (pairMatch) {
    const lng = toFiniteNumber(pairMatch[1]);
    const lat = toFiniteNumber(pairMatch[2]);
    if (lat !== null && lng !== null) return { lat, lng };
  }

  return null;
}

function parseNumericBraceList(str: string): number[] | null {
  // `{1,2,3}` → [1, 2, 3]
  if (!str.startsWith('{') || !str.endsWith('}')) return null;
  const inner = str.slice(1, -1).trim();
  if (!inner) return null;
  const parts = inner.split(',').map(s => s.trim());
  const nums: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  return nums;
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'bigint') return Number(v);
  return null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate lat/lng ranges. Points outside Earth's valid range are dropped to
 * avoid Leaflet throwing on bad data (e.g. a `{col: NaN}` that slipped through).
 */
export function isValidCoord(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  );
}

/** Pick a reasonable default label column: first non-coord text column. */
export function suggestLabelColumn(
  columns: QueryColumn[],
  mode: MapCoordMode,
): string | null {
  const excluded = new Set<string>();
  if (mode.kind === 'single') excluded.add(mode.column);
  else {
    excluded.add(mode.latColumn);
    excluded.add(mode.lngColumn);
  }

  // Prefer columns that look like a name/label, in priority order
  const priorities = [/^name$/i, /^title$/i, /^label$/i, /^description$/i, /^code$/i, /^id$/i];
  for (const rx of priorities) {
    const match = columns.find(c => !excluded.has(c.name) && rx.test(c.name));
    if (match) return match.name;
  }

  // Fallback: first non-excluded column
  const first = columns.find(c => !excluded.has(c.name));
  return first?.name ?? null;
}
