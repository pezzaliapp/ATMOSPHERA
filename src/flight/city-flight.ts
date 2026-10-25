import './city-flight.css';
import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  FogExp2,
  HalfFloatType,
  HemisphereLight,
  Mesh,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SpotLight,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  type Material,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createAircraft } from './aircraft';
import { createBlock } from './block';
import { COAST_X, createCity } from './city';
import { createOutskirts } from './outskirts';
import { startPilot } from './pilot/pilot';
import { createSea } from './sea';
import { SUN_DIR, createSky, skyEnvironment } from './sky';
import { createUniverse } from './universe/universe';

/**
 * CITY FLIGHT — simulatore di volo sopra una città dimostrativa al crepuscolo, con APP UNIVERSE.
 * Modulo caricato solo quando si entra (import dinamico): crea il proprio renderer e alla chiusura
 * libera GPU, memoria, ascoltatori e app incorporate. Simulazione semplificata, non aerodinamica reale.
 */

export interface CityFlight {
  dispose(): void;
}

export interface CityFlightOptions {
  /** «Torna ad ATMOSPHERA». */
  onExit(): void;
}

const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>';

/**
 * Un solo renderer (e contesto WebGL) per tutta la sessione, creato al primo ingresso e riusato.
 * three.js aggancia ascoltatori di ogni renderer alle proprie texture interne condivise e non li rilascia:
 * un renderer nuovo a ogni ingresso resterebbe trattenuto con il suo contesto (WebKit ne conserva le risorse).
 * All'uscita si liberano scena, texture e buffer; il contesto resta, vuoto, pronto per il volo successivo.
 */
let shared: { renderer: WebGLRenderer; canvas: HTMLCanvasElement; mobile: boolean } | null = null;
function sharedRenderer() {
  if (shared) return shared;
  const mobile = matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 900;
  const canvas = document.createElement('canvas');
  canvas.className = 'cf-scene';
  canvas.setAttribute('aria-label', 'Volo sopra la città dimostrativa al crepuscolo');
  const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.5 : 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  shared = { renderer, canvas, mobile };
  return shared;
}

