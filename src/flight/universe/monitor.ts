import type { AppEntry, AppObjectKind } from './apps';

/**
 * Finestra di un'applicazione in APP UNIVERSE (una per app): nome, descrizione, anteprima reale quando il sito la
 * consente, collegamento all'app originale (sempre disponibile), riduzione a icona, chiusura, pulsante di volo.
 *
 * Anteprima incorporata solo per le app verificate come incorporabili (apps.ts). L'evento load dell'iframe
 * non basta: prima si verifica che il sito risponda (fetch CORS, nessun cookie, nessun referrer), poi si attende
 * il caricamento con un tempo massimo; in ogni caso la scheda e il collegamento restano disponibili.
 * Nessuna restrizione viene aggirata: se il sito non consente l'incorporamento si mostra solo la scheda.
 *
 * Persistenza: l'iframe nasce alla prima apertura e muore solo con la X. Riduzione, ripristino e primo piano
 * cambiano soltanto visibilità e z-index (mai lo spostamento del nodo nel documento, che ricaricherebbe l'app);
 * da ridotta la finestra conserva le dimensioni, così l'app non riceve nemmeno un ridimensionamento.
 * Su schermi ampi si sposta trascinandone l'intestazione; i gesti sulla finestra non arrivano mai alla scena 3D.
 */

const GLYPH: Record<AppObjectKind, string> = {
  atmosphere:
    '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="15"/><path d="M20 30c4-3 8-3 12 0s8 3 12 0M19 36c5 2 9 2 13-1s9-3 14 0" /><ellipse cx="32" cy="32" rx="27" ry="8" transform="rotate(-12 32 32)" opacity=".55"/></svg>',
  cube: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 8l21 12v24L32 56 11 44V20z"/><path d="M11 20l21 12 21-12M32 32v24M18 16l21 12v24M25 12l21 12M11 28l21 12 21-12M11 36l21 12 21-12" opacity=".6"/></svg>',
  network:
    '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="18"/><path d="M14 32h36M32 14c-7 6-7 30 0 36M32 14c7 6 7 30 0 36" opacity=".5"/><circle cx="22" cy="24" r="2.4" class="dot"/><circle cx="40" cy="22" r="2.4" class="dot"/><circle cx="43" cy="38" r="2.4" class="dot"/><circle cx="26" cy="42" r="2.4" class="dot"/><path d="M22 24L40 22 43 38 26 42z" opacity=".8"/></svg>',
  orbital:
    '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="28" y="24" width="8" height="16" rx="2"/><path d="M6 28h16v8H6zM42 28h16v8H42zM22 32h6M36 32h6"/><ellipse cx="32" cy="32" rx="22" ry="22" opacity=".45" transform="rotate(30 32 32) scale(1 .45) translate(0 39)"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

const hostOf = (url: string) => new URL(url).host.replace(/^www\./, '');

/** Motore WebKit: Safari e tutti i browser su iPhone/iPad (anche iPad che si presenta come Mac). */
const isWebKit = (() => {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios || (/AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua));
})();

export interface AppWindowEvents {
  /** X: chiusura volontaria (scarica l'app). */
  onClose(): void;
  /** Riduzione a icona dalla finestra. */
  onMinimize(): void;
  /** Interazione con la finestra: va in primo piano. */
  onFocus(): void;
  /** Pulsante di volo (riprendi il volo / esplora). */
  onFlight(): void;
  /** Fine di uno spostamento manuale. */
  onMoved(): void;
}

