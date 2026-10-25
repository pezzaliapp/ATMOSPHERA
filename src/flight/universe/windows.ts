import type { AppEntry } from './apps';
import { createAppWindow, type AppWindow } from './monitor';

/**
 * APP UNIVERSE — più applicazioni aperte insieme, ciascuna nella propria finestra, con una barra discreta.
 *
 * - Un iframe per app, creato alla prima apertura e scaricato solo con la X: riduzione, ripristino, primo piano,
 *   volo, atterraggio ed ESPLORA non lo toccano. L'ordine di sovrapposizione cambia solo lo z-index:
 *   i nodi non vengono mai spostati nel documento (spostarli ricaricherebbe le app).
 * - Desktop: finestre spostabili, posizioni iniziali a slot liberi (destra, sinistra, poi sfalsate).
 * - Telefono: una sola finestra espansa alla volta; le altre restano caricate ma ridotte, e si cambia dalla barra.
 * - Nessun polling: il primo piano segue i gesti sulla finestra e il focus dell'iframe quando si tocca l'app.
 */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export interface WindowManagerEvents {
  /** Pulsante di volo di una finestra. */
  onFlight(): void;
  /** Una finestra è stata chiusa con la X. */
  onClosed(app: AppEntry): void;
  /** Cambio di finestre visibili o in primo piano. */
  onChange(): void;
}

