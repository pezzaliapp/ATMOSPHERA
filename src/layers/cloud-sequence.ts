import {
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RedFormat,
  RGFormat,
  Texture,
  Vector2,
  Vector4,
} from 'three';
import { blendSlots, frameTimes, locate, observedAt, type BlendSlots, type SequenceIndex } from '../data/sequence';

/**
 * Fotogrammi della sequenza satellitare sulla GPU.
 *
 * Le immagini compresse vengono scaricate in ordine cronologico dopo l'avvio (~230 KB l'una)
 * e decodificate dal browser; sulla GPU restano solo i fotogrammi vicini all'istante corrente,
 * a un canale (R8) invece di quattro. Le uniform sono condivise tra il livello nuvole e la
 * superficie (ombre), così un solo aggiornamento vale per entrambi.
 */

interface FrameTextures {
  albedo: Texture;
  bt: Texture;
  flow: Texture | null;
}

const GPU_FRAMES = 8;

/** GLSL condiviso: lettura della sequenza (dichiarazioni e funzioni). */
export const cloudSequenceGlsl = /* glsl */ `
  uniform sampler2D albedo0;
  uniform sampler2D albedo1;
  uniform sampler2D albedo2;
  uniform sampler2D albedo3;
  uniform sampler2D bt0;
  uniform sampler2D bt1;
  uniform sampler2D bt2;
  uniform sampler2D bt3;
  uniform sampler2D flowPrev;
  uniform sampler2D flowCur;
  uniform sampler2D flowNext;
  uniform vec4 blendWeights;
  uniform float blendT;
  /** Da valore del PNG (0–1) a spostamento in coordinate uv. */
  uniform vec2 flowToUv;

  vec2 flowAt(sampler2D f, vec2 uv) {
    return (texture2D(f, uv).rg * 255.0 - 128.0) * flowToUv;
  }

  /** Spostamenti dei quattro slot verso l'istante corrente (vedi src/data/sequence.ts). */
  void slotOffsets(vec2 uv, out vec2 d0, out vec2 d1, out vec2 d2, out vec2 d3) {
    vec2 vc = flowAt(flowCur, uv);
    d1 = -blendT * vc;
    d2 = (1.0 - blendT) * vc;
    d0 = blendWeights.x > 0.0 ? d1 - flowAt(flowPrev, uv) : d1;
    d3 = blendWeights.w > 0.0 ? d2 + flowAt(flowNext, uv) : d2;
  }

  /** Albedo e BT (codificate 0–1) mescolate sui quattro slot. */
  vec2 sampleSequence(vec2 uv) {
    vec2 d0, d1, d2, d3;
    slotOffsets(uv, d0, d1, d2, d3);
    vec2 r = blendWeights.y * vec2(texture2D(albedo1, uv + d1).r, texture2D(bt1, uv + d1).r)
           + blendWeights.z * vec2(texture2D(albedo2, uv + d2).r, texture2D(bt2, uv + d2).r);
    if (blendWeights.x > 0.0) r += blendWeights.x * vec2(texture2D(albedo0, uv + d0).r, texture2D(bt0, uv + d0).r);
    if (blendWeights.w > 0.0) r += blendWeights.w * vec2(texture2D(albedo3, uv + d3).r, texture2D(bt3, uv + d3).r);
    return r;
  }

  /** Versione economica e filtrata (solo i due slot centrali, livello di mipmap scelto). */
  vec2 sampleSequenceLod(vec2 uv, vec2 vc, float lod) {
    vec2 d1 = -blendT * vc;
    vec2 d2 = (1.0 - blendT) * vc;
    float w = blendWeights.z + blendWeights.w;
    vec2 a = vec2(textureLod(albedo1, uv + d1, lod).r, textureLod(bt1, uv + d1, lod).r);
    vec2 b = vec2(textureLod(albedo2, uv + d2, lod).r, textureLod(bt2, uv + d2, lod).r);
    return mix(a, b, clamp(w, 0.0, 1.0));
  }
`;

