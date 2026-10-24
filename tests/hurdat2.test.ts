import { describe, expect, it } from 'vitest';
import { parseHurdat2 } from '../src/data/hurdat2';

// Estratto reale di HURDAT2 (AL142024, Milton): intestazione + 3 righe.
const SAMPLE = `AL142024,             MILTON,      3,
20241007, 1800,  , HU, 21.7N,  91.3W, 150,  908,  110,  100,   80,  100,   50,   50,   40,   50,   30,   30,   20,   25,    5,
20241007, 2000, I, HU, 21.8N,  90.9W, 155,  895,  110,  100,   80,  100,   50,   50,   40,   50,   30,   30,   20,   25,    5,
20241010, 0030, L, HU, 27.4N,  82.6W, 100,  958,  130,  160,  120,   90,   80,   70,   50,   50,   40,   40,   30,   30,   20,
`;

describe('parseHurdat2', () => {
  const [storm] = parseHurdat2(SAMPLE);

  it('legge intestazione e numero di punti', () => {
    expect(storm?.id).toBe('AL142024');
    expect(storm?.name).toBe('MILTON');
    expect(storm?.points).toHaveLength(3);
  });

  it('converte tempo, coordinate (O negative) e valori', () => {
    expect(storm?.points[1]).toEqual({
      time: '2024-10-07T20:00:00Z',
      record: 'I',
      status: 'HU',
      lat: 21.8,
      lon: -90.9,
      windKt: 155,
      pressureHpa: 895,
      rmwNm: 5,
    });
  });

  it('riconosce il landfall', () => {
    expect(storm?.points[2]?.record).toBe('L');
    expect(storm?.points[2]?.time).toBe('2024-10-10T00:30:00Z');
  });

  it('gestisce più tempeste e righe vuote', () => {
    const two = parseHurdat2(`${SAMPLE}\nAL152024, NADINE, 1,\n20241019, 1600, L, TS, 17.5N, 88.2W, 50, 1002,\n`);
    expect(two.map((s) => s.name)).toEqual(['MILTON', 'NADINE']);
    expect(two[1]?.points[0]?.rmwNm).toBeNull();
  });
});
