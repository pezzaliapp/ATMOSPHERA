import {
  ACESFilmicToneMapping,
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  NoToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { createAircraft } from '../../src/flight/aircraft';
import type { ProbeResult } from './probe';

/**
 * Il velivolo Concept C di CITY FLIGHT (stesso modulo, nessuna modifica) disegnato sopra l'immagine delle
 * nubi, in una scena propria in metri centrata sulla telecamera (niente imprecisioni a centinaia di km
 * dall'origine). Luce del Sole filtrata dalle nubi, cielo e luce diffusa dalla sonda; nebbia tra telecamera
 * e velivolo quando si è dentro una nube.
 */

const envVertex = /* glsl */ `
  varying vec3 vDir;
  void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
/** Ambiente di mezzogiorno per i riflessi della grafite: cielo blu, orizzonte chiaro, mare scuro. */
const envFragment = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 sunDir;
  void main() {
    vec3 d = normalize(vDir);
    vec3 sky = mix(vec3(0.75, 0.82, 0.92), vec3(0.18, 0.32, 0.62), smoothstep(0.0, 0.6, d.y));
    vec3 sea = mix(vec3(0.5, 0.56, 0.62), vec3(0.03, 0.08, 0.13), smoothstep(0.0, -0.3, d.y));
    vec3 c = d.y > 0.0 ? sky : sea;
    c += vec3(1.0, 0.95, 0.85) * pow(max(dot(d, sunDir), 0.0), 600.0) * 30.0;
    gl_FragColor = vec4(c, 1.0);
  }
`;

export function createAircraftView(renderer: WebGLRenderer, sunDir: Vector3) {
  // Mappa d'ambiente generata una volta.
  const pmrem = new PMREMGenerator(renderer);
  const envScene = new Scene();
  const envMesh = new Mesh(new SphereGeometry(10, 32, 16), new ShaderMaterial({ vertexShader: envVertex, fragmentShader: envFragment, uniforms: { sunDir: { value: sunDir.clone() } }, side: BackSide }));
  envScene.add(envMesh);
  const envTarget = pmrem.fromScene(envScene, 0, 0.1, 100);
  const env: Texture = envTarget.texture;
  envMesh.geometry.dispose();
  (envMesh.material as ShaderMaterial).dispose();
  pmrem.dispose();

  const aircraft = createAircraft(env);
  const scene = new Scene();
  scene.add(aircraft.group);
  const camera = new PerspectiveCamera(60, 1, 0.3, 5000);
  const sun = new DirectionalLight(new Color(1, 0.96, 0.9), 3);
  sun.position.copy(sunDir).multiplyScalar(100);
  const hemi = new HemisphereLight(new Color(0.45, 0.6, 0.95), new Color(0.05, 0.1, 0.16), 0.9);
  const cloudLight = new AmbientLight(new Color(1, 1, 1), 0);
  scene.add(sun, sun.target, hemi, cloudLight);
  const fog = new FogExp2(new Color(1, 1, 1), 0);
  scene.fog = fog;
  scene.environment = env;
  scene.environmentIntensity = 0.6;

  // Lampo: luce breve e diffusa da una direzione casuale (intensità limitata, nessun effetto stroboscopico).
  const flashLight = new DirectionalLight(new Color(0.85, 0.9, 1.0), 0);
  scene.add(flashLight);
  // S2.5: canali dei fulmini in una scena propria (fino a ~80 km), disegnati prima del velivolo.
  const boltScene = new Scene();
  const boltCamera = new PerspectiveCamera(60, 1, 5, 120000);
  const rel = new Vector3();
  const vib = new Vector3();
  return {
    aircraft,
    scene,
    camera,
    boltScene,
    /** Lampo: intensità 0–1 e direzione (assi della scena). */
    setFlash(level: number, dir?: Vector3) {
      flashLight.intensity = 6 * level;
      if (dir) flashLight.position.copy(dir).multiplyScalar(100);
    },
    /**
     * Prepara la scena: posizioni in km nel piano della tempesta, la telecamera diventa l'origine.
     * Il modello usa i metri.
     */
    update(aircraftKm: Vector3, attitude: Quaternion, stormCamera: PerspectiveCamera, probe: ProbeResult, t: number, dt: number, power: number, vibration = 0, rainExt = 0) {
      rel.subVectors(aircraftKm, stormCamera.position).multiplyScalar(1000);
      // Vibrazione visiva del velivolo in turbolenza: pochi centimetri, alta frequenza (disattivabile).
      vib.set(Math.sin(t * 37.1) + 0.5 * Math.sin(t * 59.3), Math.sin(t * 43.7 + 1.1) + 0.5 * Math.sin(t * 71.9), 0).multiplyScalar(0.035 * vibration);
      aircraft.group.position.copy(rel).add(vib);
      aircraft.group.quaternion.copy(attitude);
      aircraft.update(t, dt, power);
      camera.position.set(0, 0, 0);
      camera.quaternion.copy(stormCamera.quaternion);
      camera.fov = stormCamera.fov;
      camera.aspect = stormCamera.aspect;
      camera.updateProjectionMatrix();
      boltCamera.quaternion.copy(stormCamera.quaternion);
      boltCamera.fov = stormCamera.fov;
      boltCamera.aspect = stormCamera.aspect;
      boltCamera.updateProjectionMatrix();
      // Luce: Sole attraverso le nubi, cielo visibile, luce diffusa della nube (sonda).
      sun.intensity = 3.2 * probe.sunT;
      hemi.intensity = 0.25 + 0.65 * probe.skyVis;
      const [r, g, b] = probe.radiance;
      const inCloud = 1 - Math.exp(-probe.sigmaAircraft * 0.05);
      cloudLight.color.setRGB(r, g, b);
      cloudLight.intensity = 0.8 * inCloud;
      // Nebbia tra telecamera e velivolo: trasmittanza exp(−σ·d) alla distanza della telecamera
      // (FogExp2 usa exp(−(ρ·d)²): ρ scelto per coincidere a quella distanza).
      const d = Math.max(1, rel.length());
      const sigma = (0.5 * (probe.sigmaAircraft + probe.sigmaCamera) + rainExt) / 1000;
      fog.density = Math.sqrt((sigma * d) / (d * d));
      fog.color.setRGB(r, g, b);
    },
    render(exposure: number) {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.toneMapping = ACESFilmicToneMapping;
      renderer.toneMappingExposure = exposure * 1.15;
      renderer.setRenderTarget(null);
      if (boltScene.children.some((o) => o.visible)) renderer.render(boltScene, boltCamera);
      renderer.render(scene, camera);
      renderer.toneMapping = NoToneMapping;
    },
    dispose() {
      aircraft.dispose();
      envTarget.dispose();
      scene.clear();
    },
  };
}

export type AircraftView = ReturnType<typeof createAircraftView>;
