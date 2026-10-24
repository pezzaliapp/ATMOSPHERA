import { Vector2, Vector3, Vector4, type Object3D } from 'three';
import type { LoadedEvent } from '../app/load-event';
import type { EventScene } from '../app/scene';
import { subsolarPoint } from '../core/astro';
import type { Engine } from '../core/engine';
import { latLonToVector } from '../core/geo';
import { median, nextVolumeScale } from './adaptive';
import { createColumnPass, type ColumnPass } from './columns';
import { createEarthVolume } from './earth-volume';
import { createVolumeLayer, type VolumeLayer } from './volume-layer';

/**
 * Visualizzazione VOLUME 3D (solo in EXPLORE): al posto della superficie a rilievo delle nuvole,
 * il volume ricostruito dalle colonne osservate (vedi columns.ts e volume-layer.ts).
 *
 * Tutto viene creato al primo uso: STORY e REPLAY non pagano né memoria né compilazione.
 * Il volume si compone sopra la scena dopo il rendering; la traccia, che è una sovrapposizione
 * cartografica, viene ridisegnata sopra il volume come nella vista satellitare.
 */

/** Il volume richiede render target in virgola mobile a 16 bit (WebGL 2 con estensione). */
export function volumeSupported(engine: Engine): boolean {
  const ext = engine.renderer.extensions;
  return ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
}

interface Parts {
  columns: ColumnPass;
  layer: VolumeLayer;
  earth: ReturnType<typeof createEarthVolume>;
}

export function createVolumeView(engine: Engine, scene: EventScene, event: LoadedEvent, overlay: Object3D) {
  const renderer = engine.renderer;
  const mobile = engine.quality.name === 'mobile';
  /** Profilo: frazione massima della risoluzione di disegno e passi del ray marching. */
  const maxScale = mobile ? 0.4 : 0.5;
  const minScale = 0.3;
  const b = event.index.bounds;
  const bounds = new Vector4(b.west, b.south, b.east, b.north);
  const sun = new Vector3();
  const size = new Vector2();

  let parts: Parts | null = null;
  let active = false;
  let cloudsVisible = true;
  let overlayVisible = true;
  let exaggeration = event.manifest.cloudExaggeration;
  let lastKey = '';

  // Misure per la risoluzione dinamica: timer GPU se disponibile, altrimenti intervallo tra i frame.
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const queries: WebGLQuery[] = [];
  const gpuMs: number[] = [];
  const intervals: number[] = [];
  let lastFrame = 0;
  let adaptedAt = 0;
  /** Tetto temporaneo della scala dopo un rallentamento (risale lentamente). */
  let ceiling = maxScale;

  const build = (): Parts => {
    const columns = createColumnPass(scene.sequence);
    const layer = createVolumeLayer(columns, bounds);
    layer.scale = maxScale;
    layer.maxSteps = mobile ? 96 : 160;
    const earth = createEarthVolume({
      dayMap: event.dayMap,
      nightMap: event.nightMap,
      surface: event.surface,
      groundLight: columns.ground.texture,
      bounds,
      segments: engine.quality.sphereSegments,
    });
    earth.mesh.visible = false;
    engine.scene.add(earth.mesh);
    columns.setExaggeration(exaggeration);
    layer.setExaggeration(exaggeration);
    return { columns, layer, earth };
  };

  /** Quale superficie e quali nuvole sono nella scena. */
  const applyVisibility = () => {
    const volume = active && parts !== null;
    scene.earth.mesh.visible = !volume;
    scene.clouds.mesh.visible = !volume && cloudsVisible;
    if (parts) parts.earth.mesh.visible = volume;
    // Nel volume la traccia si disegna dopo la composizione (vedi render).
    overlay.visible = !volume && overlayVisible;
  };

  const readTimers = () => {
    while (timer && queries.length) {
      const head = queries[0]!;
      if (!gl.getQueryParameter(head, gl.QUERY_RESULT_AVAILABLE)) break;
      queries.shift();
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpuMs.push(gl.getQueryParameter(head, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(head);
      if (gpuMs.length > 60) gpuMs.shift();
    }
  };

  return {
    get active() {
      return active;
    },
    enable() {
      parts ??= build();
      active = true;
      lastKey = '';
      applyVisibility();
    },
    disable() {
      active = false;
      applyVisibility();
    },
    setCloudsVisible(visible: boolean) {
      cloudsVisible = visible;
      applyVisibility();
    },
    setOverlayVisible(visible: boolean) {
      overlayVisible = visible;
      applyVisibility();
    },
    setExaggeration(value: number) {
      exaggeration = value;
      parts?.columns.setExaggeration(value);
      parts?.layer.setExaggeration(value);
      lastKey = '';
    },
    /**
     * Dopo l'aggiornamento della sequenza all'istante: ricalcola colonne e luce al suolo
     * solo se istante, miscela o rilievo sono cambiati.
     */
    update(timeMs: number, smoothing: number) {
      if (!active || !parts) return;
      const key = `${timeMs}|${smoothing}|${exaggeration}`;
      if (key === lastKey) return;
      lastKey = key;
      const s = subsolarPoint(new Date(timeMs));
      sun.set(...latLonToVector(s.lat, s.lon));
      parts.columns.setSunDirection(sun);
      parts.layer.setSunDirection(sun);
      parts.earth.setSunDirection(sun);
      parts.columns.render(renderer);
      parts.layer.reset();
    },
    /** Composizione sopra la scena appena disegnata (dopo ogni frame). */
    render() {
      if (!active || !parts) return;
      const now = performance.now();
      if (lastFrame && now - lastFrame < 100) intervals.push(now - lastFrame);
      if (intervals.length > 60) intervals.shift();
      lastFrame = now;

      const { x: w, y: h } = renderer.getSize(size);
      if (cloudsVisible) {
        let query: WebGLQuery | null = null;
        if (timer && queries.length < 4) {
          query = gl.createQuery();
          if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
        }
        parts.layer.render(renderer, engine.camera, { x: 0, y: 0, w, h });
        if (query && timer) {
          gl.endQuery(timer.TIME_ELAPSED_EXT);
          queries.push(query);
        }
      }
      if (overlayVisible) {
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        overlay.visible = true;
        renderer.render(overlay, engine.camera);
        overlay.visible = false;
        renderer.autoClear = autoClear;
      }
      readTimers();
      // Risoluzione dinamica, al massimo una correzione al secondo.
      if (now - adaptedAt > 1000 && intervals.length >= 20) {
        adaptedAt = now;
        const iv = median(intervals.slice(-30))!;
        const gpu = timer && gpuMs.length >= 10 ? median(gpuMs.slice(-30)) : null;
        const previous = parts.layer.scale;
        const next = nextVolumeScale(previous, minScale, Math.max(minScale, ceiling), { gpuMs: gpu, intervalMs: iv });
        // Rallentamento: la scala che lo ha causato diventa il tetto; poi il tetto risale del 2% al secondo.
        ceiling = next < previous ? previous * 0.97 : Math.min(maxScale, ceiling * 1.02);
        parts.layer.scale = next;
      }
    },
    /** true se servono altri frame anche a scena ferma (accumulo che riduce la grana). */
    get wantsFrame() {
      return active && cloudsVisible && parts !== null && parts.layer.accumulating;
    },
    /** Misure correnti (per le verifiche di prestazione). */
    get stats() {
      return {
        scale: parts?.layer.scale ?? null,
        gpuMs: median(gpuMs),
        intervalMs: median(intervals),
        gpuTimer: timer !== null,
      };
    },
  };
}

export type VolumeView = ReturnType<typeof createVolumeView>;
