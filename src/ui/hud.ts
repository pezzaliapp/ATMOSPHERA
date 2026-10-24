import { formatUtc } from '../core/clock';
import { formatLat, formatLon } from '../core/geo';
import { categoryLabel, compassIt, KT_TO_KMH, saffirSimpson, type StormState, type StormTrack } from '../data/storm';
import { categoryColor } from '../layers/track';
import type { ThemePreference } from './theme';
import { t } from './i18n';
import { icon, type IconName } from './icons';

/**
 * Interfaccia sovrapposta alla scena: intestazione con modalità, scheda dell'evento,
 * legenda dati (osservato / ricostruito / illustrativo), traccia dell'intensità, comandi.
 */

export type Provenance = 'observed' | 'reconstructed' | 'illustrative';

export interface HudActions {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onToggleView: () => void;
  onThemeCycle: () => void;
  onLayer: (layer: 'clouds' | 'track' | 'labels', visible: boolean) => void;
}

export interface EventInfo {
  title: string;
  subtitle: string;
  time: Date;
  localTimes: readonly { place: string; offsetHours: number; zone: string }[];
  exaggeration: number;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(name: IconName, label: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', 'icon-button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  button.addEventListener('click', onClick);
  return button;
}

const PROVENANCE_LABEL: Record<Provenance, string> = {
  observed: t.observed,
  reconstructed: t.reconstructed,
  illustrative: t.illustrative,
};

function badge(kind: Provenance, short = true): HTMLElement {
  const b = el('span', `badge badge--${kind}`, short ? PROVENANCE_LABEL[kind].slice(0, 3).toUpperCase() : PROVENANCE_LABEL[kind]);
  b.title = PROVENANCE_LABEL[kind];
  b.setAttribute('aria-label', PROVENANCE_LABEL[kind]);
  return b;
}

const THEME_LABEL: Record<ThemePreference, string> = { auto: t.themeAuto, light: t.themeLight, dark: t.themeDark };
const THEME_ICON: Record<ThemePreference, IconName> = { auto: 'theme-auto', light: 'sun', dark: 'moon' };

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Grafico dell'intensità (vento massimo) lungo la traccia, con l'istante corrente evidenziato. */
function intensityChart(track: StormTrack, now: Date): SVGSVGElement {
  const W = 600;
  const H = 64;
  const PAD = { l: 4, r: 4, t: 8, b: 18 };
  const pts = track.points;
  const t0 = Date.parse(pts[0]!.time);
  const t1 = Date.parse(pts.at(-1)!.time);
  const maxKt = 160;
  const x = (ms: number) => PAD.l + ((ms - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (kt: number) => PAD.t + (1 - kt / maxKt) * (H - PAD.t - PAD.b);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'intensity');
  svg.setAttribute('role', 'img');
  const peak = pts.reduce((a, b) => (b.windKt > a.windKt ? b : a));
  svg.setAttribute(
    'aria-label',
    `${t.timelineTitle}: picco di ${peak.windKt} nodi il ${formatUtc(new Date(peak.time)).date}`,
  );

  const add = (name: string, attrs: Record<string, string>) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
    return node;
  };

  // Soglie delle categorie 1 e 5 come riferimento.
  for (const kt of [64, 137]) {
    add('line', { x1: '0', x2: String(W), y1: String(y(kt)), y2: String(y(kt)), class: 'intensity__grid' });
  }
  // Barre colorate per categoria: un segmento per ogni intervallo della best track.
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    add('path', {
      d: `M${x(Date.parse(a.time))},${y(0)} L${x(Date.parse(a.time))},${y(a.windKt)} L${x(Date.parse(b.time))},${y(b.windKt)} L${x(Date.parse(b.time))},${y(0)} Z`,
      fill: categoryColor(Math.max(a.windKt, b.windKt)),
      class: Date.parse(b.time) <= now.getTime() ? 'intensity__past' : 'intensity__future',
    });
  }
  // Etichette dei giorni.
  const day = new Date(t0);
  day.setUTCHours(0, 0, 0, 0);
  for (let d = day.getTime() + 86_400_000; d <= t1; d += 86_400_000) {
    add('line', { x1: String(x(d)), x2: String(x(d)), y1: String(y(0)), y2: String(H - 12), class: 'intensity__tick' });
    const label = add('text', { x: String(x(d) + 3), y: String(H - 4), class: 'intensity__label' });
    label.textContent = `${new Date(d).getUTCDate()} ott`;
  }
  const nx = x(now.getTime());
  add('line', { x1: String(nx), x2: String(nx), y1: '0', y2: String(y(0)), class: 'intensity__now' });
  return svg;
}

