import { Vector3, type PerspectiveCamera } from 'three';
import { latLonToVector } from '../core/geo';

/**
 * Etichette geografiche in HTML, posizionate proiettando punti della superficie sullo schermo.
 * Nascoste oltre l'orizzonte del pianeta e, per i luoghi minori, quando la camera è lontana.
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

export function createLabelLayer(container: HTMLElement, labels: PlaceLabel[]) {
  const layer = document.createElement('div');
  layer.className = 'labels';
  layer.setAttribute('aria-hidden', 'true');
  container.append(layer);

  const items = labels.map((label) => {
    const el = document.createElement('span');
    el.className = `label label--${label.kind}`;
    el.textContent = label.text;
    if (label.kind === 'city') el.dataset.anchor = 'start';
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
    update(camera: PerspectiveCamera, width: number, height: number, distance: number) {
      layer.hidden = !visible;
      if (!visible) return;
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
        const left = start ? x : x - w / 2;
        if (left < 4 || left + w > width - 4) {
          item.el.classList.add('is-hidden');
          continue;
        }
        item.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(${start ? '0' : '-50%'}, -50%)`;
        // Vicino all'orizzonte le etichette sfumano.
        item.el.style.opacity = String(Math.min(1, (facing - 0.05) * 6));
      }
    },
    setVisible(value: boolean) {
      visible = value;
    },
  };
}
