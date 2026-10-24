import {
  BufferAttribute,
  DoubleSide,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  Points,
  ShaderMaterial,
  type PerspectiveCamera,
} from 'three';
import { latLonToVector, vectorToLatLon, type Vec3 } from '../core/geo';
import { greatCircleKm, saffirSimpson, type StormTrack } from '../data/storm';

/**
 * Traccia del ciclone dalla best track NOAA (OSSERVATO; i tratti tra i punti sono interpolati).
 * Disegnata sopra le nuvole come sovrapposizione cartografica, ma nascosta sul lato opposto
 * del pianeta. Passato: linea piena colorata per categoria. Futuro: tratteggio tenue.
 */

/** Palette originale per categoria (depressione → categoria 5). */
export const CATEGORY_COLORS: Record<number, string> = {
  [-1]: '#8fb3cc',
  0: '#52c7a5',
  1: '#f3d34a',
  2: '#f6a623',
  3: '#f0702b',
  4: '#e5484d',
  5: '#d0349a',
};

export function categoryColor(windKt: number): string {
  return CATEGORY_COLORS[saffirSimpson(windKt)]!;
}

const SURFACE = 1.0004;
const SUBDIVISIONS = 12;

const ribbonVertex = /* glsl */ `
  attribute vec3 side;
  attribute float sideSign;
  attribute float hours;
  attribute float along;
  attribute vec3 color;
  uniform float halfWidth;

  varying float vHours;
  varying float vAlong;
  varying float vSide;
  varying vec3 vColor;
  varying vec3 vUp;
  varying vec3 vPositionW;

  void main() {
    vHours = hours;
    vAlong = along;
    vSide = sideSign;
    vColor = color;
    vUp = normalize(position);
    vec4 world = modelMatrix * vec4(position + side * sideSign * halfWidth, 1.0);
    vPositionW = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const ribbonFragment = /* glsl */ `
  uniform float currentHours;
  uniform float dashKm;

  varying float vHours;
  varying float vAlong;
  varying float vSide;
  varying vec3 vColor;
  varying vec3 vUp;
  varying vec3 vPositionW;

  void main() {
    // Nascosta oltre l'orizzonte del pianeta.
    if (dot(vUp, normalize(cameraPosition - vPositionW)) < 0.0) discard;
    bool future = vHours > currentHours + 0.01;
    if (future && fract(vAlong / dashKm) > 0.55) discard;
    float edge = 1.0 - smoothstep(0.6, 1.0, abs(vSide));
    vec3 c = future ? vec3(0.92, 0.95, 1.0) : vColor;
    float a = future ? 0.55 : 0.95;
    gl_FragColor = vec4(c, a * edge);
    #include <colorspace_fragment>
  }
`;

const pointVertex = /* glsl */ `
  attribute vec3 color;
  attribute float size;
  attribute float hours;
  uniform float pixelRatio;
  uniform float currentHours;

  varying vec3 vColor;
  varying float vVisible;
  varying float vFuture;

  void main() {
    vColor = color;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vVisible = dot(normalize(position), normalize(cameraPosition - world.xyz));
    vFuture = hours > currentHours + 0.01 ? 1.0 : 0.0;
    gl_Position = projectionMatrix * viewMatrix * world;
    gl_PointSize = size * pixelRatio;
  }
