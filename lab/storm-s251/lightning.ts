import {
  AdditiveBlending,
  DoubleSide,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector3,
  type Scene,
} from 'three';

/**
 * STORM FLIGHT S2.5 — fulmini procedurali (RICOSTRUZIONE ILLUSTRATIVA: posizioni e istanti non sono dati osservati).
 *
 * Attività: processo lento e irregolare (tempo di correlazione ~25 s) moltiplicato per la convezione stimata, così si
 * alternano fasi senza fulmini e raffiche di scariche. Ogni scarica nasce in un punto reale attorno alla telecamera,
 * scelto tra candidati dove la convezione è più forte (celle delle bande e parete); nell'occhio la probabilità è
 * ridotta di ~10 volte. Tipi: intranube (~85%, solo luce), nube-mare (rari, solo celle molto convettive),
 * ramificati tra le nubi (visibili da sopra le sommità). Ogni lampo ha 1–4 colpi di ritorno.
 */

export type BoltKind = 'intra' | 'cg' | 'cc';

export interface Bolt {
  kind: BoltKind;
  /** Punto del canale principale (km, piano della scena), sorgente della luce. */
  pos: Vector3;
  /** Polilinea ramificata (km): coppie di estremi dei segmenti. */
  segments: Vector3[];
  strength: number;
  /** Istanti relativi (s) e intensità dei colpi. */
  strokes: { at: number; power: number; len: number }[];
  t0: number;
  distKm: number;
  /** Base della nube (km): il canale si vede solo sotto. */
  base: number;
}

export interface LightningEnv {
  /** Convezione (0–1) e quota della sommità/della base nel punto (x, z). */
  sample(x: number, z: number): { convective: number; top: number; base: number; eye: boolean };
  /** Punto a quota h sopra (x, z) del piano (km). */
  worldAt(x: number, z: number, h: number, out?: Vector3): Vector3;
}

const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.22;

/** Canale ramificato: spostamento del punto medio ricorsivo, con rami che si staccano e si assottigliano. */
export function branchChannel(a: Vector3, b: Vector3, rough: number, depth: number, out: Vector3[], branch: number) {
  if (depth === 0) {
    out.push(a.clone(), b.clone());
    return;
  }
  const len = a.distanceTo(b);
  const mid = a.clone().lerp(b, 0.5).add(new Vector3(gauss(), gauss() * 0.4, gauss()).multiplyScalar(len * rough));
  branchChannel(a, mid, rough, depth - 1, out, branch);
  branchChannel(mid, b, rough, depth - 1, out, branch);
  if (branch > 0 && Math.random() < 0.35) {
    const dir = b.clone().sub(a).normalize().add(new Vector3(gauss(), gauss() * 0.5, gauss()).multiplyScalar(0.8)).normalize();
    branchChannel(mid, mid.clone().addScaledVector(dir, len * (0.3 + 0.4 * Math.random())), rough, Math.max(0, depth - 2), out, branch - 1);
  }
}

