import {
  Color,
  Group,
  IcosahedronGeometry,
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RingGeometry,
  Vector3,
  type Texture,
} from 'three';
import { Builder } from './builder';
import { createFacadeMaterial } from './facade';

/**
 * Isolato principale (FLIGHT 2.0), progetto originale: torre simbolo con profili LED e piattaforma
 * sul tetto, uffici in vetro, residenziale con balconi, edificio in cemento con terrazza verde,
 * piano terra commerciale, cortile alberato. Unità in metri; l'isolato occupa x, z ∈ [−55, 55].
 */

export interface BlockParts {
  group: Group;
  /** Luci rosse di segnalazione (lampeggiano). */
  beacons: MeshBasicMaterial;
  /** Volumi per le collisioni future: [minX, maxX, minZ, maxZ, altezza]. */
  volumes: [number, number, number, number, number][];
  /** Centro e quota della piattaforma sul tetto della torre. */
  pad: { x: number; y: number; z: number; radius: number };
  facade: MeshStandardMaterial;
}

export function createBlock(env: Texture): BlockParts {
  const group = new Group();
  group.name = 'hero-block';
  const facade = createFacadeMaterial({ envMap: env, vertexColors: true });
  const walls = new Builder();
  const plain = new Builder();
  const glowWhite = new Builder();
  const glowWarm = new Builder();
  const red = new Builder();
  const neon: { builder: Builder; color: Color }[] = [
    { builder: new Builder(), color: new Color(0.2, 2.6, 2.2) },
    { builder: new Builder(), color: new Color(3.0, 0.5, 1.6) },
    { builder: new Builder(), color: new Color(2.6, 1.6, 0.4) },
  ];
  const greens = new Builder();
  const volumes: BlockParts['volumes'] = [];
  const vol = (x0: number, x1: number, z0: number, z1: number, h: number) => volumes.push([x0, x1, z0, z1, h]);

  // ── Torre simbolo «Faro» (≈ 200 m): fusto quadrato, due arretramenti, corona con piattaforma.
  walls.color.setRGB(0.42, 0.45, 0.52);
  walls.building = [0.137, 0.62, 0, 14];
  const T = { x0: -48, x1: -16, z0: -48, z1: -16 };
  walls.box(T.x0, 0, T.z0, T.x1, 150, T.z1, { top: false });
  walls.box(T.x0 + 4, 150, T.z0 + 4, T.x1 - 4, 186, T.z1 - 4, { top: false });
  walls.box(T.x0 + 7, 186, T.z0 + 7, T.x1 - 7, 196, T.z1 - 7, { top: false });
  vol(T.x0, T.x1, T.z0, T.z1, 150);
  vol(T.x0 + 4, T.x1 - 4, T.z0 + 4, T.z1 - 4, 186);
  vol(T.x0 + 7, T.x1 - 7, T.z0 + 7, T.z1 - 7, 197);
  plain.color.setRGB(0.16, 0.17, 0.2);
  // Solette degli arretramenti e coronamento.
  plain.box(T.x0 - 0.6, 149.4, T.z0 - 0.6, T.x1 + 0.6, 150.4, T.z1 + 0.6);
  plain.box(T.x0 + 3.4, 185.4, T.z0 + 3.4, T.x1 - 3.4, 186.4, T.z1 - 3.4);
  plain.parapet(T.x0, T.z0, T.x1, T.z1, 150.4, 1.4);
  plain.parapet(T.x0 + 4, T.z0 + 4, T.x1 - 4, T.z1 - 4, 186.4, 1.4);
  // Pinne verticali sulle facciate (ritmo architettonico, ombre radenti del tramonto).
  for (let k = 1; k < 8; k++) {
    const x = T.x0 + (k * (T.x1 - T.x0)) / 8;
    const z = T.z0 + (k * (T.z1 - T.z0)) / 8;
    plain.box(x - 0.25, 14, T.z0 - 0.9, x + 0.25, 149.4, T.z0);
    plain.box(x - 0.25, 14, T.z1, x + 0.25, 149.4, T.z1 + 0.9);
    plain.box(T.x0 - 0.9, 14, z - 0.25, T.x0, 149.4, z + 0.25);
    plain.box(T.x1, 14, z - 0.25, T.x1 + 0.9, 149.4, z + 0.25);
  }
  // Profili LED sugli spigoli del fusto e degli arretramenti.
  const corners = (x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, w = 0.45) => {
    for (const [x, z] of [
      [x0, z0],
      [x1, z0],
      [x0, z1],
      [x1, z1],
    ] as const) glowWhite.box(x - w, y0, z - w, x + w, y1, z + w);
  };
  corners(T.x0 - 0.5, T.z0 - 0.5, T.x1 + 0.5, T.z1 + 0.5, 14, 150);
  corners(T.x0 + 3.6, T.z0 + 3.6, T.x1 - 3.6, T.z1 - 3.6, 150, 186);
  // Fasce luminose orizzontali agli arretramenti.
  const band = (x0: number, z0: number, x1: number, z1: number, y: number) => {
    glowWhite.box(x0, y, z0 - 0.3, x1, y + 0.5, z0);
    glowWhite.box(x0, y, z1, x1, y + 0.5, z1 + 0.3);
    glowWhite.box(x0 - 0.3, y, z0, x0, y + 0.5, z1);
    glowWhite.box(x1, y, z0, x1 + 0.3, y + 0.5, z1);
  };
  band(T.x0 - 0.6, T.z0 - 0.6, T.x1 + 0.6, T.z1 + 0.6, 148.8);
  band(T.x0 + 3.4, T.z0 + 3.4, T.x1 - 3.4, T.z1 - 3.4, 184.8);
  // Corona: piattaforma circolare a sbalzo con anello di luci.
  const pad = { x: (T.x0 + T.x1) / 2, y: 197.4, z: (T.z0 + T.z1) / 2, radius: 13 };
  plain.color.setRGB(0.13, 0.13, 0.15);
  plain.cylinder(pad.x, pad.z, pad.radius, 196, pad.y, 48);
  plain.cylinder(pad.x, pad.z, 2.6, 186, 196, 16);
  for (let k = 0; k < 40; k++) {
    const a = (k / 40) * Math.PI * 2;
    glowWarm.boxAt(pad.x + Math.cos(a) * (pad.radius - 0.5), pad.y + 0.15, pad.z + Math.sin(a) * (pad.radius - 0.5), 0.45, 0.3, 0.45);
  }
  vol(pad.x - pad.radius, pad.x + pad.radius, pad.z - pad.radius, pad.z + pad.radius, pad.y);
  // Segnaletica sulla piattaforma (anello e croce in giallo tenue).
  // (la segnaletica ad anelli è aggiunta sotto come geometria continua)
  // Antenna sottile sull'arretramento, fuori dalla piattaforma, con luce di segnalazione.
  plain.color.setRGB(0.2, 0.2, 0.22);
  plain.box(T.x0 + 4.6, 186.4, T.z0 + 4.6, T.x0 + 4.95, 212, T.z0 + 4.95);
  red.boxAt(T.x0 + 4.78, 212.5, T.z0 + 4.78, 0.7, 0.7, 0.7);
  for (const [x, z] of [
    [T.x0 + 0.5, T.z0 + 0.5],
    [T.x1 - 0.5, T.z1 - 0.5],
  ] as const) red.boxAt(x, 151.6, z, 0.8, 0.8, 0.8);

  // ── Uffici in vetro (78 m), lato est.
  walls.color.setRGB(0.3, 0.34, 0.4);
  walls.building = [0.583, 0.48, 0, 6];
  walls.box(6, 0, -52, 52, 78, -26, { top: false });
  vol(6, 52, -52, -26, 78);
  plain.color.setRGB(0.2, 0.21, 0.24);
  plain.box(6, 77.8, -52, 52, 78.2, -26);
  plain.parapet(6, -52, 52, -26, 78.2);
  // Marcapiani metallici ogni 4 piani.
  for (let y = 6 + 15.2; y < 78; y += 15.2) plain.box(5.6, y - 0.25, -52.4, 52.4, y + 0.25, -25.6, { top: true });
  plain.color.setRGB(0.32, 0.33, 0.35);
  plain.box(12, 78.2, -46, 22, 82.5, -36);
  plain.box(30, 78.2, -48, 44, 81, -40);
  plain.cylinder(47, -31, 2.2, 78.2, 82, 16);

  // ── Residenziale (46 m) con balconi, lato sud-ovest.
  walls.color.setRGB(0.62, 0.52, 0.42);
  walls.building = [0.291, 0.55, 1, 5];
  walls.box(-52, 0, 26, -12, 46, 46, { top: false });
  vol(-52, -12, 26, 46, 46);
  plain.color.setRGB(0.55, 0.5, 0.45);
  for (let y = 5 + 3.2; y < 45; y += 3.2) {
    for (let x = -50; x < -14; x += 7.2) plain.box(x, y - 0.12, 46, x + 5.6, y + 0.12, 47.6);
    // Ringhiere vetrate (sottili, chiare).
  }
  plain.color.setRGB(0.4, 0.37, 0.34);
  plain.box(-52.2, 45.8, 25.8, -11.8, 46.4, 46.2);
  plain.parapet(-52, 26, -12, 46, 46.4);
  plain.box(-44, 46.4, 30, -36, 50.5, 38);
  plain.cylinder(-20, 36, 2.6, 46.4, 52, 18);

  // ── Edificio in cemento (30 m) con terrazza verde, lato sud-est.
  walls.color.setRGB(0.55, 0.55, 0.53);
  walls.building = [0.774, 0.5, 2, 5];
  walls.box(18, 0, 6, 52, 30, 50, { top: false });
  vol(18, 52, 6, 50, 30);
  plain.color.setRGB(0.36, 0.36, 0.35);
  plain.box(17.8, 29.8, 5.8, 52.2, 30.4, 50.2);
  plain.parapet(18, 6, 52, 50, 30.4, 1.2);
  greens.color.setRGB(0.2, 0.32, 0.16);
  for (let k = 0; k < 9; k++) greens.box(21 + (k % 3) * 10, 30.4, 10 + Math.floor(k / 3) * 12, 28 + (k % 3) * 10, 31.4, 18 + Math.floor(k / 3) * 12);

  // ── Piano terra commerciale lungo i fronti (10 m) tra gli edifici.
  walls.color.setRGB(0.34, 0.33, 0.33);
  walls.building = [0.905, 0.0, 2, 10];
  walls.box(-12, 0, 30, 18, 10, 52, { top: false });
  walls.box(-14, 0, -52, 6, 10, -30, { top: false });
  vol(-12, 18, 30, 52, 10);
  vol(-14, 6, -52, -30, 10);
  plain.color.setRGB(0.28, 0.28, 0.29);
  plain.box(-12, 9.8, 30, 18, 10.3, 52);
  plain.box(-14, 9.8, -52, 6, 10.3, -30);
  // Pensiline sopra le vetrine.
  plain.color.setRGB(0.15, 0.15, 0.17);
  plain.box(-12, 4.6, 52, 18, 4.9, 54.5);
  plain.box(6, 4.6, -54.5, 52, 4.9, -52);

  // Insegne al neon sui fronti commerciali.
  const sign = (k: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => neon[k % 3]!.builder.box(x0, y0, z0, x1, y1, z1);
  sign(0, -9, 6, 52.05, 1, 7.4, 52.3);
  sign(1, 4, 6, 52.05, 15, 7.2, 52.3);
  sign(2, 10, 6.4, -52.3, 22, 7.6, -52.05);
  sign(1, 32, 6.2, -52.3, 40, 7.6, -52.05);
  sign(0, 52.05, 5.5, 14, 52.3, 7, 26);

  // Segnaletica della piattaforma: due anelli continui e un anello interno tratteggiato.
  const markMat = new MeshStandardMaterial({ color: new Color(0.85, 0.58, 0.16), roughness: 0.6, metalness: 0 });
  for (const [r0, r1] of [
    [7.2, 7.75],
    [11.3, 11.6],
  ] as const) {
    const ring = new Mesh(new RingGeometry(r0, r1, 96), markMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pad.x, pad.y + 0.02, pad.z);
    ring.receiveShadow = true;
    group.add(ring);
  }
  for (let k = 0; k < 12; k++) {
    const seg = new Mesh(new RingGeometry(3.2, 3.55, 16, 1, (k / 12) * Math.PI * 2, Math.PI / 12), markMat);
    seg.rotation.x = -Math.PI / 2;
    seg.position.set(pad.x, pad.y + 0.02, pad.z);
    group.add(seg);
  }

  // Mesh.
  const facadeMesh = new Mesh(walls.geometry(), facade);
  const plainMesh = new Mesh(plain.geometry(), new MeshStandardMaterial({ color: new Color(0.5, 0.48, 0.5), vertexColors: true, roughness: 0.75, metalness: 0.2, envMap: env, envMapIntensity: 0.3 }));
  const greenMesh = new Mesh(greens.geometry(), new MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  for (const m of [facadeMesh, plainMesh, greenMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  const glow = (b: Builder, color: Color) => {
    const m = new Mesh(b.geometry(), new MeshBasicMaterial({ color, toneMapped: true }));
    group.add(m);
    return m.material as MeshBasicMaterial;
  };
  glow(glowWhite, new Color(2.6, 2.75, 3.0));
  glow(glowWarm, new Color(3.2, 2.2, 1.2));
  const beacons = glow(red, new Color(4, 0.25, 0.15));
  for (const n of neon) glow(n.builder, n.color);

  // Alberi nel cortile.
  const trees: Matrix4[] = [];
  const q = new Quaternion();
  for (let k = 0; k < 14; k++) {
    const x = -8 + (k % 5) * 6 + (k % 2) * 1.5;
    const z = -20 + Math.floor(k / 5) * 13;
    const s = 0.9 + ((k * 37) % 10) / 25;
    trees.push(new Matrix4().compose(new Vector3(x, 0, z), q, new Vector3(s, s, s)));
  }
  const trunk = new InstancedMesh(new CylinderGeometry(0.2, 0.28, 3.2, 6).translate(0, 1.6, 0), new MeshStandardMaterial({ color: 0x3a2c22, roughness: 1 }), trees.length);
  const crown = new InstancedMesh(new IcosahedronGeometry(2.4, 1).translate(0, 4.6, 0), new MeshStandardMaterial({ color: 0x23361f, roughness: 0.95, flatShading: true }), trees.length);
  trees.forEach((m, k) => {
    trunk.setMatrixAt(k, m);
    crown.setMatrixAt(k, m);
  });
  for (const m of [trunk, crown]) {
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }

  return { group, beacons, volumes, pad, facade };
}
