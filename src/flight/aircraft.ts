import {
  CatmullRomCurve3,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  SphereGeometry,
  TubeGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { cockpit, liftingBody, patch, surface, type LiftingBody } from './concepts/concepts';
import { airfoil, loft, smooth, type ConceptMaterials } from './concepts/shape';

/**
 * ATMOSPHERA FLIGHT — velivolo definitivo (Concept C perfezionato), progetto ORIGINALE.
 *
 * Delta a spigoli in grafite metallizzata, muso affusolato, due derive inclinate, lamelle dorsali
 * incassate nelle ali, calotta biposto, ugelli posteriori appiattiti. Nessun organo rotante visibile:
 * lamelle e ugelli RAPPRESENTANO una propulsione da concept di simulazione, non una tecnologia reale.
 * Prua verso −z, alto +y, destra +x, metri; quota 0 = piano d'appoggio dei pattini.
 */

export interface Aircraft {
  group: Group;
  update(t: number, dt: number, power: number): void;
  anchors: Record<'nose' | 'cockpit' | 'duct' | 'tail' | 'center', Vector3>;
  dispose(): void;
}

const L = 7.8;
const P: LiftingBody = {
  length: L,
  body: (t) => 0.7 * smooth(0, 0.42, t) ** 0.7 * (1 - 0.25 * smooth(0.7, 1, t)) + 0.01,
  span: (t) => 0.1 + 3.15 * smooth(0.05, 0.97, t),
  top: (t) => 0.46 * Math.sqrt(smooth(0, 0.36, t)) * (1 - 0.75 * smooth(0.55, 1, t)) + 0.01,
  bottom: (t) => 0.3 * Math.sqrt(smooth(0, 0.36, t)) * (1 - 0.85 * smooth(0.5, 1, t)) + 0.008,
  center: () => 0.95,
  wingTop: (t) => 0.17 * (1 - 0.8 * smooth(0.75, 1, t)) * smooth(0.05, 0.3, t) + 0.008,
  wingBottom: (t) => 0.09 * (1 - 0.8 * smooth(0.75, 1, t)) * smooth(0.05, 0.3, t) + 0.006,
  exponent: 1.35,
  sections: 96,
  across: 52,
};
const tOf = (z: number) => (z + L / 2) / L;
const zOf = (t: number) => -L / 2 + t * L;
const top = (x: number, z: number) => surface(P, x, tOf(z), 1);
const bottom = (x: number, z: number) => surface(P, x, tOf(z), -1);

/**
 * Grafite con pannellature: linee di giunzione sottili (scure, più ruvide) calcolate nello shader
 * in coordinate dell'oggetto, e una leggera variazione di riflesso da un pannello all'altro.
 */
function panelledGraphite(env: Texture): MeshPhysicalMaterial {
  const m = new MeshPhysicalMaterial({
    color: new Color(0.13, 0.14, 0.16),
    metalness: 0.82,
    roughness: 0.4,
    clearcoat: 0.45,
    clearcoatRoughness: 0.32,
    envMap: env,
    envMapIntensity: 0.9,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;\nvObjNormal = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vObjPos;
         varying vec3 vObjNormal;
         float seam(float d, float w) { float aa = fwidth(d) * 1.2; return 1.0 - smoothstep(w, w + aa, abs(d)); }
         float phash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
         float gSeam; float gPanel;
         void panels() {
           vec3 p = vObjPos;
           float onSkin = smoothstep(0.25, 0.5, abs(vObjNormal.y));
           float ax = abs(p.x);
           float s = 0.0;
           // Giunzioni longitudinali (fusoliera e radici alari) e trasversali (stazioni).
           s = max(s, seam(ax - 0.62, 0.006) * step(-2.6, p.z));
           s = max(s, seam(ax - 1.18, 0.006) * step(-0.6, p.z));
           s = max(s, seam(ax - 2.05, 0.006) * step(1.3, p.z));
           for (int i = 0; i < 5; i++) {
             float zc = -2.9 + float(i) * 1.45;
             s = max(s, seam(p.z - zc, 0.006) * step(ax, 0.62));
           }
           // Giunzioni parallele al bordo d'attacco dell'ala (freccia della delta).
           float le = (p.z + 3.5) * 0.43;
           s = max(s, seam(ax - le + 0.55, 0.006) * step(1.25, ax) * step(-0.5, p.z));
           // Superfici mobili sul bordo d'uscita (alettoni): giunzione e divisione.
           s = max(s, seam(p.z - 3.35, 0.007) * step(0.75, ax) * step(ax, 3.1));
           s = max(s, seam(ax - 1.95, 0.006) * step(3.35, p.z));
           gSeam = s * onSkin;
           vec2 cell = floor(vec2(ax / 0.6, (p.z + 4.0) / 1.45));
           gPanel = phash(cell) * onSkin;
         }`,
      )
      .replace('#include <color_fragment>', '#include <color_fragment>\npanels();\ndiffuseColor.rgb *= (1.0 - 0.55 * gSeam) * (0.94 + 0.12 * gPanel);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + 0.08 * (gPanel - 0.5) + 0.35 * gSeam, 0.05, 1.0);');
  };
  m.customProgramCacheKey = () => 'aircraft-graphite-v1';
  return m;
}

export function createAircraft(env: Texture): Aircraft {
  const group = new Group();
  group.name = 'atmosphera-flight';
  const materials: Material[] = [];
  const mat = <M extends Material>(m: M) => (materials.push(m), m);
  const body = mat(panelledGraphite(env));
  const m: ConceptMaterials = {
    body,
    dark: mat(new MeshPhysicalMaterial({ color: new Color(0.025, 0.027, 0.032), metalness: 0.7, roughness: 0.45, clearcoat: 0.3, envMap: env, envMapIntensity: 0.6 })),
    glass: mat(
      new MeshPhysicalMaterial({
        color: new Color(0.012, 0.02, 0.03),
        metalness: 0.35,
        roughness: 0.04,
        transparent: true,
        opacity: 0.8,
        envMap: env,
        envMapIntensity: 1.1,
        specularIntensity: 0.25,
        clearcoat: 0.3,
        clearcoatRoughness: 0.1,
        depthWrite: false,
        side: DoubleSide,
      }),
    ),
    interior: mat(new MeshPhysicalMaterial({ color: new Color(0.07, 0.07, 0.08), roughness: 0.75, envMap: env, envMapIntensity: 0.25 })),
    seat: mat(new MeshPhysicalMaterial({ color: new Color(0.42, 0.36, 0.3), roughness: 0.55, sheen: 0.5, envMap: env, envMapIntensity: 0.35 })),
    led: mat(new MeshBasicMaterial({ color: new Color(0.3, 1.25, 2.0) })),
    ledWarm: mat(new MeshBasicMaterial({ color: new Color(2.0, 1.5, 1.0) })),
    lift: mat(new MeshBasicMaterial({ color: new Color(0.18, 0.75, 1.35) })),
    navRed: mat(new MeshBasicMaterial({ color: new Color(2.6, 0.12, 0.08) })),
    navGreen: mat(new MeshBasicMaterial({ color: new Color(0.12, 2.6, 0.4) })),
    screen: mat(new MeshBasicMaterial({ color: new Color(0.16, 0.5, 0.8) })),
  };
  const trim = mat(new MeshPhysicalMaterial({ color: new Color(0.36, 0.37, 0.4), metalness: 1, roughness: 0.28, envMap: env, envMapIntensity: 0.9 }));
  const strobeMat = mat(new MeshBasicMaterial({ color: new Color(3, 3, 3) }));
  const add = (g: BufferGeometry, material: Material, shadow = true) => {
    const mesh = new Mesh(g, material);
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    group.add(mesh);
    return mesh;
  };
  const tube = (pts: Vector3[], r: number, material: Material, segments = 80, shadow = false) =>
    add(new TubeGeometry(new CatmullRomCurve3(pts), segments, r, 6, false), material, shadow);

  // ── Corpo portante.
  add(liftingBody(P), body);

  // ── Abitacolo e calotta (margini verificati in cockpit()), con telaio in metallo satinato.
  const Z0 = -L / 2 + 1.15;
  const Z1 = -L / 2 + 4.5;
  const canopyAt = cockpit(add, m, { z0: Z0, z1: Z1, halfWidth: 0.6, height: 0.64, surface: top });
  for (const side of [-1, 1]) {
    const pts: Vector3[] = [];
    for (let k = 1; k <= 23; k++) {
      const c = canopyAt(k / 24);
      pts.push(new Vector3(side * c.hw * 0.995, c.base + 0.035, c.z));
    }
    tube(pts, 0.022, trim, 60, true);
  }
  // Arco di rinforzo dietro i sedili.
  const hoop = canopyAt(0.78);
  const hoopPts: Vector3[] = [];
  for (let k = 0; k <= 16; k++) {
    const a = (k / 16) * Math.PI;
    const x = Math.cos(a) * hoop.hw * 0.98;
    const f = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(x) / hoop.hw, 2.4)), 1 / 2.4);
    hoopPts.push(new Vector3(x, hoop.base + (hoop.top - hoop.base) * f * 0.985 + 0.012, hoop.z));
  }
  tube(hoopPts, 0.024, trim, 32, true);
  // Consolle laterali e cloche (dentro la calotta, sotto la linea del vetro).
  const sc = canopyAt(0.56);
  const floorY = top(0, sc.z) + 0.012;
  for (const side of [-1, 1]) add(new RoundedBoxGeometry(0.1, 0.16, 0.7, 2, 0.03).translate(side * 0.5 * sc.hw * 1.45, floorY + 0.09, sc.z - 0.1), m.interior, false);
  add(new RoundedBoxGeometry(0.035, 0.22, 0.035, 2, 0.012).rotateX(0.25).translate(0, floorY + 0.12, sc.z - 0.55), m.dark, false);

  // ── Derive inclinate con bordo d'attacco in metallo e LED discreto.
  const finProfile = airfoil(0, 0.4, 0.09, 14);
  for (const side of [-1, 1]) {
    const t0 = 0.8;
    const x0 = side * 1.25;
    const y0 = surface(P, x0, t0, 1) - 0.03;
    const z0 = zOf(t0);
    const rings: Vector3[][] = [];
    for (let k = 0; k <= 10; k++) {
      const u = k / 10;
      const tipRound = u > 0.85 ? Math.sqrt(Math.max(0.02, 1 - ((u - 0.85) / 0.15) ** 2)) : 1;
      const chord = 1.5 * (1 - 0.5 * u) * tipRound;
      rings.push(finProfile.map((pt) => new Vector3(x0 + side * (0.42 * u + pt.y * chord * 0.5), y0 + 1.05 * u, z0 + 0.6 * u + (1.5 * (1 - 0.5 * u) - chord) * 0.4 + pt.x * chord)));
    }
    add(loft(rings, true, true), body);
    tube([0.06, 0.3, 0.55, 0.8].map((u) => new Vector3(x0 + side * 0.42 * u, y0 + 1.05 * u + 0.01, z0 + 0.6 * u - 0.012)), 0.007, m.led, 16);
    // Luce di posizione bianca in cima alla deriva (visibile da dietro).
    add(new SphereGeometry(0.03, 10, 8).translate(x0 + side * 0.44, y0 + 1.06, z0 + 0.62 + 0.55), m.ledWarm, false);
  }

  // ── Lamelle dorsali: porta incassata a forma di trapezio parallela alla freccia, telaio scuro,
  //    lamelle in grafite satinata, fessure luminose attenuate tra una lamella e l'altra.
  const portT0 = 0.56;
  const portT1 = 0.76;
  for (const side of [-1, 1]) {
    const N = 8;
    const inner = (t: number) => 1.02 + (t - portT0) * 0.9;
    const outer = (t: number) => 1.88 + (t - portT0) * 2.2;
    const frame: Vector3[] = [];
    const corner = (x: number, t: number, lift: number) => new Vector3(side * x, surface(P, side * x, t, 1) + lift, zOf(t));
    // Telaio: lamina scura appena sopra la pelle.
    const frameRows: Vector3[][] = [];
    for (let k = 0; k <= 10; k++) {
      const t = portT0 - 0.012 + ((portT1 - portT0 + 0.024) * k) / 10;
      const xi = inner(t) - 0.05;
      const xo = outer(t) + 0.05;
      frameRows.push([corner(xi, t, 0.004), corner((xi + xo) / 2, t, 0.004), corner(xo, t, 0.004), corner(xo, t, 0.001), corner(xi, t, 0.001)]);
    }
    add(loft(frameRows, true, true), m.dark, false);
    void frame;
    for (let k = 0; k < N; k++) {
      const ta = portT0 + ((portT1 - portT0) * (k + 0.12)) / N;
      const tb = portT0 + ((portT1 - portT0) * (k + 0.78)) / N;
      // Lamella: superficie sottile in grafite, leggermente inclinata (chiusa).
      add(patch([corner(inner(ta), ta, 0.012), corner(outer(ta), ta, 0.012), corner(outer(tb), tb, 0.02), corner(inner(tb), tb, 0.02)], 0.008), trim, false);
      // Fessura luminosa sotto la lamella successiva.
      const tg = portT0 + ((portT1 - portT0) * (k + 0.9)) / N;
      const tg2 = tg + (portT1 - portT0) * 0.06 / N;
      add(patch([corner(inner(tg), tg, 0.0065), corner(outer(tg), tg, 0.0065), corner(outer(tg2), tg2, 0.0065), corner(inner(tg2), tg2, 0.0065)], 0.002), m.lift, false);
    }
  }
  // Griglie gemelle sul ventre (stessa porta, vista da sotto).
  for (const side of [-1, 1]) {
    for (let k = 0; k < 6; k++) {
      const t = 0.58 + k * 0.028;
      const xa = 1.15 + (t - 0.58) * 0.9;
      const xb = 1.8 + (t - 0.58) * 2;
      const a = (x: number, tt: number) => new Vector3(side * x, surface(P, side * x, tt, -1) - 0.005, zOf(tt));
      add(patch([a(xa, t), a(xb, t), a(xb, t + 0.01), a(xa, t + 0.01)], -0.003), m.lift, false);
    }
  }

  // ── Coda: carenatura degli ugelli, due ugelli appiattiti incassati con bagliore interno,
  //    barra LED rossa di coda tra gli ugelli, cono di coda e luce lampeggiante.
  const tN = 0.955;
  const yc = P.center(tN);
  for (const side of [-1, 1]) {
    const x = side * 0.43;
    // Carenatura che raccorda l'ugello al dorso.
    const fairing: Vector3[][] = [];
    for (let k = 0; k <= 8; k++) {
      const t = 0.82 + (tN + 0.02 - 0.82) * (k / 8);
      const z = zOf(t);
      const w = 0.2 + 0.1 * (k / 8);
      const h = 0.05 + 0.07 * (k / 8);
      const ring: Vector3[] = [];
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const cx = x + Math.cos(a) * w;
        const yb = top(cx, z) - 0.02;
        ring.push(new Vector3(cx, Math.sin(a) > 0 ? yb + Math.sin(a) * h : yb + Math.sin(a) * 0.015, z));
      }
      fairing.push(ring);
    }
    add(loft(fairing, true, true), body);
    // Ugello: cornice in metallo e fondo luminoso arretrato.
    const zF = zOf(tN + 0.02);
    add(new RoundedBoxGeometry(0.62, 0.17, 0.12, 3, 0.05).translate(x, yc + 0.04, zF), trim);
    add(new RoundedBoxGeometry(0.5, 0.09, 0.02, 2, 0.02).translate(x, yc + 0.04, zF + 0.045), m.dark, false);
    add(new RoundedBoxGeometry(0.44, 0.05, 0.01, 1, 0.01).translate(x, yc + 0.04, zF + 0.05), m.lift, false);
    // Petali di regolazione (linee) sulla cornice.
    for (let k = -2; k <= 2; k++) add(new RoundedBoxGeometry(0.008, 0.17, 0.004, 1, 0.002).translate(x + k * 0.11, yc + 0.04, zF + 0.062), m.dark, false);
  }
  add(new RoundedBoxGeometry(0.34, 0.025, 0.02, 1, 0.008).translate(0, yc + 0.03, zOf(0.997)), m.navRed, false);
  const strobe = add(new SphereGeometry(0.028, 10, 8).translate(0, top(0, zOf(0.93)) + 0.05, zOf(0.93)), strobeMat, false);
  add(new RoundedBoxGeometry(0.03, 0.1, 0.16, 2, 0.01).translate(0, top(0, zOf(0.9)) + 0.05, zOf(0.9)), trim);

  // ── Luci di navigazione alle estremità alari, piccole e incassate nel bordo.
  for (const side of [-1, 1]) {
    const t = 0.955;
    const x = side * (P.span(t) - 0.05);
    add(new SphereGeometry(0.025, 10, 8).translate(x, surface(P, x, t, 1) + 0.005, zOf(t)), side > 0 ? m.navGreen : m.navRed, false);
  }
  // LED lungo lo spigolo della fusoliera (sottile) e luce d'atterraggio sotto il muso.
  for (const side of [-1, 1]) {
    const pts: Vector3[] = [];
    for (let k = 0; k <= 18; k++) {
      const t = 0.14 + (0.42 * k) / 18;
      const b = P.body(t) * 0.985;
      pts.push(new Vector3(side * b, surface(P, b, t, 1) + 0.004, zOf(t)));
    }
    tube(pts, 0.0055, m.led);
  }
  add(new SphereGeometry(0.035, 12, 8).scale(1.4, 0.6, 1).translate(0, bottom(0, zOf(0.16)) - 0.01, zOf(0.16)), m.ledWarm, false);
  // Sonda di pressione sul muso (dettaglio tecnico, sottile).
  tube([new Vector3(0, 0.95, -L / 2 + 0.02), new Vector3(0, 0.95, -L / 2 - 0.28)], 0.008, trim, 4, true);

  // ── Pattini: gambe carenate e piedi.
  for (const [x, z] of [
    [0, -2.6],
    [-1.4, 1.2],
    [1.4, 1.2],
  ] as const) {
    const yb = bottom(x, z);
    add(new RoundedBoxGeometry(0.09, yb - 0.1, 0.16, 2, 0.035).translate(x, (yb + 0.1) / 2, z), m.dark);
    add(new RoundedBoxGeometry(0.3, 0.07, 0.42, 2, 0.03).translate(x, 0.05, z), m.dark);
  }

  const anchors = {
    nose: new Vector3(0, 0.95, -L / 2),
    cockpit: new Vector3(0, top(0, sc.z) + 0.4, sc.z),
    duct: new Vector3(1.5, top(1.5, zOf(0.66)), zOf(0.66)),
    tail: new Vector3(0, yc, zOf(0.97)),
    center: new Vector3(0, 0.9, 0.2),
  };
  const baseLift = (m.lift.color as Color).clone();
  return {
    group,
    anchors,
    update(t, _dt, power) {
      strobe.visible = t % 1.3 < 0.06;
      // Respiro lento delle fessure al minimo; più luminose con la potenza (fase 3).
      const k = 0.85 + 0.15 * Math.sin(t * 2.2) + 0.6 * Math.max(0, power - 1);
      m.lift.color.copy(baseLift).multiplyScalar(k);
    },
    dispose() {
      group.traverse((o) => o instanceof Mesh && o.geometry.dispose());
      for (const x of materials) x.dispose();
    },
  };
}
