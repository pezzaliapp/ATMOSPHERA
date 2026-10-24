import { describe, expect, it } from 'vitest';
import { cameraAt, type CameraKey } from '../src/core/camera-path';

const keys: CameraKey[] = [
  { at: 0, state: { lat: 20, lon: -95, heading: 350, tilt: 60, distance: 0.4 } },
  { at: 0.5, state: { lat: 21, lon: -92, heading: 20, tilt: 50, distance: 0.1 } },
  { at: 1, state: { lat: 23, lon: -88, heading: 60, tilt: 60, distance: 0.3 } },
];

describe('cameraAt', () => {
  it('passa per i punti chiave', () => {
    const mid = cameraAt(keys, 0.5);
    expect(mid.lat).toBeCloseTo(21);
    expect(mid.distance).toBeCloseTo(0.1);
    expect(cameraAt(keys, 0).heading).toBeCloseTo(350);
    expect(cameraAt(keys, 1).lon).toBeCloseTo(-88);
  });
  it('gira lungo l’arco più breve (350° → 20° passa per 0°)', () => {
    const h = cameraAt(keys, 0.25).heading;
    expect(h > 340 || h < 30).toBe(true);
  });
  it('è continua: nessun salto tra campioni vicini', () => {
    let prev = cameraAt(keys, 0);
    for (let u = 0.002; u <= 1; u += 0.002) {
      const s = cameraAt(keys, u);
      expect(Math.abs(s.lat - prev.lat)).toBeLessThan(0.05);
      expect(Math.abs(Math.log(s.distance / prev.distance))).toBeLessThan(0.05);
      prev = s;
    }
  });
});
