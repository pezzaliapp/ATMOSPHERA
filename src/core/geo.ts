/**
 * Conversioni geografiche coerenti con la mappatura UV di THREE.SphereGeometry
 * e con texture equirettangolari centrate sul meridiano di Greenwich:
 * lon 0° → +X, lon 90° E → −Z, polo nord → +Y.
 */

const DEG = Math.PI / 180;

export type Vec3 = [x: number, y: number, z: number];

export function latLonToVector(lat: number, lon: number, radius = 1): Vec3 {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const cosPhi = Math.cos(phi);
  return [radius * cosPhi * Math.cos(lambda), radius * Math.sin(phi), -radius * cosPhi * Math.sin(lambda)];
}

export function vectorToLatLon([x, y, z]: Vec3): { lat: number; lon: number } {
  const r = Math.hypot(x, y, z);
  if (r === 0) return { lat: 0, lon: 0 };
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, y / r))) / DEG,
    lon: Math.atan2(-z, x) / DEG,
  };
}

/** Formatta una coordinata in stile italiano, es. "41,9° N". */
export function formatLat(lat: number, digits = 1): string {
  return `${Math.abs(lat).toFixed(digits).replace('.', ',')}° ${lat >= 0 ? 'N' : 'S'}`;
}

export function formatLon(lon: number, digits = 1): string {
  return `${Math.abs(lon).toFixed(digits).replace('.', ',')}° ${lon >= 0 ? 'E' : 'O'}`;
}

export interface LocalFrame {
  /** Normale alla superficie (verso l'alto). */
  up: Vec3;
  /** Tangente verso est. */
  east: Vec3;
  /** Tangente verso nord. */
  north: Vec3;
}

/** Base ortonormale locale in un punto della superficie (stessa convenzione di latLonToVector). */
export function localFrame(lat: number, lon: number): LocalFrame {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const sinL = Math.sin(lambda);
  const cosL = Math.cos(lambda);
  return {
    up: [cosPhi * cosL, sinPhi, -cosPhi * sinL],
    east: [-sinL, 0, -cosL],
    north: [-sinPhi * cosL, cosPhi, sinPhi * sinL],
  };
}
