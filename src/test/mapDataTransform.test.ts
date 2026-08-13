import { describe, it, expect } from 'vitest';
import {
  parseGeoValue,
  detectCoordMode,
  extractPoints,
  isValidCoord,
  suggestLabelColumn,
} from '../map/mapDataTransform';
import { QueryColumn } from '../types/query';

const col = (name: string, dataType = 'text'): QueryColumn => ({ name, dataType });

describe('parseGeoValue', () => {
  it('returns null for null/undefined', () => {
    expect(parseGeoValue(null)).toBeNull();
    expect(parseGeoValue(undefined)).toBeNull();
    expect(parseGeoValue('')).toBeNull();
  });

  it('parses GeoJSON Point object', () => {
    expect(parseGeoValue({ type: 'Point', coordinates: [-0.1, 51.5] }))
      .toEqual({ lat: 51.5, lng: -0.1 });
  });

  it('parses plain {lat,lng} object', () => {
    expect(parseGeoValue({ lat: 40.7, lng: -74 })).toEqual({ lat: 40.7, lng: -74 });
    expect(parseGeoValue({ latitude: 40.7, longitude: -74 })).toEqual({ lat: 40.7, lng: -74 });
    expect(parseGeoValue({ lat: 40.7, lon: -74 })).toEqual({ lat: 40.7, lng: -74 });
  });

  it('parses array [lng, lat]', () => {
    expect(parseGeoValue([-0.1, 51.5])).toEqual({ lat: 51.5, lng: -0.1 });
  });

  it('parses WKT POINT', () => {
    expect(parseGeoValue('POINT(-0.1 51.5)')).toEqual({ lat: 51.5, lng: -0.1 });
    expect(parseGeoValue('point(-0.1 51.5)')).toEqual({ lat: 51.5, lng: -0.1 });
    expect(parseGeoValue('POINT Z (-0.1 51.5 12)')).toEqual({ lat: 51.5, lng: -0.1 });
  });

  it('parses PG array string "{lng,lat}"', () => {
    expect(parseGeoValue('{-0.1,51.5}')).toEqual({ lat: 51.5, lng: -0.1 });
    expect(parseGeoValue('{ -0.1 , 51.5 }')).toEqual({ lat: 51.5, lng: -0.1 });
  });

  it('parses JSON string of GeoJSON', () => {
    expect(parseGeoValue('{"type":"Point","coordinates":[-0.1,51.5]}'))
      .toEqual({ lat: 51.5, lng: -0.1 });
  });

  it('parses JSON string of {lat,lng}', () => {
    expect(parseGeoValue('{"lat":51.5,"lng":-0.1}'))
      .toEqual({ lat: 51.5, lng: -0.1 });
  });

  it('parses parenthesised pair "(lng,lat)"', () => {
    expect(parseGeoValue('(-0.1,51.5)')).toEqual({ lat: 51.5, lng: -0.1 });
  });

  it('parses string numbers in objects', () => {
    expect(parseGeoValue({ lat: '51.5', lng: '-0.1' })).toEqual({ lat: 51.5, lng: -0.1 });
  });

  it('rejects non-parseable garbage', () => {
    expect(parseGeoValue('hello')).toBeNull();
    expect(parseGeoValue({ foo: 1 })).toBeNull();
    expect(parseGeoValue([])).toBeNull();
    expect(parseGeoValue([1])).toBeNull();
    expect(parseGeoValue({ lat: 'abc', lng: 1 })).toBeNull();
    expect(parseGeoValue('POINT(abc def)')).toBeNull();
  });

  it('rejects malformed JSON', () => {
    expect(parseGeoValue('{bad json}')).toBeNull();
  });
});

describe('isValidCoord', () => {
  it('accepts valid ranges', () => {
    expect(isValidCoord(0, 0)).toBe(true);
    expect(isValidCoord(90, 180)).toBe(true);
    expect(isValidCoord(-90, -180)).toBe(true);
  });

  it('rejects out-of-range', () => {
    expect(isValidCoord(91, 0)).toBe(false);
    expect(isValidCoord(0, 181)).toBe(false);
    expect(isValidCoord(-91, 0)).toBe(false);
    expect(isValidCoord(0, -181)).toBe(false);
  });

  it('rejects NaN/Infinity', () => {
    expect(isValidCoord(NaN, 0)).toBe(false);
    expect(isValidCoord(0, Infinity)).toBe(false);
  });
});

