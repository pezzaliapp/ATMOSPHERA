import {
  CatmullRomCurve3,
  Color,
  Group,
  LatheGeometry,
  Mesh,
  TubeGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { airfoil, conceptMaterials, loft, smooth, type ConceptMaterials } from './shape';

/**
 * Tre concept VTOL senza organi rotanti visibili (FLIGHT 2.0, progetti ORIGINALI, solo codice).
 * Riferimento: prua verso −z, alto +y, destra +x, metri. La quota 0 è il piano d'appoggio.
 *
 * La propulsione è RAPPRESENTATA (prese, griglie, fessure luminose): sono concept di fantascienza,
 * non soluzioni aeronautiche dimostrate.
 */

export interface Concept {
  group: Group;
  name: string;
  /** Dimensioni d'ingombro per le inquadrature: lunghezza, apertura, altezza. */
  size: Vector3;
  dispose(): void;
}

const smax = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
};
const superY = (f: number, half: number, e: number) => (f >= half ? 0 : Math.pow(1 - Math.pow(f / half, e), 1 / e));

/** Parametri di un corpo portante (fusoliera e ala in un'unica superficie). */
export interface LiftingBody {
  length: number;
  /** Semilarghezza della fusoliera, semiapertura (≥ fusoliera), quote dorso e ventre, centro verticale. */
  body: (t: number) => number;
  span: (t: number) => number;
  top: (t: number) => number;
  bottom: (t: number) => number;
  center: (t: number) => number;
  /** Spessore dell'ala alla radice (dorso, ventre) e esponente della sezione della fusoliera. */
  wingTop: (t: number) => number;
  wingBottom: (t: number) => number;
  exponent: number;
  /** Spostamento longitudinale dei punti esterni (bordo d'uscita a mezzaluna, ecc.). */
  zShift?: (xAbs: number, t: number) => number;
  sections?: number;
  across?: number;
}

/** Quota del dorso (sign = +1) o del ventre (−1) del corpo portante nel punto (x, t). */
export function surface(p: LiftingBody, x: number, t: number, sign: 1 | -1): number {
  const f = Math.abs(x);
  const b = Math.max(p.body(t), 1e-3);
  const w = Math.max(p.span(t), b);
  const bodyH = (sign > 0 ? p.top(t) : p.bottom(t)) * superY(f, b, p.exponent);
  const wingH = (sign > 0 ? p.wingTop(t) : p.wingBottom(t)) * Math.sqrt(Math.max(0, 1 - (f / w) ** 2)) * (1 - 0.55 * (f / w));
  return p.center(t) + sign * smax(bodyH, wingH, 0.12);
}

export function liftingBody(p: LiftingBody): BufferGeometry {
  const S = p.sections ?? 72;
  const K = p.across ?? 40;
  const rings: Vector3[][] = [];
  for (let k = 0; k <= S; k++) {
    const t = Math.min(0.9995, Math.max(0.0005, (1 - Math.cos((k / S) * Math.PI)) / 2));
    const w = Math.max(p.span(t), p.body(t));
    const z = -p.length / 2 + t * p.length;
    const ring: Vector3[] = [];
    // Dorso da sinistra a destra, ventre a ritroso: punti più fitti verso i bordi.
    for (let i = 0; i <= 2 * K; i++) {
      const s = i / K - 1;
      const x = w * Math.sin((s * Math.PI) / 2);
      ring.push(new Vector3(x, surface(p, x, t, 1), z + (p.zShift?.(Math.abs(x), t) ?? 0)));
    }
    for (let i = 2 * K - 1; i >= 1; i--) {
      const s = i / K - 1;
      const x = w * Math.sin((s * Math.PI) / 2);
      ring.push(new Vector3(x, surface(p, x, t, -1), z + (p.zShift?.(Math.abs(x), t) ?? 0)));
    }
    rings.push(ring);
  }
  return loft(rings, true, true);
}

