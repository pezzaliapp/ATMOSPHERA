/** Grandezze derivate di un ciclone tropicale a partire dalla best track. */

import { normalizeLongitude } from '../core/astro';

export interface TrackPoint {
  time: string;
  record: string;
  status: string;
  lat: number;
  lon: number;
  windKt: number;
  pressureHpa: number | null;
  rmwNm: number | null;
}

export interface StormTrack {
  id: string;
  name: string;
  source: string;
  points: TrackPoint[];
}

export const KT_TO_KMH = 1.852;

/** Categoria Saffir-Simpson (1–5); 0 = tempesta tropicale; −1 = depressione o inferiore. */
export function saffirSimpson(windKt: number): number {
  if (windKt >= 137) return 5;
  if (windKt >= 113) return 4;
  if (windKt >= 96) return 3;
  if (windKt >= 83) return 2;
  if (windKt >= 64) return 1;
  if (windKt >= 34) return 0;
  return -1;
}

export function categoryLabel(windKt: number, status: string): string {
  const cat = saffirSimpson(windKt);
  if (status === 'EX') return 'Ciclone extratropicale';
  if (cat >= 1) return `Uragano · categoria ${cat}`;
  if (cat === 0) return 'Tempesta tropicale';
  return status === 'LO' ? 'Bassa pressione' : 'Depressione tropicale';
}

const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

export function greatCircleKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rotta iniziale da a verso b, in gradi da nord in senso orario. */
export function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const φ1 = a.lat * DEG;
  const φ2 = b.lat * DEG;
  const Δλ = (b.lon - a.lon) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];

export function compassIt(bearing: number): string {
  return COMPASS[Math.round(bearing / 22.5) % 16]!;
}

export interface StormState {
  time: Date;
  lat: number;
  lon: number;
  windKt: number;
  pressureHpa: number | null;
  status: string;
  /** true se l'istante coincide con un punto della best track (nessuna interpolazione). */
  exact: boolean;
  /** Movimento medio tra i punti adiacenti. */
  motion: { bearing: number; speedKmh: number } | null;
}

/**
 * Stato della tempesta a un istante: esatto sui punti della best track,
 * interpolato linearmente tra due punti (ricostruzione) altrimenti.
 */
export function stormAt(track: StormTrack, time: Date): StormState | null {
  const pts = track.points;
  const t = time.getTime();
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const ta = Date.parse(a.time);
    const tb = Date.parse(b.time);
    if (t < ta || t > tb) continue;
    const exactPoint = t === ta ? a : t === tb ? b : null;
    const f = (t - ta) / (tb - ta);
    const hours = (tb - ta) / 3_600_000;
    return {
      time,
      lat: exactPoint ? exactPoint.lat : a.lat + (b.lat - a.lat) * f,
      lon: exactPoint ? exactPoint.lon : normalizeLongitude(a.lon + normalizeLongitude(b.lon - a.lon) * f),
      windKt: exactPoint ? exactPoint.windKt : Math.round(a.windKt + (b.windKt - a.windKt) * f),
      pressureHpa:
        exactPoint?.pressureHpa ??
        (a.pressureHpa !== null && b.pressureHpa !== null
          ? Math.round(a.pressureHpa + (b.pressureHpa - a.pressureHpa) * f)
          : null),
      status: (exactPoint ?? (f < 0.5 ? a : b)).status,
      exact: exactPoint !== null,
      motion: hours > 0 ? { bearing: bearingDeg(a, b), speedKmh: greatCircleKm(a, b) / hours } : null,
    };
  }
  return null;
}