describe('detectCoordMode', () => {
  it('detects single geometry column by type', () => {
    const columns = [col('id', 'integer'), col('geom', 'geometry')];
    const rows = [{ id: 1, geom: 'POINT(-0.1 51.5)' }];
    expect(detectCoordMode(columns, rows)).toEqual({ kind: 'single', column: 'geom' });
  });

  it('detects single location column by name', () => {
    const columns = [col('id'), col('location', 'jsonb')];
    const rows = [{ id: 1, location: { lat: 40.7, lng: -74 } }];
    expect(detectCoordMode(columns, rows)).toEqual({ kind: 'single', column: 'location' });
  });

  it('detects lat/lng pair', () => {
    const columns = [col('id'), col('lat', 'double'), col('lng', 'double')];
    const rows = [{ id: 1, lat: 40.7, lng: -74 }];
    expect(detectCoordMode(columns, rows)).toEqual({
      kind: 'pair',
      latColumn: 'lat',
      lngColumn: 'lng',
    });
  });

  it('detects latitude/longitude pair', () => {
    const columns = [col('latitude'), col('longitude')];
    const rows = [{ latitude: 40.7, longitude: -74 }];
    const mode = detectCoordMode(columns, rows);
    expect(mode).toEqual({ kind: 'pair', latColumn: 'latitude', lngColumn: 'longitude' });
  });

  it('returns null when no plausible columns', () => {
    const columns = [col('id'), col('name')];
    const rows = [{ id: 1, name: 'foo' }];
    expect(detectCoordMode(columns, rows)).toBeNull();
  });

  it('returns null when geom column has only garbage', () => {
    const columns = [col('geom', 'geometry')];
    const rows = [{ geom: 'garbage' }, { geom: null }];
    expect(detectCoordMode(columns, rows)).toBeNull();
  });
});

describe('extractPoints', () => {
  it('extracts single-column geo values', () => {
    const rows = [
      { id: 1, pt: { type: 'Point', coordinates: [-0.1, 51.5] } },
      { id: 2, pt: 'POINT(2.35 48.86)' },
      { id: 3, pt: null },
    ];
    const result = extractPoints(rows, { kind: 'single', column: 'pt' });
    expect(result.points).toHaveLength(2);
    expect(result.points[0]).toMatchObject({ lat: 51.5, lng: -0.1, rowIndex: 0 });
    expect(result.points[1]).toMatchObject({ lat: 48.86, lng: 2.35, rowIndex: 1 });
    expect(result.skipped).toBe(1);
  });

  it('extracts lat/lng pairs', () => {
    const rows = [
      { id: 1, lat: 40.7, lng: -74 },
      { id: 2, lat: null, lng: -74 },
      { id: 3, lat: 999, lng: 0 }, // out of range
    ];
    const result = extractPoints(rows, { kind: 'pair', latColumn: 'lat', lngColumn: 'lng' });
    expect(result.points).toHaveLength(1);
    expect(result.points[0]).toMatchObject({ lat: 40.7, lng: -74, rowIndex: 0 });
    expect(result.skipped).toBe(2);
  });

  it('preserves original row reference for popup rendering', () => {
    const row = { id: 1, lat: 40.7, lng: -74, name: 'NYC' };
    const result = extractPoints([row], { kind: 'pair', latColumn: 'lat', lngColumn: 'lng' });
    expect(result.points[0].row).toBe(row);
  });
});

describe('suggestLabelColumn', () => {
  it('prefers a name-like column', () => {
    const columns = [col('id'), col('lat'), col('lng'), col('name')];
    expect(suggestLabelColumn(columns, { kind: 'pair', latColumn: 'lat', lngColumn: 'lng' }))
      .toBe('name');
  });

  it('excludes coord columns', () => {
    const columns = [col('lat'), col('lng'), col('description')];
    expect(suggestLabelColumn(columns, { kind: 'pair', latColumn: 'lat', lngColumn: 'lng' }))
      .toBe('description');
  });

  it('excludes single-column geo', () => {
    const columns = [col('geom'), col('city')];
    expect(suggestLabelColumn(columns, { kind: 'single', column: 'geom' }))
      .toBe('city');
  });

  it('returns null when only coord columns', () => {
    const columns = [col('lat'), col('lng')];
    expect(suggestLabelColumn(columns, { kind: 'pair', latColumn: 'lat', lngColumn: 'lng' }))
      .toBeNull();
  });
});
