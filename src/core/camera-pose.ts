import { localFrame, type Vec3 } from './geo';

/**
 * Stato della camera "a orbita sulla superficie": un punto osservato sulla Terra,
 * la direzione dello sguardo (heading), l'inclinazione rispetto alla verticale (tilt)
 * e la distanza dal punto. La vista globo è lo stesso stato con distanza grande e tilt nullo.
 */
export interface CameraState {
  lat: number;
  lon: number;
  /** Direzione dello sguardo in gradi da nord, in senso orario. */
  heading: number;
  /** 0° = sguardo verticale verso il basso; 90° = orizzonte. */
  tilt: number;
  /** Distanza camera–punto, in raggi terrestri. */
  distance: number;
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
}

const DEG = Math.PI / 180;

// Più vicino la griglia delle nuvole (≈5 km per vertice) mostrerebbe le sfaccettature.
export const MIN_DISTANCE = 0.06;
export const MAX_DISTANCE = 7;
/** Quota minima della camera sopra la superficie (≈ 64 km). */
export const MIN_ALTITUDE = 0.01;

/** Inclinazione massima consentita: si annulla gradualmente allontanandosi verso la vista globo. */
export function maxTilt(distance: number): number {
  const t = Math.min(1, Math.max(0, (distance - 0.5) / (1.4 - 0.5)));
  const fade = t * t * (3 - 2 * t);
  const byDistance = 74 * (1 - fade);
  // La camera non deve scendere sotto MIN_ALTITUDE (approssimazione piana, prudente).
  const byAltitude = Math.acos(Math.min(1, MIN_ALTITUDE / distance)) / DEG;
  return Math.max(0, Math.min(byDistance, byAltitude));
}

export function clampState(s: CameraState): CameraState {
  const distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, s.distance));
  return {
    lat: Math.min(85, Math.max(-85, s.lat)),
    lon: ((((s.lon + 180) % 360) + 360) % 360) - 180,
    heading: ((s.heading % 360) + 360) % 360,
    tilt: Math.min(maxTilt(distance), Math.max(0, s.tilt)),
    distance,
  };
}

export function cameraPose(s: CameraState): CameraPose {
  const { up: n, east, north } = localFrame(s.lat, s.lon);
  const h = s.heading * DEG;
  const t = s.tilt * DEG;
  // Direzione orizzontale dello sguardo.
  const fwd: Vec3 = [
    north[0] * Math.cos(h) + east[0] * Math.sin(h),
    north[1] * Math.cos(h) + east[1] * Math.sin(h),
    north[2] * Math.cos(h) + east[2] * Math.sin(h),
  ];
  const offset: Vec3 = [
    n[0] * Math.cos(t) - fwd[0] * Math.sin(t),
    n[1] * Math.cos(t) - fwd[1] * Math.sin(t),
    n[2] * Math.cos(t) - fwd[2] * Math.sin(t),
  ];
  return {
    target: n,
    position: [n[0] + offset[0] * s.distance, n[1] + offset[1] * s.distance, n[2] + offset[2] * s.distance],
    // Perpendicolare a offset: lo schermo "in alto" punta verso la direzione dello sguardo.
    up: [
      fwd[0] * Math.cos(t) + n[0] * Math.sin(t),
      fwd[1] * Math.cos(t) + n[1] * Math.sin(t),
      fwd[2] * Math.cos(t) + n[2] * Math.sin(t),
    ],
  };
}

/** Interpolazione tra due stati: distanza in scala logaritmica, angoli lungo l'arco più breve. */
export function lerpState(a: CameraState, b: CameraState, f: number): CameraState {
  const angle = (x: number, y: number) => x + ((((y - x + 540) % 360) + 360) % 360 - 180) * f;
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lon: angle(a.lon, b.lon),
    heading: angle(a.heading, b.heading),
    tilt: a.tilt + (b.tilt - a.tilt) * f,
    distance: Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * f),
  };
}
