import { describe, expect, it } from 'vitest';
import { median, nextVolumeScale } from '../src/volume/adaptive';

describe('nextVolumeScale', () => {
  it('riduce la risoluzione quando il volume costa troppo sulla GPU', () => {
    expect(nextVolumeScale(0.5, 0.3, 0.5, { gpuMs: 14, intervalMs: 16.7 })).toBeCloseTo(0.425);
  });
  it('non scende sotto il minimo', () => {
    expect(nextVolumeScale(0.31, 0.3, 0.5, { gpuMs: 30, intervalMs: 33 })).toBe(0.3);
  });
  it('risale fino al massimo del profilo quando c’è margine', () => {
    expect(nextVolumeScale(0.4, 0.3, 0.5, { gpuMs: 4, intervalMs: 16.7 })).toBeCloseTo(0.44);
    expect(nextVolumeScale(0.48, 0.3, 0.5, { gpuMs: 4, intervalMs: 16.7 })).toBe(0.5);
  });
  it('senza timer GPU usa il ritmo dei frame', () => {
    expect(nextVolumeScale(0.5, 0.3, 0.5, { gpuMs: null, intervalMs: 25 })).toBeCloseTo(0.425);
    expect(nextVolumeScale(0.4, 0.3, 0.5, { gpuMs: null, intervalMs: 16.7 })).toBeCloseTo(0.44);
    expect(nextVolumeScale(0.4, 0.3, 0.5, { gpuMs: null, intervalMs: 17.8 })).toBe(0.4);
    // 55 fps (≈18,2 ms) senza timer GPU: si riduce.
    expect(nextVolumeScale(0.5, 0.3, 0.5, { gpuMs: null, intervalMs: 18.2 })).toBeCloseTo(0.425);
  });
});

describe('median', () => {
  it('restituisce il valore centrale', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBeNull();
  });
});
