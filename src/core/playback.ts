/**
 * Orologio di riproduzione degli eventi.
 *
 * STORY: racconto accelerato a durata fissa, con regia della camera.
 * EXPLORE: camera libera; il tempo scorre a velocità scelta e ricomincia alla fine.
 * REPLAY: riproduzione scientifica a velocità scelta (minuti di osservazione per secondo),
 *         sempre con l'ora reale indicata.
 * Funzione pura rispetto al tempo: update(dt) avanza, nessun accesso a orologi di sistema.
 */

export type PlaybackMode = 'story' | 'explore' | 'replay';

export interface PlaybackRange {
  start: number;
  end: number;
}

export class Playback {
  mode: PlaybackMode = 'story';
  playing = true;
  /** Istante rappresentato, in ms UTC. */
  time: number;
  /** EXPLORE e REPLAY: minuti di osservazione per secondo reale. */
  replaySpeed = 20;
  loop = false;
  onEnd: (() => void) | null = null;

  /** Intervallo raccontato da STORY (può iniziare dopo la prima osservazione). */
  readonly storyRange: PlaybackRange;

  constructor(
    readonly range: PlaybackRange,
    /** Durata del racconto STORY, in secondi. */
    readonly storySeconds: number,
    storyStart = range.start,
  ) {
    this.storyRange = { start: Math.max(range.start, storyStart), end: range.end };
    this.time = this.storyRange.start;
  }

  /** Posizione nell'intera sequenza, 0–1. */
  get progress(): number {
    return (this.time - this.range.start) / (this.range.end - this.range.start);
  }

  /** Avanzamento del racconto STORY, 0–1. */
  get storyProgress(): number {
    const r = this.storyRange;
    return Math.min(1, Math.max(0, (this.time - r.start) / (r.end - r.start)));
  }

  /** Minuti di osservazione per secondo nella modalità corrente. */
  get minutesPerSecond(): number {
    if (this.mode === 'story') return (this.storyRange.end - this.storyRange.start) / 60_000 / this.storySeconds;
    return this.replaySpeed;
  }

  /** Riparte dall'inizio del racconto. */
  restartStory(): void {
    this.time = this.storyRange.start;
  }

  seek(time: number): void {
    this.time = Math.min(this.range.end, Math.max(this.range.start, time));
  }

  seekProgress(u: number): void {
    this.seek(this.range.start + (this.range.end - this.range.start) * u);
  }

  /** Avanza di dt secondi reali; restituisce true se l'istante è cambiato. */
  update(dt: number): boolean {
    if (!this.playing) return false;
    const before = this.time;
    this.time += dt * this.minutesPerSecond * 60_000;
    if (this.time >= this.range.end) {
      if (this.loop) this.time = this.range.start + (this.time - this.range.end);
      else {
        this.time = this.range.end;
        this.playing = false;
        this.onEnd?.();
      }
    }
    return this.time !== before;
  }
}
