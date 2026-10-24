import { formatUtc } from '../core/clock';
import { formatLat, formatLon } from '../core/geo';
import type { PlaybackMode } from '../core/playback';
import { VIEWPOINTS, type ViewpointId } from '../core/viewpoints';
import { categoryLabel, compassIt, KT_TO_KMH, saffirSimpson, stormAt, type StormState, type StormTrack } from '../data/storm';
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
  onMode: (mode: PlaybackMode) => void;
  onPlayPause: () => void;
  /** Posizione richiesta nella sequenza, 0–1. */
  onSeek: (u: number) => void;
  onSpeed: (minutesPerSecond: number) => void;
  onResumeDirector: () => void;
  /** Da STORY a EXPLORE, conservando istante e inquadratura. */
  onExplore: () => void;
  onViewpoint: (id: ViewpointId) => void;
  onFollow: () => void;
  onExaggeration: (value: number) => void;
  onNorth: () => void;
  /** EXPLORE: immagini satellitari originali o volume ricostruito. */
  onRender: (view: RenderView) => void;
}

/** Visualizzazione delle nuvole in EXPLORE. */
export type RenderView = 'satellite' | 'volume';

export interface SequenceRange {
  start: Date;
  end: Date;
  observations: Date[];
}

export interface PlaybackView {
  mode: PlaybackMode;
  playing: boolean;
  time: Date;
  progress: number;
  /** Ora della scansione se l'istante coincide con un'osservazione reale. */
  observed: Date | null;
  /** Osservazioni tra cui si trova un fotogramma interpolato. */
  between: [Date, Date] | null;
  speed: number;
}

export interface StoryCaptionView {
  title: string;
  text: string;
}

export const REPLAY_SPEEDS = [5, 10, 20, 30] as const;
/** Esagerazioni verticali proposte in EXPLORE: ×1 è la scala reale. */
export const EXAGGERATIONS = [1, 2] as const;