export function createAppWindow(root: HTMLElement, app: AppEntry, events: AppWindowEvents) {
  const panel = el('aside', 'au-monitor');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `${app.name}: finestra dell'applicazione`);
  panel.dataset.app = app.id;
  panel.style.setProperty('--au-accent', app.accent);
  panel.innerHTML = `
    <header class="au-mon__head" title="Trascina per spostare la finestra">
      <span class="au-mon__grip" aria-hidden="true"></span>
      <div>
        <span class="au-mon__kicker"></span>
        <h2 class="au-mon__name"></h2>
        <p class="au-mon__tag"></p>
      </div>
      <button type="button" class="au-mon__min" aria-label="Riduci a icona"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button>
      <button type="button" class="au-mon__x" aria-label="Chiudi l’applicazione"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </header>
    <div class="au-mon__screen">
      <div class="au-mon__card">
        <div class="au-mon__glyph"></div>
        <b class="au-mon__cardname"></b>
        <span class="au-mon__cardtag"></span>
        <span class="au-mon__reason"></span>
        <button type="button" class="au-mon__load" hidden>Mostra anteprima</button>
      </div>
      <div class="au-mon__status" hidden></div>
    </div>
    <p class="au-mon__desc"></p>
    <div class="au-mon__actions">
      <a class="au-mon__open" target="_blank" rel="noopener noreferrer">Apri l’app <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h9v9M18 6L7 17"/></svg></a>
      <button type="button" class="au-mon__back">Riprendi il volo</button>
    </div>`;
  root.append(panel);
  const q = <T extends HTMLElement>(sel: string) => panel.querySelector(sel) as T;
  const screen = q<HTMLDivElement>('.au-mon__screen');
  const status = q<HTMLDivElement>('.au-mon__status');
  const card = q<HTMLDivElement>('.au-mon__card');
  const reason = q<HTMLSpanElement>('.au-mon__reason');
  const openLink = q<HTMLAnchorElement>('.au-mon__open');
  const loadBtn = q<HTMLButtonElement>('.au-mon__load');
  const backBtn = q<HTMLButtonElement>('.au-mon__back');
  q<HTMLSpanElement>('.au-mon__kicker').textContent = app.url ? `App · ${hostOf(app.url)}` : 'App · indirizzo da verificare';
  q<HTMLHeadingElement>('.au-mon__name').textContent = app.name;
  q<HTMLParagraphElement>('.au-mon__tag').textContent = app.tagline;
  q<HTMLParagraphElement>('.au-mon__desc').textContent = app.description;
  q<HTMLDivElement>('.au-mon__glyph').innerHTML = GLYPH[app.object];
  q<HTMLElement>('.au-mon__cardname').textContent = app.name;
  q<HTMLSpanElement>('.au-mon__cardtag').textContent = app.tagline;
  if (app.url) openLink.href = app.url;
  else openLink.setAttribute('aria-disabled', 'true');

  q<HTMLButtonElement>('.au-mon__x').addEventListener('click', () => events.onClose());
  q<HTMLButtonElement>('.au-mon__min').addEventListener('click', () => events.onMinimize());
  backBtn.addEventListener('click', () => events.onFlight());
  // Qualsiasi interazione con la finestra (fuori dall'iframe) la porta in primo piano.
  panel.addEventListener('pointerdown', () => events.onFocus(), { capture: true });
  loadBtn.addEventListener('click', () => {
    loadBtn.hidden = true;
    reason.textContent = '';
    void embed();
  });

  let closed = false;
  let frame: HTMLIFrameElement | null = null;
  let watchdog = 0;
  let loads = 0;
  let minimized = false;
  /** Esito della verifica dell'anteprima (per i test e per il resoconto). */
  let preview: 'none' | 'request' | 'checking' | 'loading' | 'shown' | 'fallback' = 'none';
  let previewNote = '';

  const setStatus = (text: string) => {
    status.textContent = text;
    status.hidden = !text;
  };
  const dropFrame = () => {
    clearTimeout(watchdog);
    if (frame) {
      frame.src = 'about:blank';
      frame.remove();
      frame = null;
    }
    screen.classList.remove('is-live');
  };
  const fallback = (why: string) => {
    dropFrame();
    preview = 'fallback';
    previewNote = why;
    card.hidden = false;
    reason.textContent = why;
    setStatus('');
  };

  const embed = async () => {
    preview = 'checking';
    setStatus('Verifica del collegamento…');
    if (!navigator.onLine) return fallback('Sei offline: l’anteprima non è disponibile.');
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 7000);
      // 'cors': stato e tipo della risposta leggibili; 'reach' (sito senza CORS): solo raggiungibilità del server.
      const cors = (app.open.check ?? 'cors') === 'cors';
      const res = await fetch(app.url!, { mode: cors ? 'cors' : 'no-cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: abort.signal });
      clearTimeout(timer);
      if (closed) return;
      if (cors && !res.ok) return fallback(`Il sito ha risposto con errore ${res.status}: anteprima non disponibile.`);
      if (cors && !(res.headers.get('content-type') ?? '').includes('text/html')) return fallback('Risposta inattesa dal sito: anteprima non disponibile.');
    } catch {
      if (closed) return;
      return fallback('Il sito non risponde in questo momento: anteprima non disponibile.');
    }
    preview = 'loading';
    setStatus('Caricamento dell’anteprima…');
    const f = document.createElement('iframe');
    f.className = 'au-mon__frame';
    f.title = `Anteprima di ${app.name}`;
    f.referrerPolicy = 'no-referrer';
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
    f.setAttribute('allow', '');
    frame = f;
    f.addEventListener('load', () => {
      if (closed || f.src === 'about:blank' || preview === 'shown') return;
      clearTimeout(watchdog);
      // Breve attesa perché l'app disegni il primo fotogramma, poi l'anteprima sostituisce la scheda.
      setTimeout(() => {
        if (closed) return;
        preview = 'shown';
        screen.classList.add('is-live');
        setStatus(app.open.check === 'reach' ? 'Anteprima dal sito originale · se mostra un errore il servizio non è attivo: usa «Apri l’app»' : 'Anteprima dal sito originale · se resta vuota usa «Apri l’app»');
      }, 700);
    });
    watchdog = window.setTimeout(() => {
      if (!closed && preview === 'loading') fallback('L’anteprima non si è caricata in tempo: usa «Apri l’app».');
    }, 12000);
    f.src = app.url!;
    loads++;
    screen.prepend(f);
  };

  // Prima apertura: anteprima automatica, su richiesta o scheda.
  if (app.url && app.open.mode === 'iframe' && app.open.noEmbedOnWebKit && isWebKit) {
    previewNote = app.open.noEmbedOnWebKit;
    reason.textContent = previewNote;
    preview = 'fallback';
  } else if (app.url && app.open.mode === 'iframe' && app.open.onRequest) {
    previewNote = app.open.reason;
    reason.textContent = app.open.reason;
    loadBtn.hidden = false;
    preview = 'request';
  } else if (app.url && app.open.mode === 'iframe') {
    void embed();
  } else {
    previewNote = app.url ? app.open.reason : 'Indirizzo pubblico non ancora verificato.';
    reason.textContent = previewNote;
    preview = 'fallback';
  }

  // Spostamento (schermi ampi): si trascina l'intestazione; il gesto resta alla finestra grazie alla cattura del puntatore.
  const head = q<HTMLElement>('.au-mon__head');
  const wide = () => innerWidth > 720;
  let drag: { id: number; dx: number; dy: number } | null = null;
  const moveTo = (left: number, top: number) => {
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    panel.style.left = `${Math.round(Math.min(Math.max(8, left), innerWidth - w - 8))}px`;
    panel.style.top = `${Math.round(Math.min(Math.max(8, top), innerHeight - h - 8))}px`;
  };
  head.addEventListener('pointerdown', (e) => {
    if (!wide() || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
    panel.classList.add('is-dragging');
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    moveTo(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    panel.classList.remove('is-dragging');
    events.onMoved();
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  return {
    app,
    element: panel,
    /** L'iframe di questa finestra (per riconoscere il primo piano quando si interagisce dentro l'app). */
    get frame() {
      return frame;
    },
    get minimized() {
      return minimized;
    },
    get state() {
      return { app: app.id, minimized, preview, note: previewNote, iframe: !!frame, loads, z: Number(panel.style.zIndex || 0), rect: [panel.offsetLeft, panel.offsetTop, panel.offsetWidth, panel.offsetHeight] };
    },
    setMinimized(v: boolean) {
      minimized = v;
      panel.classList.toggle('is-min', v);
      panel.setAttribute('aria-hidden', String(v));
      // Da ridotta non riceve il focus da tastiera né i gesti.
      panel.inert = v;
    },
    setZ(z: number) {
      panel.style.zIndex = String(z);
    },
    setFront(v: boolean) {
      panel.classList.toggle('is-front', v);
    },
    /** Posizione libera (schermi ampi); null = ancoraggio del foglio di stile (telefono). */
    place(pos: { left: number; top: number } | null) {
      if (!pos) {
        panel.style.left = panel.style.top = '';
        return;
      }
      moveTo(pos.left, pos.top);
    },
    clamp() {
      if (panel.style.left) moveTo(panel.offsetLeft, panel.offsetTop);
    },
    setFlightButton(mode: 'resume' | 'explore' | 'hidden') {
      backBtn.hidden = mode === 'hidden';
      const text = mode === 'explore' ? 'Esplora' : 'Riprendi il volo';
      if (backBtn.textContent !== text) backBtn.textContent = text;
    },
    destroy() {
      closed = true;
      dropFrame();
      panel.remove();
    },
  };
}

export type AppWindow = ReturnType<typeof createAppWindow>;
