/**
 * Parser del formato NOAA NHC HURDAT2 (Atlantic hurricane database, revisione 2).
 * Specifica: https://www.nhc.noaa.gov/data/hurdat/hurdat2-format-atlantic.pdf
 * Modulo puro: usato dallo script di conversione e dai test, non dall'app.
 */

export interface Hurdat2Point {
  /** Istante in ISO 8601 UTC. */
  time: string;
  /** Identificatore di record: L landfall, I picco di intensità, R dettaglio su variazioni rapide, … */
  record: string;
  /** Stato del sistema: TD, TS, HU, EX, SD, SS, LO, WV, DB. */
  status: string;
  lat: number;
  lon: number;
  /** Vento massimo sostenuto (1 minuto) in nodi. */
  windKt: number;
  /** Pressione minima centrale in hPa (null se mancante). */
  pressureHpa: number | null;
  /** Raggio del vento massimo in miglia nautiche (dal 2021; null se mancante). */
  rmwNm: number | null;
}

export interface Hurdat2Storm {
  id: string;
  name: string;
  points: Hurdat2Point[];
}

function parseCoord(raw: string): number {
  const value = Number.parseFloat(raw);
  const hemi = raw.trim().slice(-1);
  if (Number.isNaN(value) || !'NSEW'.includes(hemi)) throw new Error(`coordinata non valida: ${raw}`);
  return hemi === 'S' || hemi === 'W' ? -value : value;
}

function optional(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) || value === -999 || value === -99 ? null : value;
}

export function parseHurdat2(text: string): Hurdat2Storm[] {
  const storms: Hurdat2Storm[] = [];
  let current: Hurdat2Storm | null = null;
  let remaining = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split(',').map((s) => s.trim());
    if (remaining === 0) {
      // Intestazione: AL142024, MILTON, 34,
      current = { id: f[0]!, name: f[1]!, points: [] };
      remaining = Number.parseInt(f[2]!, 10);
      storms.push(current);
      continue;
    }
    const [date, hhmm] = [f[0]!, f[1]!.padStart(4, '0')];
    current!.points.push({
      time: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`,
      record: f[2]!,
      status: f[3]!,
      lat: parseCoord(f[4]!),
      lon: parseCoord(f[5]!),
      windKt: Number.parseInt(f[6]!, 10),
      pressureHpa: optional(f[7]),
      rmwNm: optional(f[20]),
    });
    remaining--;
  }
  return storms;
}