export interface EventInfo {
  title: string;
  subtitle: string;
  time: Date;
  localTimes: readonly { place: string; offsetHours: number; zone: string }[];
  exaggeration: number;
  /** Nome del satellite delle osservazioni (es. GOES-16). */
  satellite: string;
  /** Dimensione di un pixel dei dati satellitari, in km. */
  resolutionKm: number;
  /** Il dispositivo può mostrare il Volume 3D. */
  volumeAvailable: boolean;
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

const MODE_ICON: Record<PlaybackMode, IconName> = { story: 'film', explore: 'compass', replay: 'history' };
const MODE_LABEL: Record<PlaybackMode, string> = { story: t.modeStory, explore: t.modeExplore, replay: t.modeReplay };
const MODE_TITLE: Record<PlaybackMode, string> = { story: t.storyMode, explore: t.exploreMode, replay: t.replayMode };
const MODE_ANNOUNCE: Record<PlaybackMode, string> = { story: t.announceStory, explore: t.announceExplore, replay: t.announceReplay };

const THEME_LABEL: Record<ThemePreference, string> = { auto: t.themeAuto, light: t.themeLight, dark: t.themeDark };
const THEME_ICON: Record<ThemePreference, IconName> = { auto: 'theme-auto', light: 'sun', dark: 'moon' };

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Pressione al centro (best track NOAA, interpolata tra i punti) sull'intervallo della sequenza,
 * con un segno per ogni osservazione satellitare reale e il cursore dell'istante corrente.
 */
function pressureChart(track: StormTrack, range: SequenceRange) {
  const W = 600;
  const H = 64;
  const PAD = { l: 2, r: 2, t: 6, b: 16 };
  const t0 = range.start.getTime();
  const t1 = range.end.getTime();
  const samples: { ms: number; state: StormState }[] = [];
  for (let ms = t0; ms <= t1; ms += 10 * 60_000) {
    const state = stormAt(track, new Date(ms));
    if (state && state.pressureHpa !== null) samples.push({ ms, state });
  }
  const pressures = samples.map((s) => s.state.pressureHpa!);
  const pMax = Math.max(...pressures) + 4;
  const pMin = Math.min(...pressures) - 4;
  const x = (ms: number) => PAD.l + ((ms - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  // Pressione più bassa = più in alto: la curva sale mentre l'uragano si intensifica.
  const y = (hpa: number) => PAD.t + ((hpa - pMin) / (pMax - pMin)) * (H - PAD.t - PAD.b);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'intensity');
  svg.setAttribute('aria-hidden', 'true');
  const add = (name: string, attrs: Record<string, string>, parent: Element = svg) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent.append(node);
    return node;
  };

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    add('path', {
      d: `M${x(a.ms)},${y(pMax)} L${x(a.ms)},${y(a.state.pressureHpa!)} L${x(b.ms)},${y(b.state.pressureHpa!)} L${x(b.ms)},${y(pMax)} Z`,
      fill: categoryColor(Math.max(a.state.windKt, b.state.windKt)),
      class: 'intensity__area',
    });
  }
  for (const obs of range.observations) {
    add('line', { x1: String(x(obs.getTime())), x2: String(x(obs.getTime())), y1: String(H - 14), y2: String(H - 10), class: 'intensity__obs' });
  }
  // Le scritte sono HTML sopra il grafico: l'SVG si deforma per riempire lo spazio
  // (preserveAspectRatio="none"), il testo no.
  const wrap = el('div', 'intensity-chart');
  const text = (className: string, value: string, xPct: number, yPct: number) => {
    const node = el('span', className, value);
    node.style.left = `${xPct.toFixed(2)}%`;
    node.style.top = `${yPct.toFixed(2)}%`;
    wrap.append(node);
  };
  const first = new Date(t0);
  first.setUTCMinutes(0, 0, 0);
  for (let ms = first.getTime() + 3_600_000; ms < t1; ms += 3_600_000) {
    if (new Date(ms).getUTCHours() % 2) continue;
    text('intensity__label', `${String(new Date(ms).getUTCHours()).padStart(2, '0')}:00`, (x(ms) / W) * 100, 100);
  }
  const minPoint = samples.reduce((a, b) => (b.state.pressureHpa! < a.state.pressureHpa! ? b : a));
  text('intensity__peak', `${minPoint.state.pressureHpa} hPa`, (x(minPoint.ms) / W) * 100, (y(minPoint.state.pressureHpa!) / H) * 100);
  const now = add('line', { x1: '0', x2: '0', y1: '0', y2: String(H - 12), class: 'intensity__now' });
  wrap.prepend(svg);
  return {
    element: wrap,
    setTime(ms: number) {
      const nx = String(x(Math.min(t1, Math.max(t0, ms))));
      now.setAttribute('x1', nx);
      now.setAttribute('x2', nx);
    },
  };
}