export function createLightning(env: LightningEnv) {
  let activity = 0;
  let last = -10;
  return {
    reset() {
      activity = 0;
      last = -10;
    },
    /** Avanza il processo; restituisce un nuovo lampo quando avviene. cam in km; camZone dalla zona del velivolo. */
    /** boost: fattore della regia (CINEMA) o della modalità (PILOTA); alza frequenza e attività minima. */
    step(t: number, dt: number, cam: Vector3, camAlt: number, camInEye: boolean, boost = 1): Bolt | null {
      // Attività elettrica lenta e irregolare in [0, 1] (spesso bassa: intervalli senza fulmini).
      activity += (-activity / 25) * dt + 0.35 * Math.sqrt((2 * dt) / 25) * gauss();
      const act = Math.max(boost > 1.5 ? 0.4 : 0, Math.min(1, 0.25 + activity));
      if (t - last < 1.2) return null;
      // Candidati attorno alla telecamera (3–28 km): la convezione decide dove e se avviene.
      let best: { x: number; z: number; c: number; s: ReturnType<LightningEnv['sample']> } | null = null;
      let mean = 0;
      for (let i = 0; i < 6; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rr = 3 + Math.pow(Math.random(), 0.7) * 25;
        const x = cam.x + Math.cos(ang) * rr;
        const z = cam.z + Math.sin(ang) * rr;
        const s = env.sample(x, z);
        let c = s.convective;
        if (s.eye) c *= 0.1;
        mean += c / 6;
        const score = c * (0.6 + 0.4 * Math.random());
        if (!best || score > best.c) best = { x, z, c: score, s };
      }
      const camFactor = camInEye ? 0.1 : 1;
      const rate = 0.32 * mean * mean * act * act * 4 * camFactor * boost;
      if (!best || best.c < 0.25 || Math.random() > rate * dt) return null;
      last = t;
      const s = best.s;
      const strength = 0.5 + 0.5 * Math.random();
      const r = Math.random();
      const kind: BoltKind = s.convective > 0.7 && r < 0.09 ? 'cg' : r < 0.17 ? 'cc' : 'intra';
      const segs: Vector3[] = [];
      let pos: Vector3;
      if (kind === 'cg') {
        // Nube-mare: dalla base della cella al mare, ramificato verso il basso.
        const top = env.worldAt(best.x, best.z, Math.max(3, s.base + 2.5));
        const ground = env.worldAt(best.x + gauss() * 0.8, best.z + gauss() * 0.8, 0);
        branchChannel(top, ground, 0.12, 6, segs, 3);
        pos = env.worldAt(best.x, best.z, Math.max(1.5, s.base));
      } else if (kind === 'cc') {
        // Ramificato orizzontale vicino alle sommità (visibile da sopra le nubi).
        const h = Math.max(6, s.top - 1.5 - Math.random() * 2);
        const a = env.worldAt(best.x, best.z, h);
        const ang = Math.random() * Math.PI * 2;
        const b = env.worldAt(best.x + Math.cos(ang) * (4 + 6 * Math.random()), best.z + Math.sin(ang) * (4 + 6 * Math.random()), h - 1 + Math.random() * 2);
        branchChannel(a, b, 0.16, 6, segs, 4);
        pos = a.clone().lerp(b, 0.5);
      } else {
        pos = env.worldAt(best.x, best.z, 4 + Math.random() * Math.max(2, s.top - 6));
      }
      const n = 1 + Math.floor(Math.random() * Math.random() * 4);
      const strokes: Bolt['strokes'] = [];
      let at = 0;
      for (let i = 0; i < n; i++) {
        strokes.push({ at, power: strength * (i === 0 ? 1 : 0.4 + 0.5 * Math.random()), len: 0.06 + 0.12 * Math.random() });
        at += 0.05 + 0.12 * Math.random();
      }
      const distKm = pos.distanceTo(cam);
      void camAlt;
      return { kind, pos, segments: segs, strength, strokes, t0: t, distKm, base: kind === 'cg' ? s.base : Infinity };
    },
  };
}

/** Intensità del lampo al tempo t (0–1+), con i colpi di ritorno; in modalità attenuata un solo impulso morbido. */
export function flashEnvelope(b: Bolt, t: number, gentle: boolean): number {
  const dt = t - b.t0;
  if (dt < 0) return 0;
  if (gentle) return 0.25 * b.strength * Math.max(0, Math.sin(Math.min(1, dt / 0.6) * Math.PI));
  let v = 0;
  for (const s of b.strokes) {
    const u = dt - s.at;
    if (u >= 0) v = Math.max(v, s.power * Math.exp(-u / s.len));
  }
  return v;
}

const boltVertex = /* glsl */ `
  attribute vec3 other;
  attribute float side;
  attribute float weight;
  attribute float vis;
  uniform float widthPx;
  uniform float pixelSize;
  varying float vSide;
  varying float vWeight;
  varying float vVis;
  void main() {
    vec4 a = viewMatrix * vec4(position, 1.0);
    vec4 b = viewMatrix * vec4(other, 1.0);
    vec2 d = b.xy / max(-b.z, 1.0) - a.xy / max(-a.z, 1.0);
    vec2 perp = length(d) > 1e-9 ? normalize(vec2(-d.y, d.x)) : vec2(1.0, 0.0);
    a.xy += perp * side * widthPx * weight * pixelSize * max(-a.z, 1.0);
    gl_Position = projectionMatrix * a;
    vSide = side;
    vWeight = weight;
    vVis = vis;
  }
`;
const boltFragment = /* glsl */ `
  uniform float intensity;
  varying float vSide;
  varying float vWeight;
  varying float vVis;
  void main() {
    float core = exp(-vSide * vSide * 6.0);
    vec3 c = mix(vec3(0.55, 0.65, 1.0), vec3(1.0), core) * intensity * (0.4 + 0.6 * vWeight) * vVis;
    gl_FragColor = vec4(c * core, 1.0);
  }
`;

