import './universe.css';
import { Vector3, type PerspectiveCamera, type Scene, type Texture } from 'three';
import { APPS, type AppEntry } from './apps';
import { createAppObject, type AppObject } from './objects';
import { createWindowManager } from './windows';

/**
 * APP UNIVERSE — le applicazioni come oggetti nella città di volo. Modulo separato dal pilotaggio:
 * usa soltanto i comandi pubblici del pilota (stato e modalità ESPLORA).
 *
 * In volo il trascinamento resta la cloche; avvicinandosi a un oggetto compare il nome.
 * ESPLORA mette il velivolo in hovering: da quel momento un tocco seleziona (oggetto o elenco) e non fa virare.
 * Più app possono restare aperte insieme (windows.ts), anche in volo e dopo l'atterraggio: ciascuna si chiude solo con la sua X.
 */

export interface UniversePilot {
  readonly state: { phase: string; x: number; y: number; z: number };
  explore(on: boolean, face?: { x: number; y: number; z: number } | null): boolean;
}

export interface UniverseContext {
  scene: Scene;
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  root: HTMLElement;
  /** Ambiente per i riflessi dei materiali (lo stesso, attenuato, del velivolo). */
  env: Texture;
  /** Edifici [minX, maxX, minZ, maxZ, altezza]: per non mostrare etichette di oggetti nascosti. */
  volumes: [number, number, number, number, number][];
  apps?: AppEntry[];
  /** Interrompe gli ascoltatori globali all'uscita dal simulatore. */
  signal?: AbortSignal;
}

interface Item {
  app: AppEntry;
  obj: AppObject;
  center: Vector3;
  label: HTMLButtonElement;
  meta: HTMLSpanElement;
  chip: HTMLButtonElement;
  chipMeta: HTMLSpanElement;
  occluded: boolean;
  shown: number;
}

const NEAR = 340;
const FAR_EXPLORE = 2600;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

const fmtDist = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);

