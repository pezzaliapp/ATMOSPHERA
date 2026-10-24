import { Vector3, type PerspectiveCamera } from 'three';
import { cameraPose, clampState, lerpState, type CameraState } from './camera-pose';
import { vectorToLatLon } from './geo';

/**
 * Controller di camera originale per ATMOSPHERA.
 *
 * Vicino alla superficie (vista regionale):
 *   trascina con un dito / tasto sinistro → ruota attorno al punto osservato e inclina
 *   due dita / tasto destro / Maiusc + trascina → sposta il punto osservato
 *   pizzica / rotella → zoom
 *   doppio clic / doppio tocco → centra il punto toccato
 * Lontano (vista globo): trascinare fa ruotare il pianeta.
 *
 * Lo stato visualizzato insegue lo stato obiettivo con uno smorzamento esponenziale;
 * le transizioni lunghe (es. regionale ↔ globo) usano un'interpolazione temporizzata.
 */

const GLOBE_THRESHOLD = 1.0;

interface Flight {
  from: CameraState;
  to: CameraState;
  start: number;
  duration: number;
}

export class CameraRig {
  private goal: CameraState;
  private current: CameraState;
  private flight: Flight | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchStart: { dist: number; angle: number; mid: { x: number; y: number } } | null = null;
  private dragMode: 'orbit' | 'pan' | null = null;
  private interacting = false;
  private lastTap: { time: number; x: number; y: number } | null = null;
  private lastTouchFocus = -Infinity;
  /** Notificato alla prima interazione dell'utente. */
  onUserInput: (() => void) | null = null;
  /** Notificato quando l'utente sposta il punto osservato (trascinamento, doppio tocco). */
  onPan: (() => void) | null = null;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly element: HTMLElement,
    initial: CameraState,
  ) {
    this.goal = clampState(initial);
    this.current = { ...this.goal };
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', this.onContextMenu);
    element.addEventListener('dblclick', this.onDoubleClick);
    this.apply();
  }

  get state(): CameraState {
    return this.current;
  }

  get isGlobe(): boolean {
    return this.goal.distance >= GLOBE_THRESHOLD;
  }

  get isFlying(): boolean {
    return this.flight !== null;
  }

  /** Volo animato verso uno stato. */
  flyTo(target: Partial<CameraState>, duration = 1800): void {
    const to = clampState({ ...this.goal, ...target });
    this.flight = { from: { ...this.current }, to, start: performance.now(), duration };
    this.goal = to;
  }

  /** Posiziona subito la camera (regia): nessun volo né smorzamento. */
  set(state: CameraState): void {
    this.flight = null;
    this.goal = clampState(state);
    this.current = { ...this.goal };
    this.apply();
  }

  /**
   * Sposta il punto osservato senza cambiare direzione, inclinazione e distanza (es. per
   * seguire l'occhio del ciclone). Il centro si aggiorna subito: nessun ritardo che oscilli.
   */
  setCenter(lat: number, lon: number): void {
    if (this.flight) return;
    this.goal = clampState({ ...this.goal, lat, lon });
    this.current = { ...this.current, lat: this.goal.lat, lon: this.goal.lon };
    this.apply();
  }

  /** Rotazione e inclinazione da tastiera, in gradi. */
  orbitBy(dHeading: number, dTilt: number): void {
    this.flight = null;
    this.goal = clampState({ ...this.goal, heading: this.goal.heading + dHeading, tilt: this.goal.tilt + dTilt });
  }

  zoomBy(factor: number): void {
    this.flight = null;
    this.goal = clampState({ ...this.goal, distance: this.goal.distance * factor });
  }

  /** Aggiorna la camera; restituisce true se si è mossa (serve un nuovo frame). */
  update(dt: number): boolean {
    const before = this.current;
    if (this.flight) {
      const f = Math.min(1, (performance.now() - this.flight.start) / this.flight.duration);
      // Ease in-out cubico: partenza e arrivo morbidi, come un movimento di macchina da presa.
      const e = f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2;
      this.current = lerpState(this.flight.from, this.flight.to, e);
      if (f >= 1) this.flight = null;
    } else {
      const k = 1 - Math.exp(-dt * (this.interacting ? 18 : 9));
      this.current = lerpState(this.current, this.goal, k);
    }
    const moved =
      Math.abs(before.lat - this.current.lat) > 1e-6 ||
      Math.abs(before.lon - this.current.lon) > 1e-6 ||
      Math.abs(before.heading - this.current.heading) > 1e-5 ||
      Math.abs(before.tilt - this.current.tilt) > 1e-5 ||
      Math.abs(before.distance - this.current.distance) > 1e-7;
    if (moved) this.apply();
    return moved;
  }

  dispose(): void {
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerup', this.onPointerUp);
    this.element.removeEventListener('pointercancel', this.onPointerUp);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    this.element.removeEventListener('dblclick', this.onDoubleClick);
  }

  private apply(): void {
    const pose = cameraPose(this.current);
    this.camera.position.set(...pose.position);
    this.camera.up.set(...pose.up);
    this.camera.lookAt(...pose.target);
    // Piani di clipping adattati alla distanza: più precisione di profondità da vicino.
    const d = this.camera.position.length();
    this.camera.near = Math.max(0.0005, (d - 1) * 0.05);
    this.camera.far = d + 2;
    this.camera.updateProjectionMatrix();
  }

  /** Gradi di superficie per pixel di schermo, alla distanza attuale. */
  private degreesPerPixel(): number {
    const h = this.element.clientHeight || 1;
    const fov = (this.camera.fov * Math.PI) / 180;
    const units = (2 * this.goal.distance * Math.tan(fov / 2)) / h;
    return (units * 180) / Math.PI;
  }

  private pan(dx: number, dy: number): void {
    const k = this.degreesPerPixel();
    const h = (this.goal.heading * Math.PI) / 180;
    // Lo schermo "in alto" corrisponde alla direzione dello sguardo.
    const north = (dy * Math.cos(h) + dx * Math.sin(h)) * k;
    const east = (-dx * Math.cos(h) + dy * Math.sin(h)) * k;
    const cosLat = Math.max(0.2, Math.cos((this.goal.lat * Math.PI) / 180));
    this.goal = clampState({ ...this.goal, lat: this.goal.lat + north, lon: this.goal.lon + east / cosLat });
    if (dx !== 0 || dy !== 0) this.onPan?.();
  }

  /** Punto della superficie sotto un pixel dello schermo (sfera unitaria), se c'è. */
  private pick(clientX: number, clientY: number): { lat: number; lon: number } | null {
    const rect = this.element.getBoundingClientRect();
    const ndc = new Vector3(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1, 0.5);
    const origin = this.camera.position.clone();
    const dir = ndc.unproject(this.camera).sub(origin).normalize();
    const b = origin.dot(dir);
    const disc = b * b - (origin.lengthSq() - 1);
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t <= 0) return null;
    const p = origin.addScaledVector(dir, t);
    return vectorToLatLon([p.x, p.y, p.z]);
  }

  /** Vola sul punto toccato, avvicinandosi un poco. */
  private focusAt(clientX: number, clientY: number): void {
    const hit = this.pick(clientX, clientY);
    if (!hit) return;
    this.onUserInput?.();
    this.onPan?.();
    this.flyTo({ lat: hit.lat, lon: hit.lon, distance: this.goal.distance * 0.7 }, 1200);
  }

  private readonly onDoubleClick = (event: MouseEvent) => {
    // Il tocco ha il suo riconoscimento (onPointerDown): si ignora il dblclick sintetico che segue.
    if (performance.now() - this.lastTouchFocus < 800) return;
    this.focusAt(event.clientX, event.clientY);
  };

  private orbit(dx: number, dy: number): void {
    this.goal = clampState({
      ...this.goal,
      heading: this.goal.heading - dx * 0.25,
      // Trascinare verso l'alto inclina lo sguardo verso l'orizzonte.
      tilt: this.goal.tilt - dy * 0.2,
    });
  }

  private beginInput(): void {
    this.flight = null;
    this.interacting = true;
    this.onUserInput?.();
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch' && this.pointers.size === 0) {
      // Doppio tocco: due tocchi brevi e vicini.
      const now = performance.now();
      const last = this.lastTap;
      if (last && now - last.time < 320 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 30) {
        this.lastTap = null;
        this.lastTouchFocus = now;
        this.focusAt(event.clientX, event.clientY);
        return;
      }
      this.lastTap = { time: now, x: event.clientX, y: event.clientY };
    }
    this.element.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.beginInput();
    if (this.pointers.size === 2) {
      this.pinchStart = this.pinchGeometry();
      this.dragMode = null;
    } else {
      this.dragMode = event.button === 2 || event.shiftKey || this.isGlobe ? 'pan' : 'orbit';
    }
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const prev = this.pointers.get(event.pointerId);
    if (!prev) return;
    const dx = event.clientX - prev.x;
    const dy = event.clientY - prev.y;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.pointers.size >= 2 && this.pinchStart) {
      const now = this.pinchGeometry();
      this.goal = clampState({
        ...this.goal,
        distance: this.goal.distance * (this.pinchStart.dist / Math.max(now.dist, 1)),
        heading: this.goal.heading - ((now.angle - this.pinchStart.angle) * 180) / Math.PI,
      });
      this.pan(now.mid.x - this.pinchStart.mid.x, now.mid.y - this.pinchStart.mid.y);
      this.pinchStart = now;
      return;
    }
    if (this.dragMode === 'pan') this.pan(dx, dy);
    else if (this.dragMode === 'orbit') this.orbit(dx, dy);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinchStart = null;
    if (this.pointers.size === 0) {
      this.dragMode = null;
      this.interacting = false;
    }
  };

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.beginInput();
    this.interacting = false;
    // deltaMode 1 = righe (Firefox); il trackpad di macOS produce valori piccoli e frequenti.
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    this.zoomBy(Math.exp(delta * 0.0015));
  };

  private readonly onContextMenu = (event: Event) => event.preventDefault();

  private pinchGeometry() {
    const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }
}