/**
 * Abitacolo biposto: pavimento scuro, sedili, cruscotto e calotta panoramica.
 * La calotta poggia sul dorso (seguendone la quota ai lati) e i sedili restano sotto il vetro
 * con almeno 12 cm di margine (verificato in costruzione).
 */
export function cockpit(
  add: (g: BufferGeometry, m: Material, shadow?: boolean) => Mesh,
  m: ConceptMaterials,
  o: { z0: number; z1: number; halfWidth: number; height: number; surface: (x: number, z: number) => number },
) {
  const N = 40;
  const RING = 40;
  const rings: Vector3[][] = [];
  const canopyAt = (u: number) => {
    const z = o.z0 + (o.z1 - o.z0) * u;
    const hw = Math.max(0.02, o.halfWidth * Math.sin(Math.PI * u) ** 0.42);
    const base = o.surface(hw, z) - 0.03;
    const top = o.surface(0, z) + o.height * Math.sin(Math.PI * Math.min(1, u * 1.08)) ** 0.62;
    return { z, hw, base, top };
  };
  for (let k = 0; k <= N; k++) {
    const c = canopyAt(k / N);
    const ring: Vector3[] = [];
    for (let i = 0; i < RING; i++) {
      const th = (i / RING) * Math.PI * 2;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      const x = c.hw * Math.sign(cs) * Math.abs(cs) ** (2 / 2.4);
      const y = sn > 0 ? c.base + (c.top - c.base) * Math.abs(sn) ** (2 / 2.4) : c.base - 0.02 * Math.abs(sn);
      ring.push(new Vector3(x, y, c.z));
    }
    rings.push(ring);
  }
  add(loft(rings, true, true), m.glass, false);
  // Pavimento scuro sotto il vetro (copre la carrozzeria), poco sopra il dorso.
  const floorRings: Vector3[][] = [];
  for (let k = 0; k <= 20; k++) {
    const c = canopyAt(0.04 + (0.92 * k) / 20);
    const y = Math.max(o.surface(0, c.z), o.surface(c.hw * 0.9, c.z)) + 0.012;
    floorRings.push([new Vector3(-c.hw * 0.92, y, c.z), new Vector3(c.hw * 0.92, y, c.z), new Vector3(c.hw * 0.92, y - 0.01, c.z), new Vector3(-c.hw * 0.92, y - 0.01, c.z)]);
  }
  add(loft(floorRings, true, true), m.interior, false);
  // Sedili affiancati a metà calotta; la testiera è controllata contro il vetro.
  const seatU = 0.56;
  const sc = canopyAt(seatU);
  const floorY = o.surface(0, sc.z) + 0.012;
  const glassAt = (x: number) => sc.base + (sc.top - sc.base) * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(x) / sc.hw, 2.4)), 1 / 2.4);
  for (const side of [-1, 1]) {
    const x = side * Math.min(0.3, sc.hw * 0.42);
    const headTop = Math.min(floorY + 0.84, glassAt(x + side * 0.13) - 0.12);
    const backTop = headTop - 0.2;
    add(new RoundedBoxGeometry(0.44, 0.12, 0.46, 3, 0.04).translate(x, floorY + 0.12, sc.z - 0.18), m.seat, false);
    add(new RoundedBoxGeometry(0.44, backTop - floorY - 0.1, 0.12, 3, 0.05).rotateX(0.2).translate(x, (floorY + 0.12 + backTop) / 2, sc.z + 0.08), m.seat, false);
    add(new RoundedBoxGeometry(0.24, 0.15, 0.1, 3, 0.04).translate(x, headTop - 0.08, sc.z + 0.16), m.seat, false);
  }
  const dash = canopyAt(0.2);
  const dashY = o.surface(0, dash.z) + 0.1;
  add(new RoundedBoxGeometry(Math.min(0.95, dash.hw * 1.5), 0.12, 0.26, 2, 0.04).translate(0, dashY, dash.z + 0.1), m.interior, false);
  add(new RoundedBoxGeometry(Math.min(0.7, dash.hw * 1.1), 0.08, 0.02, 1, 0.005).rotateX(-0.6).translate(0, dashY + 0.09, dash.z + 0.2), m.screen, false);
  return canopyAt;
}