export function createUniverse(ctx: UniverseContext) {
  const { scene, camera, canvas } = ctx;
  const apps = ctx.apps ?? APPS;

  // ── Interfaccia.
  const layer = el('div', 'au-layer');
  const labels = el('div', 'au-labels');
  const exploreBtn = el('button', 'au-explore', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3"/></svg><span>ESPLORA</span>');
  exploreBtn.type = 'button';
  exploreBtn.hidden = true;
  const pick = el('div', 'au-pick');
  pick.hidden = true;
  const pickHint = el('p', 'au-pick__hint', 'In hovering · tocca un oggetto luminoso o scegli un’app');
  const pickList = el('div', 'au-pick__list');
  pick.append(pickHint, pickList);
  const hint = el('div', 'au-hint');
  hint.hidden = true;
  layer.append(labels, pick, exploreBtn, hint);
  ctx.root.append(layer);

  let exploring = false;
  /** Ultima app scelta (il velivolo in hovering si orienta verso di lei). */
  let selected: Item | null = null;
  let shiftDirty = true;
  // Gli oggetti delle app aperte restano evidenziati finché la loro finestra è aperta.
  const wm = createWindowManager(layer, {
    onFlight: () => setExplore(!exploring),
    onClosed: (app) => {
      const it = items.find((i) => i.app.id === app.id);
      it?.obj.setHighlight(false);
      it?.chip.setAttribute('aria-pressed', 'false');
      if (selected === it) selected = null;
    },
    onChange: () => {
      shiftDirty = true;
      layer.classList.toggle('has-monitor', wm.anyVisible);
    },
  }, ctx.signal);
  addEventListener('resize', () => (shiftDirty = true), ctx.signal ? { signal: ctx.signal } : {});

  // ── Oggetti nella città.
  const items: Item[] = apps.map((app) => {
    const obj = createAppObject(app.object, app.radius, app.accent, ctx.env);
    obj.group.position.set(...app.position);
    scene.add(obj.group);
    const label = el('button', 'au-label', `<span class="au-label__name">${app.name}</span><span class="au-label__meta"></span>`);
    label.type = 'button';
    label.style.setProperty('--au-accent', app.accent);
    label.tabIndex = -1;
    labels.append(label);
    const chip = el('button', 'au-chip', `<i></i><b>${app.name}</b><span></span>`);
    chip.type = 'button';
    chip.style.setProperty('--au-accent', app.accent);
    pickList.append(chip);
    const item: Item = {
      app,
      obj,
      center: new Vector3(...app.position),
      label,
      meta: label.querySelector('.au-label__meta') as HTMLSpanElement,
      chip,
      chipMeta: chip.querySelector('span') as HTMLSpanElement,
      occluded: false,
      shown: 0,
    };
    label.addEventListener('click', () => exploring && select(item));
    chip.addEventListener('click', () => select(item));
    return item;
  });

  let pilot: UniversePilot | null = null;
  const setExplore = (on: boolean) => {
    if (!pilot) return;
    if (on) {
      if (!pilot.explore(true)) return;
      exploring = true;
      hint.hidden = true;
    } else {
      // Si riprende il volo: le finestre e le app restano aperte.
      pilot.explore(false);
      exploring = false;
    }
    layer.classList.toggle('is-exploring', exploring);
    pick.hidden = !exploring;
    exploreBtn.querySelector('span')!.textContent = exploring ? 'RIPRENDI IL VOLO' : 'ESPLORA';
    exploreBtn.setAttribute('aria-pressed', String(exploring));
  };
  const select = (item: Item) => {
    if (!pilot) return;
    if (!exploring) setExplore(true);
    if (!exploring) return;
    selected = item;
    item.obj.setHighlight(true);
    // In hovering il velivolo ruota verso l'oggetto: la camera lo inquadra.
    pilot.explore(true, item.center);
    item.chip.setAttribute('aria-pressed', 'true');
    wm.open(item.app);
  };
  exploreBtn.addEventListener('click', () => setExplore(!exploring));

  // ── Selezione con tocco o clic sugli oggetti (solo in ESPLORA: il gesto non arriva mai alla cloche).
  const screenOf = (p: Vector3) => {
    const v = p.clone().project(camera);
    return { x: (v.x * 0.5 + 0.5) * canvas.clientWidth, y: (-v.y * 0.5 + 0.5) * canvas.clientHeight, front: v.z < 1 && v.z > -1 };
  };
  const pxPerUnit = () => canvas.clientHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
  let down: { id: number; x: number; y: number; t: number } | null = null;
  const onCanvas: AddEventListenerOptions = ctx.signal ? { signal: ctx.signal } : {};
  canvas.addEventListener('pointerdown', (e) => {
    if (!exploring) return;
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
  }, onCanvas);
  canvas.addEventListener('pointerup', (e) => {
    if (!exploring || !down || e.pointerId !== down.id) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 800;
    down = null;
    if (moved > 14 || !quick) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best: Item | null = null;
    let bestDepth = Infinity;
    for (const it of items) {
      if (it.occluded) continue;
      const s = screenOf(it.center);
      if (!s.front) continue;
      const d = camera.position.distanceTo(it.center);
      const rad = Math.max(30, ((it.app.radius * pxPerUnit()) / d) * 1.1);
      if (Math.hypot(s.x - x, s.y - y) < rad && d < bestDepth) {
        best = it;
        bestDepth = d;
      }
    }
    if (best) select(best);
  }, onCanvas);

  // ── Visibilità delle etichette: segmento camera → oggetto contro gli edifici.
  const blocked = (from: Vector3, to: Vector3, shorten: number) => {
    const d = new Vector3().subVectors(to, from);
    const len = d.length();
    const tEnd = Math.max(0, 1 - shorten / len);
    for (const [x0, x1, z0, z1, h] of ctx.volumes) {
      let t0 = 0;
      let t1 = tEnd;
      const slab = (o: number, dd: number, lo: number, hi: number) => {
        if (Math.abs(dd) < 1e-9) return o >= lo && o <= hi;
        let a = (lo - o) / dd;
        let b = (hi - o) / dd;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
        return t0 <= t1;
      };
      if (slab(from.x, d.x, x0, x1) && slab(from.y, d.y, -1, h) && slab(from.z, d.z, z0, z1)) return true;
    }
    return false;
  };

  let checkAt = 0;
  let flightMode: 'resume' | 'explore' | 'hidden' | '' = '';
  let hintShownFor = new Set<string>();
  let hintTimer = 0;
  const up = new Vector3();
  const aircraft = new Vector3();
  // Con finestre aperte il centro dell'inquadratura si sposta nella parte libera dello schermo
  // (ricalcolato solo quando le finestre cambiano o lo schermo si ridimensiona).
  const shift = { x: 0, y: 0, tx: 0, ty: 0, applied: false };
  const updateShift = (dt: number) => {
    if (shiftDirty) {
      shiftDirty = false;
      shift.tx = shift.ty = 0;
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      const rects = wm.visibleRects();
      const wideRect = rects.find((r) => r.width > W * 0.7);
      if (wideRect) {
        // Telefono: finestra in alto o in basso.
        const free = wideRect.top + wideRect.height / 2 > H / 2 ? [70, wideRect.top] : [wideRect.bottom, H - 100];
        shift.ty = Math.max(-H * 0.3, Math.min(H * 0.3, H / 2 - (free[0]! + free[1]!) / 2));
      } else if (rects.length) {
        // Desktop: spazio libero tra le finestre a sinistra e quelle a destra.
        let lo = 0;
        let hi = W;
        for (const r of rects) {
          if (r.left + r.width / 2 < W / 2) lo = Math.max(lo, r.right);
          else hi = Math.min(hi, r.left);
        }
        if (hi - lo > W * 0.25) shift.tx = Math.max(-W * 0.3, Math.min(W * 0.3, W / 2 - (lo + hi) / 2));
      }
    }
    const k = 1 - Math.exp(-5 * dt);
    shift.x += (shift.tx - shift.x) * k;
    shift.y += (shift.ty - shift.y) * k;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (Math.abs(shift.x) > 0.5 || Math.abs(shift.y) > 0.5) {
      camera.setViewOffset(W, H, shift.x, shift.y, W, H);
      shift.applied = true;
    } else if (shift.applied) {
      shift.x = shift.y = 0;
      camera.clearViewOffset();
      shift.applied = false;
    }
  };

  return {
    /** Ostacoli per il pilotaggio (sfere d'ingombro). */
    obstacles: items.map((it) => ({ x: it.center.x, y: it.center.y, z: it.center.z, r: it.app.radius })),
    /** Uscita dal simulatore: app scaricate, oggetti e interfaccia rimossi. */
    dispose() {
      wm.dispose();
      for (const it of items) {
        scene.remove(it.obj.group);
        it.obj.dispose();
      }
      layer.remove();
      camera.clearViewOffset();
    },
    bind(p: UniversePilot) {
      pilot = p;
      // Una riga nella guida del pilotaggio.
      const guideList = ctx.root.querySelector('.pl-guide ul');
      if (guideList) guideList.append(el('li', undefined, '<b>ESPLORA</b>: il velivolo si ferma in volo; tocca un oggetto luminoso o scegli un’app dall’elenco.'));
    },
    update(dt: number, t: number) {
      const frame = { camera, pxScale: canvas.height / (2 * Math.tan((camera.fov * Math.PI) / 360)) };
      for (const it of items) it.obj.update(t, dt, frame);
      if (!pilot) return;
      const st = pilot.state;
      const phase = st.phase;
      // Crash, atterraggio o altro: si esce da ESPLORA senza lasciare stati sospesi.
      if (exploring && phase !== 'explore') setExplore(false);
      const flying = phase === 'flying' || phase === 'transition';
      exploreBtn.hidden = !(flying || exploring);
      const mode = exploring ? 'resume' : flying ? 'explore' : 'hidden';
      if (mode !== flightMode) wm.setFlightButton((flightMode = mode));
      aircraft.set(st.x, st.y, st.z);

      const now = performance.now();
      updateShift(dt);
      const recheck = now - checkAt > 100;
      if (recheck) checkAt = now;
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      const ppu = pxPerUnit();
      for (const it of items) {
        const dist = aircraft.distanceTo(it.center);
        const camDist = camera.position.distanceTo(it.center);
        if (recheck) {
          it.occluded = blocked(camera.position, it.center, it.app.radius * 0.6);
          const text = fmtDist(Math.max(0, dist - it.app.radius));
          it.meta.textContent = text;
          it.chipMeta.textContent = text;
        }
        const top = it.center.clone().addScaledVector(up, it.app.radius * 1.15);
        const s = screenOf(top);
        const onScreen = s.front && s.x > -40 && s.x < canvas.clientWidth + 40 && s.y > -20 && s.y < canvas.clientHeight + 40;
        let want = 0;
        if (onScreen && !it.occluded && phase !== 'parked' && phase !== 'intro') {
          if (exploring) want = camDist < FAR_EXPLORE ? 1 : 0;
          else if (flying || phase === 'return') want = dist < NEAR ? Math.min(1, (NEAR - dist) / 80) : 0;
        }
        if (it === selected) want = onScreen && !it.occluded && phase !== 'intro' ? 1 : 0;
        it.shown += (want - it.shown) * (1 - Math.exp(-6 * dt));
        const visible = it.shown > 0.02;
        it.label.hidden = !visible;
        if (visible) {
          // L'etichetta resta sopra l'oggetto, più piccola da lontano.
          const k = Math.max(0.82, Math.min(1, (it.app.radius * ppu) / camDist / 60 + 0.8));
          it.label.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -100%) scale(${k.toFixed(3)})`;
          it.label.style.opacity = it.shown.toFixed(3);
          it.label.classList.toggle('is-selected', it === selected);
          it.label.classList.toggle('is-pickable', exploring);
        }
        // Primo avvicinamento in volo: suggerimento discreto (una volta per app).
        if (flying && !exploring && want > 0.6 && !hintShownFor.has(it.app.id)) {
          hintShownFor.add(it.app.id);
          hint.textContent = `${it.app.name} · premi ESPLORA per aprirla`;
          hint.hidden = false;
          hintTimer = 3.2;
        }
      }
      if (hintTimer > 0) {
        hintTimer -= dt;
        if (hintTimer <= 0 || exploring) hint.hidden = true;
      }
    },
    /** Comandi per i test automatici (stessa logica di pulsanti e tocchi). */
    api: {
      explore: (on: boolean) => setExplore(on),
      select: (id: string) => {
        const it = items.find((i) => i.app.id === id);
        if (it) select(it);
      },
      close: (id: string) => wm.close(id),
      minimize: (id: string) => wm.minimize(id),
      restore: (id: string) => wm.restore(id),
      focus: (id: string) => wm.focus(id),
      minimizeAll: () => wm.minimizeAll(),
      /** Punto dello schermo (CSS px) del centro di un oggetto, per i test di tocco. */
      screenPoint: (id: string) => {
        const it = items.find((i) => i.app.id === id);
        return it ? { ...screenOf(it.center), occluded: it.occluded } : null;
      },
      get state() {
        return {
          exploring,
          selected: selected?.app.id ?? null,
          windows: wm.state,
          labels: items.filter((i) => !i.label.hidden).map((i) => i.app.id),
        };
      },
      resetHints: () => (hintShownFor = new Set()),
    },
  };
}

export type Universe = ReturnType<typeof createUniverse>;