export function createHud(root: HTMLElement, actions: HudActions, event: EventInfo, track: StormTrack) {
  // Intestazione
  const header = el('header', 'hud-header');
  const brand = el('div', 'brand');
  brand.append(el('h1', 'brand__name', t.appName), el('span', 'brand__by', t.brand));

  const modes = el('div', 'modes');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', t.modes);
  for (const [label, active] of [
    [t.modeStory, false],
    [t.modeReplay, true],
    [t.modeLive, false],
  ] as const) {
    const b = el('button', 'modes__item', label);
    b.type = 'button';
    if (active) b.setAttribute('aria-pressed', 'true');
    else {
      b.disabled = true;
      b.title = `${label} — ${t.soon}`;
      b.append(el('small', undefined, t.soon));
    }
    modes.append(b);
  }

  const status = el('span', 'status-pill', t.offline);
  status.setAttribute('role', 'status');
  status.dataset.state = 'offline';

  const viewButton = iconButton('globe', t.viewGlobe, actions.onToggleView);
  const themeButton = iconButton('theme-auto', t.themeAuto, actions.onThemeCycle);
  const infoButton = iconButton('info', t.info, () => dialog.showModal());
  const tools = el('div', 'hud-header__tools');
  tools.append(status, viewButton, themeButton, infoButton);
  header.append(brand, modes, tools);

  // Scheda dell'evento
  const card = el('section', 'event-card');
  card.setAttribute('aria-label', event.title);
  const cardTitle = el('h2', 'event-card__title', event.title);
  const cardSub = el('p', 'event-card__subtitle', event.subtitle);
  const category = el('p', 'event-card__category');
  const rows = el('dl', 'event-card__rows');
  const when = el('p', 'event-card__time');
  card.append(cardTitle, cardSub, category, rows, when);

  // Legenda e livelli
  const legend = el('details', 'legend');
  const summary = el('summary', 'legend__summary');
  summary.append(badge('observed'), badge('reconstructed'), badge('illustrative'), el('span', 'legend__summary-text', t.legendTitle));
  const legendBody = el('div', 'legend__body');
  const legendRow = (kind: Provenance, text: string) => {
    const row = el('p', 'legend__row');
    row.append(badge(kind, false), el('span', undefined, text));
    return row;
  };
  const toggles = el('fieldset', 'legend__layers');
  toggles.append(el('legend', undefined, t.layers));
  for (const [key, label] of [
    ['clouds', t.layerClouds],
    ['track', t.layerTrack],
    ['labels', t.layerLabels],
  ] as const) {
    const wrap = el('label', 'switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = true;
    input.addEventListener('change', () => actions.onLayer(key, input.checked));
    wrap.append(input, el('span', undefined, label));
    toggles.append(wrap);
  }
  legendBody.append(
    legendRow('observed', t.legendObserved),
    legendRow('reconstructed', t.legendReconstructed),
    legendRow('illustrative', t.legendIllustrative.replace('{x}', String(event.exaggeration))),
    toggles,
  );
  legend.append(summary, legendBody);

  // Traccia dell'intensità (anteprima della timeline)
  const timeline = el('section', 'timeline');
  timeline.setAttribute('aria-label', t.timelineTitle);
  const timelineHead = el('div', 'timeline__head');
  timelineHead.append(el('span', 'timeline__title', t.timelineTitle), badge('observed'), el('span', 'timeline__soon', t.timelineSoon));
  timeline.append(timelineHead, intensityChart(track, event.time));

  // Comandi di navigazione
  const nav = el('nav', 'view-controls');
  nav.setAttribute('aria-label', 'Navigazione');
  nav.append(
    iconButton('plus', t.zoomIn, actions.onZoomIn),
    iconButton('minus', t.zoomOut, actions.onZoomOut),
    iconButton('home', t.resetView, actions.onReset),
  );

  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const hint = el('p', 'gesture-hint', coarse ? t.gestureHintTouch : t.gestureHint);

  // Pannello informazioni
  const dialog = el('dialog', 'info-dialog');
  dialog.setAttribute('aria-labelledby', 'info-title');
  const dialogTitle = el('h2', undefined, t.aboutTitle);
  dialogTitle.id = 'info-title';
  const closeButton = iconButton('close', t.close, () => dialog.close());
  closeButton.classList.add('info-dialog__close');
  const section = (heading: string, ...paragraphs: string[]) => {
    const s = el('section');
    s.append(el('h3', undefined, heading), ...paragraphs.map((p) => el('p', undefined, p)));
    return s;
  };
  dialog.append(
    closeButton,
    dialogTitle,
    el('p', undefined, t.aboutBody),
    section(t.honestyTitle, t.honestyBody),
    section(t.sourcesTitle, t.sourceGoes, t.sourceTrack, t.sourceDay, t.sourceNight, t.sourceNote),
    section(t.privacyTitle, t.privacyBody),
    section(t.licenseTitle, t.licenseBody),
    el('p', 'info-dialog__version', `${t.version} ${__APP_VERSION__}`),
  );
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  const toast = el('div', 'toast');
  toast.setAttribute('role', 'status');
  toast.hidden = true;

  root.append(header, card, legend, timeline, nav, hint, dialog, toast);

  const updateOnline = () => {
    status.hidden = navigator.onLine;
  };
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();

  const hideHint = () => hint.classList.add('is-hidden');
  window.setTimeout(hideHint, 9000);

  return {
    hideHint,
    setStorm(state: StormState) {
      const cat = saffirSimpson(state.windKt);
      category.replaceChildren();
      const chip = el('span', 'category-chip', categoryLabel(state.windKt, state.status));
      chip.style.setProperty('--cat', categoryColor(state.windKt));
      if (cat >= 1) chip.dataset.cat = String(cat);
      category.append(chip);

      const row = (label: string, value: string, kind: Provenance) => {
        const dt = el('dt', undefined, label);
        const dd = el('dd');
        dd.append(el('span', undefined, value), badge(kind));
        rows.append(dt, dd);
      };
      rows.replaceChildren();
      const exact: Provenance = state.exact ? 'observed' : 'reconstructed';
      row(t.wind, `${Math.round(state.windKt * KT_TO_KMH)} km/h · ${state.windKt} nodi`, exact);
      if (state.pressureHpa !== null) row(t.pressure, `${state.pressureHpa} hPa`, exact);
      row(t.position, `${formatLat(state.lat)}, ${formatLon(state.lon)}`, exact);
      if (state.motion) {
        row(t.motion, `verso ${compassIt(state.motion.bearing)} · ${Math.round(state.motion.speedKmh)} km/h`, 'reconstructed');
      }

      const f = formatUtc(state.time);
      const locals = event.localTimes
        .map((z) => `${formatUtc(new Date(state.time.getTime() + z.offsetHours * 3_600_000)).time} a ${z.place}`)
        .join(' · ');
      when.replaceChildren(el('strong', undefined, `${f.date} · ${f.time} ${t.utc}`), el('span', undefined, locals));
    },
    setView(globe: boolean) {
      viewButton.replaceChildren(icon(globe ? 'map' : 'globe'));
      const label = globe ? t.viewRegional : t.viewGlobe;
      viewButton.setAttribute('aria-label', label);
      viewButton.title = label;
    },
    setTheme(preference: ThemePreference) {
      themeButton.replaceChildren(icon(THEME_ICON[preference]));
      themeButton.setAttribute('aria-label', THEME_LABEL[preference]);
      themeButton.title = THEME_LABEL[preference];
    },
    showToast(message: string, action?: { label: string; run: () => void }) {
      hideHint();
      toast.replaceChildren(el('span', undefined, message));
      if (action) {
        const button = el('button', 'toast__action', action.label);
        button.type = 'button';
        button.addEventListener('click', action.run);
        toast.append(button);
      } else {
        window.setTimeout(() => (toast.hidden = true), 5000);
      }
      toast.hidden = false;
    },
  };
}

export function showFatalError(root: HTMLElement, message: string): void {
  const box = el('div', 'fatal');
  box.setAttribute('role', 'alert');
  const button = el('button', 'fatal__action', t.reload);
  button.type = 'button';
  button.addEventListener('click', () => location.reload());
  box.append(el('p', undefined, message), button);
  root.append(box);
}