function makeGroup(env: Texture, body: Color) {
  const group = new Group();
  const m = conceptMaterials(env, body);
  const add = (g: BufferGeometry, material: Material, shadow = true) => {
    const mesh = new Mesh(g, material);
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    group.add(mesh);
    return mesh;
  };
  const tube = (pts: Vector3[], r: number, material: Material, segments = 80) => add(new TubeGeometry(new CatmullRomCurve3(pts), segments, r, 6, false), material, false);
  const dispose = () => {
    group.traverse((o) => o instanceof Mesh && o.geometry.dispose());
    for (const mat of Object.values(m)) mat.dispose();
  };
  return { group, m, add, tube, dispose };
}

/** Pannello sottile che segue una superficie (griglie e fessure di propulsione): quadrilatero da 4 angoli. */
export function patch(corners: Vector3[], thickness: number): BufferGeometry {
  const [a, b, c, d] = corners as [Vector3, Vector3, Vector3, Vector3];
  // Spessore verso l'alto per valori positivi, verso il basso per negativi (indipendente dall'ordine dei vertici).
  const up = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(d, a)).normalize();
  if (up.y < 0) up.negate();
  up.multiplyScalar(thickness);
  return loft([
    [a, b, c, d],
    [a.clone().add(up), b.clone().add(up), c.clone().add(up), d.clone().add(up)],
  ], true, true);
}

