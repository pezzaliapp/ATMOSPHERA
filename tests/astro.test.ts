import { describe, expect, it } from 'vitest';
import { normalizeLongitude, subsolarPoint } from '../src/core/astro';

describe('subsolarPoint', () => {
  it('declinazione ~0° all’equinozio di marzo 2026 (20/03 14:46 UTC)', () => {
    const p = subsolarPoint(new Date('2026-03-20T14:46:00Z'));
    expect(Math.abs(p.lat)).toBeLessThan(0.05);
  });

  it('declinazione ~+23,44° al solstizio di giugno 2026 (21/06 08:24 UTC)', () => {
    const p = subsolarPoint(new Date('2026-06-21T08:24:00Z'));
    expect(p.lat).toBeCloseTo(23.44, 1);
  });

  it('declinazione ~−23,44° al solstizio di dicembre 2026 (21/12 20:50 UTC)', () => {
    const p = subsolarPoint(new Date('2026-12-21T20:50:00Z'));
    expect(p.lat).toBeCloseTo(-23.44, 1);
  });

  it('a mezzogiorno UTC la longitudine riflette l’equazione del tempo', () => {
    // Inizio novembre: il Sole "anticipa" di ~16,4 min → è già 4,1° a ovest di Greenwich.
    expect(subsolarPoint(new Date('2026-11-03T12:00:00Z')).lon).toBeCloseTo(-4.1, 0);
    // Metà febbraio: il Sole "ritarda" di ~14,2 min → si trova 3,6° a est.
    expect(subsolarPoint(new Date('2026-02-11T12:00:00Z')).lon).toBeCloseTo(3.55, 0);
  });

  it('si sposta verso ovest di 15° ogni ora', () => {
    const a = subsolarPoint(new Date('2026-10-23T10:00:00Z'));
    const b = subsolarPoint(new Date('2026-10-23T11:00:00Z'));
    expect(normalizeLongitude(a.lon - b.lon)).toBeCloseTo(15, 1);
  });

  it('restituisce longitudini nell’intervallo [-180, 180)', () => {
    for (let h = 0; h < 24; h++) {
      const { lon } = subsolarPoint(new Date(Date.UTC(2026, 9, 23, h)));
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThan(180);
    }
  });
});

describe('normalizeLongitude', () => {
  it('riporta gli angoli nell’intervallo [-180, 180)', () => {
    expect(normalizeLongitude(190)).toBe(-170);
    expect(normalizeLongitude(-190)).toBe(170);
    expect(normalizeLongitude(540)).toBe(-180);
    expect(normalizeLongitude(12.5)).toBe(12.5);
  });
});
