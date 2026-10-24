import { type PerspectiveCamera } from 'three';
import { cameraPose, clampState, lerpState, type CameraState } from './camera-pose';

/**
 * Controller di camera originale per ATMOSPHERA.
 *
 * Vicino alla superficie (vista regionale):
 *   trascina con un dito / tasto sinistro → ruota attorno al punto osservato e inclina
 *   due dita / tasto destro / Maiusc + trascina → sposta il punto osservato
 *   pizzica / rotella → zoom
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
  /** Notificato alla prima interazione dell'utente. */
  onUserInput: (() => void) | null = null;

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
    this.apply();
  }

  get state(): CameraState {
    return this.current;
  }

  get isGlobe(): boolean {
    return this.goal.distance >= GLOBE_THRESHOLD;
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
  }

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