export function createHud(root: HTMLElement, actions: HudActions, event: EventInfo, track: StormTrack, range: SequenceRange) {
  // Intestazione
  const header = el('header', 'hud-header');
  const brand = el('div', 'brand');
  const beta = el('span', 'brand__beta', 'Beta');
  beta.title = t.beta;
  brand.append(el('h1', 'brand__name', t.appName), beta, el('span', 'brand__by', t.brand));

  const modes = el('div', 'modes');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', t.modes);
  const modeButtons = new Map<PlaybackMode, HTMLButtonElement>();
  for (const [label, mode, title] of [
    [t.modeStory, 'story', t.storyMode],
    [t.modeExplore, 'explore', t.exploreMode],
    [t.modeReplay, 'replay', t.replayMode],
  ] as const) {
    const b = el('button', 'modes__item', label);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => actions.onMode(mode));
    modeButtons.set(mode, b);
    modes.append(b);
  }
  // LIVE non è disponibile: un'indicazione, non un pulsante.
  const live = el('span', 'modes__item modes__item--soon', t.modeLive);
  live.title = t.liveSoon;
  live.append(el('small', undefined, t.soon));
  modes.append(live);

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
  const reconstructedRow = legendRow('reconstructed', t.legendReconstructed);
  const illustrativeRow = legendRow('illustrative', t.legendIllustrative.replace('{x}', String(event.exaggeration)));
  legendBody.append(legendRow('observed', t.legendObserved), reconstructedRow, illustrativeRow, toggles);
  // La legenda descrive la visualizzazione in uso (immagini satellitari o volume ricostruito).
  let legendState: { render: RenderView; exaggeration: number } = { render: 'satellite', exaggeration: event.exaggeration };
  const updateLegend = () => {
    const volume = legendState.render === 'volume';
    reconstructedRow.lastElementChild!.textContent = volume ? t.legendReconstructedVolume : t.legendReconstructed;
    illustrativeRow.lastElementChild!.textContent = (volume ? t.legendIllustrativeVolume : t.legendIllustrative).replace(
      '{x}',
      String(legendState.exaggeration),
    );
  };
  legend.append(summary, legendBody);

  // Riproduzione: comandi, istante rappresentato, pressione al centro e cursore.
  const timeline = el('section', 'timeline');
  timeline.setAttribute('aria-label', t.seek);
  const playButton = iconButton('pause', t.pause, actions.onPlayPause);
  playButton.classList.add('timeline__play');
  const clock = el('div', 'timeline__clock');
  const clockTime = el('strong', 'timeline__time');
  const clockFrame = el('span', 'timeline__frame');
  // Modalità corrente, sempre visibile accanto all'ora: icona e nome diversi per ciascuna.
  const modeTag = el('span', 'mode-tag');
  const clockRow = el('div', 'timeline__clockrow');
  clockRow.append(modeTag, clockTime);
  clock.append(clockRow, clockFrame);
  const speeds = el('div', 'timeline__speeds');
  speeds.setAttribute('role', 'group');
  speeds.setAttribute('aria-label', t.speed);
  const speedButtons = REPLAY_SPEEDS.map((v) => {
    const b = el('button', 'timeline__speed', `${v}`);
    b.type = 'button';
    b.title = `${v} ${t.minPerSecond}`;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => actions.onSpeed(v));
    speeds.append(b);
    return b;
  });
  speeds.append(el('span', 'timeline__unit', t.minPerSecond));
  const director = el('button', 'timeline__director');
  director.type = 'button';
  director.append(icon('camera'), el('span', undefined, t.resumeDirector));
  director.addEventListener('click', actions.onResumeDirector);
  director.hidden = true;
  const exploreButton = el('button', 'timeline__director timeline__explore');
  exploreButton.type = 'button';
  exploreButton.title = t.exploreSceneHint;
  exploreButton.setAttribute('aria-label', t.exploreScene);
  exploreButton.append(icon('compass'), el('span', 'timeline__explore-long', t.exploreScene), el('span', 'timeline__explore-short', t.modeExplore));
  exploreButton.addEventListener('click', actions.onExplore);
  exploreButton.hidden = true;
  const timelineHead = el('div', 'timeline__head');
  timelineHead.append(playButton, clock, speeds, director, exploreButton);

  const chart = pressureChart(track, range);
  const scrub = el('div', 'timeline__scrub');
  const slider = el('input', 'timeline__slider');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1000';
  slider.step = '1';
  slider.setAttribute('aria-label', t.seek);
  slider.addEventListener('input', () => actions.onSeek(Number(slider.value) / 1000));
  scrub.append(chart.element, slider);
  timeline.append(timelineHead, scrub);

  // Titolo d'apertura: compare sopra la scena nei primi secondi del racconto, senza bloccarla.
  const intro = el('div', 'intro');
  intro.setAttribute('aria-hidden', 'true');
  intro.append(el('p', 'intro__name', t.appName), el('p', 'intro__tagline', t.tagline), el('p', 'intro__author', t.author));

  // Didascalie del racconto (STORY).
  const caption = el('div', 'story-caption');
  caption.setAttribute('aria-live', 'polite');
  const captionTitle = el('p', 'story-caption__title');
  const captionText = el('p', 'story-caption__text');
  caption.append(captionTitle, captionText, el('p', 'story-caption__source', t.storySource));
  caption.hidden = true;

  // EXPLORE: seguire l'occhio, inquadrature, rilievo, orientamento.
  const explore = el('section', 'explore');
  explore.setAttribute('aria-label', t.exploreMode);
  explore.hidden = true;
  const exploreBar = el('div', 'explore__bar');
  const followButton = el('button', 'explore__chip explore__follow');
  followButton.type = 'button';
  followButton.title = t.followHint;
  followButton.setAttribute('aria-pressed', 'false');
  followButton.append(icon('target'), el('span', undefined, t.follow), badge('reconstructed'));
  followButton.addEventListener('click', actions.onFollow);
  const views = el('div', 'explore__group');
  views.setAttribute('role', 'group');
  views.setAttribute('aria-label', t.viewpoints);
  const VIEW_LABEL: Record<ViewpointId, [string, string]> = {
    eye: [t.viewEye, t.viewEyeHint],
    eyewall: [t.viewEyewall, t.viewEyewallHint],
    whole: [t.viewWhole, t.viewWholeHint],
    satellite: [t.viewSatellite, t.viewSatelliteHint],
    horizon: [t.viewHorizon, t.viewHorizonHint],
  };
  const viewButtons = new Map<ViewpointId, HTMLButtonElement>();
  // Sui telefoni le inquadrature sono un selettore nativo: compatto e accessibile.
  const viewSelectWrap = el('label', 'explore__select');
  const viewSelect = el('select');
  viewSelect.setAttribute('aria-label', t.viewpoints);
  const placeholder = el('option', undefined, t.viewpointFree);
  placeholder.value = '';
  viewSelect.append(placeholder);
  for (const id of VIEWPOINTS) {
    const [label, hint] = VIEW_LABEL[id];
    const text = label.replace('{sat}', event.satellite);
    const b = el('button', 'explore__chip', text);
    b.type = 'button';
    b.title = hint.replace('{sat}', event.satellite);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => actions.onViewpoint(id));
    views.append(b);
    viewButtons.set(id, b);
    const option = el('option', undefined, text);
    option.value = id;
    viewSelect.append(option);
  }
  viewSelect.addEventListener('change', () => {
    if (viewSelect.value) actions.onViewpoint(viewSelect.value as ViewpointId);
  });
  viewSelectWrap.append(icon('camera'), viewSelect);
  // SATELLITE / VOLUME 3D: stessa camera e stesso istante, due rappresentazioni delle nuvole.
  const render = el('div', 'explore__group explore__render');
  render.setAttribute('role', 'group');
  render.setAttribute('aria-label', t.renderMode);
  const renderButtons = new Map<RenderView, HTMLButtonElement>();
  for (const [view, label, hint, iconName] of [
    ['satellite', t.renderSatellite, t.renderSatelliteHint, 'satellite'],
    ['volume', t.renderVolume, event.volumeAvailable ? t.renderVolumeHint : t.volumeUnavailable, 'cube'],
  ] as const) {
    const b = el('button', 'explore__chip explore__render-chip');
    b.type = 'button';
    b.title = hint;
    b.setAttribute('aria-pressed', String(view === 'satellite'));
    b.append(icon(iconName), el('span', undefined, label));
    if (view === 'volume') {
      b.append(badge('reconstructed'));
      b.disabled = !event.volumeAvailable;
    }
    b.addEventListener('click', () => actions.onRender(view));
    render.append(b);
    renderButtons.set(view, b);
  }
  const relief = el('div', 'explore__group explore__relief');
  relief.setAttribute('role', 'group');
  relief.setAttribute('aria-label', t.relief);
  relief.title = t.reliefHint;
  relief.append(el('span', 'explore__label', t.relief));
  const reliefButtons = EXAGGERATIONS.map((x) => {
    const b = el('button', 'explore__chip explore__chip--small', `×${x}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.title = x === 1 ? t.reliefTrue : t.reliefExaggerated.replace('{x}', String(x));
    b.addEventListener('click', () => actions.onExaggeration(x));
    relief.append(b);
    return b;
  });
  relief.append(badge('reconstructed'));
  const compass = el('button', 'explore__compass');
  compass.type = 'button';
  compass.title = t.north;
  compass.setAttribute('aria-label', t.north);
  const needle = icon('north');
  compass.append(needle);
  compass.addEventListener('click', actions.onNorth);
  exploreBar.append(render, viewSelectWrap, followButton, views, relief, compass);
  const detail = el(
    'p',
    'explore__note',
    t.detailLimit.replace('{sat}', event.satellite).replace('{km}', event.resolutionKm.toFixed(1).replace('.', ',')),
  );
  detail.hidden = true;
  // Nel volume una nota resta sempre visibile: è una ricostruzione, non una misura 3D.
  const volumeNote = el('p', 'explore__note explore__note--volume');
  volumeNote.append(badge('reconstructed'), el('span', undefined, t.volumeNote.replace('{sat}', event.satellite)));
  volumeNote.hidden = true;
  explore.append(detail, volumeNote, exploreBar);

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
  const licenseSection = () => {
    const s = section(t.licenseTitle, t.licenseBody);
    const links = el('p', 'info-dialog__links');
    const base = import.meta.env.BASE_URL;
    for (const [label, file] of [
      [t.licenseFile, 'LICENSE.txt'],
      [t.noticesFile, 'THIRD_PARTY_NOTICES.txt'],
      [t.dataFile, 'DATA_SOURCES.txt'],
    ] as const) {
      const a = el('a', undefined, label);
      a.href = `${base}${file}`;
      a.target = '_blank';
      a.rel = 'noopener';
      links.append(a);
    }
    s.append(links);
    return s;
  };
  dialog.append(
    closeButton,
    dialogTitle,
    el('p', 'info-dialog__tagline', `${t.tagline} · ${t.author}`),
    el('p', undefined, t.aboutBody),
    section(t.honestyTitle, t.honestyBody),
    section(t.sourcesTitle, t.sourceGoes, t.sourceTrack, t.sourceDay, t.sourceNight, t.sourceNote),
    section(t.privacyTitle, t.privacyBody),
    section(t.devTitle, t.devBody),
    licenseSection(),
    el('p', 'info-dialog__version', `${t.beta} · ${t.version} ${__APP_VERSION__}`),
  );
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  const toast = el('div', 'toast');
  toast.setAttribute('role', 'status');
  toast.hidden = true;

  root.append(intro, header, card, legend, caption, explore, timeline, nav, hint, dialog, toast);

  const updateOnline = () => {
    status.hidden = navigator.onLine;
  };
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();

  const hideHint = () => hint.classList.add('is-hidden');
  window.setTimeout(hideHint, 9000);

  let lastClock = '';
  let lastFrame = '';
  let lastMode: PlaybackMode | null = null;
  let lastPlaying: boolean | null = null;
  let lastSpeed = -1;
  let lastCaption = '';
  let lastHeading = Number.NaN;
  const hhmm = (d: Date) => formatUtc(d).time.slice(0, 5);

  const panels = [header, card, legend, caption, intro, explore, timeline, nav, toast];
  return {
    hideHint,
    /** Rettangoli dei pannelli visibili (coordinate della scena), per tenere libere le etichette. */
    obstacles() {
      const base = root.getBoundingClientRect();
      const rects = [];
      for (const panel of panels) {
        if (panel.hidden || getComputedStyle(panel).opacity === '0') continue;
        const r = panel.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        rects.push({ x0: r.left - base.left, y0: r.top - base.top, x1: r.right - base.left, y1: r.bottom - base.top });
      }
      return rects;
    },
    /** Aggiorna i comandi di riproduzione; tocca il DOM solo se qualcosa è cambiato. */
    setPlayback(view: PlaybackView) {
      const f = formatUtc(view.time);
      const clockText = `${f.date} · ${f.time} ${t.utc}`;
      if (clockText !== lastClock) {
        // La data è separata: sui telefoni, con i comandi di velocità, si nasconde.
        clockTime.replaceChildren(el('span', 'timeline__date', `${f.date} · `), `${f.time} ${t.utc}`);
        lastClock = clockText;
      }
      const frameText = view.observed
        ? `${t.observedFrame} ${formatUtc(view.observed).time} ${t.utc}`
        : view.between
          ? t.interpolatedFrame.replace('{a}', hhmm(view.between[0])).replace('{b}', hhmm(view.between[1]))
          : '';
      const frameKind = view.observed ? 'observed' : 'illustrative';
      if (frameText + frameKind !== lastFrame) {
        clockFrame.replaceChildren(badge(frameKind), el('span', undefined, frameText));
        lastFrame = frameText + frameKind;
      }
      chart.setTime(view.time.getTime());
      if (document.activeElement !== slider) slider.value = String(Math.round(view.progress * 1000));
      if (view.mode !== lastMode) {
        for (const [mode, b] of modeButtons) b.setAttribute('aria-pressed', String(mode === view.mode));
        modeTag.replaceChildren(icon(MODE_ICON[view.mode]), el('span', undefined, MODE_LABEL[view.mode]));
        modeTag.title = MODE_TITLE[view.mode];
        modeTag.dataset.mode = view.mode;
        speeds.hidden = view.mode === 'story';
        exploreButton.hidden = view.mode !== 'story';
        explore.hidden = view.mode !== 'explore';
        timeline.dataset.mode = view.mode;
        root.dataset.mode = view.mode;
        lastMode = view.mode;
      }
      if (view.playing !== lastPlaying) {
        playButton.replaceChildren(icon(view.playing ? 'pause' : 'play'));
        const label = view.playing ? t.pause : t.play;
        playButton.setAttribute('aria-label', label);
        playButton.title = label;
        lastPlaying = view.playing;
      }
      if (view.speed !== lastSpeed) {
        speedButtons.forEach((b, k) => b.setAttribute('aria-pressed', String(REPLAY_SPEEDS[k] === view.speed)));
        lastSpeed = view.speed;
      }
    },
    setCaption(value: StoryCaptionView | null) {
      const key = value ? value.title : '';
      if (key === lastCaption) return;
      lastCaption = key;
      if (!value) {
        caption.classList.remove('is-visible');
        return;
      }
      // Le didascalie e il suggerimento dei gesti occuperebbero lo stesso spazio.
      hideHint();
      caption.hidden = false;
      captionTitle.textContent = value.title;
      captionText.textContent = value.text;
      // Riavvia la transizione di comparsa.
      caption.classList.remove('is-visible');
      void caption.offsetWidth;
      caption.classList.add('is-visible');
    },
    setIntro(visible: boolean) {
      intro.classList.toggle('is-visible', visible);
    },
    /** Inquadratura scelta (evidenziata), o null se la camera è stata mossa a mano. */
    setViewpoint(id: ViewpointId | null) {
      for (const [key, b] of viewButtons) b.setAttribute('aria-pressed', String(key === id));
      viewSelect.value = id ?? '';
    },
    /** Breve avviso al cambio di modalità: che cosa si sta guardando. */
    announceMode(mode: PlaybackMode) {
      this.showToast(MODE_ANNOUNCE[mode].replace('{sat}', event.satellite));
    },
    setFollow(on: boolean) {
      followButton.setAttribute('aria-pressed', String(on));
    },
    setExaggeration(value: number) {
      reliefButtons.forEach((b, k) => b.setAttribute('aria-pressed', String(EXAGGERATIONS[k] === value)));
      legendState = { ...legendState, exaggeration: value };
      updateLegend();
    },
    /** Visualizzazione delle nuvole in uso: pulsanti, nota sul volume, legenda. */
    setRender(view: RenderView) {
      renderButtons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === view)));
      volumeNote.hidden = view !== 'volume';
      root.dataset.render = view;
      legendState = { ...legendState, render: view };
      updateLegend();
    },
    announceRender(view: RenderView) {
      this.showToast((view === 'volume' ? t.announceVolume : t.announceSatellite).replace('{sat}', event.satellite));
    },
    /** Bussola: l'ago punta al nord geografico sullo schermo. */
    setHeading(degrees: number) {
      const rounded = Math.round(degrees);
      if (rounded === lastHeading) return;
      lastHeading = rounded;
      needle.style.transform = `rotate(${-rounded}deg)`;
    },
    /** Avviso quando la camera è al dettaglio massimo consentito dai dati. */
    setDetailLimit(atLimit: boolean) {
      detail.hidden = !atLimit;
    },
    /** Pulsante «Riprendi regia»: visibile in STORY quando l'utente ha preso la camera. */
    setDirector(available: boolean) {
      director.hidden = !available;
    },
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
