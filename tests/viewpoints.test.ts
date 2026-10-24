import { describe, expect, it } from 'vitest';
import { MIN_DISTANCE } from '../src/core/camera-pose';
import { azimuth, satelliteLook, viewpoint, VIEWPOINTS } from '../src/core/viewpoints';

const eye = { lat: 21.8, lon: -90.9 };
const current = { lat: 22, lon: -90, heading: 40, tilt: 50, distance: 0.2 };

describe('inquadrature di EXPLORE', () => {
  it('azimut dei punti cardinali', () => {
    expect(azimuth(0, 0, 10, 0)).toBeCloseTo(0);
    expect(azimuth(0, 0, 0, 10)).toBeCloseTo(90);
    expect(azimuth(0, 0, -10, 0)).toBeCloseTo(180);
    expect(azimuth(0, 0, 0, -10)).toBeCloseTo(270);
  });
  it('geometria di GOES-16 vista dall’occhio di Milton', () => {
    const look = satelliteLook(eye.lat, eye.lon, -75.2);
    // Il satellite è a sud-est e alto sull'orizzonte (zenit ≈ 31°).
    expect(look.azimuth).toBeGreaterThan(120);
    expect(look.azimuth).toBeLessThan(160);
    expect(look.zenith).toBeGreaterThan(28);
    expect(look.zenith).toBeLessThan(34);
    // Sotto il satellite lo zenit è nullo.
    expect(satelliteLook(0, -75.2, -75.2).zenith).toBeCloseTo(0);
  });
  it('tutte le inquadrature sono centrate sull’occhio e valide', () => {
    for (const id of VIEWPOINTS) {
      const s = viewpoint(id, eye, current, -75.2);
      expect(s.lat).toBeCloseTo(eye.lat);
      expect(s.lon).toBeCloseTo(eye.lon);
      expect(s.distance).toBeGreaterThanOrEqual(MIN_DISTANCE);
      expect(s.tilt).toBeGreaterThanOrEqual(0);
    }
  });
  it('«come il satellite»: la camera sta dalla parte del satellite e guarda verso l’occhio', () => {
    const s = viewpoint('satellite', eye, current, -75.2);
    const look = satelliteLook(eye.lat, eye.lon, -75.2);
    expect(((s.heading - look.azimuth + 360) % 360)).toBeCloseTo(180);
    expect(s.tilt).toBeCloseTo(look.zenith);
  });
  it('sopra l’occhio è zenitale e conserva la direzione dello sguardo', () => {
    const s = viewpoint('eye', eye, current, -75.2);
    expect(s.tilt).toBe(0);
    expect(s.heading).toBeCloseTo(40);
  });
});
