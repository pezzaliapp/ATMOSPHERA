import { clampState, type CameraState } from './camera-pose';

/**
 * Percorso di camera per la regia: stati chiave a istanti normalizzati (0–1), uniti da una
 * spline di Catmull-Rom (nodi ai tempi dei punti chiave) per parametro. A differenza di voli separati, la camera non
 * si ferma sui punti chiave: velocità e direzione cambiano con continuità.
 * Distanza in scala logaritmica; heading e longitudine "srotolati" per evitare giri inutili.
 */

export interface CameraKey {
  at: number;
  state: CameraState;
}

type Vec5 = [number, number, number, number, number];

function unwrap(prev: number, next: number): number {
  return prev + ((((next - prev + 540) % 360) + 360) % 360) - 180;
}

function toVectors(keys: readonly CameraKey[]): Vec5[] {
  const out: Vec5[] = [];
  for (const { state } of keys) {
    const p = out.at(-1);
    out.push([
      state.lat,
      p ? unwrap(p[1], state.lon) : state.lon,
      p ? unwrap(p[2], state.heading) : state.heading,
      state.tilt,
      Math.log(state.distance),
    ]);
  }
  return out;
}

/** Catmull-Rom su nodi non uniformi (tempi dei punti chiave), per un singolo valore. */
function catmullRom(t: number, t0: number, t1: number, t2: number, t3: number, p0: number, p1: number, p2: number, p3: number): number {
  const m1 = ((p2 - p1) / (t2 - t1) + (p1 - p0) / (t1 - t0)) * 0.5 * (t2 - t1);
  const m2 = ((p3 - p2) / (t3 - t2) + (p2 - p1) / (t2 - t1)) * 0.5 * (t2 - t1);
  const s = (t - t1) / (t2 - t1);
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p1 + (s3 - 2 * s2 + s) * m1 + (-2 * s3 + 3 * s2) * p2 + (s3 - s2) * m2;
}

export function cameraAt(keys: readonly CameraKey[], u: number): CameraState {
  if (keys.length === 0) throw new Error('camera path without keys');
  if (keys.length === 1 || u <= keys[0]!.at) return clampState(keys[0]!.state);
  if (u >= keys.at(-1)!.at) return clampState(keys.at(-1)!.state);
  const v = toVectors(keys);
  let k = 0;
  while (keys[k + 1]!.at < u) k++;
  const n = keys.length;
  // Estremi: tangente nulla (partenza e arrivo dolci) duplicando il punto.
  const i0 = Math.max(0, k - 1);
  const i3 = Math.min(n - 1, k + 2);
  const t1 = keys[k]!.at;
  const t2 = keys[k + 1]!.at;
  const t0 = i0 === k ? t1 - (t2 - t1) : keys[i0]!.at;
  const t3 = i3 === k + 1 ? t2 + (t2 - t1) : keys[i3]!.at;
  const r = [0, 1, 2, 3, 4].map((c) =>
    catmullRom(u, t0, t1, t2, t3, v[i0]![c]!, v[k]![c]!, v[k + 1]![c]!, v[i3]![c]!),
  ) as Vec5;
  return clampState({ lat: r[0], lon: r[1], heading: r[2], tilt: r[3], distance: Math.exp(r[4]) });
}
