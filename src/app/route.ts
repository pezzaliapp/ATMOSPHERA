import type { PlaybackMode } from '../core/playback';

/**
 * Indirizzo condivisibile della scena, nel frammento: #/<modalità>/<evento>.
 * Esempi: #/story/milton-2024, #/explore/milton-2024. Nessun dato sul server.
 */

export interface Route {
  mode: PlaybackMode;
  eventId: string | null;
}

const MODES: readonly PlaybackMode[] = ['story', 'explore', 'replay'];

export function parseRoute(hash: string): Route {
  const [mode, eventId] = hash.replace(/^#\/?/, '').split('/');
  return {
    mode: MODES.includes(mode as PlaybackMode) ? (mode as PlaybackMode) : 'story',
    eventId: eventId && /^[a-z0-9-]+$/.test(eventId) ? eventId : null,
  };
}

export function formatRoute(route: { mode: PlaybackMode; eventId: string }): string {
  return `#/${route.mode}/${route.eventId}`;
}
