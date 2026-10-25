import { MathUtils, Vector3 } from 'three';

/**
 * Punti di osservazione. Stato della camera: punto osservato (target), distanza, azimut ed elevazione
 * della camera rispetto al target (azimut 0 = da sud, π/2 = da est), campo visivo.
 */

export type ViewName = 'panorama' | 'approach' | 'eye';

export interface CameraState {
  target: Vector3;
  distance: number;
  azimuth: number;
  elevation: number;
  fov: number;
  /** Accelerazione del tempo delle nubi (×1 = tempo reale). */
  rate: number;
  exposure: number;
}

const DEG = Math.PI / 180;

export type ViewSet = Record<ViewName, CameraState>;

/**
 * Telecamere della Fase S1 (posizione, direzione, campo visivo): restano disponibili (?cams=s1) per i
 * confronti prima/dopo. L'esposizione è quella della S1.1, tarata sulla nuova illuminazione.
 */
export const VIEWS_S1: ViewSet = {
  panorama: { target: new Vector3(0, 0, -20), distance: 1150, azimuth: 12 * DEG, elevation: 74 * DEG, fov: 48, rate: 90, exposure: 0.5 },
  approach: { target: new Vector3(0, 9, 0), distance: 52, azimuth: -70 * DEG, elevation: 38 * DEG, fov: 55, rate: 12, exposure: 0.55 },
  eye: { target: new Vector3(0, 7.5, 0), distance: 1.4, azimuth: -22 * DEG, elevation: 7 * DEG, fov: 88, rate: 1, exposure: 0.55 },
};

export const VIEWS: ViewSet = {
  // Dall'alto e obliqua, leggermente da sud: la spirale intera (~900 km) con la curvatura e l'orizzonte.
  panorama: { target: new Vector3(0, 0, -60), distance: 1080, azimuth: 12 * DEG, elevation: 52 * DEG, fov: 50, rate: 90, exposure: 0.5 },
  // Obliqua da est-nord-est verso il Sole (ovest-sud-ovest), appena sopra la sommità: lo «stadio» con la
  // parete occidentale in ombra e quella orientale illuminata.
  approach: { target: new Vector3(0, 5, 0), distance: 26, azimuth: 112 * DEG, elevation: 40 * DEG, fov: 60, rate: 12, exposure: 0.55 },
  // Dentro l'occhio, a ~4,3 km di quota, verso nord-ovest e verso l'alto: la parete illuminata di taglio,
  // l'ombra della parete opposta, il bordo superiore contro il cielo.
  eye: { target: new Vector3(0, 6, 0), distance: 4, azimuth: 40 * DEG, elevation: -25 * DEG, fov: 70, rate: 1, exposure: 0.55 },
};

/** Passaggio intermedio sopra l'occhio: per entrare e uscire dall'occhio senza attraversare la parete. */
const ABOVE_EYE: CameraState = { target: new Vector3(0, 8, 0), distance: 26, azimuth: -100 * DEG, elevation: 84 * DEG, fov: 62, rate: 4, exposure: 1.1 };

export function cloneState(s: CameraState): CameraState {
  return { ...s, target: s.target.clone() };
}

export function cameraPosition(s: CameraState, out = new Vector3()): Vector3 {
  const c = Math.cos(s.elevation);
  return out.set(c * Math.sin(s.azimuth), Math.sin(s.elevation), c * Math.cos(s.azimuth)).multiplyScalar(s.distance).add(s.target);
}

function lerpState(a: CameraState, b: CameraState, f: number): CameraState {
  let da = (b.azimuth - a.azimuth) % (2 * Math.PI);
  if (da > Math.PI) da -= 2 * Math.PI;
  if (da < -Math.PI) da += 2 * Math.PI;
  return {
    target: a.target.clone().lerp(b.target, f),
    // Distanza e accelerazione in scala logaritmica: da 1000 km a 1 km il moto resta regolare.
    distance: Math.exp(MathUtils.lerp(Math.log(a.distance), Math.log(b.distance), f)),
    azimuth: a.azimuth + da * f,
    elevation: MathUtils.lerp(a.elevation, b.elevation, f),
    fov: MathUtils.lerp(a.fov, b.fov, f),
    rate: Math.exp(MathUtils.lerp(Math.log(a.rate), Math.log(b.rate), f)),
    exposure: MathUtils.lerp(a.exposure, b.exposure, f),
  };
}

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** Transizione morbida, eventualmente con il passaggio sopra l'occhio. */
export function makeTransition(from: CameraState, to: ViewName, fromView: ViewName | null, views: ViewSet = VIEWS) {
  const target = views[to];
  const viaEye = (to === 'eye') !== (fromView === 'eye');
  const legs: CameraState[] = viaEye ? [cloneState(from), ABOVE_EYE, target] : [cloneState(from), target];
  const durations = viaEye ? [to === 'eye' && fromView === 'panorama' ? 4.2 : 2.6, 3.2] : [fromView === 'panorama' || to === 'panorama' ? 4.2 : 3.0];
  if (viaEye && to !== 'eye') durations.reverse();
  const total = durations.reduce((a, b) => a + b, 0);
  return {
    total,
    at(seconds: number): CameraState {
      let t = Math.min(seconds, total);
      for (let i = 0; i < durations.length; i++) {
        const d = durations[i]!;
        if (t <= d || i === durations.length - 1) return lerpState(legs[i]!, legs[i + 1]!, ease(Math.min(1, t / d)));
        t -= d;
      }
      return cloneState(target);
    },
  };
}
