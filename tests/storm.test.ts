import { describe, expect, it } from 'vitest';
import { bearingDeg, categoryLabel, compassIt, greatCircleKm, saffirSimpson, stormAt, type StormTrack } from '../src/data/storm';

const track: StormTrack = {
  id: 'AL142024',
  name: 'Milton',
  source: 'test',
  points: [
    { time: '2024-10-07T18:00:00Z', record: '', status: 'HU', lat: 21.7, lon: -91.3, windKt: 150, pressureHpa: 908, rmwNm: 5 },
    { time: '2024-10-07T20:00:00Z', record: 'I', status: 'HU', lat: 21.8, lon: -90.9, windKt: 155, pressureHpa: 895, rmwNm: 5 },
    { time: '2024-10-08T00:00:00Z', record: '', status: 'HU', lat: 21.8, lon: -90.4, windKt: 145, pressureHpa: 902, rmwNm: 5 },
  ],
};

describe('scala Saffir-Simpson', () => {
  it('rispetta le soglie in nodi', () => {
    expect([33, 34, 63, 64, 82, 83, 95, 96, 112, 113, 136, 137].map(saffirSimpson)).toEqual([
      -1, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5,
    ]);
  });

  it('etichette in italiano', () => {
    expect(categoryLabel(155, 'HU')).toBe('Uragano · categoria 5');
    expect(categoryLabel(50, 'TS')).toBe('Tempesta tropicale');
    expect(categoryLabel(60, 'EX')).toBe('Ciclone extratropicale');
  });
});

describe('geodesia', () => {
  it('distanza: un grado di latitudine ≈ 111,2 km', () => {
    expect(greatCircleKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111.19, 1);
  });

  it('rotta e punti cardinali', () => {
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 6);
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 6);
    expect(compassIt(270)).toBe('O');
    expect(compassIt(67.5)).toBe('ENE');
  });
});

describe('stormAt', () => {
  it('su un punto della best track restituisce i valori esatti', () => {
    const s = stormAt(track, new Date('2024-10-07T20:00:00Z'));
    expect(s).toMatchObject({ lat: 21.8, lon: -90.9, windKt: 155, pressureHpa: 895, exact: true });
  });

  it('tra due punti interpola e lo segnala', () => {
    const s = stormAt(track, new Date('2024-10-07T22:00:00Z'))!;
    expect(s.exact).toBe(false);
    expect(s.lon).toBeCloseTo(-90.65, 6);
    expect(s.windKt).toBe(150);
  });

  it('fuori dall’intervallo restituisce null', () => {
    expect(stormAt(track, new Date('2024-10-01T00:00:00Z'))).toBeNull();
  });

  it('calcola il movimento medio (Milton il 7/10: verso est, ~20 km/h)', () => {
    const s = stormAt(track, new Date('2024-10-07T20:00:00Z'))!;
    expect(compassIt(s.motion!.bearing)).toBe('ENE');
    expect(s.motion!.speedKmh).toBeGreaterThan(15);
    expect(s.motion!.speedKmh).toBeLessThan(30);
  });
});
