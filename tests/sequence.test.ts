import { describe, expect, it } from 'vitest';
import { blendSlots, bsplineWeights, locate, observedAt } from '../src/data/sequence';

const times = [0, 1000, 2000, 3000, 4000];
const sum = (w: readonly number[]) => w.reduce((a, b) => a + b, 0);

describe('locate', () => {
  it('trova intervallo e frazione', () => {
    expect(locate(times, 2500)).toEqual({ i: 2, t: 0.5 });
    expect(locate(times, 1000)).toEqual({ i: 1, t: 0 });
  });
  it('limita agli estremi', () => {
    expect(locate(times, -5)).toEqual({ i: 0, t: 0 });
    expect(locate(times, 9999)).toEqual({ i: 3, t: 1 });
  });
});

describe('bsplineWeights', () => {
  it('somma 1 e ha i valori noti', () => {
    for (const t of [0, 0.25, 0.5, 0.9, 1]) expect(sum(bsplineWeights(t))).toBeCloseTo(1, 12);
    const w = bsplineWeights(0);
    expect(w[0]).toBeCloseTo(1 / 6);
    expect(w[1]).toBeCloseTo(4 / 6);
    expect(w[2]).toBeCloseTo(1 / 6);
    expect(w[3]).toBeCloseTo(0);
  });
  it('è simmetrica', () => {
    const a = bsplineWeights(0.3);
    const b = bsplineWeights(0.7);
    expect(a[0]).toBeCloseTo(b[3]);
    expect(a[1]).toBeCloseTo(b[2]);
  });
});

describe('blendSlots', () => {
  it('senza miscela mostra le osservazioni pure', () => {
    const s = blendSlots({ i: 2, t: 0 }, 5, 0);
    expect(s.weights).toEqual([0, 1, 0, 0]);
    expect(s.indices).toEqual([1, 2, 3, 4]);
  });
  it('agli estremi sposta il peso sugli slot esistenti', () => {
    const first = blendSlots({ i: 0, t: 0.5 }, 5, 1);
    expect(first.weights[0]).toBe(0);
    expect(first.indices[0]).toBe(0);
    expect(sum(first.weights)).toBeCloseTo(1, 12);
    const last = blendSlots({ i: 3, t: 0.5 }, 5, 1);
    expect(last.weights[3]).toBe(0);
    expect(last.indices[3]).toBe(4);
    expect(sum(last.weights)).toBeCloseTo(1, 12);
  });
  it('la miscela è continua al cambio di intervallo', () => {
    // Fine dell'intervallo 1 (t = 1) e inizio dell'intervallo 2 (t = 0) danno lo stesso peso per frame.
    const a = blendSlots({ i: 1, t: 1 }, 5, 1);
    const b = blendSlots({ i: 2, t: 0 }, 5, 1);
    const perFrame = (s: ReturnType<typeof blendSlots>) => {
      const m = new Map<number, number>();
      s.indices.forEach((k, j) => m.set(k, (m.get(k) ?? 0) + s.weights[j]!));
      return m;
    };
    const pa = perFrame(a);
    const pb = perFrame(b);
    for (const k of [1, 2, 3]) expect(pa.get(k) ?? 0).toBeCloseTo(pb.get(k) ?? 0, 12);
  });
});

describe('observedAt', () => {
  it('riconosce le osservazioni entro mezzo secondo', () => {
    expect(observedAt(times, 2000.2)).toBe(2);
    expect(observedAt(times, 2500)).toBeNull();
  });
});
