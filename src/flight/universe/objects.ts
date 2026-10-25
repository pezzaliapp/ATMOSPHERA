import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  FrontSide,
  Group,
  InstancedMesh,
  LatheGeometry,
  LineBasicMaterial,
  LineSegments,
  NormalBlending,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PlaneGeometry,
  Points,
  RingGeometry,
  Shape,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type Texture,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { SUN_DIR } from '../sky';
import type { AppObjectKind } from './apps';

/**
 * APP UNIVERSE — oggetti 3D originali, generati dal codice (nessun asset esterno).
 * Animazioni lente; geometrie leggere (istanze, shader) per non pesare sul volo.
 */

export interface FrameInfo {
  camera: PerspectiveCamera;
  /** Pixel per unità a distanza 1 (altezza del buffer / (2·tan(fov/2))): dimensione dei punti luminosi. */
  pxScale: number;
}

export interface AppObject {
  group: Group;
  update(t: number, dt: number, frame: FrameInfo): void;
  setHighlight(on: boolean): void;
  dispose(): void;
}

const NOISE = /* glsl */ `
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise3(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm3(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }
`;

/** ShaderMaterial con la nebbia della scena (stessa prospettiva aerea degli edifici). */
function fogShader(opts: { uniforms: Record<string, { value: unknown }>; vertex: string; fragment: string; additive?: boolean; side?: typeof FrontSide | typeof BackSide | typeof DoubleSide }) {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([UniformsLib.fog, opts.uniforms]),
    vertexShader: opts.vertex,
    fragmentShader: opts.fragment,
    transparent: true,
    depthWrite: false,
    fog: true,
    side: opts.side ?? FrontSide,
    blending: opts.additive ? AdditiveBlending : NormalBlending,
  });
}

