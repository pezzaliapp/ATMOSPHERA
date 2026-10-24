import {
  CustomBlending,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three';
import { HAZE_COLOR } from '../globe/earth';
import { aerialPerspective } from '../globe/shading';
import { columnGlsl, type ColumnPass } from './columns';

/**
 * Volume atmosferico RICOSTRUITO, attraversato con ray marching.
 *
 * Per ogni pixel il raggio visivo attraversa il guscio tra la superficie e 19 km (× esagerazione);
 * a ogni passo la densità viene dalla colonna ricostruita sotto quel punto (vedi columns.ts),
 * la luce del Sole da un secondo percorso verso il Sole attraverso le stesse colonne
 * (ombre proprie e proiettate), la luce del cielo dalla nube sovrastante.
 * Nessun rumore procedurale: il volume non contiene dettagli che i dati non hanno.
 * Il risultato si calcola a risoluzione ridotta e si compone sulla scena.
 */

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const marchFragment = /* glsl */ `
  uniform mat4 projInverse;
  uniform mat4 cameraWorld;
  uniform vec3 camPos;
  uniform vec3 sunDirection;
  uniform vec3 hazeColor;
  uniform float exaggeration;
  uniform float frame;
  uniform float maxSteps;
  uniform vec2 resolution;
  varying vec2 vUv;

  ${columnGlsl}
  ${aerialPerspective}

  const float TOP_KM = 19.0;

  /** Intervallo [t0, t1] del raggio dentro la sfera di raggio r (t1 < t0 se manca). */
  vec2 sphere(vec3 o, vec3 d, float r) {
    float b = dot(o, d);
    float c = dot(o, o) - r * r;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
  }

  float hg(float cosT, float g) {
    float g2 = g * g;
    return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosT, 1.5);
  }

  /** Estinzione per km di scena nel punto p (coordinate mondo, raggi terrestri). */
  float densityAt(vec3 p, out vec4 c, out float h) {
    float r = length(p);
    h = (r - 1.0) * RE_KM / exaggeration;
    vec2 uv = columnUv(p / r);
    if (!inRegion(uv)) { c = vec4(0.0); return 0.0; }
    c = textureLod(columns, uv, 0.0);
    return extinction(c, h) / exaggeration;
  }

  /** Spessore ottico verso il Sole dal punto p (passi crescenti, km di scena). */
  float sunDepth(vec3 p, vec3 l, float jitter) {
    float tau = 0.0;
    float t = 0.0;
    float stepKm = (0.25 + 0.2 * jitter) * exaggeration;
    for (int i = 0; i < 7; i++) {
      t += stepKm;
      vec3 q = p + l * (t / RE_KM);
      vec4 c; float h;
      float k = densityAt(q, c, h);
      tau += k * stepKm;
      if (h > TOP_KM) break;
      stepKm *= 1.7;
    }
    return tau;
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec4 clip = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec4 view = projInverse * clip;
    vec3 dir = normalize((cameraWorld * vec4(view.xyz / view.w, 0.0)).xyz);
    vec3 o = camPos;

    float rTop = 1.0 + (TOP_KM * exaggeration + 0.5) / RE_KM;
    vec2 shell = sphere(o, dir, rTop);
    if (shell.y < 0.0 || shell.x > shell.y) { gl_FragColor = vec4(0.0); return; }
    vec2 ground = sphere(o, dir, 1.0);
    float t0 = max(shell.x, 0.0);
    float t1 = ground.x > 0.0 && ground.x < ground.y ? min(shell.y, ground.x) : shell.y;

    // Raggi interamente fuori dalla regione: niente da attraversare.
    vec2 uvA = columnUv(normalize(o + dir * t0));
    vec2 uvB = columnUv(normalize(o + dir * t1));
    if ((uvA.x < -0.05 && uvB.x < -0.05) || (uvA.x > 1.05 && uvB.x > 1.05) ||
        (uvA.y < -0.05 && uvB.y < -0.05) || (uvA.y > 1.05 && uvB.y > 1.05)) {
      gl_FragColor = vec4(0.0); return;
    }

    vec3 l = normalize(sunDirection);
    float cosT = dot(dir, l);
    // Funzione di fase a due lobi (diffusione in avanti delle goccioline), normalizzata a ~1.
    float phase = mix(hg(cosT, -0.25), hg(cosT, 0.65), 0.7) * 0.75 + 0.25;

    float lenKm = (t1 - t0) * RE_KM;
    float steps = clamp(lenKm / (0.3 * exaggeration), 24.0, maxSteps);
    float stepKm = lenKm / steps;
    float jitter = hash12(gl_FragCoord.xy + frame * vec2(17.31, 41.7));
    float t = t0 * RE_KM + stepKm * jitter;
    float tEnd = t1 * RE_KM;

    vec3 radiance = vec3(0.0);
    float trans = 1.0;
    vec3 firstHit = vec3(0.0);
    float hitWeight = 0.0;

    // Raffinamento: al primo ingresso in una nube si torna indietro di un passo e lo si ripercorre
    // a passi di un quarto (evita le venature a strati del campionamento regolare).
    float fineLeft = 0.0;
    float lastAdvance = 0.0;
    for (int i = 0; i < 480; i++) {
      if (t > tEnd || trans < 0.01) break;
      vec3 p = o + dir * (t / RE_KM);
      vec4 c; float h;
      float k = densityAt(p, c, h);
      float advance = fineLeft > 0.0 ? stepKm * 0.25 : stepKm;
      if (k <= 0.0) {
        // Sopra la sommità della colonna: passo più lungo (la densità è nulla fino alla sommità).
        if (fineLeft <= 0.0 && h > c.y + 0.6) advance = stepKm * 2.0;
        fineLeft = max(fineLeft - 1.0, 0.0);
        lastAdvance = advance;
        t += advance;
        continue;
      }
      if (fineLeft <= 0.0 && lastAdvance > 0.0) {
        t -= lastAdvance;
        fineLeft = 4.0 * lastAdvance / stepKm + 4.0;
        lastAdvance = 0.0;
        continue;
      }
      fineLeft = max(fineLeft - 1.0, 0.0);
      vec3 up = p / length(p);
      float sinElev = dot(up, l);
      float sunUp = smoothstep(-0.08, 0.12, sinElev);
      vec3 sunColor = mix(vec3(1.0, 0.62, 0.38), vec3(1.0, 0.97, 0.92), smoothstep(0.05, 0.4, sinElev));

      float tauSun = sunUp > 0.0 ? sunDepth(p, l, fract(jitter + float(i) * 0.618)) : 1e3;
      // Diffusione multipla approssimata (somma di ottave): le nubi spesse non diventano nere.
      // La parte diffusa porta l'energia entrata dalla sommità: proporzionale all'irraggiamento
      // su una superficie orizzontale (seno dell'elevazione del Sole). Col Sole radente resta
      // soprattutto la luce diretta sui fianchi rivolti al Sole.
      float irradiance = clamp(sinElev * 2.0, 0.0, 1.0);
      float beer = (exp(-tauSun) + (0.35 * exp(-0.25 * tauSun) + 0.12 * exp(-0.06 * tauSun)) * irradiance) / 1.47;
      // Cielo: attenuato dalla nube sovrastante nella stessa colonna.
      float tauAbove = depthAbove(c, h);
      float sky = exp(-0.12 * tauAbove) * 0.85 + 0.15;
      // Luce del cielo: più debole col Sole basso (crepuscolo), mai nulla.
      vec3 ambient = vec3(0.15, 0.2, 0.31) * (0.12 + 0.88 * sunUp * mix(0.3, 1.0, smoothstep(0.0, 0.5, sinElev)));
      vec3 light = sunColor * beer * phase * 1.05 * sunUp + ambient * sky;
      // Luminosità OSSERVATA: stessa curva di tono e stesso contrasto locale della vista attuale
      // (albedo meno la sua media su ~15 km). Il volume aggiunge ombre e profondità,
      // la tessitura del CDO resta quella misurata da GOES-16, senza strutture aggiunte.
      float albedoMean = textureLod(columns, columnUv(up), 2.5).a;
      float detail = clamp(c.a - albedoMean, -0.15, 0.15);
      float tone = pow(smoothstep(0.3, 1.0, c.a), 2.0);
      float observed = (0.45 + 0.5 * tone + 1.2 * detail) / 0.85;
      light *= mix(1.0, observed, smoothstep(0.02, 0.22, sinElev));

      float a = 1.0 - exp(-k * advance);
      radiance += trans * a * light;
      float w = trans * a;
      firstHit += p * w;
      hitWeight += w;
      trans *= 1.0 - a;
      lastAdvance = 0.0;
      t += advance;
    }

    float alpha = 1.0 - trans;
    if (alpha < 0.002) { gl_FragColor = vec4(0.0); return; }
    // Prospettiva aerea nel punto medio visto (come la scena).
    vec3 hit = firstHit / max(hitWeight, 1e-5);
    vec3 n = normalize(hit);
    vec3 v = normalize(camPos - hit);
    vec3 color = applyHaze(radiance / alpha, n, v, l, hazeColor);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

const accumulateFragment = /* glsl */ `
  uniform sampler2D current;
  uniform sampler2D history;
  uniform float weight;
  varying vec2 vUv;
  void main() {
    gl_FragColor = mix(texture2D(history, vUv), texture2D(current, vUv), weight);
  }
`;

const compositeFragment = /* glsl */ `
  uniform sampler2D volume;
  uniform vec2 texel;
  uniform float blur;
  varying vec2 vUv;
  void main() {
    // Filtro a tenda su 5 campioni (circa un pixel del volume): riduce la grana del campionamento
    // casuale senza perdere dettagli, che a questa scala sono già più fini dei dati (~2,8 km).
    vec2 o = texel * 0.75 * blur;
    vec4 s = 0.4 * texture2D(volume, vUv)
      + 0.15 * (texture2D(volume, vUv + o) + texture2D(volume, vUv - o)
              + texture2D(volume, vUv + vec2(o.x, -o.y)) + texture2D(volume, vUv + vec2(-o.x, o.y)));
    float a = s.a;
    if (a < 0.002) discard;
    gl_FragColor = vec4(s.rgb / a, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor = vec4(gl_FragColor.rgb * a, a);
  }
`;

/** Fotogrammi mediati a camera ferma. */
const ACCUMULATED_FRAMES = 16;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VolumeLayer {
  /** Disegna il volume sopra ciò che è già nel viewport corrente. */
  render(renderer: WebGLRenderer, camera: PerspectiveCamera, viewport: Rect, scissor?: Rect): void;
  setSunDirection(direction: Vector3): void;
  setExaggeration(value: number): void;
  /** Frazione della risoluzione di disegno usata per il ray marching. */
  scale: number;
  maxSteps: number;
  /** Accumulo temporale a camera ferma (riduce la grana). */
  accumulate: boolean;
  /** Il contenuto è cambiato (istante, dati): si ricomincia l'accumulo. */
  reset(): void;
  /** true finché l'accumulo a camera ferma non è completo (servono altri frame). */
  readonly accumulating: boolean;
  dispose(): void;
}

export function createVolumeLayer(columns: ColumnPass, bounds: Vector4): VolumeLayer {
  const makeTarget = () =>
    new WebGLRenderTarget(4, 4, {
      type: HalfFloatType,
      format: RGBAFormat,
      depthBuffer: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
  // Fotogramma corrente e due storie (ping-pong) per l'accumulo temporale a camera ferma.
  const target = makeTarget();
  const histories = [makeTarget(), makeTarget()];
  let accumulated = 0;
  let readIndex = 0;
  const lastView = new Float32Array(33);
  const sun = new Vector3(1, 0, 0);
  const march = new ShaderMaterial({
    vertexShader: quadVertex,
    fragmentShader: marchFragment,
    uniforms: {
      columns: { value: columns.columns.texture },
      columnBounds: { value: bounds },
      projInverse: { value: null },
      cameraWorld: { value: null },
      camPos: { value: new Vector3() },
      sunDirection: { value: sun },
      hazeColor: { value: HAZE_COLOR },
      exaggeration: { value: 2 },
      frame: { value: 0 },
      maxSteps: { value: 160 },
      resolution: { value: new Vector2() },
    },
    depthTest: false,
    depthWrite: false,
  });
  const composite = new ShaderMaterial({
    vertexShader: quadVertex,
    fragmentShader: compositeFragment,
    uniforms: { volume: { value: target.texture }, texel: { value: new Vector2() }, blur: { value: 1 } },
    transparent: true,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    depthTest: false,
    depthWrite: false,
  });
  const accumulate = new ShaderMaterial({
    vertexShader: quadVertex,
    fragmentShader: accumulateFragment,
    uniforms: { current: { value: target.texture }, history: { value: null }, weight: { value: 1 } },
    depthTest: false,
    depthWrite: false,
  });
  const geometry = new PlaneGeometry(2, 2);
  const quad = new Mesh(geometry, march);
  quad.frustumCulled = false;
  const scene = new Scene();
  scene.add(quad);
  const ortho = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let frame = 0;

  const layer: VolumeLayer = {
    scale: 0.5,
    maxSteps: 160,
    accumulate: true,
    render(renderer, camera, vp, scissor = vp) {
      const pr = renderer.getPixelRatio();
      const w = Math.max(1, Math.round(vp.w * pr * layer.scale));
      const h = Math.max(1, Math.round(vp.h * pr * layer.scale));
      if (target.width !== w || target.height !== h) {
        target.setSize(w, h);
        histories.forEach((x) => x.setSize(w, h));
        accumulated = 0;
      }
      // Camera o viewport cambiati: si ricomincia l'accumulo.
      const view = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, vp.x];
      if (view.some((x, i) => Math.abs(x - lastView[i]!) > 1e-9)) {
        accumulated = 0;
        lastView.set(view);
      }
      const u = march.uniforms;
      u.projInverse!.value = camera.projectionMatrixInverse;
      u.cameraWorld!.value = camera.matrixWorld;
      (u.camPos!.value as Vector3).setFromMatrixPosition(camera.matrixWorld);
      u.frame!.value = frame++ % 64;
      u.maxSteps!.value = layer.maxSteps;
      (u.resolution!.value as Vector2).set(w, h);

      const previous = renderer.getRenderTarget();
      const autoClear = renderer.autoClear;
      const toneMapping = renderer.toneMapping;
      renderer.toneMapping = 0;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      quad.material = march;
      renderer.render(scene, ortho);
      // Media mobile dei fotogrammi con rumore diverso mentre nulla si muove.
      const write = histories[1 - readIndex]!;
      accumulate.uniforms.history!.value = histories[readIndex]!.texture;
      accumulate.uniforms.weight!.value = layer.accumulate ? 1 / (Math.min(accumulated, ACCUMULATED_FRAMES - 1) + 1) : 1;
      renderer.setRenderTarget(write);
      quad.material = accumulate;
      renderer.render(scene, ortho);
      readIndex = 1 - readIndex;
      accumulated++;
      composite.uniforms.volume!.value = write.texture;
      (composite.uniforms.texel!.value as Vector2).set(1 / w, 1 / h);
      // Con l'accumulo la grana è già mediata: il filtro spaziale si riduce, l'immagine resta nitida.
      composite.uniforms.blur!.value = layer.accumulate ? Math.max(0.25, 1 - accumulated / 6) : 1;
      renderer.setRenderTarget(previous);
      renderer.toneMapping = toneMapping;

      renderer.autoClear = false;
      renderer.setViewport(vp.x, vp.y, vp.w, vp.h);
      renderer.setScissor(scissor.x, scissor.y, scissor.w, scissor.h);
      quad.material = composite;
      renderer.render(scene, ortho);
      renderer.autoClear = autoClear;
    },
    setSunDirection(direction) {
      if (!direction.equals(sun)) accumulated = 0;
      sun.copy(direction);
    },
    setExaggeration(value) {
      march.uniforms.exaggeration!.value = value;
      accumulated = 0;
    },
    reset() {
      accumulated = 0;
    },
    get accumulating() {
      return layer.accumulate && accumulated < ACCUMULATED_FRAMES;
    },
    dispose() {
      target.dispose();
      histories.forEach((x) => x.dispose());
      accumulate.dispose();
      march.dispose();
      composite.dispose();
      geometry.dispose();
    },
  };
  return layer;
}
