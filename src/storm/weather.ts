/**
 * STORM FLIGHT S2.2 — condizioni meteorologiche locali attorno al velivolo (RICOSTRUZIONE ILLUSTRATIVA).
 *
 * Dati usati: spessore ottico e quota della sommità dalla mappa GOES-16 (stessa della scena), distanza dal centro
 * e geometria dell'occhio della S1.1, quota del velivolo. Tutto il resto è stimato con valori tipici dei cicloni
 * tropicali, non misurato per Milton:
 * - temperatura: superficie del mare ~29,5 °C (valore tipico del Golfo a ottobre 2024), aria 1,5 °C più fredda,
 *   gradiente pseudo-adiabatico umido ~5,5 °C/km → isoterma 0 °C a ~5,1 km (tipica dei tropici: 4,5–5,5 km);
 * - pioggia: intensità stimata dalla colonna (nubi spesse e alte → piogge convettive), massima nella parete
 *   (in letteratura 50–200 mm/h), debole nell'occhio;
 * - fase: pioggia sopra 0 °C; tra 0 e −10 °C neve bagnata/graupel nelle zone convettive, neve granulosa altrove;
 *   sotto −15 °C cristalli di ghiaccio;
 * - grandine: rara nei cicloni tropicali maturi; solo episodi localizzati nelle celle convettive più alte
 *   (sommità ≥ 14 km, entro ~45 km dal centro, pioggia > 40 mm/h), tra lo 0 °C e ~9 km, decisi da un campo di
 *   celle fisso nello spazio (~10% della superficie convettiva; non casuale nel tempo);
 * - fulmini: nella parete e nelle bande convettive, frequenza moderata (intervallo minimo 2,5 s).
 */

export type Phase = 'none' | 'rain' | 'mixed' | 'graupel' | 'snow' | 'ice' | 'hail';
export const PHASE_LABEL: Record<Phase, string> = {
  none: 'nessuna precipitazione',
  rain: 'pioggia',
  mixed: 'pioggia con ghiaccio in fusione',
  graupel: 'graupel (neve tonda)',
  snow: 'neve granulosa',
  ice: 'cristalli di ghiaccio',
  hail: 'grandine (episodio)',
};

export interface WeatherInput {
  x: number;
  z: number;
  alt: number;
  r: number;
  tau: number;
  top: number;
  core: number;
  zone: string;
  turb: number;
  /** Densità delle nubi al velivolo (1/km), dalla sonda GPU. */
  sigma: number;
}

export interface Weather {
  /** Temperatura stimata (°C). */
  tempC: number;
  freezingKm: number;
  /** Intensità della pioggia equivalente (mm/h). */
  rateMmH: number;
  /** 0–1 per gli effetti (particelle, audio). */
  intensity: number;
  phase: Phase;
  /** Estinzione aggiuntiva delle precipitazioni (1/km), per la visibilità. */
  extinction: number;
  convective: number;
  hail: boolean;
}

