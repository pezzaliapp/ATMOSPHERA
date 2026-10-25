import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
  BufferGeometry,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Builder } from './builder';
import { createFacadeMaterial } from './facade';

/**
 * Città di contorno (FLIGHT 2.0), generata dal codice con seme fisso: isolati attorno all'isolato
 * principale, torri simbolo lontane, strade con lampioni e traffico animato nello shader, lungomare.
 * Il mare è a ovest (−x), dove tramonta il Sole. Unità in metri.
 */

export const PITCH = 134;
export const ROAD = 24;
const BLOCK = PITCH - ROAD;
export const COAST_X = -3.5 * PITCH;
const I_MIN = -3;
const I_MAX = 13;
const J_MIN = -11;
const J_MAX = 11;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CityParts {
  group: Group;
  beacons: MeshBasicMaterial;
  /** Materiali con uniform del tempo (traffico). */
  timed: { uniforms: { uTime: { value: number } } }[];
  volumes: [number, number, number, number, number][];
  facade: MeshStandardMaterial;
}

export function createCity(env: Texture, options: { trafficDensity: number }): CityParts {
  const random = rng(77);
  const group = new Group();
  group.name = 'city';
  const volumes: CityParts['volumes'] = [];

  // ── Edifici di contorno: un cubo unitario istanziato, finestre dal materiale.
  type B = { x: number; z: number; w: number; d: number; h: number; style: number; seed: number; lit: number; color: Color };
  const list: B[] = [];
  const downtown = (cx: number, cz: number) => Math.exp(-((cx - 260) ** 2 + (cz - 40) ** 2) / (2 * 700 ** 2));
  // Isolati occupati dalle torri simbolo (costruite più sotto).
  const TOWER_CELLS = [
    [4, -2],
    [7, 3],
    [9, -5],
    [3, 6],
  ];
  for (let j = J_MIN; j <= J_MAX; j++) {
    for (let i = I_MIN; i <= I_MAX; i++) {
      if (i === 0 && j === 0) continue;
      if (TOWER_CELLS.some(([ti, tj]) => ti === i && tj === j)) continue;
      const cx = i * PITCH;
      const cz = j * PITCH;
      const core = downtown(cx, cz);
      const nearCoast = i <= I_MIN + 1;
      // Lotti: 1, 2 o 4 per isolato.
      const r = random();
      const lots: [number, number, number, number][] = [];
      const h = BLOCK / 2 - 4;
      if (r < 0.3) lots.push([cx, cz, BLOCK - 14, BLOCK - 14]);
      else if (r < 0.65) {
        if (random() < 0.5) lots.push([cx - h / 2 - 2, cz, h - 4, BLOCK - 14], [cx + h / 2 + 2, cz, h - 4, BLOCK - 14]);
        else lots.push([cx, cz - h / 2 - 2, BLOCK - 14, h - 4], [cx, cz + h / 2 + 2, BLOCK - 14, h - 4]);
      } else for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) lots.push([cx + sx * (h / 2 + 2), cz + sz * (h / 2 + 2), h - 4, h - 4]);
      for (const [x, z, w0, d0] of lots) {
        const shrink = random() * 8;
        const w = w0 - shrink;
        const d = d0 - shrink * random();
        const tall = core * (60 + random() * 170) * (random() < 0.7 ? 1 : 0.35);
        const height = Math.max(14, (nearCoast ? 12 : 18) + random() * 30 + tall);
        const style = height > 70 ? (random() < 0.75 ? 0 : 2) : random() < 0.6 ? 1 : 2;
        const tone = style === 0 ? 0.28 + random() * 0.12 : 0.38 + random() * 0.25;
        const warm = style === 1 ? 0.06 : 0;
        list.push({ x, z, w, d, h: height, style, seed: random(), lit: 0.32 + random() * 0.35, color: new Color(tone + warm, tone + warm * 0.4, tone - warm * 0.3 + 0.03) });
        volumes.push([x - w / 2, x + w / 2, z - d / 2, z + d / 2, height]);
      }
    }
  }
  const facade = createFacadeMaterial({ envMap: env });
  const unit = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  unit.deleteAttribute('uv');
  const buildings = new InstancedMesh(unit, facade, list.length);
  const attr = new Float32Array(list.length * 4);
  const m = new Matrix4();
  const q = new Quaternion();
  list.forEach((b, k) => {
    m.compose(new Vector3(b.x, 0, b.z), q, new Vector3(b.w, b.h, b.d));
    buildings.setMatrixAt(k, m);
    buildings.setColorAt(k, b.color);
    attr.set([b.seed, b.lit, b.style, 5 + (b.seed * 3) % 2], k * 4);
  });
  unit.setAttribute('aBuilding', new InstancedBufferAttribute(attr, 4));
  buildings.castShadow = true;
  buildings.receiveShadow = true;
  group.add(buildings);

  // Profili luminosi sui bordi dei tetti di una parte degli edifici (illuminazione architettonica).
  const edges: Matrix4[] = [];
  for (const b of list) {
    if (b.h < 40 || random() > 0.22) continue;
    const y = b.h + 0.25;
    edges.push(new Matrix4().compose(new Vector3(b.x, y, b.z - b.d / 2), q, new Vector3(b.w, 0.16, 0.16)));
    edges.push(new Matrix4().compose(new Vector3(b.x, y, b.z + b.d / 2), q, new Vector3(b.w, 0.16, 0.16)));
    edges.push(new Matrix4().compose(new Vector3(b.x - b.w / 2, y, b.z), q, new Vector3(0.16, 0.16, b.d)));
    edges.push(new Matrix4().compose(new Vector3(b.x + b.w / 2, y, b.z), q, new Vector3(0.16, 0.16, b.d)));
  }
  const edgeMesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: new Color(1.3, 1.36, 1.55) }), edges.length);
  edges.forEach((e, n) => edgeMesh.setMatrixAt(n, e));
  group.add(edgeMesh);

  // Luci rosse sui tetti degli edifici alti.
  const beacons = new MeshBasicMaterial({ color: new Color(4, 0.25, 0.15) });
  const tallOnes = list.filter((b) => b.h > 90);
  const beaconMesh = new InstancedMesh(new BoxGeometry(0.9, 0.9, 0.9), beacons, tallOnes.length);
  tallOnes.forEach((b, k) => beaconMesh.setMatrixAt(k, new Matrix4().makeTranslation(b.x, b.h + 0.8, b.z)));
  group.add(beaconMesh);

  // ── Torri simbolo lontane (design originale): fusti alti con profili LED e coronamenti.
  const landmark = new Builder();
  const led = new Builder();
  const towers: [number, number, number, number][] = [
    [4 * PITCH, -2 * PITCH, 300, 0.311],
    [7 * PITCH, 3 * PITCH, 340, 0.451],
    [9 * PITCH, -5 * PITCH, 280, 0.632],
    [3 * PITCH, 6 * PITCH, 260, 0.812],
  ];
  for (const [cx, cz, h, seed] of towers) {
    landmark.color.setRGB(0.34, 0.38, 0.46);
    landmark.building = [seed, 0.55, 0, 8];
    // Fusto a gradoni che si assottiglia.
    const steps = 5;
    for (let s = 0; s < steps; s++) {
      const half = 20 - s * 3;
      const y0 = (h * s) / steps;
      const y1 = (h * (s + 1)) / steps;
      landmark.box(cx - half, y0, cz - half, cx + half, y1, cz + half, { top: s === steps - 1 });
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) led.box(cx + x * half - 0.5, y0, cz + z * half - 0.5, cx + x * half + 0.5, y1, cz + z * half + 0.5);
    }
    led.box(cx - 0.6, h, cz - 0.6, cx + 0.6, h + 40, cz + 0.6);
    volumes.push([cx - 20, cx + 20, cz - 20, cz + 20, h + 40]);
  }
  const landmarkMesh = new Mesh(landmark.geometry(), createFacadeMaterial({ envMap: env, vertexColors: true }));
  landmarkMesh.castShadow = true;
  group.add(landmarkMesh);
  group.add(new Mesh(led.geometry(), new MeshBasicMaterial({ color: new Color(2.4, 2.6, 3.0) })));

  // ── Suolo, marciapiedi, segnaletica.
  const asphalt = new Mesh(
    new PlaneGeometry(I_MAX * PITCH - COAST_X + 400, (J_MAX - J_MIN + 2) * PITCH),
    new MeshStandardMaterial({ color: 0x15161a, roughness: 0.42, metalness: 0.1, envMap: env, envMapIntensity: 0.35 }),
  );
  asphalt.rotation.x = -Math.PI / 2;
  asphalt.position.set((COAST_X + I_MAX * PITCH + 400) / 2, 0, 0);
  asphalt.receiveShadow = true;
  group.add(asphalt);
  const kerbs: Matrix4[] = [];
  for (let j = J_MIN; j <= J_MAX; j++)
    for (let i = I_MIN; i <= I_MAX; i++) kerbs.push(new Matrix4().compose(new Vector3(i * PITCH, 0.1, j * PITCH), q, new Vector3(BLOCK, 0.2, BLOCK)));
  const kerbMesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x232327, roughness: 0.9 }), kerbs.length);
  kerbs.forEach((k, n) => kerbMesh.setMatrixAt(n, k));
  kerbMesh.receiveShadow = true;
  group.add(kerbMesh);

  const roadsX: number[] = [];
  const roadsZ: number[] = [];
  for (let i = I_MIN; i <= I_MAX; i++) roadsX.push(i * PITCH + PITCH / 2);
  for (let j = J_MIN - 1; j <= J_MAX; j++) roadsZ.push(j * PITCH + PITCH / 2);
  const zMin = (J_MIN - 0.5) * PITCH;
  const zMax = (J_MAX + 0.5) * PITCH;
  const xMin = COAST_X + 10;
  const xMax = (I_MAX + 0.5) * PITCH;

  // Linee tratteggiate (solo vicino all'isolato principale).
  const dashes: Matrix4[] = [];
  const rotY = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
  for (const x of roadsX) if (Math.abs(x) < 900) for (let z = -900; z < 900; z += 12) dashes.push(new Matrix4().compose(new Vector3(x, 0.03, z), q, new Vector3(1, 1, 1)));
  for (const z of roadsZ) if (Math.abs(z) < 900) for (let x = Math.max(xMin, -900); x < 900; x += 12) dashes.push(new Matrix4().compose(new Vector3(x, 0.03, z), rotY, new Vector3(1, 1, 1)));
  const dashMesh = new InstancedMesh(new BoxGeometry(0.22, 0.02, 4.5), new MeshStandardMaterial({ color: 0x8a8678, roughness: 0.7 }), dashes.length);
  dashes.forEach((d, n) => dashMesh.setMatrixAt(n, d));
  group.add(dashMesh);

  // ── Lampioni: testa luminosa ovunque; pali e pozze di luce vicino all'isolato.
  const heads: Matrix4[] = [];
  const poles: Matrix4[] = [];
  const pools: Matrix4[] = [];
  const LAMP_STEP = 32;
  const addLamp = (x: number, z: number, near: boolean) => {
    heads.push(new Matrix4().makeTranslation(x, 9, z));
    if (near) {
      poles.push(new Matrix4().makeTranslation(x, 4.5, z));
      pools.push(new Matrix4().compose(new Vector3(x, 0.05, z), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2), new Vector3(1, 1, 1)));
    }
  };
  for (const x of roadsX) for (let z = zMin; z < zMax; z += LAMP_STEP) for (const s of [-1, 1]) addLamp(x + s * (ROAD / 2 - 0.8), z + (s > 0 ? LAMP_STEP / 2 : 0), Math.abs(x) < 500 && Math.abs(z) < 500);
  for (const z of roadsZ) for (let x = xMin; x < xMax; x += LAMP_STEP) for (const s of [-1, 1]) addLamp(x + (s > 0 ? LAMP_STEP / 2 : 0), z + s * (ROAD / 2 - 0.8), Math.abs(x) < 500 && Math.abs(z) < 500);
  // Lungomare.
  for (let z = zMin; z < zMax; z += 18) addLamp(COAST_X + 4, z, Math.abs(z) < 600);
  const headMesh = new InstancedMesh(new BoxGeometry(1.1, 0.35, 1.1), new MeshBasicMaterial({ color: new Color(2.6, 1.8, 0.95) }), heads.length);
  heads.forEach((h, n) => headMesh.setMatrixAt(n, h));
  group.add(headMesh);
  const poleMesh = new InstancedMesh(new BoxGeometry(0.22, 9, 0.22), new MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.6, metalness: 0.6 }), poles.length);
  poles.forEach((p, n) => poleMesh.setMatrixAt(n, p));
  poleMesh.castShadow = true;
  group.add(poleMesh);
  const poolTex = radialTexture();
  const poolMesh = new InstancedMesh(
    new CircleGeometry(9, 24),
    new MeshBasicMaterial({ map: poolTex, color: new Color(0.24, 0.16, 0.08), transparent: true, blending: AdditiveBlending, depthWrite: false }),
    pools.length,
  );
  pools.forEach((p, n) => poolMesh.setMatrixAt(n, p));
  group.add(poolMesh);

  // Bagliore dei viali: una striscia additiva per strada (luce dei lampioni sull'asfalto, vista dall'alto).
  const glowTex = stripTexture();
  const glowMat = new MeshBasicMaterial({ map: glowTex, color: new Color(0.2, 0.11, 0.045), transparent: true, blending: AdditiveBlending, depthWrite: false });
  for (const x of roadsX) {
    const g = new Mesh(new PlaneGeometry(ROAD, zMax - zMin), glowMat);
    g.rotation.x = -Math.PI / 2;
    g.position.set(x, 0.06, (zMin + zMax) / 2);
    group.add(g);
  }
  for (const z of roadsZ) {
    const g = new Mesh(new PlaneGeometry(xMax - xMin, ROAD), glowMat.clone());
    (g.material as MeshBasicMaterial).map = stripTexture(true);
    g.rotation.x = -Math.PI / 2;
    g.position.set((xMin + xMax) / 2, 0.06, z);
    group.add(g);
  }

  // ── Traffico: veicoli e luci animati nello shader lungo le corsie.
  const lanes: { axis: 0 | 1; coord: number; dir: 1 | -1 }[] = [];
  for (const x of roadsX) for (const [off, dir] of [[-6.5, 1], [-3, 1], [3, -1], [6.5, -1]] as const) lanes.push({ axis: 1, coord: x + off, dir });
  for (const z of roadsZ) for (const [off, dir] of [[-6.5, -1], [-3, -1], [3, 1], [6.5, 1]] as const) lanes.push({ axis: 0, coord: z + off, dir });
  const cars: number[] = [];
  for (const lane of lanes) {
    const length = lane.axis === 0 ? xMax - xMin : zMax - zMin;
    const count = Math.round((length / 38) * options.trafficDensity * (0.6 + random() * 0.8));
    for (let k = 0; k < count; k++) {
      const speed = (9 + random() * 7) * lane.dir;
      cars.push(lane.axis, lane.coord, random() * length, speed);
    }
  }
  const carCount = cars.length / 4;
  const carAttr = new InstancedBufferAttribute(new Float32Array(cars), 4);
  const timed: CityParts['timed'] = [];
  const motion = (material: MeshBasicMaterial | MeshStandardMaterial, key: string) => {
    const uniforms = { uTime: { value: 0 }, uX: { value: [xMin, xMax - xMin] }, uZ: { value: [zMin, zMax - zMin] } };
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec4 aCar; uniform float uTime; uniform vec2 uX; uniform vec2 uZ;
           vec3 carOffset() {
             vec2 range = aCar.x < 0.5 ? uX : uZ;
             float along = range.x + mod(aCar.z + aCar.w * uTime, range.y);
             return aCar.x < 0.5 ? vec3(along, 0.0, aCar.y) : vec3(aCar.y, 0.0, along);
           }
           vec3 carRotate(vec3 v) {
             // Modello lungo +x; corsie lungo z ruotano di 90°, il verso negativo di 180°.
             float s = sign(aCar.w);
             if (aCar.x < 0.5) return vec3(v.x * s, v.y, v.z * s);
             return vec3(-v.z * s, v.y, v.x * s);
           }`,
        )
        .replace('#include <begin_vertex>', `vec3 transformed = carRotate(position) + carOffset();`)
        .replace('#include <beginnormal_vertex>', `vec3 objectNormal = carRotate(normal);`);
    };
    material.customProgramCacheKey = () => `car-${key}`;
    timed.push({ uniforms });
  };
  const bodyGeo = mergeGeometries([new BoxGeometry(4.4, 0.8, 1.9).translate(0, 0.65, 0), new BoxGeometry(2.4, 0.6, 1.7).translate(-0.2, 1.3, 0)])!;
  bodyGeo.setAttribute('aCar', carAttr);
  const bodyMat = new MeshStandardMaterial({ color: 0x24262b, roughness: 0.35, metalness: 0.6, envMap: env, envMapIntensity: 0.8 });
  motion(bodyMat, 'body');
  const bodies = new InstancedMesh(bodyGeo, bodyMat, carCount);
  bodies.frustumCulled = false;
  const palette = [0x1c1e22, 0x6b6e73, 0x8a1d1d, 0x1b2f4f, 0xc9c6bd, 0x2d2d30, 0xb8901f].map((c) => new Color(c));
  for (let k = 0; k < carCount; k++) bodies.setColorAt(k, palette[Math.floor(random() * palette.length)]!);
  group.add(bodies);
  const lightsGeo = (x: number) => mergeGeometries([new BoxGeometry(0.3, 0.4, 0.6).translate(x, 0.75, 0.62), new BoxGeometry(0.3, 0.4, 0.6).translate(x, 0.75, -0.62)])!;
  const head = lightsGeo(2.25);
  head.setAttribute('aCar', carAttr);
  const tail = lightsGeo(-2.25);
  tail.setAttribute('aCar', carAttr);
  const headMat = new MeshBasicMaterial({ color: new Color(5, 4.4, 3.4) });
  const tailMat = new MeshBasicMaterial({ color: new Color(4.5, 0.3, 0.15) });
  motion(headMat, 'head');
  motion(tailMat, 'tail');
  for (const [g, mat] of [
    [head, headMat],
    [tail, tailMat],
  ] as const) {
    const mesh = new InstancedMesh(g as BufferGeometry, mat, carCount);
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  return { group, beacons, timed, volumes, facade };
}

/** Gradiente trasversale della strada: più luce ai bordi, sotto i lampioni (generato). */
function stripTexture(rotated = false): Texture {
  const c = document.createElement('canvas');
  c.width = rotated ? 4 : 64;
  c.height = rotated ? 64 : 4;
  const g = c.getContext('2d')!;
  const grad = rotated ? g.createLinearGradient(0, 0, 0, 64) : g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.2, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  grad.addColorStop(0.8, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0.9)');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Gradiente radiale per le pozze di luce dei lampioni (generato, nessun file). */
function radialTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}
