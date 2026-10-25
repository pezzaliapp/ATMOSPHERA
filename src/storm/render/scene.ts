import {
  BufferAttribute,
  BufferGeometry,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PerspectiveCamera,
  RawShaderMaterial,
  RepeatWrapping,
  Scene,
  Vector2,
  Vector3,
  WebGL3DRenderTarget,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { median, nextVolumeScale } from '../../volume/adaptive';
import type { MiltonState } from './milton';
import { cloudFragment, compositeFragment, fullscreenVertex, noiseFragment, oceanFragment, reconFragment, waveFragment } from './shaders';
import { VIEWS, VIEWS_S1, cameraPosition, cloneState, makeTransition, type CameraState, type ViewName } from './views';

const RE = 6371;
const NOISE_SIZE = 64;
const FLOW_PERIOD = 14;
/** Posizione del pixel tracciato in ogni blocco N×N, a rotazione: ogni pixel si aggiorna ogni N² frame. */
const TRACE_ORDER: Record<number, readonly (readonly [number, number])[]> = {
  2: [[0, 0], [1, 1], [1, 0], [0, 1]],
  3: [[0, 0], [2, 2], [0, 2], [2, 0], [1, 1], [0, 1], [2, 1], [1, 0], [1, 2]],
};

export interface StormQuality {
  mobile: boolean;
  /** Risoluzione fissa della ricostruzione delle nubi (frazione), altrimenti adattiva. */
  fixedScale?: number;
  /** Diagnostica: 1 oceano, 2 luce delle nubi, 3 trasparenza delle nubi. */
  debug?: number;
  /** Telecamere della Fase S1 (confronti prima/dopo). */
  camsS1?: boolean;
  /** Lato del blocco di ricostruzione (2: un pixel tracciato su 4 per frame; 3: uno su 9). */
  stride?: number;
  /** In movimento, peso del frame corrente nei pixel non aggiornati (0,25 di base; più alto in volo). */
  motionBlend?: number;
  /** In movimento, peso dell'interpolazione anche nei pixel con campione nuovo (0 nella S1.1). */
  motionSmooth?: number;
  /** S2.1: movimento stimato dalla parallasse (errore di riproiezione) invece che dallo spostamento. */
  parallaxMode?: boolean;
  /** Disegno aggiuntivo sopra l'immagine finale (STORM FLIGHT S2: il velivolo). */
  overlay?: () => void;
}

/** Telecamera guidata dall'esterno (pilotaggio S2): posizione e punto osservato in km. */
export interface StormPose {
  pos: Vector3;
  look: Vector3;
  up: Vector3;
  /** Campo visivo verticale, gradi (già adattato all'orientamento dello schermo). */
  fov: number;
  rate: number;
  exposure: number;
  /** 0–1: movimento rapido (riduce l'accumulo temporale). */
  fast?: number;
}

export interface StormStats {
  view: ViewName;
  transitioning: boolean;
  /** Risoluzione della ricostruzione delle nubi (frazione dello schermo); si traccia 1 pixel ogni 4. */
  cloudScale: number;
  maxSteps: number;
  intervalMs: number | null;
  fps: number | null;
  cameraAltKm: number;
  rate: number;
}

export function createStormScene(renderer: WebGLRenderer, milton: MiltonState, quality: StormQuality) {
  const listeners = new AbortController();
  const canvas = renderer.domElement;
  const views = quality.camsS1 ? VIEWS_S1 : VIEWS;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new Mesh(geometry);
  quad.frustumCulled = false;
  const quadScene = new Scene();
  quadScene.add(quad);
  const draw = (material: RawShaderMaterial, target: WebGLRenderTarget | WebGL3DRenderTarget | null, layer = 0) => {
    quad.material = material;
    renderer.setRenderTarget(target, layer);
    renderer.render(quadScene, quadCamera);
  };
  const raw = (fragmentShader: string, uniforms: Record<string, { value: unknown }>, vertexShader = fullscreenVertex) =>
    new RawShaderMaterial({ glslVersion: GLSL3, vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false });

  // Texture procedurali, generate una volta sulla GPU.
  const simpleVertex = /* glsl */ `
    in vec3 position;
    out vec2 vUv;
    void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `;
  const noise = new WebGL3DRenderTarget(NOISE_SIZE, NOISE_SIZE, NOISE_SIZE, { depthBuffer: false });
  noise.texture.minFilter = noise.texture.magFilter = LinearFilter;
  noise.texture.wrapS = noise.texture.wrapT = noise.texture.wrapR = RepeatWrapping;
  const noiseMaterial = raw(noiseFragment, { layer: { value: 0 }, size: { value: NOISE_SIZE } }, simpleVertex);
  for (let z = 0; z < NOISE_SIZE; z++) {
    noiseMaterial.uniforms.layer!.value = z;
    draw(noiseMaterial, noise, z);
  }
  noiseMaterial.dispose();
  const waves = new WebGLRenderTarget(256, 256, { depthBuffer: false, generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, wrapS: RepeatWrapping, wrapT: RepeatWrapping });
  const waveMaterial = raw(waveFragment, {}, simpleVertex);
  draw(waveMaterial, waves);
  waveMaterial.dispose();

  const camera = new PerspectiveCamera(50, 1, 0.01, 1e5);
  const shared = {
    stormMap: { value: milton.map },
    noiseTex: { value: noise.texture },
    sunDir: { value: milton.sun.clone() },
    cameraPos: { value: new Vector3() },
    cameraAlt: { value: 0 },
    mapAngle: { value: 0 },
    coreAngle: { value: 0 },
    rmw: { value: milton.rmwKm },
    vmax: { value: milton.vmaxMs },
    rate: { value: 1 },
    flowPhase: { value: new Vector2() },
    flowWeight: { value: new Vector2(0.5, 0.5) },
    flowOffset0: { value: new Vector3() },
    flowOffset1: { value: new Vector3() },
    frame: { value: 0 },
    interiorLight: { value: 0 },
    farReuse: { value: 0 },
    s23Vis: { value: 0 },
    rainRange: { value: 25 },
    s25Waves: { value: 0 },
    s251Ocean: { value: 0 },
    flashPos: { value: new Vector3() },
    flashPower: { value: 0 },
    flashRange: { value: 3 },
    fogJitter: { value: 0 },
    fineFade: { value: new Vector2(0.03, 0.12) },
    erodeFade: { value: new Vector2(1e3, 2e3) },
    s21Flags: { value: 0 },
    farLod: { value: new Vector2(0, 0) },
    staticFlow: { value: 0 },
    rainExt: { value: 0 },
    rainColor: { value: new Vector3(0.3, 0.32, 0.36) },
    projectionInverse: { value: camera.projectionMatrixInverse },
    cameraWorld: { value: camera.matrixWorld },
  };
  const ocean = raw(oceanFragment, { ...shared, waveTex: { value: waves.texture }, time: { value: 0 }, pixelAngle: { value: 0.001 } });
  let stride = quality.stride ?? 3;
  const clouds = raw(cloudFragment, { ...shared, pixelAngle: { value: 0.001 }, maxSteps: { value: quality.mobile ? 96 : 144 }, reconSize: { value: new Vector2() }, traceOffset: { value: new Vector2() }, traceStride: { value: stride } });
  const prevViewProj = new Matrix4();
  const recon = raw(reconFragment, {
    traceColor: { value: null }, traceDepth: { value: null }, history: { value: null },
    prevViewProj: { value: prevViewProj }, cameraPos: shared.cameraPos, traceOffset: clouds.uniforms.traceOffset!, traceStride: clouds.uniforms.traceStride!,
    reconSize: clouds.uniforms.reconSize!, historyValid: { value: 0 }, alphaNew: { value: 0.3 }, clampAmount: { value: 1 }, motionBlend: { value: quality.motionBlend ?? 0.25 }, motionSmooth: { value: quality.motionSmooth ?? 0 }, parallaxMode: { value: quality.parallaxMode ? 1 : 0 }, fogJitter: shared.fogJitter, fastMotion: { value: 0 }, s23Fix: { value: 0 }, cameraAlt: shared.cameraAlt, reconDiag: { value: +(new URLSearchParams(location.search).get('recondiag') || (new URLSearchParams(location.search).has('recondiag') ? 1 : 0)) },
    projectionInverse: shared.projectionInverse, cameraWorld: shared.cameraWorld,
  });
  const composite = raw(compositeFragment, { oceanTex: { value: null }, cloudTex: { value: null }, exposure: { value: 1 }, frame: { value: 0 }, debugMode: { value: quality.debug ?? 0 }, flash: { value: 0 }, flashNdc: { value: new Vector3() }, flashSize: { value: 0.1 }, flashGlow: { value: 0 }, aspect: { value: 1 } }, simpleVertex);

  const rtOptions = { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter } as const;
  const oceanRT = new WebGLRenderTarget(1, 1, rtOptions);
  // Campioni del frame: luce e trasmittanza delle nubi (0), distanza rappresentativa (1).
  const traceRT = new WebGLRenderTarget(1, 1, { ...rtOptions, count: 2 });
  traceRT.textures[1]!.minFilter = traceRT.textures[1]!.magFilter = NearestFilter;
  const reconRT = [new WebGLRenderTarget(1, 1, rtOptions), new WebGLRenderTarget(1, 1, rtOptions)] as const;
  let ping = 0;

  const minScale = quality.mobile ? 0.55 : 0.6;
  const maxScale = 1.0;
  let cloudScale = quality.fixedScale ?? (quality.mobile ? 0.8 : 1.0);
  let scaleCap = maxScale;
  const size = new Vector2();
  let reconW = 0;
  let reconH = 0;
  let historyValid = false;

  const resize = () => {
    renderer.getDrawingBufferSize(size);
    if (oceanRT.width !== size.x || oceanRT.height !== size.y) oceanRT.setSize(size.x, size.y);
    reconW = Math.max(2, Math.round(size.x * cloudScale));
    reconH = Math.max(2, Math.round(size.y * cloudScale));
    const tw = Math.ceil(reconW / stride);
    const th = Math.ceil(reconH / stride);
    if (traceRT.width !== tw || traceRT.height !== th) traceRT.setSize(tw, th);
  };

  // Camera e punti di vista.
  let view: ViewName = 'panorama';
  let state = cloneState(views.panorama);
  let base = cloneState(views.panorama);
  let transition: ReturnType<typeof makeTransition> | null = null;
  let transitionTime = 0;
  let viewChange = 1;
  const forward = new Vector3();
  const prevForward = new Vector3();
  const prevPos = new Vector3();

  // Telecamera esterna (S2): se presente sostituisce punti di vista e transizioni.
  let pose: StormPose | null = null;
  const setView = (next: ViewName) => {
    if (next === view && !transition) return;
    transition = makeTransition(state, next, transition ? null : view, views);
    transitionTime = 0;
    view = next;
    base = cloneState(views[next]);
  };

  // Osservazione: trascinare per ruotare (attorno al punto osservato; nell'occhio, guardarsi attorno),
  // rotella o pizzico per la distanza, entro limiti per vista.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const limits = () =>
    view === 'eye'
      ? { el: [-0.75, 0.6], dist: [2.5, 6] }
      : view === 'approach'
        ? { el: [0.25, 1.25], dist: [26, 110] }
        : { el: [0.75, 1.5], dist: [700, 1700] };
  const orbit = (dx: number, dy: number) => {
    if (transition) return;
    const k = view === 'eye' ? 0.0035 : 0.004;
    state.azimuth -= dx * k;
    const l = limits();
    state.elevation = Math.min(l.el[1]!, Math.max(l.el[0]!, state.elevation + dy * k * (view === 'eye' ? -1 : 1)));
  };
  const zoom = (factor: number) => {
    if (transition) return;
    const l = limits();
    state.distance = Math.min(l.dist[1]!, Math.max(l.dist[0]!, state.distance * factor));
  };
  const opts = { signal: listeners.signal };
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
  }, opts);
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) orbit(e.clientX - p.x, e.clientY - p.y);
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinch) zoom(pinch / d);
      pinch = d;
    }
  }, opts);
  const release = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinch = 0;
  };
  canvas.addEventListener('pointerup', release, opts);
  canvas.addEventListener('pointercancel', release, opts);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom(Math.exp(e.deltaY * 0.0012));
  }, { signal: listeners.signal, passive: false });

  // Tempo delle nubi.
  let visualTime = 0;
  let frame = 0;
  const intervals: number[] = [];
  let lastAdapt = 0;
  let slowUntil = 0;
  const windAt = (r: number) => (r < milton.rmwKm ? (milton.vmaxMs * r) / milton.rmwKm : milton.vmaxMs * Math.pow(milton.rmwKm / r, 0.55));
  const mapOmega = (windAt(150) * 1e-3) / 150;
  const hash = (n: number) => {
    const s = Math.sin(n * 91.345 + 7.13) * 43758.5453;
    return s - Math.floor(s);
  };

  const applyCamera = (s: CameraState) => {
    cameraPosition(s, camera.position);
    camera.up.set(0, 1, 0);
    // Vista quasi verticale: «alto» dello schermo verso nord.
    if (Math.abs(Math.sin(s.elevation)) > 0.995) camera.up.set(0, 0, -1);
    camera.lookAt(s.target);
    // Il campo visivo è definito per uno schermo 16:10: in verticale si allarga per conservare
    // la stessa ampiezza orizzontale (la spirale resta intera sul telefono).
    const aspect = size.x / Math.max(1, size.y);
    const ref = 1.6;
    const tanH = Math.tan((s.fov * Math.PI) / 360) * Math.max(1, ref / aspect) ** 0.75;
    camera.fov = Math.min(100, (Math.atan(tanH) * 360) / Math.PI);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  };

  return {
    camera,
    get view() {
      return view;
    },
    setView,
    /** Solo laboratorio: fissa la telecamera della vista corrente (distanza, azimut°, elevazione°, fov, target). */
    setCamera([distance, az, el, fov, tx, ty, tz]: number[]) {
      transition = null;
      const deg = Math.PI / 180;
      base = { ...cloneState(views[view]), distance: distance!, azimuth: az! * deg, elevation: el! * deg, fov: fov!, target: new Vector3(tx, ty, tz) };
      state = cloneState(base);
    },

    /** Lato del blocco di ricostruzione (S2: 2 dentro le nubi, 3 fuori); la storia resta valida. */
    setStride(next: number) {
      if (next === stride || !TRACE_ORDER[next]) return;
      stride = next;
      clouds.uniforms.traceStride!.value = next;
    },
    /** Telecamera guidata dall'esterno (S2); null torna ai punti di vista. */
    setPose(next: StormPose | null) {
      pose = next;
    },
    /** Per i moduli del laboratorio che aggiungono passate con gli stessi dati (S2: sonda nelle nubi). */
    internals: { shared, draw, raw, composite, recon },

    update(dt: number, now: number) {
      resize();
      if (pose) {
        camera.position.copy(pose.pos);
        camera.up.copy(pose.up);
        camera.lookAt(pose.look);
        camera.fov = pose.fov;
        camera.aspect = size.x / Math.max(1, size.y);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
      } else if (transition) {
        transitionTime += dt;
        state = transition.at(transitionTime);
        if (transitionTime >= transition.total) {
          transition = null;
          state = cloneState(base);
        }
      }
      if (!pose) applyCamera(state);
      // Quanto è cambiata la vista dall'ultimo frame (spostamento relativo + rotazione).
      // Con la telecamera esterna (S2) il punto osservato è il velivolo, a pochi metri: per le nubi conta una
      // distanza tipica (~2 km); la parallasse delle nubi vicine è gestita pixel per pixel nella ricostruzione.
      const toTarget = pose ? 2 : Math.max(0.01, camera.position.distanceTo(state.target));
      camera.getWorldDirection(forward);
      // Stacco della telecamera esterna (CINEMA, dissolvenze, prove): l'immagine precedente non è riproiettabile.
      if (pose && camera.position.distanceTo(prevPos) > 2) historyValid = false;
      // Allontanamento rapido verso un punto lontano (finale di CINEMA): spostamento > 3% della distanza.
      if (pose) {
        const lookDist = camera.position.distanceTo(pose.look);
        if (lookDist > 1 && camera.position.distanceTo(prevPos) > 0.03 * lookDist) historyValid = false;
        recon.uniforms.fastMotion!.value = pose.fast ?? 0;
      }
      viewChange = camera.position.distanceTo(prevPos) / toTarget + forward.angleTo(prevForward) * 6;
      prevForward.copy(forward);
      prevPos.copy(camera.position);

      const rate = pose ? pose.rate : state.rate;
      visualTime += dt;
      shared.mapAngle.value += dt * Math.min(rate * mapOmega, 0.012);
      shared.coreAngle.value += dt * Math.min(rate * (milton.vmaxMs * 1e-3) / milton.rmwKm * 0.5, 0.03);
      shared.rate.value = rate;
      const cycle = visualTime / FLOW_PERIOD;
      const f0 = cycle - Math.floor(cycle);
      const f1 = cycle + 0.5 - Math.floor(cycle + 0.5);
      shared.flowPhase.value.set(f0 * FLOW_PERIOD, f1 * FLOW_PERIOD);
      const w0 = 1 - Math.abs(2 * f0 - 1);
      shared.flowWeight.value.set(w0, 1 - w0);
      const c0 = Math.floor(cycle);
      const c1 = Math.floor(cycle + 0.5) + 1000;
      shared.flowOffset0.value.set(hash(c0) * 40, hash(c0 + 0.3) * 40, hash(c0 + 0.7) * 40);
      shared.flowOffset1.value.set(hash(c1) * 40, hash(c1 + 0.3) * 40, hash(c1 + 0.7) * 40);

      // Risoluzione adattiva delle nubi, sul ritmo misurato dei frame (a gradini, per non cambiare
      // dimensione a ogni secondo).
      intervals.push(dt * 1000);
      if (intervals.length > 40) intervals.shift();
      if (quality.fixedScale === undefined && now - lastAdapt > 1000 && intervals.length >= 20) {
        lastAdapt = now;
        // Media e non mediana: un frame perso ogni due (16,7 / 33 ms) deve contare come lentezza.
        const intervalMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        if (now > slowUntil) scaleCap = maxScale;
        const next = Math.round(nextVolumeScale(cloudScale, minScale, scaleCap, { gpuMs: null, intervalMs }) * 20) / 20;
        if (next < cloudScale) {
          scaleCap = cloudScale;
          slowUntil = now + 8000;
        }
        cloudScale = Math.min(scaleCap, Math.max(minScale, next));
      }
      resize();
    },

    render() {
      const alt = Math.hypot(camera.position.x, camera.position.y + RE, camera.position.z) - RE;
      shared.cameraPos.value.copy(camera.position);
      shared.cameraAlt.value = alt;
      shared.frame.value = frame;
      shared.sunDir.value.copy(milton.sun);
      const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
      ocean.uniforms.time!.value = visualTime;
      ocean.uniforms.pixelAngle!.value = (2 * tanHalf) / size.y;
      draw(ocean, oceanRT);

      // Nubi: un pixel per blocco N×N della ricostruzione.
      const order = TRACE_ORDER[stride]!;
      const [ox, oy] = order[frame % order.length]!;
      (clouds.uniforms.traceOffset!.value as Vector2).set(ox, oy);
      (clouds.uniforms.reconSize!.value as Vector2).set(reconW, reconH);
      clouds.uniforms.pixelAngle!.value = (2 * tanHalf) / reconH;
      draw(clouds, traceRT);

      // Ricostruzione: la storia può avere ancora la dimensione precedente (si campiona per coordinate).
      const src = reconRT[ping]!;
      const dst = reconRT[1 - ping]!;
      if (dst.width !== reconW || dst.height !== reconH) dst.setSize(reconW, reconH);
      recon.uniforms.traceColor!.value = traceRT.textures[0];
      recon.uniforms.traceDepth!.value = traceRT.textures[1];
      recon.uniforms.history!.value = src.texture;
      recon.uniforms.historyValid!.value = historyValid ? 1 : 0;
      const moving = Math.min(1, viewChange * 40);
      recon.uniforms.alphaNew!.value = 0.3;
      recon.uniforms.clampAmount!.value = moving;
      draw(recon, dst);
      ping = 1 - ping;
      historyValid = true;
      prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

      composite.uniforms.oceanTex!.value = oceanRT.texture;
      composite.uniforms.cloudTex!.value = dst.texture;
      composite.uniforms.exposure!.value = pose ? pose.exposure : state.exposure;
      composite.uniforms.frame!.value = frame;
      draw(composite, null);
      quality.overlay?.();
      frame++;
    },

    stats(): StormStats {
      const intervalMs = median(intervals);
      return {
        view,
        transitioning: transition !== null,
        cloudScale,
        maxSteps: clouds.uniforms.maxSteps!.value as number,
        intervalMs,
        fps: intervalMs ? 1000 / intervalMs : null,
        cameraAltKm: Math.hypot(camera.position.x, camera.position.y + RE, camera.position.z) - RE,
        rate: pose ? pose.rate : state.rate,
      };
    },

    dispose() {
      listeners.abort('storm-closed');
      geometry.dispose();
      for (const m of [ocean, clouds, recon, composite]) m.dispose();
      for (const rt of [oceanRT, traceRT, ...reconRT, waves, noise]) rt.dispose();
      milton.map.dispose();
      renderer.setRenderTarget(null);
      renderer.renderLists.dispose();
    },
  };
}

export type StormScene = ReturnType<typeof createStormScene>;
