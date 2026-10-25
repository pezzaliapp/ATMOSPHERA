import { ClampToEdgeWrapping, DataTexture, DataUtils, HalfFloatType, LinearFilter, RGBAFormat, Vector3 } from 'three';
import { subsolarPoint } from '../../src/core/astro';

/**
 * Milton, 7 ottobre 2024, 20:01 UTC (vicino al picco: 155 kt, 895 hPa). Campo nuvoloso di grande scala
 * dalle osservazioni GOES-16 già presenti nel progetto (stesse formule di src/volume/columns.ts),
 * riproiettato in un piano locale centrato sull'occhio: 1 unità = 1 km, +x est, −z nord.
 *
 * Mappa RGBA (512², 2 km per texel, ±512 km):
 *   R  spessore ottico ridotto τ' dall'albedo visibile (RICOSTRUITO)
 *   G  quota della sommità in km dalla temperatura di brillanza (RICOSTRUITA, 6,5 K/km)
 *   B  τ' mediato su ~20 km, per la luce del cielo sotto le nubi (ILLUSTRATIVO)
 *   A  albedo visibile osservata (OSSERVATA): tessitura fine della sommità
 */

export const FRAME = '20241007T2001Z';
export const OBSERVED = '2024-10-07T20:01:17Z';
const BOUNDS = { west: -100, south: 16, east: -68, north: 36 };
export const MAP_SIZE = 512;
export const MAP_HALF_KM = 512;
const KT_TO_MS = 0.514444;
const NM_TO_KM = 1.852;

export interface MiltonState {
  /** Centro dell'occhio (raffinato sul punto più caldo dell'infrarosso vicino alla traccia). */
  lat: number;
  lon: number;
  windKt: number;
  pressureHpa: number;
  rmwKm: number;
  vmaxMs: number;
  /** Direzione del Sole nel piano locale (unitaria). */
  sun: Vector3;
  sunElevationDeg: number;
  map: DataTexture;
}

interface Gray {
  w: number;
  h: number;
  v: Float32Array;
}

async function loadGray(url: string): Promise<Gray> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const { width: w, height: h } = canvas;
  const v = new Float32Array(w * h);
  for (let i = 0; i < v.length; i++) v[i] = data[i * 4]! / 255;
  canvas.width = canvas.height = 0;
  return { w, h, v };
}

