import { describe, expect, it } from 'vitest';
import { Playback } from '../src/core/playback';

const H = 3_600_000;

describe('Playback', () => {
  it('STORY copre l’intervallo nella durata stabilita', () => {
    const p = new Playback({ start: 0, end: 12 * H }, 24);
    expect(p.minutesPerSecond).toBeCloseTo(30);
    p.update(12);
    expect(p.progress).toBeCloseTo(0.5);
  });
  it('si ferma alla fine e lo segnala', () => {
    const p = new Playback({ start: 0, end: H }, 10);
    let ended = false;
    p.onEnd = () => (ended = true);
    for (let k = 0; k < 20; k++) p.update(1);
    expect(p.time).toBe(H);
    expect(p.playing).toBe(false);
    expect(ended).toBe(true);
  });
  it('REPLAY usa la velocità scelta', () => {
    const p = new Playback({ start: 0, end: 10 * H }, 24);
    p.mode = 'replay';
    p.replaySpeed = 5;
    p.update(2);
    expect(p.time).toBe(10 * 60_000);
  });
  it('in pausa non avanza; seek resta nei limiti', () => {
    const p = new Playback({ start: 0, end: H }, 10);
    p.playing = false;
    expect(p.update(1)).toBe(false);
    p.seek(2 * H);
    expect(p.time).toBe(H);
  });
});
