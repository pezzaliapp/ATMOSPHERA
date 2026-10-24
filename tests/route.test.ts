import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute } from '../src/app/route';

describe('indirizzo della scena', () => {
  it('legge modalità ed evento dal frammento', () => {
    expect(parseRoute('#/explore/milton-2024')).toEqual({ mode: 'explore', eventId: 'milton-2024' });
    expect(parseRoute('#/replay/milton-2024')).toEqual({ mode: 'replay', eventId: 'milton-2024' });
  });
  it('senza frammento o con valori non validi apre STORY sull’evento predefinito', () => {
    expect(parseRoute('')).toEqual({ mode: 'story', eventId: null });
    expect(parseRoute('#/live/x')).toEqual({ mode: 'story', eventId: 'x' });
    expect(parseRoute('#/explore/../../etc')).toEqual({ mode: 'explore', eventId: null });
  });
  it('andata e ritorno', () => {
    const r = { mode: 'explore' as const, eventId: 'milton-2024' };
    expect(parseRoute(formatRoute(r))).toEqual(r);
  });
});
