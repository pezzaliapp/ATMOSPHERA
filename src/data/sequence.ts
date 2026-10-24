/**
 * Sequenza di osservazioni satellitari (vedi scripts/data/goes_sequence.py e motion_flow.py).
 *
 * Tra due osservazioni reali i fotogrammi intermedi sono ILLUSTRATIVI: ogni immagine viene
 * spostata lungo il campo di moto stimato e mescolata alle vicine. Per evitare che la
 * nitidezza "pulsi" (massima sulle osservazioni, minima a metà intervallo) la miscela usa
 * pesi B-spline cubici su quattro osservazioni: nessun dettaglio inventato, solo una media
 * pesata di immagini reali allineate dal moto.
 */

export interface SequenceFrame {
  id: string;
  /** Inizio effettivo della scansione, ISO 8601 UTC. */
  observed: string;
  albedo: string;
  bt: string;
  /** Campo di moto verso l'osservazione successiva (assente sull'ultima). */
  flow?: string;
}

export interface SequenceIndex {
  bounds: { west: number; south: number; east: number; north: number };
  albedoSize: [number, number];
  btSize: [number, number];
  flowEncoding: { downsample: number; scale: number; offset: number };
  parallax?: { corrected: boolean };
  frames: SequenceFrame[];
}

/** Posizione nella sequenza: intervallo [i, i+1] e frazione t ∈ [0, 1]. */
export interface SequencePosition {
  i: number;
  t: number;
}

export function frameTimes(index: SequenceIndex): number[] {
  return index.frames.map((f) => Date.parse(f.observed));
}

export function locate(times: readonly number[], ms: number): SequencePosition {
  const n = times.length;
  if (n < 2 || ms <= times[0]!) return { i: 0, t: 0 };
  if (ms >= times[n - 1]!) return { i: Math.max(0, n - 2), t: 1 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= ms) lo = mid;
    else hi = mid;
  }
  return { i: lo, t: (ms - times[lo]!) / (times[lo + 1]! - times[lo]!) };
}

/** Pesi B-spline cubici uniformi per le osservazioni i−1, i, i+1, i+2. */
export function bsplineWeights(t: number): [number, number, number, number] {
  const u = 1 - t;
  return [(u * u * u) / 6, (3 * t * t * t - 6 * t * t + 4) / 6, (-3 * t * t * t + 3 * t * t + 3 * t + 1) / 6, (t * t * t) / 6];
}

export interface BlendSlots {
  /** Indici delle osservazioni nei quattro slot (i−1, i, i+1, i+2), limitati alla sequenza. */
  indices: [number, number, number, number];
  weights: [number, number, number, number];
  t: number;
}

/**
 * Pesi di miscela per una posizione. smoothing = 0: interpolazione lineare tra i e i+1
 * (le osservazioni compaiono pure); smoothing = 1: B-spline (nitidezza uniforme).
 * Agli estremi della sequenza il peso dello slot mancante passa al vicino.
 */
export function blendSlots(pos: SequencePosition, count: number, smoothing: number): BlendSlots {
  const { i, t } = pos;
  const b = bsplineWeights(t);
  const s = Math.min(1, Math.max(0, smoothing));
  const w: [number, number, number, number] = [b[0] * s, (1 - t) * (1 - s) + b[1] * s, t * (1 - s) + b[2] * s, b[3] * s];
  const last = count - 1;
  const indices: [number, number, number, number] = [i - 1, i, Math.min(i + 1, last), i + 2];
  if (indices[0] < 0) {
    w[1] += w[0];
    w[0] = 0;
    indices[0] = indices[1];
  }
  if (indices[3] > last) {
    w[2] += w[3];
    w[3] = 0;
    indices[3] = indices[2];
  }
  return { indices, weights: w, t };
}

/** true se la posizione coincide (entro 0,5 s) con un'osservazione reale. */
export function observedAt(times: readonly number[], ms: number): number | null {
  for (let k = 0; k < times.length; k++) if (Math.abs(times[k]! - ms) < 500) return k;
  return null;
}