export interface CloudSequence {
  index: SequenceIndex;
  times: number[];
  /** Uniform da inserire nei materiali che leggono le nuvole. */
  uniforms: Record<string, { value: unknown }>;
  /** Avanzamento del download delle immagini, 0–1. */
  readonly loaded: number;
  /** true se l'ultimo download è fallito (connessione lenta o assente): si riprova da soli. */
  readonly failing: boolean;
  /** Imposta l'istante; restituisce false se i fotogrammi necessari non sono ancora pronti. */
  setTime(ms: number, smoothing: number): boolean;
  /** Promessa risolta quando i fotogrammi per l'istante sono pronti. */
  whenReady(ms: number): Promise<void>;
  /** Slot e pesi correnti (per l'interfaccia: osservato o interpolato). */
  readonly slots: BlendSlots;
  observedIndex(ms: number): number | null;
  /** Richiede tutti i file della sequenza attraverso il service worker, per l'uso offline. */
  warmCache(): Promise<void>;
  dispose(): void;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image-load-failed: ${url}`));
    img.src = url;
  });
}

function dataTexture(image: HTMLImageElement, format: typeof RedFormat | typeof RGFormat, mipmaps: boolean): Texture {
  const texture = new Texture(image);
  texture.format = format;
  texture.colorSpace = NoColorSpace;
  texture.generateMipmaps = mipmaps;
  texture.minFilter = mipmaps ? LinearMipmapLinearFilter : LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function createCloudSequence(index: SequenceIndex, baseUrl: string, onProgress?: (f: number) => void): CloudSequence {
  const times = frameTimes(index);
  const n = index.frames.length;
  const images: { albedo?: HTMLImageElement; bt?: HTMLImageElement; flow?: HTMLImageElement }[] = index.frames.map(() => ({}));
  const pending = new Map<number, Promise<void>>();
  /** Istante dell'ultimo errore per fotogramma: evita di ritentare a ogni frame. */
  const failedAt = new Map<number, number>();
  const RETRY_MS = 4000;
  const gpu = new Map<number, FrameTextures>();
  let loadedCount = 0;
  let failing = false;

  const placeholder = new Texture();

  const load = (k: number): Promise<void> => {
    let p = pending.get(k);
    if (p) return p;
    const failed = failedAt.get(k);
    if (failed !== undefined && performance.now() - failed < RETRY_MS) return Promise.reject(new Error('retry-later'));
    const f = index.frames[k]!;
    p = Promise.all([
      loadImage(baseUrl + f.albedo),
      loadImage(baseUrl + f.bt),
      f.flow ? loadImage(baseUrl + f.flow) : Promise.resolve(undefined),
    ]).then(([albedo, bt, flow]) => {
      images[k] = flow ? { albedo, bt, flow } : { albedo, bt };
      loadedCount++;
      failedAt.delete(k);
      failing = failedAt.size > 0;
      onProgress?.(loadedCount / n);
    });
    // Un errore non resta in memoria: il fotogramma verrà richiesto di nuovo più tardi.
    p.catch(() => {
      pending.delete(k);
      failedAt.set(k, performance.now());
      failing = true;
    });
    pending.set(k, p);
    return p;
  };
  // Download in ordine cronologico: la riproduzione può partire con i primi fotogrammi.
  // Se la connessione cade, il precaricamento riprende quando torna.
  const preload = async () => {
    for (let k = 0; k < n; k += 4) {
      try {
        await Promise.all([k, k + 1, k + 2, k + 3].filter((j) => j < n && !images[j]?.albedo).map(load));
      } catch {
        window.addEventListener('online', () => void preload(), { once: true });
        return;
      }
    }
  };
  void preload();

  const textures = (k: number): FrameTextures | null => {
    const cached = gpu.get(k);
    if (cached) {
      // Ordine di inserimento = ordine d'uso (LRU).
      gpu.delete(k);
      gpu.set(k, cached);
      return cached;
    }
    const img = images[k];
    if (!img?.albedo || !img.bt) return null;
    const t: FrameTextures = {
      albedo: dataTexture(img.albedo, RedFormat, true),
      bt: dataTexture(img.bt, RedFormat, true),
      flow: img.flow ? dataTexture(img.flow, RGFormat, false) : null,
    };
    gpu.set(k, t);
    while (gpu.size > GPU_FRAMES) {
      const [oldest, old] = gpu.entries().next().value as [number, FrameTextures];
      gpu.delete(oldest);
      old.albedo.dispose();
      old.bt.dispose();
      old.flow?.dispose();
    }
    return t;
  };

  const [w, h] = index.albedoSize;
  const enc = index.flowEncoding;
  const uniforms: Record<string, { value: unknown }> = {
    albedo0: { value: placeholder },
    albedo1: { value: placeholder },
    albedo2: { value: placeholder },
    albedo3: { value: placeholder },
    bt0: { value: placeholder },
    bt1: { value: placeholder },
    bt2: { value: placeholder },
    bt3: { value: placeholder },
    flowPrev: { value: placeholder },
    flowCur: { value: placeholder },
    flowNext: { value: placeholder },
    blendWeights: { value: new Vector4(0, 1, 0, 0) },
    blendT: { value: 0 },
    // vx in pixel verso est → +u; vy in pixel verso sud → −v (riga 0 = nord).
    flowToUv: { value: new Vector2(1 / (enc.scale * w), -1 / (enc.scale * h)) },
  };

  let slots: BlendSlots = blendSlots({ i: 0, t: 0 }, n, 1);

  return {
    index,
    times,
    uniforms,
    get loaded() {
      return loadedCount / n;
    },
    get failing() {
      return failing;
    },
    get slots() {
      return slots;
    },
    setTime(ms, smoothing) {
      const s = blendSlots(locate(times, ms), n, smoothing);
      const tex = s.indices.map(textures);
      if (tex.some((x) => x === null)) {
        s.indices.forEach((k) => load(k).catch(() => undefined));
        return false;
      }
      const [t0, t1, t2, t3] = tex as [FrameTextures, FrameTextures, FrameTextures, FrameTextures];
      uniforms.albedo0!.value = t0.albedo;
      uniforms.albedo1!.value = t1.albedo;
      uniforms.albedo2!.value = t2.albedo;
      uniforms.albedo3!.value = t3.albedo;
      uniforms.bt0!.value = t0.bt;
      uniforms.bt1!.value = t1.bt;
      uniforms.bt2!.value = t2.bt;
      uniforms.bt3!.value = t3.bt;
      // Flussi: (i−1 → i), (i → i+1), (i+1 → i+2); sull'ultimo fotogramma non c'è moto.
      uniforms.flowPrev!.value = t0.flow ?? placeholder;
      uniforms.flowCur!.value = t1.flow ?? placeholder;
      uniforms.flowNext!.value = t2.flow ?? placeholder;
      (uniforms.blendWeights!.value as Vector4).set(...s.weights);
      uniforms.blendT!.value = s.t;
      slots = s;
      return true;
    },
    async whenReady(ms) {
      const s = blendSlots(locate(times, ms), n, 1);
      await Promise.all(s.indices.map(load));
    },
    observedIndex(ms) {
      return observedAt(times, ms);
    },
    async warmCache() {
      const files = index.frames.flatMap((f) => [f.albedo, f.bt, ...(f.flow ? [f.flow] : [])]);
      // Uno alla volta: non compete con la riproduzione.
      for (const file of files) {
        try {
          await (await fetch(baseUrl + file)).arrayBuffer();
        } catch {
          return;
        }
      }
    },
    dispose() {
      for (const t of gpu.values()) {
        t.albedo.dispose();
        t.bt.dispose();
        t.flow?.dispose();
      }
      gpu.clear();
      placeholder.dispose();
    },
  };
}