const SPHERE_VERTEX = /* glsl */ `
#include <fog_pars_vertex>
varying vec3 vObj;
varying vec3 vNormalW;
varying vec3 vViewDir;
void main() {
  vObj = normalize(position);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewDir = normalize(cameraPosition - world.xyz);
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

/** Alone di selezione: anello sottile rivolto alla camera, colore d'accento. */
function createHalo(radius: number, accent: Color) {
  const material = fogShader({
    uniforms: { uColor: { value: accent }, uTime: { value: 0 }, uOn: { value: 0 } },
    vertex: /* glsl */ `
      #include <fog_pars_vertex>
      varying vec2 vUv;
      void main() { vUv = uv * 2.0 - 1.0; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
      }`,
    fragment: /* glsl */ `
      #include <fog_pars_fragment>
      uniform vec3 uColor; uniform float uTime; uniform float uOn;
      varying vec2 vUv;
      void main() {
        float d = length(vUv);
        float a = atan(vUv.y, vUv.x);
        float ring = smoothstep(0.86, 0.9, d) * smoothstep(0.95, 0.91, d);
        float dash = 0.55 + 0.45 * smoothstep(0.3, 0.7, sin(a * 24.0 - uTime * 1.2) * 0.5 + 0.5);
        float g = (d - 0.905) * 14.0;
        float glow = exp(-g * g) * 0.35;
        float pulse = 0.8 + 0.2 * sin(uTime * 2.4);
        gl_FragColor = vec4(uColor * (ring * dash + glow) * pulse * uOn, 1.0);
        #include <fog_fragment>
      }`,
    additive: true,
    side: DoubleSide,
  });
  const mesh = new Mesh(new PlaneGeometry(2, 2), material);
  mesh.scale.setScalar(radius * 1.32);
  mesh.renderOrder = 10;
  mesh.visible = false;
  let on = 0;
  let target = 0;
  return {
    mesh,
    set(v: boolean) {
      target = v ? 1 : 0;
      if (v) mesh.visible = true;
    },
    update(t: number, dt: number, camera: PerspectiveCamera) {
      on += (target - on) * (1 - Math.exp(-5 * dt));
      material.uniforms.uOn!.value = on;
      material.uniforms.uTime!.value = t;
      if (target === 0 && on < 0.01) mesh.visible = false;
      if (mesh.visible) mesh.quaternion.copy(camera.quaternion);
    },
  };
}

// ── NOWCAST: sfera atmosferica semitrasparente, nubi in lento movimento, celle temporalesche, anelli radar.
function atmosphere(radius: number, accent: Color): AppObject {
  const group = new Group();
  const r = radius * 0.86;
  const sun = { value: SUN_DIR.clone() };
  const glow = { value: 0 };
  const time = { value: 0 };

  // Corpo traslucido: dà volume alla sfera senza nasconderne il retro.
  const body = new Mesh(
    new SphereGeometry(r * 0.94, 48, 32),
    fogShader({
      uniforms: { uSun: sun },
      vertex: SPHERE_VERTEX,
      fragment: /* glsl */ `
        #include <fog_pars_fragment>
        uniform vec3 uSun; varying vec3 vObj; varying vec3 vNormalW; varying vec3 vViewDir;
        void main() {
          float l = dot(vNormalW, uSun) * 0.5 + 0.5;
          float fres = clamp(1.0 - abs(dot(vNormalW, vViewDir)), 0.0, 1.0);
          vec3 c = mix(vec3(0.012, 0.03, 0.065), vec3(0.07, 0.09, 0.16), l) + vec3(0.03, 0.06, 0.1) * fres;
          gl_FragColor = vec4(c, 0.62 + 0.2 * fres);
          #include <fog_fragment>
        }`,
    }),
  );
  body.renderOrder = 1;

  // Strato di nubi: rumore frattale con deriva per latitudine e vortici; nuclei temporaleschi con eco radar.
  const cloudFragment = /* glsl */ `
    #include <fog_pars_fragment>
    uniform vec3 uSun; uniform float uTime; uniform float uGlow; uniform float uBack;
    varying vec3 vObj; varying vec3 vNormalW; varying vec3 vViewDir;
    ${NOISE}
    void main() {
      vec3 p = vObj;
      float ang = uTime * 0.035 * (1.0 + 0.8 * p.y * p.y);
      float c = cos(ang), s = sin(ang);
      vec3 q = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
      vec3 w = vec3(fbm3(q * 2.0 + uTime * 0.02), fbm3(q * 2.0 + vec3(5.2, 1.3, 2.8) - uTime * 0.015), fbm3(q * 2.0 + vec3(2.1, 7.7, 0.4)));
      float n = fbm3(q * 3.2 + w * 1.4);
      float cover = smoothstep(0.42, 0.64, n);
      float cell = fbm3(q * 5.5 + w * 0.8 + vec3(0.0, uTime * 0.04, 0.0));
      float core = smoothstep(0.6, 0.8, cell) * cover;
      float l = dot(vNormalW, uSun) * 0.5 + 0.5;
      vec3 lit = mix(vec3(0.2, 0.19, 0.32), vec3(1.0, 0.68, 0.48), smoothstep(0.35, 0.95, l));
      vec3 col = lit * (0.5 + 0.55 * n);
      float e = smoothstep(0.6, 0.85, cell);
      vec3 radar = mix(vec3(0.15, 0.85, 0.45), vec3(1.0, 0.82, 0.25), smoothstep(0.25, 0.65, e));
      radar = mix(radar, vec3(1.0, 0.3, 0.18), smoothstep(0.7, 1.0, e));
      col = mix(col, radar * 0.8, core * 0.5);
      float fres = clamp(1.0 - abs(dot(vNormalW, vViewDir)), 0.0, 1.0);
      float alpha = (cover * 0.88 + core * 0.12) * (1.0 - 0.5 * pow(fres, 3.0));
      gl_FragColor = vec4(col * (1.0 + uGlow * 0.35) + radar * core * 0.2, alpha * uBack);
      #include <fog_fragment>
    }`;
  const cloudGeo = new SphereGeometry(r, 64, 40);
  const cloudBack = new Mesh(cloudGeo, fogShader({ uniforms: { uSun: sun, uTime: time, uGlow: glow, uBack: { value: 0.45 } }, vertex: SPHERE_VERTEX, fragment: cloudFragment, side: BackSide }));
  const cloudFront = new Mesh(cloudGeo, fogShader({ uniforms: { uSun: sun, uTime: time, uGlow: glow, uBack: { value: 1 } }, vertex: SPHERE_VERTEX, fragment: cloudFragment }));
  cloudBack.renderOrder = 0;
  cloudFront.renderOrder = 2;

  // Bordo atmosferico: rilievo luminoso tenue, più caldo dal lato del Sole.
  const shell = new Mesh(
    new SphereGeometry(radius * 0.95, 48, 32),
    fogShader({
      uniforms: { uSun: sun, uGlow: glow },
      vertex: SPHERE_VERTEX,
      fragment: /* glsl */ `
        #include <fog_pars_fragment>
        uniform vec3 uSun; uniform float uGlow; varying vec3 vObj; varying vec3 vNormalW; varying vec3 vViewDir;
        void main() {
          float fres = clamp(1.0 - abs(dot(vNormalW, vViewDir)), 0.0, 1.0);
          float sunSide = smoothstep(-0.2, 0.8, dot(vNormalW, uSun));
          vec3 c = mix(vec3(0.3, 0.62, 1.0), vec3(1.0, 0.62, 0.42), sunSide * 0.6);
          gl_FragColor = vec4(c * pow(fres, 3.4) * (0.26 + 0.24 * uGlow), 1.0);
          #include <fog_fragment>
        }`,
      additive: true,
    }),
  );
  shell.renderOrder = 3;

  // Anelli radar: scansione rotante, cerchi di distanza e un impulso che si espande.
  const radarGroup = new Group();
  radarGroup.rotation.set(0.22, 0, -0.12);
  const inner = radius * 0.98;
  const outer = radius * 1.75;
  const radar = new Mesh(
    new RingGeometry(inner, outer, 128, 1).rotateX(-Math.PI / 2),
    fogShader({
      uniforms: { uTime: time, uInner: { value: inner }, uOuter: { value: outer }, uGlow: glow },
      vertex: /* glsl */ `
        #include <fog_pars_vertex>
        varying vec2 vP;
        void main() { vP = position.xz; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
        }`,
      fragment: /* glsl */ `
        #include <fog_pars_fragment>
        uniform float uTime; uniform float uInner; uniform float uOuter; uniform float uGlow;
        varying vec2 vP;
        void main() {
          float r = length(vP);
          float k = (r - uInner) / (uOuter - uInner);
          float a = atan(vP.y, vP.x);
          float sweep = mod(a + uTime * 0.6, 6.2831853);
          float trail = exp(-sweep * 3.5) * 0.12;
          float rings = 0.0;
          for (int i = 1; i <= 3; i++) { float rr = float(i) / 3.4; rings += smoothstep(0.01, 0.0, abs(k - rr)) * 0.2; }
          float pk = fract(uTime * 0.18);
          float pulse = smoothstep(0.016, 0.0, abs(k - pk)) * (1.0 - pk) * 0.5;
          float fade = smoothstep(0.0, 0.05, k) * smoothstep(1.0, 0.75, k);
          vec3 col = vec3(0.3, 0.95, 0.75) * (trail + rings + pulse) * fade * (0.75 + 0.5 * uGlow);
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }`,
      additive: true,
      side: DoubleSide,
    }),
  );
  radar.renderOrder = 4;
  radarGroup.add(radar);

  const halo = createHalo(radius * 1.32, accent);
  group.add(body, cloudBack, cloudFront, shell, radarGroup, halo.mesh);

  return {
    group,
    update(t, dt, frame) {
      time.value = t;
      body.rotation.y = t * 0.02;
      halo.update(t, dt, frame.camera);
    },
    setHighlight(on) {
      glow.value = on ? 1 : 0;
      halo.set(on);
    },
    dispose() {
      group.traverse((o) => (o as Mesh).geometry?.dispose());
    },
  };
}

// ── ILCUBO: cubo magico 3×3×3 (corpo nero, tessere colorate), rotazione lenta e mosse di strato.
function cube(radius: number, accent: Color, env: Texture): AppObject {
  const group = new Group();
  const pivot = new Group();
  group.add(pivot);
  const S = radius * 0.33;
  const P = S * 1.035;
  const bodyGeo = new RoundedBoxGeometry(S, S, S, 3, S * 0.11);
  const bodyMat = new MeshPhysicalMaterial({ color: new Color(0.012, 0.013, 0.016), metalness: 0.1, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.2, envMap: env, envMapIntensity: 1.4 });
  const bodies = new InstancedMesh(bodyGeo, bodyMat, 27);

  // Tessera: quadrato arrotondato con un leggero smusso.
  const T = S * 0.84;
  const rr = T * 0.16;
  const shape = new Shape();
  shape.moveTo(-T / 2 + rr, -T / 2);
  shape.lineTo(T / 2 - rr, -T / 2);
  shape.quadraticCurveTo(T / 2, -T / 2, T / 2, -T / 2 + rr);
  shape.lineTo(T / 2, T / 2 - rr);
  shape.quadraticCurveTo(T / 2, T / 2, T / 2 - rr, T / 2);
  shape.lineTo(-T / 2 + rr, T / 2);
  shape.quadraticCurveTo(-T / 2, T / 2, -T / 2, T / 2 - rr);
  shape.lineTo(-T / 2, -T / 2 + rr);
  shape.quadraticCurveTo(-T / 2, -T / 2, -T / 2 + rr, -T / 2);
  const tileGeo = new ExtrudeGeometry(shape, { depth: S * 0.02, bevelEnabled: true, bevelThickness: S * 0.012, bevelSize: S * 0.012, bevelSegments: 2, curveSegments: 4 });
  const glowU = { value: 0.22 };
  const tileMat = new MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.32, clearcoat: 0.9, clearcoatRoughness: 0.08, envMap: env, envMapIntensity: 1.1 });
  // Leggera luminosità propria delle tessere: restano leggibili anche nella luce del crepuscolo.
  tileMat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlow = glowU;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uGlow;');
  };
  const tiles = new InstancedMesh(tileGeo, tileMat, 54);

  const FACES: { n: Vector3; color: Color }[] = [
    { n: new Vector3(1, 0, 0), color: new Color('#d8351c') },
    { n: new Vector3(-1, 0, 0), color: new Color('#ff7a12') },
    { n: new Vector3(0, 1, 0), color: new Color('#f4f1f8') },
    { n: new Vector3(0, -1, 0), color: new Color('#ffd21a') },
    { n: new Vector3(0, 0, 1), color: new Color('#1f9b55') },
    { n: new Vector3(0, 0, -1), color: new Color('#1d5fd6') },
  ];
  const cubies: { base: Matrix4; grid: Vector3 }[] = [];
  const stickers: { cubie: number; local: Matrix4 }[] = [];
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        const index = cubies.length;
        cubies.push({ base: new Matrix4().makeTranslation(x * P, y * P, z * P), grid: new Vector3(x, y, z) });
        for (const f of FACES) {
          if (f.n.x * x + f.n.y * y + f.n.z * z !== 1) continue;
          const q = new Matrix4().lookAt(new Vector3(), f.n.clone().negate(), Math.abs(f.n.y) > 0.5 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0));
          // lookAt con bersaglio opposto alla normale: l'asse z locale (estrusione) punta verso l'esterno.
          const local = new Matrix4().makeTranslation(f.n.x * S * 0.5, f.n.y * S * 0.5, f.n.z * S * 0.5).multiply(q);
          tiles.setColorAt(stickers.length, f.color);
          stickers.push({ cubie: index, local });
        }
      }
  pivot.add(bodies, tiles);

  // Mosse di strato: un quarto di giro ogni pochi secondi, mai l'inverso della mossa precedente.
  const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  let turn: { axis: number; layer: number; dir: number; t: number } | null = null;
  let wait = 1.5;
  let last = { axis: -1, layer: 0, dir: 0 };
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const current = cubies.map(() => new Matrix4());
  const rot = new Matrix4();
  const tmp = new Matrix4();
  const ease = (f: number) => (f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2);
  const coord = (g: Vector3, axis: number) => (axis === 0 ? g.x : axis === 1 ? g.y : g.z);
  const snap = (m: Matrix4) => {
    const e = m.elements;
    for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) e[i] = Math.round(e[i]!);
    for (const i of [12, 13, 14]) e[i] = Math.round(e[i]! / P) * P;
  };
  const compose = () => {
    for (let i = 0; i < cubies.length; i++) bodies.setMatrixAt(i, current[i]!);
    for (let i = 0; i < stickers.length; i++) tiles.setMatrixAt(i, tmp.multiplyMatrices(current[stickers[i]!.cubie]!, stickers[i]!.local));
    bodies.instanceMatrix.needsUpdate = true;
    tiles.instanceMatrix.needsUpdate = true;
  };
  for (let i = 0; i < cubies.length; i++) current[i]!.copy(cubies[i]!.base);
  compose();
  bodies.computeBoundingSphere();
  tiles.computeBoundingSphere();
  if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;

  const halo = createHalo(radius * 1.25, accent);
  group.add(halo.mesh);

  return {
    group,
    update(t, dt, frame) {
      pivot.rotation.set(0.5 + 0.06 * Math.sin(t * 0.21), t * 0.11, 0.2 + 0.05 * Math.sin(t * 0.17));
      if (!turn) {
        wait -= dt;
        if (wait <= 0) {
          let axis: number;
          let layer: number;
          do {
            axis = Math.floor(rand() * 3);
            layer = Math.floor(rand() * 3) - 1;
          } while (axis === last.axis && layer === last.layer);
          turn = { axis, layer, dir: rand() < 0.5 ? 1 : -1, t: 0 };
        }
      }
      if (turn) {
        turn.t = Math.min(1, turn.t + dt / 1.25);
        rot.makeRotationAxis(AXES[turn.axis]!, ease(turn.t) * turn.dir * (Math.PI / 2));
        for (let i = 0; i < cubies.length; i++) {
          const c = cubies[i]!;
          if (coord(c.grid, turn.axis) === turn.layer) current[i]!.multiplyMatrices(rot, c.base);
          else current[i]!.copy(c.base);
        }
        if (turn.t >= 1) {
          for (let i = 0; i < cubies.length; i++) {
            const c = cubies[i]!;
            if (coord(c.grid, turn.axis) !== turn.layer) continue;
            c.base.copy(current[i]!);
            snap(c.base);
            c.grid.set(Math.round(c.base.elements[12]! / P), Math.round(c.base.elements[13]! / P), Math.round(c.base.elements[14]! / P));
            current[i]!.copy(c.base);
          }
          last = turn;
          turn = null;
          wait = 1.6 + rand() * 1.6;
        }
        compose();
      }
      halo.update(t, dt, frame.camera);
    },
    setHighlight(on) {
      glowU.value = on ? 0.42 : 0.22;
      halo.set(on);
    },
    dispose() {
      bodyGeo.dispose();
      tileGeo.dispose();
    },
  };
}

// ── NEXUM: globo tecnologico, nodi luminosi, relazioni sottili percorse da impulsi, anello della linea del tempo.
function network(radius: number, accent: Color, env: Texture): AppObject {
  const group = new Group();
  const spin = new Group();
  group.add(spin);
  const R = radius * 0.84;
  const time = { value: 0 };
  const glow = { value: 0 };
  const pxScale = { value: 800 };

  const core = new Mesh(
    new SphereGeometry(R, 64, 40),
    new MeshPhysicalMaterial({ color: new Color(0.018, 0.021, 0.024), metalness: 0.55, roughness: 0.36, clearcoat: 1, clearcoatRoughness: 0.12, envMap: env, envMapIntensity: 1.3 }),
  );

  // Reticolo di meridiani e paralleli.
  const grid: number[] = [];
  const rg = R * 1.004;
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = Math.sin((lat * Math.PI) / 180) * rg;
    const rr = Math.cos((lat * Math.PI) / 180) * rg;
    for (let i = 0; i < 72; i++) {
      const a0 = (i / 72) * Math.PI * 2;
      const a1 = ((i + 1) / 72) * Math.PI * 2;
      grid.push(Math.cos(a0) * rr, y, Math.sin(a0) * rr, Math.cos(a1) * rr, y, Math.sin(a1) * rr);
    }
  }
  for (let lon = 0; lon < 180; lon += 30) {
    const a = (lon * Math.PI) / 180;
    for (let i = 0; i < 72; i++) {
      const b0 = (i / 72) * Math.PI * 2;
      const b1 = ((i + 1) / 72) * Math.PI * 2;
      grid.push(Math.cos(a) * Math.cos(b0) * rg, Math.sin(b0) * rg, Math.sin(a) * Math.cos(b0) * rg, Math.cos(a) * Math.cos(b1) * rg, Math.sin(b1) * rg, Math.sin(a) * Math.cos(b1) * rg);
    }
  }
  const gridGeo = new BufferGeometry();
  gridGeo.setAttribute('position', new BufferAttribute(new Float32Array(grid), 3));
  const graticule = new LineSegments(gridGeo, new LineBasicMaterial({ color: new Color(0.42, 0.47, 0.5), transparent: true, opacity: 0.22, depthWrite: false }));

  // Nodi: distribuzione quasi uniforme con piccoli addensamenti.
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const N = 150;
  const nodes: Vector3[] = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const rr = Math.sqrt(1 - y * y);
    const a = i * 2.399963 + (rand() - 0.5) * 0.5;
    nodes.push(new Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr).normalize());
  }
  const nodePos = new Float32Array(N * 3);
  const nodeSeed = new Float32Array(N);
  const nodeSize = new Float32Array(N);
  nodes.forEach((n, i) => {
    n.toArray(nodePos, i * 3);
    nodePos[i * 3]! *= R * 1.012;
    nodePos[i * 3 + 1]! *= R * 1.012;
    nodePos[i * 3 + 2]! *= R * 1.012;
    nodeSeed[i] = rand();
    nodeSize[i] = rand() < 0.12 ? 1.25 : 0.55 + rand() * 0.3;
  });
  const nodeGeo = new BufferGeometry();
  nodeGeo.setAttribute('position', new BufferAttribute(nodePos, 3));
  nodeGeo.setAttribute('aSeed', new BufferAttribute(nodeSeed, 1));
  nodeGeo.setAttribute('aSize', new BufferAttribute(nodeSize, 1));
  const points = new Points(
    nodeGeo,
    fogShader({
      uniforms: { uTime: time, uScale: pxScale, uGlow: glow },
      vertex: /* glsl */ `
        #include <fog_pars_vertex>
        uniform float uTime; uniform float uScale; attribute float aSeed; attribute float aSize; varying float vPulse;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = clamp(aSize * uScale / -mvPosition.z, 1.5, 28.0);
          vPulse = 0.65 + 0.35 * sin(uTime * 1.3 + aSeed * 6.2831);
          #include <fog_vertex>
        }`,
      fragment: /* glsl */ `
        #include <fog_pars_fragment>
        uniform float uGlow; varying float vPulse;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.0, d);
          a = a * a;
          gl_FragColor = vec4(vec3(1.0, 0.72, 0.32) * a * vPulse * (1.1 + 0.6 * uGlow), 1.0);
          #include <fog_fragment>
        }`,
      additive: true,
    }),
  );

  // Relazioni: archi tra vicini (corte, aderenti) e alcune relazioni lontane (archi alti).
  const linePos: number[] = [];
  const lineT: number[] = [];
  const lineSeed: number[] = [];
  const arc = (a: Vector3, b: Vector3, lift: number, segments: number) => {
    const s = rand();
    const angle = a.angleTo(b);
    for (let k = 0; k < segments; k++) {
      for (const u of [k / segments, (k + 1) / segments]) {
        const p = new Vector3()
          .copy(a)
          .multiplyScalar(Math.sin((1 - u) * angle))
          .addScaledVector(b, Math.sin(u * angle))
          .divideScalar(Math.sin(angle))
          .multiplyScalar(R * (1.012 + lift * Math.sin(Math.PI * u)));
        linePos.push(p.x, p.y, p.z);
        lineT.push(u);
        lineSeed.push(s);
      }
    }
  };
  const seen = new Set<string>();
  nodes.forEach((n, i) => {
    const near = nodes
      .map((m, j) => ({ j, d: n.distanceTo(m) }))
      .filter((o) => o.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    for (const { j, d } of near) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key) || d > 0.42) continue;
      seen.add(key);
      arc(n, nodes[j]!, 0.015, 6);
    }
  });
  for (let k = 0; k < 9; k++) {
    const a = nodes[Math.floor(rand() * N)]!;
    let b = nodes[Math.floor(rand() * N)]!;
    for (let tries = 0; tries < 20 && (a.angleTo(b) < 1.0 || a.angleTo(b) > 2.4); tries++) b = nodes[Math.floor(rand() * N)]!;
    arc(a, b, 0.2 + rand() * 0.12, 32);
  }
  const lineGeo = new BufferGeometry();
  lineGeo.setAttribute('position', new BufferAttribute(new Float32Array(linePos), 3));
  lineGeo.setAttribute('aT', new BufferAttribute(new Float32Array(lineT), 1));
  lineGeo.setAttribute('aSeed', new BufferAttribute(new Float32Array(lineSeed), 1));
  const links = new LineSegments(
    lineGeo,
    fogShader({
      uniforms: { uTime: time, uGlow: glow },
      vertex: /* glsl */ `
        #include <fog_pars_vertex>
        attribute float aT; attribute float aSeed; varying float vT; varying float vSeed;
        void main() { vT = aT; vSeed = aSeed; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
        }`,
      fragment: /* glsl */ `
        #include <fog_pars_fragment>
        uniform float uTime; uniform float uGlow; varying float vT; varying float vSeed;
        void main() {
          float head = fract(uTime * (0.12 + 0.1 * vSeed) + vSeed * 7.0);
          float pulse = smoothstep(0.14, 0.0, abs(vT - head)) * step(0.45, vSeed);
          vec3 base = vec3(0.75, 0.7, 0.62) * (0.16 + 0.1 * uGlow);
          gl_FragColor = vec4(base + vec3(1.0, 0.7, 0.3) * pulse * 0.9, 1.0);
          #include <fog_fragment>
        }`,
      additive: true,
    }),
  );

  // Anello della linea del tempo, con tacche regolari.
  const ring: number[] = [];
  const RR = radius * 1.12;
  for (let i = 0; i < 160; i++) {
    const a0 = (i / 160) * Math.PI * 2;
    const a1 = ((i + 1) / 160) * Math.PI * 2;
    ring.push(Math.cos(a0) * RR, 0, Math.sin(a0) * RR, Math.cos(a1) * RR, 0, Math.sin(a1) * RR);
    if (i % 8 === 0) ring.push(Math.cos(a0) * RR, 0, Math.sin(a0) * RR, Math.cos(a0) * RR * 1.04, 0, Math.sin(a0) * RR * 1.04);
  }
  const ringGeo = new BufferGeometry();
  ringGeo.setAttribute('position', new BufferAttribute(new Float32Array(ring), 3));
  const timeline = new LineSegments(ringGeo, new LineBasicMaterial({ color: new Color(0.95, 0.72, 0.36), transparent: true, opacity: 0.38, depthWrite: false }));
  timeline.rotation.set(0.32, 0, 0.18);

  spin.add(core, graticule, points, links);
  const halo = createHalo(radius * 1.3, accent);
  group.add(timeline, halo.mesh);

  return {
    group,
    update(t, dt, frame) {
      time.value = t;
      pxScale.value = frame.pxScale;
      spin.rotation.set(0.25, t * 0.045, 0);
      timeline.rotation.y = -t * 0.02;
      halo.update(t, dt, frame.camera);
    },
    setHighlight(on) {
      glow.value = on ? 1 : 0;
      (timeline.material as LineBasicMaterial).opacity = on ? 0.6 : 0.38;
      halo.set(on);
    },
    dispose() {
      group.traverse((o) => (o as Mesh).geometry?.dispose());
    },
  };
}

/** Pannello fotovoltaico: celle blu scuro e griglia argentata (texture generata nel codice). */
function solarTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0b1530';
  g.fillRect(0, 0, 256, 128);
  for (let x = 0; x < 16; x++)
    for (let y = 0; y < 8; y++) {
      const v = 18 + ((x * 7 + y * 13) % 9);
      g.fillStyle = `rgb(${v - 8}, ${v + 6}, ${v + 44})`;
      g.fillRect(x * 16 + 1.5, y * 16 + 1.5, 13, 13);
    }
  g.strokeStyle = '#aab3c4';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 254, 126);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ── SYDERA: struttura orbitale; corpo metallico, ali fotovoltaiche rivolte al Sole, anelli armillari con dodici luci.
function orbital(radius: number, accent: Color, env: Texture): AppObject {
  const group = new Group();
  const craft = new Group();
  group.add(craft);
  const k = radius / 21;
  const metal = new MeshPhysicalMaterial({ color: new Color(0.8, 0.77, 0.7), metalness: 1, roughness: 0.3, envMap: env, envMapIntensity: 1.5 });
  const foil = new MeshPhysicalMaterial({ color: new Color(0.86, 0.62, 0.3), metalness: 1, roughness: 0.4, envMap: env, envMapIntensity: 1.4 });
  const dark = new MeshPhysicalMaterial({ color: new Color(0.11, 0.115, 0.13), metalness: 0.85, roughness: 0.34, clearcoat: 0.5, envMap: env, envMapIntensity: 1.3 });
  const solarMap = solarTexture();
  const panelMat = new MeshPhysicalMaterial({ map: solarMap, metalness: 0.5, roughness: 0.22, clearcoat: 0.6, envMap: env, envMapIntensity: 1.1, emissive: new Color(0.02, 0.05, 0.16), emissiveMap: solarMap });

  const add = (geo: BufferGeometry, mat: MeshPhysicalMaterial | MeshBasicMaterial, parent: Group = craft) => {
    const m = new Mesh(geo, mat);
    parent.add(m);
    return m;
  };
  // Corpo ottagonale in titanio scuro, moduli d'estremità argentati, fasce di isolamento dorate.
  add(new CylinderGeometry(2.3 * k, 2.3 * k, 9 * k, 8), dark);
  add(new CylinderGeometry(2.36 * k, 2.36 * k, 1.1 * k, 8).translate(0, 1.6 * k, 0), foil);
  add(new CylinderGeometry(2.36 * k, 2.36 * k, 0.5 * k, 8).translate(0, -2.2 * k, 0), foil);
  add(new CylinderGeometry(1.5 * k, 2.3 * k, 1.4 * k, 8).translate(0, 5.2 * k, 0), metal);
  add(new CylinderGeometry(2.3 * k, 1.5 * k, 1.4 * k, 8).translate(0, -5.2 * k, 0), metal);
  add(new SphereGeometry(1.2 * k, 16, 12).translate(0, -6.1 * k, 0), metal);
  add(new TorusGeometry(3.1 * k, 0.26 * k, 8, 40).rotateX(Math.PI / 2), metal);
  // Antenna parabolica in cima.
  const dishPts: Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const r = (i / 12) * 2.6 * k;
    dishPts.push(new Vector2(r, (r * r) / (5.5 * k)));
  }
  const dish = add(new LatheGeometry(dishPts, 32), metal);
  (dish.material as MeshPhysicalMaterial).side = DoubleSide;
  dish.position.set(0, 6.0 * k, 0);
  dish.scale.setScalar(0.8);
  add(new CylinderGeometry(0.1 * k, 0.1 * k, 1.8 * k, 6).translate(0, 6.8 * k, 0), metal);
  // Trave e ali fotovoltaiche (ruotano per seguire il Sole).
  add(new CylinderGeometry(0.22 * k, 0.22 * k, 34 * k, 6).rotateZ(Math.PI / 2), dark);
  const wings: Group[] = [];
  for (const side of [-1, 1]) {
    const wing = new Group();
    for (const [x, w] of [
      [7.6, 7.4],
      [15.3, 7.4],
    ] as const) {
      add(new RoundedBoxGeometry(w * k, 0.14 * k, 4.4 * k, 1, 0.05 * k).translate(side * x * k, 0, 0), panelMat, wing);
      add(new RoundedBoxGeometry(w * k + 0.2 * k, 0.1 * k, 0.18 * k, 1, 0.04 * k).translate(side * x * k, 0, 2.25 * k), metal, wing);
      add(new RoundedBoxGeometry(w * k + 0.2 * k, 0.1 * k, 0.18 * k, 1, 0.04 * k).translate(side * x * k, 0, -2.25 * k), metal, wing);
    }
    craft.add(wing);
    wings.push(wing);
  }
  // Anelli armillari: dodici luci sul primo anello, un secondo anello sottile in controrotazione.
  const ringA = new Group();
  ringA.rotation.set(1.05, 0, 0.25);
  const ringB = new Group();
  ringB.rotation.set(-0.55, 0, -0.9);
  add(new TorusGeometry(11.2 * k, 0.2 * k, 8, 120), metal, ringA);
  add(new TorusGeometry(12.8 * k, 0.1 * k, 6, 120), metal, ringB);
  const nodeMat = new MeshBasicMaterial({ color: new Color(1.4, 1.6, 2.2) });
  const nodes = new InstancedMesh(new SphereGeometry(0.42 * k, 12, 8), nodeMat, 12);
  const m4 = new Matrix4();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    nodes.setMatrixAt(i, m4.makeTranslation(Math.cos(a) * 11.2 * k, Math.sin(a) * 11.2 * k, 0));
    nodes.setColorAt(i, new Color(0.35, 0.42, 0.6));
  }
  ringA.add(nodes);
  craft.add(ringA, ringB);
  // Luci di navigazione e lampeggiatore.
  const navRed = new MeshBasicMaterial({ color: new Color(4, 0.25, 0.15) });
  const navGreen = new MeshBasicMaterial({ color: new Color(0.2, 4, 0.6) });
  const strobe = new MeshBasicMaterial({ color: new Color(3, 3, 3.2) });
  const lamp = new SphereGeometry(0.28 * k, 10, 8);
  wings[0]!.add(new Mesh(lamp, navRed).translateX(-19.1 * k));
  wings[1]!.add(new Mesh(lamp, navGreen).translateX(19.1 * k));
  craft.add(new Mesh(lamp, strobe).translateY(-7.4 * k));

  const halo = createHalo(radius * 1.12, accent);
  group.add(halo.mesh);
  const node = new Color();
  const sunLocal = new Vector3();
  let bright = 0.4;

  return {
    group,
    update(t, dt, frame) {
      craft.rotation.set(0.12 * Math.sin(t * 0.1), t * 0.05, 0.08 * Math.sin(t * 0.13 + 1));
      // Le ali si orientano verso il Sole (rotazione attorno alla trave).
      craft.updateMatrixWorld();
      sunLocal.copy(SUN_DIR).transformDirection(new Matrix4().copy(craft.matrixWorld).invert());
      const want = Math.atan2(sunLocal.z, sunLocal.y);
      for (const w of wings) w.rotation.x += (-want - w.rotation.x) * (1 - Math.exp(-0.8 * dt));
      ringA.rotation.z = 0.25 + t * 0.06;
      ringB.rotation.z = -0.9 - t * 0.035;
      // Una luce più intensa percorre le dodici posizioni.
      const lead = (t * 1.1) % 12;
      for (let i = 0; i < 12; i++) {
        const d = Math.min(Math.abs(i - lead), 12 - Math.abs(i - lead));
        const v = bright * (0.55 + 1.6 * Math.exp(-d * d * 1.5));
        nodes.setColorAt(i, node.setRGB(0.6 * v, 0.75 * v, 1.1 * v));
      }
      nodes.instanceColor!.needsUpdate = true;
      const blink = t % 1.8 < 0.5 ? 1 : 0.05;
      navRed.color.setRGB(4 * blink, 0.25 * blink, 0.15 * blink);
      navGreen.color.setRGB(0.2 * blink, 4 * blink, 0.6 * blink);
      const s = (t + 0.9) % 2.4 < 0.08 ? 1 : 0.04;
      strobe.color.setRGB(3 * s, 3 * s, 3.2 * s);
      halo.update(t, dt, frame.camera);
    },
    setHighlight(on) {
      bright = on ? 0.75 : 0.4;
      halo.set(on);
    },
    dispose() {
      group.traverse((o) => (o as Mesh).geometry?.dispose());
      solarMap.dispose();
    },
  };
}

export function createAppObject(kind: AppObjectKind, radius: number, accent: string, env: Texture): AppObject {
  const color = new Color(accent);
  switch (kind) {
    case 'atmosphere':
      return atmosphere(radius, color);
    case 'cube':
      return cube(radius, color, env);
    case 'network':
      return network(radius, color, env);
    case 'orbital':
      return orbital(radius, color, env);
  }
}
