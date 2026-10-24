/**
 * Risoluzione dinamica del volume: si adatta al costo misurato per restare fluida.
 * Funzione pura: i tempi vengono misurati altrove (timer GPU se disponibile, altrimenti
 * l'intervallo tra i frame).
 */

export interface FrameCost {
  /** Mediana del tempo GPU del volume, ms (null se il timer GPU non è disponibile). */
  gpuMs: number | null;
  /** Mediana dell'intervallo tra frame consecutivi, ms. */
  intervalMs: number;
}

/** Soglie: con il timer GPU si guarda il costo del volume, altrimenti il ritmo dei frame (60 Hz ≈ 16,7 ms). */
const GPU_SLOW = 11;
const GPU_FAST = 6;
const INTERVAL_SLOW = 18;
const INTERVAL_FAST = 17.5;

/**
 * Nuova scala del volume. `max` può essere il tetto corrente: dopo un rallentamento il chiamante
 * lo abbassa per qualche secondo, così la risoluzione non oscilla attorno al limite.
 */
export function nextVolumeScale(scale: number, min: number, max: number, cost: FrameCost): number {
  const slow = cost.gpuMs !== null ? cost.gpuMs > GPU_SLOW : cost.intervalMs > INTERVAL_SLOW;
  const fast = cost.gpuMs !== null ? cost.gpuMs < GPU_FAST : cost.intervalMs < INTERVAL_FAST;
  if (slow) return Math.max(min, scale * 0.85);
  if (fast) return Math.min(max, scale * 1.1);
  return scale;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
