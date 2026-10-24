import type { CameraKey } from '../core/camera-path';
import type { CameraState } from '../core/camera-pose';
import type { PlaceLabel } from '../layers/labels';

/** Didascalia del racconto: compare dall'istante indicato (UTC). Fonte dei numeri: best track NOAA. */
export interface StoryCaption {
  from: string;
  title: string;
  text: string;
}

/**
 * Evento E0: uragano Milton, 7 ottobre 2024 alle 20:00 UTC (picco di intensità nella best track).
 * L'istante delle nuvole è quello della scansione GOES-16 CONUS che inizia alle 20:01:17 UTC.
 */
export const MILTON_2024 = {
  id: 'milton-2024',
  title: 'Uragano Milton',
  subtitle: 'Golfo del Messico · ottobre 2024',
  time: new Date('2024-10-07T20:00:00Z'),
  dataPath: 'data/events/milton-2024/',
  /** Sequenza GOES-16 animata (osservazioni ogni 20 minuti, 12:21–23:41 UTC). */
  sequencePath: 'data/events/milton-2024/seq/',
  /** Esagerazione verticale delle nuvole (ILLUSTRATIVA). */
  cloudExaggeration: 2,
  /** Inquadratura iniziale: da sud-ovest verso la Florida, con lo Yucatán in primo piano. */
  camera: { lat: 22.4, lon: -90.2, heading: 40, tilt: 60, distance: 0.19 } satisfies CameraState,
  /** Schermi verticali: meno inclinata e più lontana, per ridurre il cielo vuoto. */
  cameraPortrait: { lat: 22.9, lon: -89.6, heading: 32, tilt: 46, distance: 0.3 } satisfies CameraState,
  /** Vista globo: stesso punto, camera lontana e verticale. */
  globe: { distance: 3.4, tilt: 0 } satisfies Partial<CameraState>,
  /**
   * STORY: dalle 12:50 alle 23:41 UTC (10 h 51 min di osservazioni) in 24 s, ≈ 27 minuti al secondo.
   * Alle 12:21 il Sole è appena sorto sull'uragano e le nubi sono ancora in penombra.
   * Regia: apertura sul Golfo all'alba, avvicinamento all'occhio durante l'intensificazione,
   * giro attorno all'occhio al picco, allontanamento verso la Florida al tramonto.
   */
  story: {
    start: '2024-10-07T12:50:00Z',
    seconds: 24,
    camera: [
      { at: 0, state: { lat: 20.4, lon: -95.2, heading: 50, tilt: 60, distance: 0.3 } },
      { at: 0.2, state: { lat: 21.0, lon: -93.0, heading: 42, tilt: 56, distance: 0.2 } },
      // Al picco la camera è centrata sull'occhio (posizioni della best track all'istante)
      // e quasi zenitale: l'occhio, largo ~15 km, resta riconoscibile tra le pareti.
      { at: 0.45, state: { lat: 21.7, lon: -91.35, heading: 62, tilt: 44, distance: 0.13 } },
      { at: 0.58, state: { lat: 21.76, lon: -91.07, heading: 84, tilt: 26, distance: 0.112 } },
      { at: 0.7, state: { lat: 21.8, lon: -90.85, heading: 108, tilt: 32, distance: 0.115 } },
      { at: 0.86, state: { lat: 22.3, lon: -89.8, heading: 70, tilt: 55, distance: 0.2 } },
      { at: 1, state: { lat: 23.4, lon: -87.8, heading: 52, tilt: 62, distance: 0.33 } },
    ] satisfies CameraKey[],
    captions: [
      {
        from: '2024-10-07T12:20:00Z',
        title: 'Alba sul Golfo del Messico',
        text: 'Milton è già un uragano di categoria 4: 943 hPa, venti a 222 km/h.',
      },
      {
        from: '2024-10-07T15:00:00Z',
        title: 'Intensificazione esplosiva',
        text: 'In sei ore il raggio dei venti massimi si dimezza, da 19 a 9 km.',
      },
      {
        from: '2024-10-07T19:00:00Z',
        title: 'Categoria 5',
        text: 'Alle 20:00 UTC il picco: 895 hPa e venti a 287 km/h.',
      },
      {
        from: '2024-10-07T22:20:00Z',
        title: 'Tramonto',
        text: 'Milton punta verso la Florida, dove toccherà terra il 10 ottobre.',
      },
    ] satisfies StoryCaption[],
  },
  localTimes: [
    { place: 'Mérida', offsetHours: -6, zone: 'UTC−6' },
    { place: 'Tampa', offsetHours: -4, zone: 'EDT' },
  ],
  labels: [
    { text: 'Golfo del Messico', lat: 25.6, lon: -91.5, kind: 'sea' },
    { text: 'Florida', lat: 27.1, lon: -80.9, kind: 'region' },
    { text: 'Penisola dello Yucatán', lat: 19.4, lon: -89.0, kind: 'region' },
    { text: 'Cuba', lat: 22.0, lon: -79.3, kind: 'region' },
    { text: 'Messico', lat: 24.0, lon: -99.0, kind: 'region' },
    { text: 'Stati Uniti', lat: 33.4, lon: -86.5, kind: 'region' },
    { text: 'Tampa', lat: 27.95, lon: -82.46, kind: 'city' },
    { text: 'Mérida', lat: 20.97, lon: -89.62, kind: 'city' },
    { text: 'L’Avana', lat: 23.11, lon: -82.37, kind: 'city' },
    { text: 'New Orleans', lat: 29.95, lon: -90.07, kind: 'city' },
    { text: 'Houston', lat: 29.76, lon: -95.37, kind: 'city' },
    { text: 'Cancún', lat: 21.16, lon: -86.85, kind: 'city' },
  ] satisfies PlaceLabel[],
} as const;