export function createWindowManager(root: HTMLElement, events: WindowManagerEvents, signal?: AbortSignal) {
  const wins = new Map<string, AppWindow>();
  /** Ordine di apertura (barra) e pila di sovrapposizione (l'ultimo è in primo piano). */
  const order: string[] = [];
  const stack: string[] = [];
  const phone = () => innerWidth <= 720;
  const listen: AddEventListenerOptions = signal ? { signal } : {};
  let flightMode: 'resume' | 'explore' | 'hidden' = 'hidden';

  // ── Barra delle applicazioni aperte.
  const bar = el('div', 'au-task');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Applicazioni aperte');
  bar.hidden = true;
  const chips = el('div', 'au-task__chips');
  const allBtn = el('button', 'au-task__all', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18l5.5-7 4 5 3-3.5L21 18z"/><circle cx="16.5" cy="7.5" r="1.8"/></svg>');
  allBtn.type = 'button';
  allBtn.setAttribute('aria-label', 'Riduci tutte le finestre: solo il panorama');
  allBtn.title = 'Riduci tutte';
  bar.append(chips, allBtn);
  root.append(bar);
  const chipOf = new Map<string, HTMLButtonElement>();
  allBtn.addEventListener('click', () => minimizeAll());

  const frontId = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (!wins.get(stack[i]!)!.minimized) return stack[i]!;
    return null;
  };

  const refresh = () => {
    const front = frontId();
    stack.forEach((id, i) => {
      const w = wins.get(id)!;
      w.setZ(10 + i);
      w.setFront(id === front);
    });
    let visible = 0;
    for (const id of order) {
      const w = wins.get(id)!;
      const c = chipOf.get(id)!;
      c.classList.toggle('is-min', w.minimized);
      c.classList.toggle('is-front', id === front);
      c.setAttribute('aria-pressed', String(!w.minimized));
      c.title = w.minimized ? `Ripristina ${w.app.name}` : id === front ? `Riduci ${w.app.name}` : `Porta in primo piano ${w.app.name}`;
      if (!w.minimized) visible++;
    }
    bar.hidden = order.length === 0;
    allBtn.hidden = visible === 0;
    events.onChange();
  };

  const focus = (id: string) => {
    const w = wins.get(id);
    if (!w || w.minimized) return;
    const i = stack.indexOf(id);
    if (i === stack.length - 1) return refresh();
    stack.splice(i, 1);
    stack.push(id);
    refresh();
  };

  const minimize = (id: string) => {
    wins.get(id)?.setMinimized(true);
    refresh();
  };

  const restore = (id: string) => {
    const w = wins.get(id);
    if (!w) return;
    // Telefono: una finestra espansa alla volta, le altre restano caricate ma ridotte.
    if (phone()) for (const [other, o] of wins) if (other !== id) o.setMinimized(true);
    w.setMinimized(false);
    const i = stack.indexOf(id);
    stack.splice(i, 1);
    stack.push(id);
    refresh();
  };

  // Posizione iniziale (desktop): primo slot libero tra destra, sinistra e le due posizioni sfalsate.
  const placeNew = (w: AppWindow) => {
    if (phone()) return w.place(null);
    const width = w.element.offsetWidth;
    const top = Math.max(110, Math.min(120, innerHeight * 0.14));
    const slots = [
      { left: innerWidth - width - 14, top },
      { left: 14, top },
      { left: innerWidth - width - 58, top: top + 44 },
      { left: 58, top: top + 44 },
    ];
    // Anche le finestre ridotte conservano il loro posto: al ripristino non si sovrappongono alle nuove.
    const taken = [...wins.values()].filter((o) => o !== w).map((o) => ({ left: o.element.offsetLeft, top: o.element.offsetTop }));
    const free = slots.find((s) => !taken.some((r) => Math.abs(r.left - s.left) < 40 && Math.abs(r.top - s.top) < 40));
    w.place(free ?? { left: innerWidth - width - 14 - 28 * (wins.size % 5), top: top + 28 * (wins.size % 5) });
  };

  const close = (id: string) => {
    const w = wins.get(id);
    if (!w) return;
    const wasVisible = !w.minimized;
    w.destroy();
    wins.delete(id);
    order.splice(order.indexOf(id), 1);
    stack.splice(stack.indexOf(id), 1);
    chipOf.get(id)!.remove();
    chipOf.delete(id);
    events.onClosed(w.app);
    // Telefono: chiusa la finestra espansa, torna in vista l'ultima usata (già caricata).
    if (phone() && wasVisible && stack.length) return restore(stack[stack.length - 1]!);
    refresh();
  };

  const minimizeAll = () => {
    for (const w of wins.values()) w.setMinimized(true);
    refresh();
  };

  const open = (app: AppEntry) => {
    if (wins.has(app.id)) {
      restore(app.id);
      return wins.get(app.id)!;
    }
    const w = createAppWindow(root, app, {
      onClose: () => close(app.id),
      onMinimize: () => minimize(app.id),
      onFocus: () => focus(app.id),
      onFlight: () => events.onFlight(),
      onMoved: () => events.onChange(),
    });
    w.setFlightButton(flightMode);
    wins.set(app.id, w);
    order.push(app.id);
    stack.push(app.id);
    if (phone()) for (const [other, o] of wins) if (other !== app.id) o.setMinimized(true);
    placeNew(w);
    const chip = el('button', 'au-task__chip', `<i></i><b>${app.name}</b>`);
    chip.type = 'button';
    chip.style.setProperty('--au-accent', app.accent);
    // Ridotta → ripristina; visibile ma dietro → primo piano; in primo piano → riduci.
    chip.addEventListener('click', () => {
      const win = wins.get(app.id);
      if (!win) return;
      if (win.minimized) restore(app.id);
      else if (frontId() !== app.id) focus(app.id);
      else minimize(app.id);
    });
    chipOf.set(app.id, chip);
    chips.append(chip);
    refresh();
    return w;
  };

  // Toccando dentro un'app (iframe) la pagina perde il focus: la finestra di quell'iframe va in primo piano.
  addEventListener('blur', () =>
    setTimeout(() => {
      const active = document.activeElement;
      for (const [id, w] of wins) if (w.frame && w.frame === active) focus(id);
    }, 0),
  listen,
  );

  // Cambio di formato (rotazione, finestra del browser): telefono = una finestra espansa; desktop = posizioni libere.
  let wasPhone = phone();
  addEventListener('resize', () => {
    const now = phone();
    if (now !== wasPhone) {
      wasPhone = now;
      if (now) {
        const keep = frontId();
        for (const [id, w] of wins) {
          w.place(null);
          if (id !== keep) w.setMinimized(true);
        }
      } else for (const w of wins.values()) placeNew(w);
      refresh();
    } else if (!now) for (const w of wins.values()) w.clamp();
  }, listen);

  return {
    open,
    close,
    /** Uscita dal simulatore: scarica tutte le app e rimuove la barra. */
    dispose() {
      for (const w of wins.values()) w.destroy();
      wins.clear();
      bar.remove();
    },
    focus,
    minimize,
    restore,
    minimizeAll,
    has: (id: string) => wins.has(id),
    get frontId() {
      return frontId();
    },
    get anyVisible() {
      for (const w of wins.values()) if (!w.minimized) return true;
      return false;
    },
    /** Rettangoli delle finestre visibili (per spostare il centro dell'inquadratura nella parte libera). */
    visibleRects() {
      const out: DOMRect[] = [];
      for (const w of wins.values()) if (!w.minimized) out.push(w.element.getBoundingClientRect());
      return out;
    },
    setFlightButton(mode: 'resume' | 'explore' | 'hidden') {
      flightMode = mode;
      for (const w of wins.values()) w.setFlightButton(mode);
    },
    get state() {
      return { front: frontId(), order: [...order], stack: [...stack], windows: Object.fromEntries([...wins].map(([id, w]) => [id, w.state])) };
    },
  };
}

export type WindowManager = ReturnType<typeof createWindowManager>;