/** Campionamento bilineare in coordinate geografiche (riga 0 = nord). */
function sampleGeo(g: Gray, lat: number, lon: number): number {
  const x = ((lon - BOUNDS.west) / (BOUNDS.east - BOUNDS.west)) * g.w - 0.5;
  const y = ((BOUNDS.north - lat) / (BOUNDS.north - BOUNDS.south)) * g.h - 0.5;
  const x0 = Math.max(0, Math.min(g.w - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(g.h - 2, Math.floor(y)));
  const fx = Math.min(1, Math.max(0, x - x0));
  const fy = Math.min(1, Math.max(0, y - y0));
  const i = y0 * g.w + x0;
  const a = g.v[i]! * (1 - fx) + g.v[i + 1]! * fx;
  const b = g.v[i + g.w]! * (1 - fx) + g.v[i + g.w + 1]! * fx;
  return a * (1 - fy) + b * fy;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const decodeBT = (v: number) => 180 + v * 130;

interface TrackPoint {
  time: string;
  lat: number;
  lon: number;
  windKt: number;
  pressureHpa: number;
  rmwNm: number;
}

function stateAt(points: TrackPoint[], time: number): TrackPoint {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const ta = Date.parse(a.time);
    const tb = Date.parse(b.time);
    if (time >= ta && time <= tb) {
      const f = (time - ta) / (tb - ta);
      const mix = (x: number, y: number) => x + (y - x) * f;
      return { time: new Date(time).toISOString(), lat: mix(a.lat, b.lat), lon: mix(a.lon, b.lon), windKt: mix(a.windKt, b.windKt), pressureHpa: mix(a.pressureHpa, b.pressureHpa), rmwNm: mix(a.rmwNm, b.rmwNm) };
    }
  }
  throw new Error('istante fuori dalla traccia');
}

/** Direzione del Sole nel piano locale (est, su, sud) per il punto e l'istante dati. */
function sunLocal(lat: number, lon: number, date: Date): Vector3 {
  const s = subsolarPoint(date);
  const r = Math.PI / 180;
  const ecef = (la: number, lo: number) => new Vector3(Math.cos(la * r) * Math.cos(lo * r), Math.cos(la * r) * Math.sin(lo * r), Math.sin(la * r));
  const sun = ecef(s.lat, s.lon);
  const up = ecef(lat, lon);
  const east = new Vector3(-Math.sin(lon * r), Math.cos(lon * r), 0);
  const north = new Vector3().crossVectors(up, east);
  return new Vector3(sun.dot(east), sun.dot(up), -sun.dot(north)).normalize();
}

export async function loadMilton(base = '/data/events/milton-2024/'): Promise<MiltonState> {
  const [track, albedo, bt] = await Promise.all([
    fetch(base + 'track.json').then((r) => r.json() as Promise<{ points: TrackPoint[] }>),
    loadGray(`${base}seq/${FRAME}-albedo.jpg`),
    loadGray(`${base}seq/${FRAME}-bt.jpg`),
  ]);
  const when = Date.parse(OBSERVED);
  const best = stateAt(track.points, when);

  // Occhio: baricentro dei pixel più caldi (BT entro 4 K dal massimo) entro ~25 km dalla traccia.
  const kmLat = 111.2;
  let warmest = 0;
  const cand: [number, number, number][] = [];
  for (let dy = -25; dy <= 25; dy += 1)
    for (let dx = -25; dx <= 25; dx += 1) {
      if (dx * dx + dy * dy > 625) continue;
      const lat = best.lat - dy / kmLat;
      const lon = best.lon + dx / (kmLat * Math.cos((best.lat * Math.PI) / 180));
      const t = decodeBT(sampleGeo(bt, lat, lon));
      cand.push([lat, lon, t]);
      warmest = Math.max(warmest, t);
    }
  let sw = 0;
  let sLat = 0;
  let sLon = 0;
  for (const [lat, lon, t] of cand)
    if (t > warmest - 4) {
      const w = t - (warmest - 4);
      sw += w;
      sLat += lat * w;
      sLon += lon * w;
    }
  const lat0 = sLat / sw;
  const lon0 = sLon / sw;

  const N = MAP_SIZE;
  const kmPerTexel = (2 * MAP_HALF_KM) / N;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const tau = new Float32Array(N * N);
  const top = new Float32Array(N * N);
  const albedoObs = new Float32Array(N * N);
  const oA = 0.75 * (32 / albedo.w) * 111.32 * cosLat; // ~1,5 pixel dell'albedo, in km
  const oB = 1.5 * (32 / bt.w) * 111.32 * cosLat;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * kmPerTexel - MAP_HALF_KM;
      const z = (j + 0.5) * kmPerTexel - MAP_HALF_KM;
      const geo = (dx: number, dz: number) => [lat0 - (z + dz) / kmLat, lon0 + (x + dx) / (111.32 * cosLat)] as const;
      const k = j * N + i;
      const [lat, lon] = geo(0, 0);
      const inside = lon > BOUNDS.west + 0.1 && lon < BOUNDS.east - 0.1 && lat > BOUNDS.south + 0.1 && lat < BOUNDS.north - 0.1;
      if (!inside || Math.hypot(x, z) > 490) continue;
      const a = (dx: number, dz: number) => sampleGeo(albedo, ...geo(dx, dz));
      const soft = 0.4 * a(0, 0) + 0.15 * (a(oA, oA) + a(-oA, -oA) + a(oA, -oA) + a(-oA, oA));
      let btSoft = 0;
      for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) btSoft += sampleGeo(bt, ...geo(u * oB, v * oB));
      const btK = decodeBT(btSoft / 9);
      const rr = Math.min(0.93, Math.max(0, (soft - 0.06) / 0.94));
      let t = ((2 * rr) / (1 - rr)) * smooth(304, 297, btK);
      t *= smooth(0.06, 0.2, t);
      tau[k] = t;
      albedoObs[k] = a(0, 0);
      top[k] = Math.min(18, Math.max(0, (300 - btK) / 6.5));
    }

  // τ' mediato su ~20 km (due passate di media mobile separabile).
  const blur = (src: Float32Array, radius: number) => {
    const tmp = new Float32Array(N * N);
    const out = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) acc += src[j * N + Math.min(N - 1, Math.max(0, i))]!;
      for (let i = 0; i < N; i++) {
        tmp[j * N + i] = acc / (2 * radius + 1);
        acc += src[j * N + Math.min(N - 1, i + radius + 1)]! - src[j * N + Math.max(0, i - radius)]!;
      }
    }
    for (let i = 0; i < N; i++) {
      let acc = 0;
      for (let j = -radius; j <= radius; j++) acc += tmp[Math.min(N - 1, Math.max(0, j)) * N + i]!;
      for (let j = 0; j < N; j++) {
        out[j * N + i] = acc / (2 * radius + 1);
        acc += tmp[Math.min(N - 1, j + radius + 1) * N + i]! - tmp[Math.max(0, j - radius) * N + i]!;
      }
    }
    return out;
  };
  const tauBlur = blur(blur(tau, 5), 5);

  const half = new Uint16Array(N * N * 4);
  for (let k = 0; k < N * N; k++) {
    half[k * 4] = DataUtils.toHalfFloat(tau[k]!);
    half[k * 4 + 1] = DataUtils.toHalfFloat(top[k]!);
    half[k * 4 + 2] = DataUtils.toHalfFloat(tauBlur[k]!);
    half[k * 4 + 3] = DataUtils.toHalfFloat(albedoObs[k]!);
  }
  const map = new DataTexture(half, N, N, RGBAFormat, HalfFloatType);
  map.minFilter = map.magFilter = LinearFilter;
  map.wrapS = map.wrapT = ClampToEdgeWrapping;
  map.generateMipmaps = false;
  map.needsUpdate = true;

  const sun = sunLocal(lat0, lon0, new Date(when));
  return {
    lat: lat0,
    lon: lon0,
    windKt: best.windKt,
    pressureHpa: best.pressureHpa,
    rmwKm: best.rmwNm * NM_TO_KM,
    vmaxMs: best.windKt * KT_TO_MS,
    sun,
    sunElevationDeg: (Math.asin(sun.y) * 180) / Math.PI,
    map,
  };
}
