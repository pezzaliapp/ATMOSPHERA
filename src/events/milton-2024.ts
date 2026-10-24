import type { CameraState } from '../core/camera-pose';
import type { PlaceLabel } from '../layers/labels';

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
  /** Esagerazione verticale delle nuvole (ILLUSTRATIVA). */
  cloudExaggeration: 2,
  /** Inquadratura iniziale: da sud-ovest verso la Florida, con lo Yucatán in primo piano. */
  camera: { lat: 22.4, lon: -90.2, heading: 40, tilt: 60, distance: 0.19 } satisfies CameraState,
  /** Schermi verticali: meno inclinata e più lontana, per ridurre il cielo vuoto. */
  cameraPortrait: { lat: 22.9, lon: -89.6, heading: 32, tilt: 46, distance: 0.3 } satisfies CameraState,
  /** Vista globo: stesso punto, camera lontana e verticale. */
  globe: { distance: 3.4, tilt: 0 } satisfies Partial<CameraState>,
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