// ───────────────────────────── CONCEPT A — Ala integrata ─────────────────────────────
export function conceptA(env: Texture): Concept {
  const { group, m, add, tube, dispose } = makeGroup(env, new Color(0.72, 0.7, 0.66));
  const L = 7.4;
  const p: LiftingBody = {
    length: L,
    body: (t) => 0.82 * Math.sqrt(smooth(0, 0.34, t)) * (1 - 0.35 * smooth(0.55, 1, t)) + 0.01,
    // Muso affusolato: l'ala nasce dalla fusoliera e si allarga a freccia verso la coda.
    span: (t) => 0.82 * Math.sqrt(smooth(0, 0.34, t)) + 3.55 * smooth(0.18, 0.86, t) ** 1.1,
    top: (t) => 0.6 * Math.sqrt(smooth(0, 0.3, t)) * (1 - 0.8 * smooth(0.5, 1, t)) + 0.012,
    bottom: (t) => 0.42 * Math.sqrt(smooth(0, 0.3, t)) * (1 - 0.88 * smooth(0.45, 1, t)) + 0.008,
    center: (t) => 0.95 + 0.06 * smooth(0.4, 1, t),
    wingTop: (t) => 0.26 * (1 - 0.85 * smooth(0.6, 1, t)) + 0.01,
    wingBottom: (t) => 0.1 * (1 - 0.85 * smooth(0.6, 1, t)) + 0.006,
    exponent: 3.4,
    // Bordo d'uscita a mezzaluna: le estremità arretrano.
    zShift: (x, t) => 0.65 * (x / 4.35) ** 1.6 * smooth(0.55, 1, t),
  };
  add(liftingBody(p), m.body);
  const tOf = (z: number) => (z + L / 2) / L;
  const surf = (x: number, z: number) => surface(p, x, tOf(z), 1);
  cockpit(add, m, { z0: -L / 2 + 0.85, z1: -L / 2 + 4.4, halfWidth: 0.7, height: 0.74, surface: surf });

  // Alette d'estremità inclinate verso l'alto (superfici a profilo), con LED sul bordo d'attacco.
  const fin = airfoil(0, 0.4, 0.1, 12);
  for (const side of [-1, 1]) {
    const tipT = 0.93;
    const x0 = side * (p.span(tipT) - 0.08);
    const z0 = -L / 2 + tipT * L + p.zShift!(Math.abs(x0), tipT) - 0.55;
    const rings: Vector3[][] = [];
    for (let k = 0; k <= 8; k++) {
      const u = k / 8;
      const chord = 0.95 * (1 - 0.55 * u);
      const h = 0.62 * u;
      const out = 0.22 * u;
      rings.push(fin.map((pt) => new Vector3(x0 + side * (out + pt.y * chord * 0.6), p.center(tipT) + 0.03 + h, z0 + 0.35 * u + pt.x * chord)));
    }
    add(loft(rings, true, true), m.body);
    // LED sul bordo d'attacco dell'ala (dalla radice all'estremità).
    const pts: Vector3[] = [];
    for (let k = 0; k <= 16; k++) {
      const t = 0.3 + (0.6 * k) / 16;
      const w = p.span(t);
      const z = -L / 2 + t * L + p.zShift!(w * 0.985, t);
      pts.push(new Vector3(side * w * 0.985, surface(p, w * 0.985, t, 1) + 0.004, z - 0.02));
    }
    tube(pts, 0.012, m.led);
    add(new RoundedBoxGeometry(0.06, 0.06, 0.06, 2, 0.02).translate(x0 + side * 0.24, p.center(tipT) + 0.66, z0 + 0.42), side > 0 ? m.navGreen : m.navRed, false);
  }

  // Propulsione nascosta: quattro griglie di sostentamento sul ventre (feritoie con luce interna)
  // e una fessura di spinta lungo il bordo d'uscita centrale.
  for (const [xc, zc] of [
    [-1.55, 0.6],
    [1.55, 0.6],
    [-0.62, -1.2],
    [0.62, -1.2],
  ] as const) {
    for (let k = 0; k < 6; k++) {
      const z = zc - 0.42 + k * 0.17;
      const t = tOf(z);
      const y = (x: number) => surface(p, x, t, -1) - 0.004;
      const x0 = xc - 0.38;
      const x1 = xc + 0.38;
      add(patch([new Vector3(x0, y(x0), z), new Vector3(x1, y(x1), z), new Vector3(x1, y(x1), z + 0.09), new Vector3(x0, y(x0), z + 0.09)], -0.004), m.lift, false);
    }
  }
  const slit: Vector3[] = [];
  for (let k = 0; k <= 12; k++) {
    const x = -0.75 + (1.5 * k) / 12;
    const t = 0.985;
    slit.push(new Vector3(x, p.center(t) + 0.005, -L / 2 + t * L + p.zShift!(Math.abs(x), t) + 0.02));
  }
  tube(slit, 0.022, m.lift, 24);
  // Prese d'aria dorsali dietro la calotta: due fessure scure con filo LED.
  for (const side of [-1, 1]) {
    const pts = [0.56, 0.6, 0.64, 0.68].map((t) => {
      const x = side * 0.52;
      return new Vector3(x, surface(p, x, t, 1) + 0.004, -L / 2 + t * L);
    });
    tube(pts, 0.03, m.dark, 12);
    tube(pts.map((v) => v.clone().add(new Vector3(side * 0.05, 0.012, 0))), 0.006, m.led, 12);
  }
  // Pattini corti a scomparsa (in vista sulla piattaforma).
  for (const [x, z] of [
    [0, -2.4],
    [-1.3, 0.9],
    [1.3, 0.9],
  ] as const) {
    const t = tOf(z);
    const yb = surface(p, x, t, -1);
    add(new RoundedBoxGeometry(0.1, yb - 0.12, 0.1, 2, 0.03).translate(x, (yb + 0.12) / 2, z), m.dark);
    add(new RoundedBoxGeometry(0.32, 0.08, 0.42, 2, 0.03).translate(x, 0.06, z), m.dark);
  }
  return { group, name: 'A', size: new Vector3(L, 9.2, 2.3), dispose };
}

