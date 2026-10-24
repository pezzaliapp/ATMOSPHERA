/**
 * Posizione apparente del Sole a bassa precisione (errore tipico < 0,1°),
 * sufficiente per il terminatore giorno/notte.
 * Formule dell'Astronomical Almanac, sezione "Low precision formulas for the Sun".
 */

const DEG = Math.PI / 180;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const DAY_MS = 86_400_000;

export interface SubsolarPoint {
  /** Latitudine in gradi, positiva a nord. */
  lat: number;
  /** Longitudine in gradi, positiva a est, nell'intervallo [-180, 180). */
  lon: number;
}

/** Giorni (anche frazionari) trascorsi dall'epoca J2000.0. */
export function daysSinceJ2000(date: Date): number {
  return (date.getTime() - J2000_MS) / DAY_MS;
}

export function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function normalizeLongitude(deg: number): number {
  return normalizeDegrees(deg + 180) - 180;
}

/** Punto della superficie terrestre in cui il Sole è allo zenit. */
export function subsolarPoint(date: Date): SubsolarPoint {
  const d = daysSinceJ2000(date);

  const meanAnomaly = normalizeDegrees(357.529 + 0.98560028 * d) * DEG;
  const meanLongitude = normalizeDegrees(280.459 + 0.98564736 * d);
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG;
  const obliquity = (23.439 - 0.00000036 * d) * DEG;

  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));

  // Tempo siderale medio di Greenwich, in gradi.
  const gmst = normalizeDegrees(280.46061837 + 360.98564736629 * d);

  return {
    lat: declination / DEG,
    lon: normalizeLongitude(rightAscension / DEG - gmst),
  };
}
