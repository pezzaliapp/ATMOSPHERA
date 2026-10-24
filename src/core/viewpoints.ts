import { clampState, maxTilt, type CameraState } from './camera-pose';

/**
 * Inquadrature di EXPLORE attorno a un punto (di norma l'occhio del ciclone).
 * Funzioni pure: nessun accesso alla scena.
 */

const DEG = Math.PI / 180;
/** Raggio terrestre / raggio dell'orbita geostazionaria (6378 / 42164 km). */
const GEO_RATIO = 0.15127;

/** Azimut (gradi da nord, orario) del cammino più breve da A verso B. */
export function azimuth(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const p1 = fromLat * DEG;
  const p2 = toLat * DEG;
  const dl = (toLon - fromLon) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / DEG) % 360 + 360) % 360;
}

/**
 * Direzione da cui un satellite geostazionario (longitudine satLon) vede il punto:
 * azimut verso il satellite e angolo zenitale del satellite visto dal punto.
 */
export function satelliteLook(lat: number, lon: number, satLon: number): { azimuth: number; zenith: number } {
  const cosC = Math.cos(lat * DEG) * Math.cos((lon - satLon) * DEG);
  const sinC = Math.sqrt(Math.max(0, 1 - cosC * cosC));
  return { azimuth: azimuth(lat, lon, 0, satLon), zenith: Math.atan2(sinC, cosC - GEO_RATIO) / DEG };
}

export type ViewpointId = 'eye' | 'eyewall' | 'whole' | 'satellite' | 'horizon';

export const VIEWPOINTS: readonly ViewpointId[] = ['eye', 'eyewall', 'whole', 'satellite', 'horizon'];

/**
 * Stato di camera per un'inquadratura attorno a center, partendo dalla camera attuale
 * (si conserva la direzione dello sguardo dove ha senso).
 */
export function viewpoint(id: ViewpointId, center: { lat: number; lon: number }, current: CameraState, satLon: number): CameraState {
  const base = { lat: center.lat, lon: center.lon, heading: current.heading };
  switch (id) {
    case 'eye':
      // Zenitale e vicino, ma senza ingrandire oltre la risoluzione dei dati (~2,8 km per pixel).
      return clampState({ ...base, tilt: 0, distance: 0.11 });
    case 'eyewall':
      // Radente e vicino: il dislivello tra pareti e occhio (rilievo ricostruito).
      return clampState({ ...base, tilt: 62, distance: 0.1 });
    case 'whole':
      return clampState({ ...base, tilt: 30, distance: 0.3 });
    case 'satellite': {
      // Dalla direzione del satellite: la camera sta lungo la linea di vista, lo sguardo opposto.
      const look = satelliteLook(center.lat, center.lon, satLon);
      return clampState({ ...base, heading: look.azimuth + 180, tilt: look.zenith, distance: 0.4 });
    }
    case 'horizon': {
      const distance = 0.11;
      return clampState({ ...base, tilt: maxTilt(distance) - 2, distance });
    }
  }
}
