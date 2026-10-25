import {
  BufferAttribute,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector3,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import type { Phase } from './weather';

/**
 * Precipitazioni attorno alla telecamera (S2.3), scena del velivolo in metri con la telecamera nell'origine.
 *
 * Tre strati periodici di particelle GPU: gocce grandi vicinissime (14 m, sfocate), gocce medie (50 m) e lontane
 * (220 m). Ogni particella è un segmento orientato secondo la velocità relativa: vento + caduta − velocità della
 * telecamera. SCELTA ARTISTICA dichiarata: il contributo della velocità del velivolo è limitato (70 m/s), altrimenti
 * a centinaia di m/s tutte le scie convergerebbero nel punto di fuga («iperspazio»): così restano visibili
 * l'inclinazione dovuta al vento e la caduta. Profilo trasversale morbido, otturatore 1/110 s.
 * Ghiaccio: punti piccoli che scintillano al Sole e cadono lentamente; grandine: chicchi rari e luminosi.
 */

const vertexShader = /* glsl */ `
  attribute vec2 corner;
  attribute vec4 seed;
  uniform float box;
  uniform vec3 offset;
  uniform vec3 vel;
  uniform float streakTime;
  uniform float maxLen;
  uniform float minLen;
  uniform float widthPx;
  uniform float pixelSize;
  uniform float density;
  uniform float time;
  uniform float sparkle;
  varying float vAlpha;
  varying float vAlong;
  varying float vCross;
  void main() {
    vec3 p = (fract(seed.xyz + offset / box) - 0.5) * box;
    // Piccola variazione individuale (velocità di caduta e deriva diverse da goccia a goccia).
    vec3 v = vel * (0.85 + 0.3 * seed.w);
    vec3 tail = -v * streakTime;
    float L = length(tail);
    if (L > maxLen) tail *= maxLen / L;
    if (L < minLen) tail = (L > 1e-4 ? tail / L : vec3(0.0, -1.0, 0.0)) * minLen;
    vec4 a = viewMatrix * vec4(p, 1.0);
    vec4 b = viewMatrix * vec4(p + tail, 1.0);
    vec2 d = b.xy / max(-b.z, 0.05) - a.xy / max(-a.z, 0.05);
    vec2 dir = length(d) > 1e-6 ? normalize(d) : vec2(0.0, 1.0);
    vec2 perp = vec2(-dir.y, dir.x);
    vec4 q = mix(a, b, corner.y);
    q.xy += perp * corner.x * widthPx * pixelSize * max(-q.z, 0.05);
    gl_Position = projectionMatrix * q;
    float dist = length(p);
    float keep = step(seed.w, density);
    float tw = sparkle > 0.0 ? 0.25 + 0.75 * pow(0.5 + 0.5 * sin(time * (6.0 + 9.0 * seed.x) + seed.y * 40.0), 6.0) : 1.0;
    vAlpha = keep * tw * smoothstep(0.5, 2.5, dist) * (1.0 - smoothstep(box * 0.3, box * 0.5, dist));
    vAlong = corner.y;
    vCross = corner.x;
    if (keep < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  uniform float taper;
  varying float vAlpha;
  varying float vAlong;
  varying float vCross;
  void main() {
    float profile = exp(-vCross * vCross * 3.0);
    float a = vAlpha * opacity * profile * mix(1.0, 1.0 - vAlong * vAlong, taper);
    if (a < 0.003) discard;
    gl_FragColor = vec4(color, a);
  }
`;

interface Layer {
  mesh: Mesh;
  material: ShaderMaterial;
  offset: Vector3;
  box: number;
  role: 'near' | 'mid' | 'far';
}

/** Aspetto per fase: caduta (m/s), larghezza (pixel), opacità, assottigliamento, densità relativa, scintillio. */
const LOOK: Record<Exclude<Phase, 'none'>, { fall: number; width: number; opacity: number; taper: number; tint: [number, number, number]; density: number; sparkle: number; minLen: number }> = {
  rain: { fall: 8.5, width: 2.4, opacity: 0.5, taper: 0.55, tint: [0.86, 0.9, 0.97], density: 1, sparkle: 0, minLen: 0.25 },
  mixed: { fall: 4.5, width: 2.6, opacity: 0.5, taper: 0.4, tint: [0.92, 0.95, 1.0], density: 0.85, sparkle: 0, minLen: 0.15 },
  graupel: { fall: 3.5, width: 3.0, opacity: 0.7, taper: 0.15, tint: [1.0, 1.0, 1.0], density: 0.5, sparkle: 0, minLen: 0.05 },
  snow: { fall: 1.0, width: 1.6, opacity: 0.45, taper: 0.1, tint: [1.0, 1.0, 1.0], density: 0.5, sparkle: 0.5, minLen: 0.03 },
  ice: { fall: 0.5, width: 2.4, opacity: 0.75, taper: 0.0, tint: [1.0, 0.98, 0.92], density: 0.35, sparkle: 1, minLen: 0.02 },
  hail: { fall: 16, width: 3.6, opacity: 0.9, taper: 0.2, tint: [1.0, 1.0, 1.0], density: 0.12, sparkle: 0, minLen: 0.3 },
};

export function createPrecip(scene: Scene, mobile: boolean) {
  const layers: Layer[] = [];
  const make = (count: number, box: number, role: Layer['role']) => {
    const g = new InstancedBufferGeometry();
    g.setAttribute('corner', new BufferAttribute(new Float32Array([-1, 0, 1, 0, 1, 1, -1, 0, 1, 1, -1, 1]), 2));
    g.setAttribute('position', new BufferAttribute(new Float32Array(18), 3));
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    g.setAttribute('seed', new InstancedBufferAttribute(seeds, 4));
    g.instanceCount = count;
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      // Il verso dei triangoli dipende dalla direzione della scia sullo schermo: niente eliminazione delle facce.
      side: DoubleSide,
      uniforms: {
        box: { value: box },
        offset: { value: new Vector3() },
        vel: { value: new Vector3() },
        streakTime: { value: 1 / 110 },
        maxLen: { value: box * 0.05 },
        minLen: { value: 0.2 },
        widthPx: { value: 1 },
        pixelSize: { value: 0.002 },
        density: { value: 0 },
        time: { value: 0 },
        sparkle: { value: 0 },
        color: { value: new Color() },
        opacity: { value: 0.3 },
        taper: { value: 0.6 },
      },
    });
    const mesh = new Mesh(g, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    scene.add(mesh);
    layers.push({ mesh, material, offset: new Vector3(), box, role });
  };
  make(mobile ? 250 : 600, 14, 'near');
  make(mobile ? 3000 : 8000, 50, 'mid');
  make(mobile ? 2000 : 5000, 220, 'far');
  const rel = new Vector3();
  const fall = new Vector3();
  const air = new Vector3();
  let quality = 1;
  let time = 0;
  /** Episodio di grandine in corso (0–1, decresce in ~0,6 s): più chicchi visibili, in sincronia con i colpi. */
  let burst = 0;
  /** Limite artistico del contributo della velocità della telecamera (m/s), vedi intestazione. */
  const MAX_AIR = 70;

  return {
    /** Fattore di quantità (prestazioni): 0–1, ridotto prima della qualità delle nubi. */
    setQuality(q: number) {
      quality = Math.min(1, Math.max(0.2, q));
    },
    get quality() {
      return quality;
    },
    /** Inizio di un episodio di grandine (chiamato insieme ai colpi sonori). */
    burst(level = 1) {
      burst = Math.min(1, burst + level);
    },
    update(dt: number, phase: Phase, intensity: number, windMs: Vector3, cameraVelMs: Vector3, up: Vector3, light: [number, number, number], camera: PerspectiveCamera, screenH: number, sunGlint = 1) {
      time += dt;
      burst = Math.max(0, burst - dt * 1.7);
      const visible = phase !== 'none' && intensity > 0.01;
      for (const l of layers) l.mesh.visible = visible;
      if (!visible) return;
      const look = LOOK[phase];
      fall.copy(up).multiplyScalar(-look.fall);
      air.copy(cameraVelMs);
      if (air.length() > MAX_AIR) air.setLength(MAX_AIR);
      rel.copy(windMs).add(fall).sub(air);
      const pixelSize = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, screenH);
      const lum = Math.min(0.95, 0.32 + 0.6 * Math.sqrt(Math.max(0, 0.2126 * light[0] + 0.7152 * light[1] + 0.0722 * light[2])));
      for (const l of layers) {
        l.offset.addScaledVector(rel, dt);
        l.offset.set(((l.offset.x % l.box) + l.box) % l.box, ((l.offset.y % l.box) + l.box) % l.box, ((l.offset.z % l.box) + l.box) % l.box);
        const u = l.material.uniforms;
        (u.offset!.value as Vector3).copy(l.offset);
        (u.vel!.value as Vector3).copy(rel);
        u.pixelSize!.value = pixelSize;
        u.time!.value = time;
        u.sparkle!.value = look.sparkle * sunGlint;
        u.minLen!.value = look.minLen * (l.role === 'near' ? 0.6 : l.role === 'far' ? 2 : 1);
        u.maxLen!.value = l.box * (l.role === 'near' ? 0.1 : 0.07);
        const k = l.role === 'near' ? { w: 2.6, o: 0.3, d: 0.8 } : l.role === 'mid' ? { w: 1, o: 1, d: 1 } : { w: 0.8, o: 0.5, d: 0.75 };
        u.widthPx!.value = look.width * k.w;
        // Grandine: pochi chicchi di fondo, molti durante l'episodio.
        const hailBoost = phase === 'hail' ? 0.3 + 5 * burst : 1;
        u.density!.value = Math.min(1, intensity * look.density * quality * k.d * hailBoost);
        u.opacity!.value = look.opacity * k.o;
        u.taper!.value = look.taper;
        (u.color!.value as Color).setRGB(look.tint[0] * lum, look.tint[1] * lum, look.tint[2] * lum);
      }
    },
    get counts() {
      return layers.map((l) => (l.mesh.geometry as InstancedBufferGeometry).instanceCount);
    },
    dispose() {
      for (const l of layers) {
        scene.remove(l.mesh);
        l.mesh.geometry.dispose();
        l.material.dispose();
      }
    },
  };
}

export type Precip = ReturnType<typeof createPrecip>;
