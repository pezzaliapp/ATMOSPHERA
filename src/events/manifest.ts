import type { CameraKey } from '../core/camera-path';
import type { CameraState } from '../core/camera-pose';
import type { PlaceLabel } from '../layers/labels';

/**
 * Eventi come dati: ogni evento è una cartella public/data/events/<id>/ con un manifest
 * (event.json) e i suoi dati; il catalogo public/data/events/index.json li elenca.
 * Aggiungere un evento non richiede di modificare il codice dell'app.
 */

/** Didascalia del racconto: compare dall'istante indicato (UTC). */
export interface StoryCaption {
  from: string;
  title: string;
  text: string;
}

export interface EventManifest {
  schema: 1;
  id: string;
  kind: 'hurricane';
  title: string;
  subtitle: string;
  place: string;
  summary: string;
  /** Intervallo coperto dalle osservazioni (UTC). */
  period: { start: string; end: string };
  /** Satellite geostazionario delle osservazioni: serve per la vista «come il satellite». */
  satellite: { name: string; lon: number };
  sources: string[];
  /** Percorsi relativi alla cartella dell'evento. */
  data: { track: string; surface: string; sequence: string };
  /** Esagerazione verticale delle nuvole (ILLUSTRATIVA). */
  cloudExaggeration: number;
  camera: CameraState;
  /** Schermi verticali. */
  cameraPortrait: CameraState;
  globe: { distance: number; tilt: number };
  story: { start: string; seconds: number; camera: CameraKey[]; captions: StoryCaption[] };
  localTimes: { place: string; offsetHours: number; zone: string }[];
  labels: PlaceLabel[];
}

export interface CatalogEntry {
  id: string;
  title: string;
  subtitle: string;
  /** Percorso del manifest, relativo alla cartella del catalogo. */
  manifest: string;
}

export interface EventCatalog {
  schema: 1;
  events: CatalogEntry[];
}

