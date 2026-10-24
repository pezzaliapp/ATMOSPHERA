import { SRGBColorSpace, type Texture } from 'three';
import type { Engine } from '../core/engine';
import type { SequenceIndex } from '../data/sequence';
import type { StormTrack } from '../data/storm';
import { eventFolder, parseCatalog, parseEventManifest, type EventCatalog, type EventManifest } from '../events/manifest';

/** Tutto ciò che serve per costruire la scena di un evento. */
export interface LoadedEvent {
  catalog: EventCatalog;
  manifest: EventManifest;
  /** Indirizzo della cartella dell'evento, con «/» finale. */
  folder: string;
  sequenceUrl: string;
  track: StormTrack;
  index: SequenceIndex;
  dayMap: Texture;
  nightMap: Texture;
  surface: Texture;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

/**
 * Carica catalogo, manifest e dati di un evento (il primo del catalogo se l'id non c'è).
 * onProgress riceve l'avanzamento delle texture, 0–1.
 */
export async function loadEvent(engine: Engine, base: string, eventId: string | null, onProgress: (f: number) => void): Promise<LoadedEvent> {
  const catalogUrl = `${base}data/events/index.json`;
  const catalog = parseCatalog(await fetchJson(catalogUrl));
  const entry = catalog.events.find((e) => e.id === eventId) ?? catalog.events[0]!;
  const manifestUrl = new URL(entry.manifest, new URL(catalogUrl, location.href)).pathname;
  const manifest = parseEventManifest(await fetchJson(manifestUrl));
  const folder = eventFolder(manifestUrl);
  const sequenceUrl = `${folder}${manifest.data.sequence}`;

  const [track, index] = await Promise.all([
    fetchJson(`${folder}${manifest.data.track}`) as Promise<StormTrack>,
    fetchJson(`${sequenceUrl}frames.json`) as Promise<SequenceIndex>,
  ]);
  const size = engine.quality.textureSize;
  const textures = await engine.loadTextures(
    [
      { url: `${base}textures/earth-day-${size}.jpg`, colorSpace: SRGBColorSpace },
      { url: `${base}textures/earth-night-${size}.jpg`, colorSpace: SRGBColorSpace },
      { url: `${folder}${manifest.data.surface}`, colorSpace: SRGBColorSpace },
    ],
    onProgress,
  );
  const [dayMap, nightMap, surface] = textures as [Texture, Texture, Texture];
  return { catalog, manifest, folder, sequenceUrl, track, index, dayMap, nightMap, surface };
}
