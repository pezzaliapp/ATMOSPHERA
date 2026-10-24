import { describe, expect, it } from 'vitest';
import { cameraPose, clampState, lerpState, maxTilt, MIN_ALTITUDE, type CameraState } from '../src/core/camera-pose';
import { localFrame } from '../src/core/geo';

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
const len = (a: number[]) => Math.hypot(...a);

describe('localFrame', () => {
  it('è una base ortonormale coerente (est × nord = su)', () => {
    for (const [lat, lon] of [
      [0, 0],
      [21.8, -90.9],
      [-45, 120],
    ] as const) {
      const { up, east, north } = localFrame(lat, lon);
      expect(len(up)).toBeCloseTo(1, 9);
      expect(len(east)).toBeCloseTo(1, 9);
      expect(len(north)).toBeCloseTo(1, 9);
      expect(dot(up, east)).toBeCloseTo(0, 9);
      expect(dot(up, north)).toBeCloseTo(0, 9);
      expect(dot(east, north)).toBeCloseTo(0, 9);
      const c = [east[1] * north[2] - east[2] * north[1], east[2] * north[0] - east[0] * north[2], east[0] * north[1] - east[1] * north[0]];
      expect(dot(c, up)).toBeCloseTo(1, 9);
    }
  });
});

describe('cameraPose', () => {
  const base: CameraState = { lat: 21.8, lon: -90.9, heading: 40, tilt: 60, distance: 0.2 };

  it('con tilt 0 la camera è sulla verticale del punto', () => {
    const p = cameraPose({ ...base, tilt: 0 });
    expect(len(p.position)).toBeCloseTo(1.2, 9);
    expect(dot(p.position, p.target) / len(p.position)).toBeCloseTo(1, 9);
  });

  it('la camera sta alla distanza richiesta e "in alto" è perpendicolare allo sguardo', () => {
    const p = cameraPose(base);
    const view = p.position.map((v, i) => p.target[i]! - v);
    expect(len(view)).toBeCloseTo(0.2, 9);
    expect(dot(view, p.up)).toBeCloseTo(0, 9);
  });

  it('con heading 0 la camera è a sud del punto e guarda verso nord', () => {
    const p = cameraPose({ ...base, heading: 0, tilt: 45 });
    const { north } = localFrame(base.lat, base.lon);
    const offset = p.position.map((v, i) => v - p.target[i]!);
    expect(dot(offset, north)).toBeLessThan(0);
  });

  it('la quota della camera non scende sotto il minimo', () => {
    for (const distance of [0.06, 0.1, 0.3]) {
      const s = clampState({ ...base, distance, tilt: 89 });
      expect(len(cameraPose(s).position) - 1).toBeGreaterThan(MIN_ALTITUDE * 0.9);
    }
  });
});

describe('limiti e interpolazione', () => {
  it('allontanandosi l’inclinazione si annulla (vista globo)', () => {
    expect(maxTilt(0.2)).toBeGreaterThan(60);
    expect(maxTilt(3)).toBe(0);
  });

  it('interpola la longitudine lungo l’arco più breve', () => {
    const a: CameraState = { lat: 0, lon: 170, heading: 350, tilt: 0, distance: 1 };
    const b: CameraState = { lat: 0, lon: -170, heading: 10, tilt: 0, distance: 4 };
    const m = lerpState(a, b, 0.5);
    expect(Math.abs(m.lon)).toBeCloseTo(180, 6);
    expect(m.heading % 360).toBeCloseTo(0, 6);
    expect(m.distance).toBeCloseTo(2, 6); // media geometrica
  });
});