`;

const pointFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vVisible;
  varying float vFuture;

  void main() {
    if (vVisible < 0.0) discard;
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    float a = 1.0 - smoothstep(0.88, 1.0, r);
    float ring = smoothstep(0.62, 0.72, r);
    vec3 c;
    if (vFuture > 0.5) {
      // Punti futuri: cerchio chiaro vuoto.
      c = vec3(0.92, 0.95, 1.0);
      a *= ring * 0.75;
    } else {
      // Punti passati: disco colorato per categoria con bordo scuro.
      c = mix(vColor, vec3(0.05, 0.07, 0.12), ring);
    }
    gl_FragColor = vec4(c, a);
    #include <colorspace_fragment>
  }
`;

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function createTrackLayer(track: StormTrack, currentTime: Date, pixelRatio: number) {
  const t0 = Date.parse(track.points[0]!.time);
  const hoursOf = (iso: string) => (Date.parse(iso) - t0) / 3_600_000;
  const currentHours = (currentTime.getTime() - t0) / 3_600_000;

  // Densifica la traccia per seguire la curvatura terrestre.
  const samples: { pos: Vec3; hours: number; color: Color; along: number }[] = [];
  let along = 0;
  for (let i = 0; i < track.points.length - 1; i++) {
    const a = track.points[i]!;
    const b = track.points[i + 1]!;
    const color = new Color(categoryColor(Math.max(a.windKt, b.windKt)));
    for (let s = 0; s < SUBDIVISIONS; s++) {
      const f = s / SUBDIVISIONS;
      const lat = a.lat + (b.lat - a.lat) * f;
      const lon = a.lon + (b.lon - a.lon) * f;
      if (samples.length) along += greatCircleKm({ lat, lon }, vectorToLatLon(samples.at(-1)!.pos));
      samples.push({
        pos: latLonToVector(lat, lon, SURFACE),
        hours: hoursOf(a.time) + (hoursOf(b.time) - hoursOf(a.time)) * f,
        color,
        along,
      });
    }
  }
  const last = track.points.at(-1)!;
  along += greatCircleKm(last, vectorToLatLon(samples.at(-1)!.pos));
  samples.push({ pos: latLonToVector(last.lat, last.lon, SURFACE), hours: hoursOf(last.time), color: new Color(categoryColor(last.windKt)), along });

  // Nastro: due vertici per campione, spostati lateralmente nel piano tangente.
  const n = samples.length;
  const position = new Float32Array(n * 2 * 3);
  const side = new Float32Array(n * 2 * 3);
  const sideSign = new Float32Array(n * 2);
  const hours = new Float32Array(n * 2);
  const alongArr = new Float32Array(n * 2);
  const colors = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    const prev = samples[Math.max(0, i - 1)]!.pos;
    const next = samples[Math.min(n - 1, i + 1)]!.pos;
    const dir = normalize(sub(next, prev));
    const lateral = normalize(cross(normalize(s.pos), dir));
    for (let k = 0; k < 2; k++) {
      const j = i * 2 + k;
      position.set(s.pos, j * 3);
      side.set(lateral, j * 3);
      sideSign[j] = k === 0 ? -1 : 1;
      hours[j] = s.hours;
      alongArr[j] = s.along;
      colors.set([s.color.r, s.color.g, s.color.b], j * 3);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const ribbonGeometry = new BufferGeometry();
  ribbonGeometry.setAttribute('position', new BufferAttribute(position, 3));
  ribbonGeometry.setAttribute('side', new BufferAttribute(side, 3));
  ribbonGeometry.setAttribute('sideSign', new BufferAttribute(sideSign, 1));
  ribbonGeometry.setAttribute('hours', new BufferAttribute(hours, 1));
  ribbonGeometry.setAttribute('along', new BufferAttribute(alongArr, 1));
  ribbonGeometry.setAttribute('color', new BufferAttribute(colors, 3));
  ribbonGeometry.setIndex(index);

  const ribbonMaterial = new ShaderMaterial({
    vertexShader: ribbonVertex,
    fragmentShader: ribbonFragment,
    uniforms: {
      halfWidth: { value: 0.001 },
      currentHours: { value: currentHours },
      dashKm: { value: 40 },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
  const ribbon = new Mesh(ribbonGeometry, ribbonMaterial);
  ribbon.renderOrder = 3;
  ribbon.frustumCulled = false;

  // Punti della best track ogni 6 ore (più grandi per picco e landfall).
  const pts = track.points;
  const pPos = new Float32Array(pts.length * 3);
  const pColor = new Float32Array(pts.length * 3);
  const pSize = new Float32Array(pts.length);
  const pHours = new Float32Array(pts.length);
  pts.forEach((p, i) => {
    pPos.set(latLonToVector(p.lat, p.lon, SURFACE), i * 3);
    const c = new Color(categoryColor(p.windKt));
    pColor.set([c.r, c.g, c.b], i * 3);
    pSize[i] = p.record === 'L' || p.record === 'I' ? 13 : 8;
    pHours[i] = hoursOf(p.time);
  });
  const pointGeometry = new BufferGeometry();
  pointGeometry.setAttribute('position', new BufferAttribute(pPos, 3));
  pointGeometry.setAttribute('color', new BufferAttribute(pColor, 3));
  pointGeometry.setAttribute('size', new BufferAttribute(pSize, 1));
  pointGeometry.setAttribute('hours', new BufferAttribute(pHours, 1));
  const pointMaterial = new ShaderMaterial({
    vertexShader: pointVertex,
    fragmentShader: pointFragment,
    uniforms: { pixelRatio: { value: pixelRatio }, currentHours: { value: currentHours } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const points = new Points(pointGeometry, pointMaterial);
  points.renderOrder = 4;
  points.frustumCulled = false;

  const group = new Group();
  group.name = 'track';
  group.add(ribbon, points);

  return {
    group,
    /** Mantiene uno spessore costante sullo schermo al variare della distanza. */
    update(camera: PerspectiveCamera, distance: number) {
      const fov = (camera.fov * Math.PI) / 180;
      ribbonMaterial.uniforms.halfWidth!.value = Math.tan(fov / 2) * distance * 0.0055;
      ribbonMaterial.uniforms.dashKm!.value = Math.max(15, distance * 260);
    },
    setVisible(visible: boolean) {
      group.visible = visible;
    },
    dispose() {
      ribbonGeometry.dispose();
      ribbonMaterial.dispose();
      pointGeometry.dispose();
      pointMaterial.dispose();
    },
  };
}

