import { BackSide, Color, Mesh, PMREMGenerator, Scene, ShaderMaterial, SphereGeometry, Vector3, type Texture, type WebGLRenderer } from 'three';

/**
 * Cielo del crepuscolo (FLIGHT 2.0, originale): gradiente che dipende dalla direzione del Sole,
 * Sole basso con alone, qualche stella allo zenit. La stessa funzione GLSL serve al mare
 * (riflessi) e alla mappa d'ambiente per i vetri.
 */

/** Direzione del Sole: azimut verso ovest (−x), 3° sopra l'orizzonte. */
export const SUN_DIR = new Vector3(-Math.cos((3 * Math.PI) / 180), Math.sin((3 * Math.PI) / 180), -0.18).normalize();

export const skyGlsl = /* glsl */ `
  uniform vec3 sunDir;
  uniform float sunGain;

  vec3 skyColor(vec3 dir) {
    vec3 d = normalize(dir);
    float h = d.y;
    float toSun = max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(sunDir.x, 0.0, sunDir.z))), 0.0);
    // Orizzonte: arancio verso il Sole, rosa-viola altrove; zenit blu profondo.
    vec3 horizonSun = vec3(1.0, 0.52, 0.22);
    vec3 horizonAway = vec3(0.62, 0.34, 0.46);
    vec3 horizon = mix(horizonAway, horizonSun, pow(toSun, 3.0));
    vec3 mid = mix(vec3(0.24, 0.17, 0.34), vec3(0.55, 0.3, 0.32), pow(toSun, 4.0));
    vec3 zenith = vec3(0.04, 0.05, 0.14);
    vec3 c = mix(horizon, mid, smoothstep(0.0, 0.1, h));
    c *= 0.8;
    c = mix(c, zenith, smoothstep(0.06, 0.5, h));
    // Sotto l'orizzonte: foschia scura (il mare e la città coprono comunque).
    c = mix(c, vec3(0.16, 0.11, 0.15), smoothstep(0.0, -0.08, h));
    // Sole: disco e alone.
    float s = max(dot(d, normalize(sunDir)), 0.0);
    c += vec3(1.0, 0.75, 0.45) * pow(s, 2400.0) * 10.0 * sunGain;
    c += vec3(1.0, 0.55, 0.25) * (pow(s, 80.0) * 0.7 * sunGain + pow(s, 8.0) * 0.22);
    return c;
  }
`;

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vDir;
  uniform float stars;
  ${skyGlsl}
  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  void main() {
    vec3 d = normalize(vDir);
    vec3 c = skyColor(d);
    // Stelle: solo in alto e lontano dal Sole.
    vec3 cell = floor(d * 420.0);
    float st = step(0.9975, hash13(cell)) * smoothstep(0.25, 0.7, d.y) * stars;
    c += vec3(st) * 1.5;
    gl_FragColor = vec4(c, 1.0);
  }
`;

export function createSky(): { mesh: Mesh; material: ShaderMaterial } {
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { sunDir: { value: SUN_DIR }, stars: { value: 1 }, sunGain: { value: 1 } },
    side: BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new Mesh(new SphereGeometry(1, 48, 24), material);
  mesh.scale.setScalar(9000);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return { mesh, material };
}

/** Mappa d'ambiente dal cielo (senza stelle): riflessi dei vetri e dell'asfalto. */
export function skyEnvironment(renderer: WebGLRenderer, options: { sunGain?: number } = {}): Texture {
  const { mesh, material } = createSky();
  material.uniforms.stars!.value = 0;
  // Senza (o con poco) disco solare: riflessi controllati sulle superfici lucide del velivolo.
  material.uniforms.sunGain!.value = options.sunGain ?? 1;
  const scene = new Scene();
  scene.add(mesh);
  scene.background = new Color(0x000000);
  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(scene, 0, 1, 20000).texture;
  pmrem.dispose();
  // La sfera usata solo per generare l'ambiente non serve più.
  mesh.geometry.dispose();
  material.dispose();
  return env;
}