// ───────────────────────── CONCEPT B — Futuristico radicale: ala anulare ─────────────────────────
export function conceptB(env: Texture): Concept {
  const { group, m, add, tube, dispose } = makeGroup(env, new Color(0.9, 0.9, 0.9));
  const L = 6.6;
  const CY = 1.55;
  // Capsula a goccia.
  const pod: LiftingBody = {
    length: L,
    body: (t) => 0.72 * Math.sqrt(smooth(0, 0.36, t)) * (1 - 0.92 * smooth(0.5, 1, t)) + 0.01,
    span: () => 0,
    top: (t) => 0.62 * Math.sqrt(smooth(0, 0.33, t)) * (1 - 0.9 * smooth(0.5, 1, t)) + 0.01,
    bottom: (t) => 0.56 * Math.sqrt(smooth(0, 0.33, t)) * (1 - 0.9 * smooth(0.48, 1, t)) + 0.01,
    center: (t) => CY + 0.12 * smooth(0.5, 1, t),
    wingTop: () => 0,
    wingBottom: () => 0,
    exponent: 2.3,
    across: 24,
  };
  add(liftingBody(pod), m.body);
  const tOf = (z: number) => (z + L / 2) / L;
  cockpit(add, m, { z0: -L / 2 + 0.7, z1: -L / 2 + 3.7, halfWidth: 0.62, height: 0.5, surface: (x, z) => surface(pod, x, tOf(z), 1) });

  // Ala anulare ellittica attorno alla parte posteriore: profilo alare rivoluto attorno all'asse.
  const ringProfile = airfoil(0.05, 0.42, 0.15, 20);
  const chord = 1.55;
  const R = 2.3;
  const ringZ = 1.25;
  const pts = ringProfile.map((pt) => new Vector2(R - pt.y * chord, ringZ - chord / 2 + pt.x * chord));
  const ring = new LatheGeometry(pts, 96);
  // La rivoluzione avviene attorno a y: si ruota per avere l'asse lungo z, poi si schiaccia in verticale.
  ring.rotateX(Math.PI / 2);
  ring.scale(1.22, 0.78, 1);
  ring.translate(0, CY + 0.1, 0);
  ring.computeVertexNormals();
  add(ring, m.body);
  // Banda luminosa sul bordo d'uscita interno dell'anello (rappresenta il flusso accelerato).
  const band = (zz: number, rr: number, mat: Material, radius: number) => {
    const ptsB: Vector3[] = [];
    for (let k = 0; k <= 96; k++) {
      const a = (k / 96) * Math.PI * 2;
      ptsB.push(new Vector3(Math.cos(a) * rr * 1.22, CY + 0.1 + Math.sin(a) * rr * 0.78, zz));
    }
    add(new TubeGeometry(new CatmullRomCurve3(ptsB, true), 192, radius, 6, true), mat, false);
  };
  band(ringZ + chord / 2 - 0.12, R - 0.07, m.lift, 0.03);
  band(ringZ - chord / 2 + 0.25, R + 0.11, m.led, 0.012);
  // Due piloni orizzontali e una deriva dorsale collegano capsula e anello.
  const strut = airfoil(0, 0.4, 0.14, 12);
  const strutLoft = (from: Vector3, to: Vector3, c: number, vertical: boolean) => {
    const rings: Vector3[][] = [];
    for (let k = 0; k <= 6; k++) {
      const q = from.clone().lerp(to, k / 6);
      rings.push(strut.map((pt) => (vertical ? new Vector3(q.x + pt.y * c, q.y, q.z - c / 2 + pt.x * c) : new Vector3(q.x, q.y + pt.y * c, q.z - c / 2 + pt.x * c))));
    }
    add(loft(rings, true, true), m.body);
  };
  for (const side of [-1, 1]) strutLoft(new Vector3(side * 0.3, CY + 0.05, ringZ + 0.1), new Vector3(side * (R * 1.22 - 0.05), CY + 0.1, ringZ + 0.1), 1.1, false);
  strutLoft(new Vector3(0, CY + 0.25, ringZ + 0.2), new Vector3(0, CY + 0.1 + R * 0.78 - 0.05, ringZ + 0.2), 1.0, true);
  // Luci di navigazione sull'anello e filo LED lungo la capsula.
  add(new RoundedBoxGeometry(0.07, 0.07, 0.07, 2, 0.02).translate(R * 1.22 + 0.06, CY + 0.1, ringZ - 0.4), m.navGreen, false);
  add(new RoundedBoxGeometry(0.07, 0.07, 0.07, 2, 0.02).translate(-R * 1.22 - 0.06, CY + 0.1, ringZ - 0.4), m.navRed, false);
  for (const side of [-1, 1]) {
    const line: Vector3[] = [];
    for (let k = 0; k <= 14; k++) {
      const t = 0.34 + (0.36 * k) / 14;
      const b = pod.body(t);
      line.push(new Vector3(side * (b + 0.004), pod.center(t) - 0.04, -L / 2 + t * L));
    }
    tube(line, 0.012, m.led);
  }
  // Supporto d'appoggio: tre gambe sottili sotto l'anello e la capsula.
  for (const [x, z] of [
    [0, -1.5],
    [-1.75, 1.25],
    [1.75, 1.25],
  ] as const) {
    const yTop = x === 0 ? surface(pod, 0, tOf(z), -1) : CY + 0.1 - R * 0.78 * Math.sqrt(1 - (x / (R * 1.22)) ** 2);
    add(new RoundedBoxGeometry(0.09, yTop - 0.1, 0.09, 2, 0.03).translate(x, (yTop + 0.1) / 2, z), m.dark);
    add(new RoundedBoxGeometry(0.3, 0.08, 0.36, 2, 0.03).translate(x, 0.05, z), m.dark);
  }
  return { group, name: 'B', size: new Vector3(L, 6.4, 3.6), dispose };
}