class ManifestError extends Error {
  constructor(path: string, expected: string) {
    super(`manifest non valido: ${path} (atteso ${expected})`);
  }
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function field<T>(obj: Json, key: string, path: string, check: (v: unknown) => v is T, expected: string): T {
  const v = obj[key];
  if (!check(v)) throw new ManifestError(`${path}.${key}`, expected);
  return v;
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isDate = (v: unknown): v is string => isString(v) && !Number.isNaN(Date.parse(v));
const isArray = (v: unknown): v is unknown[] => Array.isArray(v);

function object(obj: Json, key: string, path: string): Json {
  return field(obj, key, path, isObject, 'oggetto');
}

function cameraState(v: unknown, path: string): CameraState {
  if (!isObject(v)) throw new ManifestError(path, 'stato di camera');
  const n = (k: string) => field(v, k, path, isNumber, 'numero');
  const state = { lat: n('lat'), lon: n('lon'), heading: n('heading'), tilt: n('tilt'), distance: n('distance') };
  if (state.distance <= 0) throw new ManifestError(`${path}.distance`, 'numero positivo');
  return state;
}

/** Controlla la struttura di un manifest letto da JSON; errore descrittivo se non è valido. */
export function parseEventManifest(raw: unknown): EventManifest {
  if (!isObject(raw)) throw new ManifestError('event', 'oggetto');
  const p = 'event';
  if (raw.schema !== 1) throw new ManifestError(`${p}.schema`, '1');
  if (raw.kind !== 'hurricane') throw new ManifestError(`${p}.kind`, '"hurricane"');
  const s = (k: string) => field(raw, k, p, isString, 'testo');

  const period = object(raw, 'period', p);
  const satellite = object(raw, 'satellite', p);
  const data = object(raw, 'data', p);
  const globe = object(raw, 'globe', p);
  const story = object(raw, 'story', p);

  const keys = field(story, 'camera', `${p}.story`, isArray, 'elenco').map((k, i): CameraKey => {
    const path = `${p}.story.camera[${i}]`;
    if (!isObject(k)) throw new ManifestError(path, 'oggetto');
    return { at: field(k, 'at', path, isNumber, 'numero'), state: cameraState(k.state, `${path}.state`) };
  });
  if (keys.length === 0) throw new ManifestError(`${p}.story.camera`, 'almeno un punto');
  keys.forEach((k, i) => {
    if (k.at < 0 || k.at > 1 || (i > 0 && k.at <= keys[i - 1]!.at)) {
      throw new ManifestError(`${p}.story.camera[${i}].at`, 'valori crescenti tra 0 e 1');
    }
  });

  const captions = field(story, 'captions', `${p}.story`, isArray, 'elenco').map((c, i): StoryCaption => {
    const path = `${p}.story.captions[${i}]`;
    if (!isObject(c)) throw new ManifestError(path, 'oggetto');
    return {
      from: field(c, 'from', path, isDate, 'data ISO'),
      title: field(c, 'title', path, isString, 'testo'),
      text: field(c, 'text', path, isString, 'testo'),
    };
  });

  const localTimes = field(raw, 'localTimes', p, isArray, 'elenco').map((z, i) => {
    const path = `${p}.localTimes[${i}]`;
    if (!isObject(z)) throw new ManifestError(path, 'oggetto');
    return {
      place: field(z, 'place', path, isString, 'testo'),
      offsetHours: field(z, 'offsetHours', path, isNumber, 'numero'),
      zone: field(z, 'zone', path, isString, 'testo'),
    };
  });

  const kinds = new Set(['region', 'city', 'sea', 'storm']);
  const labels = field(raw, 'labels', p, isArray, 'elenco').map((l, i): PlaceLabel => {
    const path = `${p}.labels[${i}]`;
    if (!isObject(l)) throw new ManifestError(path, 'oggetto');
    const kind = l.kind;
    if (typeof kind !== 'string' || !kinds.has(kind)) throw new ManifestError(`${path}.kind`, 'region | city | sea | storm');
    return {
      text: field(l, 'text', path, isString, 'testo'),
      lat: field(l, 'lat', path, isNumber, 'numero'),
      lon: field(l, 'lon', path, isNumber, 'numero'),
      kind: kind as PlaceLabel['kind'],
    };
  });

  const manifest: EventManifest = {
    schema: 1,
    id: s('id'),
    kind: 'hurricane',
    title: s('title'),
    subtitle: s('subtitle'),
    place: s('place'),
    summary: s('summary'),
    period: { start: field(period, 'start', `${p}.period`, isDate, 'data ISO'), end: field(period, 'end', `${p}.period`, isDate, 'data ISO') },
    satellite: { name: field(satellite, 'name', `${p}.satellite`, isString, 'testo'), lon: field(satellite, 'lon', `${p}.satellite`, isNumber, 'numero') },
    sources: field(raw, 'sources', p, isArray, 'elenco').map((x, i) => {
      if (!isString(x)) throw new ManifestError(`${p}.sources[${i}]`, 'testo');
      return x;
    }),
    data: {
      track: field(data, 'track', `${p}.data`, isString, 'percorso'),
      surface: field(data, 'surface', `${p}.data`, isString, 'percorso'),
      sequence: field(data, 'sequence', `${p}.data`, isString, 'percorso'),
    },
    cloudExaggeration: field(raw, 'cloudExaggeration', p, isNumber, 'numero'),
    camera: cameraState(raw.camera, `${p}.camera`),
    cameraPortrait: cameraState(raw.cameraPortrait, `${p}.cameraPortrait`),
    globe: { distance: field(globe, 'distance', `${p}.globe`, isNumber, 'numero'), tilt: field(globe, 'tilt', `${p}.globe`, isNumber, 'numero') },
    story: {
      start: field(story, 'start', `${p}.story`, isDate, 'data ISO'),
      seconds: field(story, 'seconds', `${p}.story`, isNumber, 'numero'),
      camera: keys,
      captions,
    },
    localTimes,
    labels,
  };
  if (Date.parse(manifest.period.end) <= Date.parse(manifest.period.start)) throw new ManifestError(`${p}.period`, 'fine dopo l’inizio');
  if (manifest.story.seconds <= 0) throw new ManifestError(`${p}.story.seconds`, 'numero positivo');
  return manifest;
}

export function parseCatalog(raw: unknown): EventCatalog {
  if (!isObject(raw) || raw.schema !== 1) throw new ManifestError('catalog.schema', '1');
  const events = field(raw, 'events', 'catalog', isArray, 'elenco').map((e, i): CatalogEntry => {
    const path = `catalog.events[${i}]`;
    if (!isObject(e)) throw new ManifestError(path, 'oggetto');
    return {
      id: field(e, 'id', path, isString, 'testo'),
      title: field(e, 'title', path, isString, 'testo'),
      subtitle: field(e, 'subtitle', path, isString, 'testo'),
      manifest: field(e, 'manifest', path, isString, 'percorso'),
    };
  });
  if (events.length === 0) throw new ManifestError('catalog.events', 'almeno un evento');
  return { schema: 1, events };
}

/** Cartella dell'evento (con «/» finale), dato l'indirizzo del manifest. */
export function eventFolder(manifestUrl: string): string {
  return manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
}
