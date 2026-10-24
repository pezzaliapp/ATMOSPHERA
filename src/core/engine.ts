import {
  ACESFilmicToneMapping,
  LinearMipmapLinearFilter,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  WebGLRenderer,
  type ColorSpace,
  type Texture,
} from 'three';
import { chooseQuality, detectDevice, type QualityProfile } from './quality';

/**
 * Motore di rendering condiviso: renderer, scena, camera, ridimensionamento,
 * ciclo di rendering "su richiesta" (nessun frame se nulla cambia) e pausa a scheda nascosta.
 */

/**
 * Legge i limiti della GPU su un canvas temporaneo, perché gli attributi del contesto
 * (es. antialias) si possono scegliere solo alla sua creazione.
 */
function probeMaxTextureSize(): number {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) throw new Error('webgl2-unavailable');
  const size = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return size;
}

export interface FrameCallback {
  /** Restituisce true se la scena è cambiata e va ridisegnata. */
  (dt: number): boolean;
}

export class Engine {
  readonly quality: QualityProfile;
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 0.001, 20);
  private readonly callbacks: FrameCallback[] = [];
  private readonly afterRender: (() => void)[] = [];
  private frame = 0;
  private last = 0;
  private needsRender = true;
  private running = false;
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.quality = chooseQuality(detectDevice(probeMaxTextureSize()));
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: this.quality.antialias,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.setClearColor(0x000000, 0);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    document.addEventListener('visibilitychange', this.onVisibility);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
  }

  /** Carica più texture in parallelo, segnalando l'avanzamento. */
  async loadTextures(
    items: { url: string; colorSpace?: ColorSpace }[],
    onProgress?: (fraction: number) => void,
  ): Promise<Texture[]> {
    const loader = new TextureLoader();
    let done = 0;
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    return Promise.all(
      items.map(
        ({ url, colorSpace }) =>
          new Promise<Texture>((resolve, reject) => {
            loader.load(
              url,
              (texture) => {
                if (colorSpace) texture.colorSpace = colorSpace;
                texture.anisotropy = Math.min(this.quality.anisotropy, maxAniso);
                texture.minFilter = LinearMipmapLinearFilter;
                onProgress?.(++done / items.length);
                resolve(texture);
              },
              undefined,
              () => reject(new Error(`texture-load-failed: ${url}`)),
            );
          }),
      ),
    );
  }

  onFrame(callback: FrameCallback): void {
    this.callbacks.push(callback);
  }

  /** Eseguito dopo ogni frame disegnato (es. posizionamento delle etichette HTML). */
  onAfterRender(callback: () => void): void {
    this.afterRender.push(callback);
  }

  invalidate(): void {
    this.needsRender = true;
  }

  start(): void {
    // Carica shader e texture sulla GPU prima del primo frame, evitando uno scatto iniziale.
    this.renderer.compile(this.scene, this.camera);
    this.running = true;
    this.loop();
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.dispose();
  }

  private loop(): void {
    cancelAnimationFrame(this.frame);
    this.last = performance.now();
    const tick = (now: number) => {
      this.frame = requestAnimationFrame(tick);
      // Limite al passo per evitare salti dopo una pausa.
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      let changed = false;
      for (const callback of this.callbacks) changed = callback(dt) || changed;
      if (changed || this.needsRender) {
        this.renderer.render(this.scene, this.camera);
        this.needsRender = false;
        for (const callback of this.afterRender) callback();
      }
    };
    this.frame = requestAnimationFrame(tick);
  }

  private resize(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    // Su schermi verticali allarga il campo visivo perché la scena resti leggibile.
    this.camera.fov = this.camera.aspect < 1 ? Math.min(70, 42 / Math.max(this.camera.aspect, 0.55)) : 42;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  // Nessun rendering a scheda nascosta: risparmio di batteria e GPU.
  private readonly onVisibility = () => {
    if (document.hidden) cancelAnimationFrame(this.frame);
    else if (this.running) {
      this.needsRender = true;
      this.loop();
    }
  };

  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.canvas.dispatchEvent(new CustomEvent('atmosphera:contextlost', { bubbles: true }));
  };
}