const SST = 29.5;
const LAPSE = 5.5;
const FREEZING = (SST - 1.5) / LAPSE;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
// Rumore di valore 2D deterministico (celle convettive di qualche km, fisse nello spazio).
const hash = (i: number, j: number) => {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
function valueNoise(x: number, z: number) {
  const i = Math.floor(x), j = Math.floor(z);
  const fx = x - i, fz = z - j;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Quota della base delle nubi (km), come cloudBase() nello shader della S2.3. */
export function cloudBaseKm(tau: number, top: number, core: number) {
  const strat = (1 - core) * (1 - smooth(10, 30, tau));
  return Math.min(0.7 + (2.2 - 0.7) * strat, Math.max(0.6, top * 0.45));
}

/**
 * Sotto la base delle nubi la pioggia è a cortine: l'intensità segue la densità della cortina attraversata
 * (misurata dalla sonda GPU), così si entra e si esce dagli scrosci.
 */
export function shaftModulate(w: Weather, sigma: number, belowBase: boolean): Weather {
  if (!belowBase || w.rateMmH <= 0) return w;
  const f = Math.min(1, sigma / 1.5);
  // Fuori dalle cortine resta una pioggia stratiforme più debole (~30%).
  const rate = w.rateMmH * (0.3 + 1.0 * f);
  const phaseK = w.phase === 'mixed' ? 1.8 : w.phase === 'ice' ? 0.6 : 1;
  return { ...w, rateMmH: rate, intensity: Math.min(1, Math.sqrt(rate / 120)), extinction: 0.25 * Math.pow(rate, 0.63) * phaseK, phase: rate < 0.5 ? 'none' : w.phase };
}

export function weatherAt(w: WeatherInput): Weather {
  const tempC = SST - 1.5 - LAPSE * Math.max(0, w.alt);
  const eyeR = 6 + 0.55 * Math.max(0, w.alt);
  const inCloudColumn = w.alt < w.top + 0.3 && w.tau > 0.5;
  // Convezione: colonne spesse con sommità alta; la parete al massimo.
  const wall = w.core * (1 - smooth(4, 14, Math.abs(w.r - eyeR - 4)));
  const cells = valueNoise(w.x / 6, w.z / 6);
  const convective = Math.min(1, Math.max(wall, smooth(9, 15, w.top) * smooth(8, 22, w.tau) * (0.5 + 0.8 * cells)));
  let rate = 0;
  if (inCloudColumn && w.zone !== 'eye') {
    // Stratiforme: debole-moderata (1–10 mm/h); convettiva: forte (fino a ~150 mm/h in parete).
    rate = smooth(2, 12, w.tau) * (2 + 8 * cells) + convective * (20 + 130 * wall + 50 * cells);
  }
  // Sopra la sommità o nell'aria limpida dell'occhio: niente (un po' di pioggia trascinata vicino alla parete).
  // Nell'occhio l'aria discende ed è limpida: solo qualche goccia entro ~1 km dalla parete.
  if (w.zone === 'eye') rate = 1.5 * smooth(eyeR - 1, eyeR, w.r);
  // La sonda conferma: fuori dalle nubi visibili la pioggia cala (siamo sotto la base o in una schiarita).
  rate *= w.zone === 'clear' ? 0.25 : 1;
  rate = Math.max(0, rate);

  let phase: Phase = rate < 0.5 ? 'none' : 'rain';
  if (phase !== 'none') {
    if (tempC < -15) phase = 'ice';
    // S2.3: niente neve «decorativa»: sopra lo zero termico, fuori dalle celle convettive, solo cristalli di
    // ghiaccio (aggregati) che cadono lentamente; graupel nelle zone convettive.
    else if (tempC < -2) phase = convective > 0.5 ? 'graupel' : 'ice';
    else if (tempC < 1.5) phase = convective > 0.5 ? 'graupel' : 'mixed';
  }
  // Grandine: celle convettive più alte, tra 0 °C e ~9 km, solo dove il campo di celle fine supera una soglia.
  const hailCell = valueNoise(w.x / 2.5 + 31.7, w.z / 2.5 - 12.3);
  const hail = convective > 0.75 && w.top > 14 && w.r < 45 && w.alt > FREEZING - 0.5 && w.alt < 9 && hailCell > 0.9 && rate > 40;
  if (hail) phase = 'hail';

  // Visibilità: estinzione ~0,25·R^0,63 per km (≈ 4,5/km a 100 mm/h, visibilità ~0,9 km); neve e ghiaccio, a parità
  // di acqua, oscurano di più.
  const phaseK = phase === 'mixed' ? 1.8 : phase === 'ice' ? 0.6 : 1;
  const extinction = rate > 0 ? 0.25 * Math.pow(rate, 0.63) * phaseK : 0;
  return { tempC, freezingKm: FREEZING, rateMmH: rate, intensity: Math.min(1, Math.sqrt(rate / 120)), phase, extinction, convective, hail };
}

/**
 * Fulmini: processo di Poisson con frequenza legata alla convezione (al massimo ~1 ogni 6 s in parete),
 * intervallo minimo 2,5 s, distanza 0,6–15 km. Restituisce un evento quando avviene.
 */
export function createLightning() {
  let last = -10;
  return {
    reset() {
      last = -10;
    },
    step(t: number, dt: number, convective: number, zone: string) {
      // Mai nell'occhio né in aria limpida; sopra le sommità solo lampi lontani più rari.
      if (zone === 'eye' || zone === 'clear') return null;
      if (zone === 'above') convective *= 0.3;
      const rate = convective > 0.35 ? (convective - 0.35) * 0.28 : 0;
      if (t - last < 2.5 || Math.random() > rate * dt) return null;
      last = t;
      const distKm = 0.6 + Math.pow(Math.random(), 1.6) * 14.4;
      return { distKm, azimuth: Math.random() * Math.PI * 2, strength: 0.6 + 0.4 * Math.random() };
    },
  };
}