export function startCityFlight(host: HTMLElement, options: CityFlightOptions): CityFlight {
  const listeners = new AbortController();
  const root = document.createElement('div');
  root.className = 'cf-root';
  const { renderer, canvas, mobile } = sharedRenderer();
  root.append(canvas);
  host.append(root);

  const scene = new Scene();
  scene.fog = new FogExp2(new Color(0.27, 0.16, 0.18), 0.00018);
  const camera = new PerspectiveCamera(55, 1, 0.5, 20000);

  const env = skyEnvironment(renderer);
  scene.environment = env;
  scene.environmentIntensity = 0.3;
  const sky = createSky();
  scene.add(sky.mesh);

  // Luce del crepuscolo: Sole radente arancio, cielo viola, rimbalzo caldo dal basso.
  const sun = new DirectionalLight(new Color(1.0, 0.5, 0.26), 0.55);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -420, right: 420, top: 420, bottom: -420, near: 10, far: 3000 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 1.2;
  sun.position.copy(SUN_DIR).multiplyScalar(1500);
  sun.target.position.set(80, 0, 0);
  scene.add(sun, sun.target);
  scene.add(new HemisphereLight(new Color(0.35, 0.33, 0.6), new Color(0.16, 0.1, 0.08), 0.2));

  const block = createBlock(env);
  scene.add(block.group);
  const city = createCity(env, { trafficDensity: mobile ? 0.45 : 1 });
  scene.add(city.group);
  const sea = createSea(COAST_X);
  scene.add(sea.group);
  scene.add(createOutskirts(COAST_X, 11.5 * 134, 13.5 * 134));

  // Velivolo (Concept C) sulla piattaforma della torre, con i due fari della piattaforma.
  const objectEnv = skyEnvironment(renderer, { sunGain: 0.08 });
  const vtol = createAircraft(objectEnv);
  const pad = block.pad;
  vtol.group.position.set(pad.x, pad.y + 0.005, pad.z);
  vtol.group.rotation.y = Math.PI / 2 - 0.4;
  scene.add(vtol.group);
  for (const [color, intensity, from] of [
    [new Color(1.0, 0.86, 0.68), 320, new Vector3(pad.x + 11, pad.y + 9, pad.z + 7)],
    [new Color(0.7, 0.82, 1.0), 160, new Vector3(pad.x - 9, pad.y + 8, pad.z - 10)],
  ] as const) {
    const l = new SpotLight(color, intensity, 0, Math.PI / 5, 0.6, 2);
    l.position.copy(from);
    l.target.position.set(pad.x, pad.y + 0.8, pad.z);
    l.castShadow = true;
    l.shadow.mapSize.set(1024, 1024);
    l.shadow.bias = -0.0002;
    l.shadow.camera.near = 2;
    l.shadow.camera.far = 60;
    scene.add(l, l.target);
  }

  // Post-elaborazione: MSAA 4× (desktop), bagliore delle luci, tone mapping e colore in uscita.
  const size = new Vector2();
  renderer.getDrawingBufferSize(size);
  const target = new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType, samples: mobile ? 0 : 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(size.x / 2, size.y / 2), 0.55, 0.45, 1.05);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 2;
  controls.maxDistance = 3500;

  const volumes = [...block.volumes, ...city.volumes];
  const universe = createUniverse({ scene, camera, canvas, root, env: objectEnv, volumes, signal: listeners.signal });
  const pilot = startPilot({
    scene,
    camera,
    canvas,
    controls,
    root,
    aircraft: vtol,
    pad,
    volumes,
    coastX: COAST_X,
    parkedHeading: Math.PI / 2 - 0.4,
    spheres: universe.obstacles,
    signal: listeners.signal,
  });
  universe.bind(pilot.api);

  // «Torna ad ATMOSPHERA»: accanto al titolo, sempre visibile.
  const brand = root.querySelector('.pl-brand');
  const title = brand?.querySelector('b');
  if (title) title.textContent = 'CITY FLIGHT';
  const exit = document.createElement('button');
  exit.type = 'button';
  exit.className = 'cf-exit';
  exit.setAttribute('aria-label', 'Torna ad ATMOSPHERA');
  exit.title = 'Torna ad ATMOSPHERA';
  exit.innerHTML = `${ICON_BACK}<span>ATMOSPHERA</span>`;
  exit.addEventListener('click', () => options.onExit());
  const head = document.createElement('div');
  head.className = 'cf-head';
  if (brand && title) {
    brand.prepend(head);
    head.append(exit, title);
  }

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  let frame = 0;
  let last = performance.now();
  let simTime = 0;
  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!pilot.paused) simTime += dt;
    const t = simTime;
    const driven = pilot.update(dt, t);
    if (!driven) controls.update();
    universe.update(pilot.paused ? 0 : dt, t);
    sky.mesh.position.copy(camera.position);
    for (const m of city.timed) m.uniforms.uTime.value = t;
    sea.material.uniforms.uTime!.value = t;
    // Luci di segnalazione: lampeggio lento e sfalsato.
    const on = t % 1.6 < 0.7 ? 1 : 0.06;
    block.beacons.color.setRGB(4 * on, 0.25 * on, 0.15 * on);
    const on2 = (t + 0.8) % 1.6 < 0.7 ? 1 : 0.06;
    city.beacons.color.setRGB(4 * on2, 0.25 * on2, 0.15 * on2);
    composer.render();
  };
  // Nessun rendering a scheda nascosta.
  const onVisibility = () => {
    cancelAnimationFrame(frame);
    if (!document.hidden) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };
  document.addEventListener('visibilitychange', onVisibility, { signal: listeners.signal });
  frame = requestAnimationFrame(tick);

  // Solo in sviluppo: comandi per le verifiche automatiche (assenti dalla build pubblicata).
  if (import.meta.env.DEV) Object.assign(window, { __pilot: pilot.api, __universe: universe.api });

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      // Motivo semplice: un'eccezione come motivo conserverebbe lo stack (e con esso le chiusure del simulatore).
      listeners.abort('city-flight-closed');
      observer.disconnect();
      controls.dispose();
      // Prima le app incorporate e le interfacce, poi tutta la GPU.
      universe.dispose();
      pilot.dispose();
      const textures = new Set<Texture>([env, objectEnv]);
      const materials = new Set<Material>();
      scene.traverse((o) => {
        const mesh = o as Mesh;
        mesh.geometry?.dispose();
        const m = mesh.material;
        if (m) for (const mat of Array.isArray(m) ? m : [m]) materials.add(mat);
        const shadow = (o as DirectionalLight).shadow;
        shadow?.map?.dispose();
      });
      for (const mat of materials) {
        for (const value of Object.values(mat)) if (value instanceof Texture) textures.add(value);
        const uniforms = (mat as Material & { uniforms?: Record<string, { value: unknown }> }).uniforms;
        if (uniforms) for (const u of Object.values(uniforms)) if (u.value instanceof Texture) textures.add(u.value);
        mat.dispose();
      }
      for (const tex of textures) tex.dispose();
      bloom.dispose();
      composer.dispose();
      target.dispose();
      // Il renderer condiviso resta: si svuotano liste e stato e il buffer di disegno torna minimo.
      renderer.setRenderTarget(null);
      renderer.renderLists.dispose();
      renderer.info.reset();
      canvas.remove();
      renderer.setSize(1, 1, false);
      if (import.meta.env.DEV) Object.assign(window, { __pilot: undefined, __universe: undefined });
      root.remove();
    },
  };
}
