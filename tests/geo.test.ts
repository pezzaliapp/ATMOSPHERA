import { describe, expect, it } from 'vitest';
import { formatLat, formatLon, latLonToVector, vectorToLatLon } from '../src/core/geo';

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9));

describe('latLonToVector', () => {
  it('rispetta la mappatura UV di SphereGeometry', () => {
    close(latLonToVector(0, 0), [1, 0, 0]);
    close(latLonToVector(0, 90), [0, 0, -1]);
    close(latLonToVector(0, -90), [0, 0, 1]);
    close(latLonToVector(0, 180), [-1, 0, 0]);
    close(latLonToVector(90, 0), [0, 1, 0]);
    close(latLonToVector(-90, 0), [0, -1, 0]);
  });

  it('applica il raggio', () => {
    close(latLonToVector(0, 0, 3), [3, 0, 0]);
  });

  it('è l’inversa di vectorToLatLon', () => {
    for (const [lat, lon] of [
      [41.9, 12.5],
      [-33.9, 151.2],
      [64.1, -21.9],
      [-54.8, -68.3],
    ] as const) {
      const back = vectorToLatLon(latLonToVector(lat, lon, 2));
      expect(back.lat).toBeCloseTo(lat, 9);
      expect(back.lon).toBeCloseTo(lon, 9);
    }
  });
});

describe('formattazione', () => {
  it('usa la virgola decimale e i punti cardinali italiani', () => {
    expect(formatLat(41.9)).toBe('41,9° N');
    expect(formatLat(-11.25, 2)).toBe('11,25° S');
    expect(formatLon(12.5)).toBe('12,5° E');
    expect(formatLon(-74)).toBe('74,0° O');
  });
});