// ─────────────────────── CONCEPT C — VTOL di nuova generazione: delta a spigoli ───────────────────────
export function conceptC(env: Texture): Concept {
  const { group, m, add, tube, dispose } = makeGroup(env, new Color(0.2, 0.22, 0.25));
  const L = 7.8;
  const p: LiftingBody = {
    length: L,
    body: (t) => 0.7 * smooth(0, 0.42, t) ** 0.7 * (1 - 0.25 * smooth(0.7, 1, t)) + 0.01,
    // Delta pura: semiapertura che cresce linearmente dal muso.
    span: (t) => 0.1 + 3.15 * smooth(0.05, 0.97, t),
    top: (t) => 0.46 * Math.sqrt(smooth(0, 0.36, t)) * (1 - 0.75 * smooth(0.55, 1, t)) + 0.01,
    bottom: (t) => 0.3 * Math.sqrt(smooth(0, 0.36, t)) * (1 - 0.85 * smooth(0.5, 1, t)) + 0.008,
    center: () => 0.95,
    wingTop: (t) => 0.17 * (1 - 0.8 * smooth(0.75, 1, t)) * smooth(0.05, 0.3, t) + 0.008,
    wingBottom: (t) => 0.09 * (1 - 0.8 * smooth(0.75, 1, t)) * smooth(0.05, 0.3, t) + 0.006,
    // Sezione a diamante: spigoli vivi (chine) lungo i fianchi.
    exponent: 1.35,
  };
  add(liftingBody(p), m.body);
  const tOf = (z: number) => (z + L / 2) / L;
  const surf = (x: number, z: number) => surface(p, x, tOf(z), 1);
  cockpit(add, m, { z0: -L / 2 + 1.15, z1: -L / 2 + 4.5, halfWidth: 0.6, height: 0.64, surface: surf });

  // Due derive inclinate all'esterno sul bordo d'uscita.
  const finProfile = airfoil(0, 0.4, 0.09, 12);
  for (const side of [-1, 1]) {
    const t0 = 0.8;
    const x0 = side * 1.25;
    const y0 = surface(p, x0, t0, 1) - 0.02;
    const z0 = -L / 2 + t0 * L;
    const rings: Vector3[][] = [];
    for (let k = 0; k <= 8; k++) {
      const u = k / 8;
      const chord = 1.5 * (1 - 0.5 * u);
      rings.push(finProfile.map((pt) => new Vector3(x0 + side * (0.42 * u + pt.y * chord * 0.5), y0 + 1.05 * u, z0 + 0.6 * u + pt.x * chord)));
    }
    add(loft(rings, true, true), m.body);
    // Filo LED sul bordo d'attacco della deriva.
    tube([0.05, 0.3, 0.55, 0.8, 1].map((u) => new Vector3(x0 + side * 0.42 * u, y0 + 1.05 * u + 0.01, z0 + 0.6 * u - 0.01)), 0.01, m.led, 16);
    add(new RoundedBoxGeometry(0.07, 0.07, 0.07, 2, 0.02).translate(side * (p.span(0.96) - 0.05), surface(p, side * (p.span(0.96) - 0.05), 0.96, 1) + 0.03, -L / 2 + 0.96 * L), side > 0 ? m.navGreen : m.navRed, false);
  }
  // Porte di sostentamento con lamelle chiuse sul dorso delle ali (fessure luminose tra le lamelle).
  for (const side of [-1, 1]) {
    const xc = side * 1.5;
    for (let k = 0; k < 7; k++) {
      const z = -L / 2 + 0.6 * L + k * 0.2;
      const t = tOf(z);
      const y = (x: number) => surface(p, x, t, 1);
      const xa = xc - 0.45;
      const xb = xc + 0.45;
      add(patch([new Vector3(xa, y(xa) + 0.006, z), new Vector3(xb, y(xb) + 0.006, z), new Vector3(xb, y(xb) + 0.006, z + 0.035), new Vector3(xa, y(xa) + 0.006, z + 0.035)], 0.003), m.lift, false);
    }
  }
  // Due ugelli rettangolari appiattiti nel bordo d'uscita, con bagliore interno.
  for (const side of [-1, 1]) {
    const x = side * 0.42;
    const t = 0.975;
    const z = -L / 2 + t * L;
    const yc = p.center(t);
    add(new RoundedBoxGeometry(0.55, 0.14, 0.22, 2, 0.04).translate(x, yc, z), m.dark);
    add(new RoundedBoxGeometry(0.45, 0.06, 0.02, 1, 0.01).translate(x, yc, z + 0.11), m.lift, false);
  }
  // Fila di LED lungo lo spigolo laterale (chine) della fusoliera.
  for (const side of [-1, 1]) {
    const pts: Vector3[] = [];
    for (let k = 0; k <= 16; k++) {
      const t = 0.12 + (0.5 * k) / 16;
      const b = p.body(t) * 0.98;
      pts.push(new Vector3(side * b, surface(p, b, t, 1) + 0.006, -L / 2 + t * L));
    }
    tube(pts, 0.01, m.led);
  }
  for (const [x, z] of [
    [0, -2.6],
    [-1.4, 1.2],
    [1.4, 1.2],
  ] as const) {
    const yb = surface(p, x, tOf(z), -1);
    add(new RoundedBoxGeometry(0.1, yb - 0.12, 0.1, 2, 0.03).translate(x, (yb + 0.12) / 2, z), m.dark);
    add(new RoundedBoxGeometry(0.3, 0.08, 0.4, 2, 0.03).translate(x, 0.06, z), m.dark);
  }
  return { group, name: 'C', size: new Vector3(L, 6.6, 2.4), dispose };
}