/** Canale visibile del fulmine (nastri rivolti alla telecamera, additivi), nella scena in metri del velivolo. */
export function createBoltView(scene: Scene) {
  const material = new ShaderMaterial({
    vertexShader: boltVertex,
    fragmentShader: boltFragment,
    uniforms: { widthPx: { value: 2.2 }, pixelSize: { value: 0.001 }, intensity: { value: 0 } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: AdditiveBlending,
    // I nastri possono avere qualunque verso: nessuna eliminazione delle facce.
    side: DoubleSide,
  });
  let mesh: Mesh | null = null;
  let kmSegments: Vector3[] = [];
  const build = (segs: Vector3[], baseKm: number) => {
    kmSegments = segs;
    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }
    if (segs.length === 0) return;
    const nSeg = segs.length / 2;
    const pos = new Float32Array(nSeg * 6 * 3);
    const oth = new Float32Array(nSeg * 6 * 3);
    const side = new Float32Array(nSeg * 6);
    const weight = new Float32Array(nSeg * 6);
    // Dentro la nube il canale non si vede (solo la luce diffusa): sfuma sopra la base.
    const vis = new Float32Array(nSeg * 6);
    const altOf = (p: Vector3) => Math.hypot(p.x, p.y + 6371, p.z) - 6371;
    for (let i = 0; i < nSeg; i++) {
      const a = segs[2 * i]!, b = segs[2 * i + 1]!;
      const va = 1 - Math.min(1, Math.max(0, (altOf(a) - baseKm + 0.2) / 0.7));
      const vb = 1 - Math.min(1, Math.max(0, (altOf(b) - baseKm + 0.2) / 0.7));
      [va, va, vb, va, vb, vb].forEach((v, k) => (vis[i * 6 + k] = v));
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('other', new BufferAttribute(oth, 3));
    g.setAttribute('side', new BufferAttribute(side, 1));
    g.setAttribute('weight', new BufferAttribute(weight, 1));
    g.setAttribute('vis', new BufferAttribute(vis, 1));
    mesh = new Mesh(g, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    scene.add(mesh);
  };
  return {
    /** Canale (coppie di punti, km); baseKm = base della nube: sopra il canale sfuma. */
    show(segs: Vector3[], baseKm = Infinity) {
      build(segs, baseKm);
    },
    /** Posizioni relative alla telecamera (metri) e intensità visibile. */
    update(cameraKm: Vector3, intensity: number, pixelSize: number) {
      material.uniforms.intensity!.value = intensity;
      material.uniforms.pixelSize!.value = pixelSize;
      if (!mesh) return;
      mesh.visible = intensity > 0.01;
      if (!mesh.visible) return;
      const g = mesh.geometry;
      const pos = g.getAttribute('position') as BufferAttribute;
      const oth = g.getAttribute('other') as BufferAttribute;
      const side = g.getAttribute('side') as BufferAttribute;
      const weight = g.getAttribute('weight') as BufferAttribute;
      const n = kmSegments.length / 2;
      const top = kmSegments[0]!;
      let maxLen = 0;
      for (let i = 0; i < n; i++) maxLen = Math.max(maxLen, kmSegments[2 * i]!.distanceTo(top));
      for (let i = 0; i < n; i++) {
        const a = kmSegments[2 * i]!, b = kmSegments[2 * i + 1]!;
        // Il canale principale è più spesso; i rami lontani dall'origine più sottili.
        const w = Math.max(0.25, 1 - a.distanceTo(top) / Math.max(maxLen, 1e-3) * 0.6);
        const corners: [Vector3, Vector3, number][] = [[a, b, -1], [a, b, 1], [b, a, 1], [a, b, -1], [b, a, 1], [b, a, -1]];
        corners.forEach(([p, o, sd], k) => {
          const idx = i * 6 + k;
          pos.setXYZ(idx, (p.x - cameraKm.x) * 1000, (p.y - cameraKm.y) * 1000, (p.z - cameraKm.z) * 1000);
          oth.setXYZ(idx, (o.x - cameraKm.x) * 1000, (o.y - cameraKm.y) * 1000, (o.z - cameraKm.z) * 1000);
          // Per i vertici con l'estremo scambiato il verso della perpendicolare si inverte: lato opposto.
          side.setX(idx, p === a ? sd : -sd);
          weight.setX(idx, w);
        });
      }
      pos.needsUpdate = oth.needsUpdate = side.needsUpdate = weight.needsUpdate = true;
    },
    dispose() {
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      material.dispose();
    },
  };
}
