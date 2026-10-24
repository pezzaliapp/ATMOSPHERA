import { Vector3, type PerspectiveCamera } from 'three';
import { latLonToVector } from '../core/geo';

/**
 * Etichette geografiche in HTML, posizionate proiettando punti della superficie sullo schermo.
 * Nascoste oltre l'orizzonte del pianeta e, per i luoghi minori, quando la camera è lontana.
 * Se due etichette si sovrappongono resta quella più importante (vedi PRIORITY).
 */

export interface PlaceLabel {
  text: string;
  lat: number;
  lon: number;
  kind: 'region' | 'city' | 'sea' | 'storm';
  /** Distanza massima della camera (raggi terrestri) a cui l'etichetta resta visibile. */
  maxDistance?: number;
}

const DEFAULT_MAX: Record<PlaceLabel['kind'], number> = { region: 1.6, city: 0.55, sea: 1.2, storm: 8 };
/** Ordine di precedenza nelle sovrapposizioni (prima = vince). */
const PRIORITY: Record<PlaceLabel['kind'], number> = { storm: 0, region: 1, sea: 2, city: 3 };
/** Margine tra etichette, in pixel. */
const GAP = 6;
/** Distanza dell'etichetta della tempesta sopra il punto, in pixel: l'occhio resta libero. */
const STORM_OFFSET = 60;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 + GAP && b.x0 < a.x1 + GAP && a.y0 < b.y1 + GAP && b.y0 < a.y1 + GAP;

export function createLabelLayer(container: HTMLElement, labels: PlaceLabel[]) {
  const layer = document.createElement('div');
  layer.className = 'labels';
  layer.setAttribute('aria-hidden', 'true');
  container.append(layer);

  const sorted = [...labels].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
  const items = sorted.map((label) => {
    const el = document.createElement('span');
    el.className = `label label--${label.kind}`;
    el.textContent = label.text;
    if (label.kind === 'city') el.dataset.anchor = 'start';
    if (label.kind === 'storm') el.dataset.anchor = 'above';
    layer.append(el);
    return {
      label,
      el,
      world: new Vector3(...latLonToVector(label.lat, label.lon, 1.002)),
      normal: new Vector3(...latLonToVector(label.lat, label.lon)),
    };
  });

  const projected = new Vector3();
  const toCamera = new Vector3();
  let visible = true;

  return {
    /** obstacles: zone dello schermo occupate dall'interfaccia, dove le etichette non vanno. */
    update(camera: PerspectiveCamera, width: number, height: number, distance: number, obstacles: Rect[] = []) {
      layer.hidden = !visible;
      if (!visible) return;
      const placed: Rect[] = [...obstacles];
      for (const item of items) {
        toCamera.copy(camera.position).sub(item.world).normalize();
        const facing = item.normal.dot(toCamera);
        const max = item.label.maxDistance ?? DEFAULT_MAX[item.label.kind];
        projected.copy(item.world).project(camera);
        const onScreen = projected.z < 1 && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 0.95;
        const show = facing > 0.05 && distance <= max && onScreen;
        item.el.classList.toggle('is-hidden', !show);
        if (!show) continue;
        const x = (projected.x * 0.5 + 0.5) * width;
        const y = (-projected.y * 0.5 + 0.5) * height;
        const start = item.el.dataset.anchor === 'start';
        // Nascondi le etichette che uscirebbero dallo schermo.
        const w = item.el.offsetWidth;
        const h = item.el.offsetHeight;
        const left = start ? x : x - w / 2;
        if (left < 4 || left + w > width - 4) {
          item.el.classList.add('is-hidden');
          continue;
        }
        // La tempesta: etichetta sopra il punto, per non coprire l'occhio.
        const above = item.el.dataset.anchor === 'above';
        const top = above ? y - h - STORM_OFFSET : y - h / 2;
        const rect = { x0: left, y0: top, x1: left + w, y1: top + h };
        if (placed.some((r) => overlaps(r, rect))) {
          item.el.classList.add('is-hidden');
          continue;
        }
        placed.push(rect);
        const dy = above ? `calc(-100% - ${STORM_OFFSET}px)` : '-50%';
        item.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(${start ? '0' : '-50%'}, ${dy})`;
        // Vicino all'orizzonte le etichette sfumano.
        item.el.style.opacity = String(Math.min(1, (facing - 0.05) * 6));
      }
    },
    /** Sposta le etichette di un tipo (es. la tempesta che si muove con il tempo). */
    move(kind: PlaceLabel['kind'], lat: number, lon: number) {
      for (const item of items) {
        if (item.label.kind !== kind) continue;
        item.world.set(...latLonToVector(lat, lon, 1.002));
        item.normal.set(...latLonToVector(lat, lon));
      }
    },
    setVisible(value: boolean) {
      visible = value;
    },
  };
}
