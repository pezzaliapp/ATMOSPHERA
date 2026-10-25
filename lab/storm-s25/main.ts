import '../storm-s11/style.css';
import '../../src/flight/pilot/pilot.css';
import './style.css';
import { Quaternion, Vector3, WebGLRenderer } from 'three';
import { loadMilton } from '../storm-s11/milton';
import { createStormScene, type StormScene } from '../storm-s11/scene';
import { createAircraftView, type AircraftView } from './aircraft-view';
import { BOOST, CRUISE, RE, SLOW, ZONE_LABEL, createColumnSampler, createFlight, type Controls, type Flight } from './flight';
import { createProbe } from './probe';
import { createNav, type Nav } from './nav';
import { createAudio } from './audio';
import { PHASE_LABEL, cloudBaseKm, shaftModulate, weatherAt, type Weather } from './weather';
import { branchChannel, createBoltView, createLightning, flashEnvelope, type Bolt } from './lightning';
import { createPrecip, type Precip } from './precip';
import { SCENES, createCinema, type Cinema } from './cinema';

/**
 * STORM FLIGHT — Fase S2.5 (oceano dinamico e fulmini localizzati) su base S2.4: volo del Concept C nell'uragano Milton con precipitazioni, fulmini, audio
 * dinamico e una regia cinematografica (laboratorio locale, non pubblicato).
 * Parametri: ?stats, ?fly o ?cinema (parte subito), ?fx=noaudio,noprecip,noveil,nolightning,noturb (misure).
 */

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const loading = document.getElementById('loading')!;
const mobile = matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 900;
const DEG = Math.PI / 180;

const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.25 : 1.5));
renderer.autoClear = false;

const damp = (c: number, t: number, rate: number, dt: number) => c + (t - c) * (1 - Math.exp(-rate * dt));
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const ICON = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" /></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none"/></svg>',
  level: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18M7 12l-2-3M17 12l2-3" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>',
  help: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 .8-1 1.5v.6M12 17.2v.1"/></svg>',
  boost: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7l6 5-6 5M12 7l6 5-6 5"/></svg>',
  slow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h3v10H7zM14 7h3v10h-3z" fill="currentColor" stroke="none"/></svg>',
};
const CARDINAL = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const FX = new Set((params.get('fx') ?? '').split(',').filter(Boolean));
const ICON_SOUND = {
  on: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  off: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>',
};

// ── Interfaccia (classi di CITY FLIGHT, pilot.css).
const hud = el('div', 'pl-hud');
hud.dataset.phase = 'start';
const brand = el('div', 'pl-brand');
const head = el('div', 'sf2-head');
const exitBtn = el('button', 'sf2-exit', `${ICON.back}<span>STORM FLIGHT</span>`);
exitBtn.setAttribute('aria-label', 'Torna alla schermata iniziale di STORM FLIGHT');
head.append(exitBtn, el('b', '', 'STORM FLIGHT'));
const zoneEl = el('span', 'sf2-zone', '');
const stateEl = el('span', 'sf2-state', '');
const noteEl = el('span', '', 'Volo arcade · uragano Milton, 7 ottobre 2024, 20:01 UTC · laboratorio');
brand.append(head, zoneEl, stateEl, noteEl);
const readout = el('div', 'pl-readout');
const speedEl = el('div', 'pl-value', '<b>0</b><span>km/h</span>');
const altEl = el('div', 'pl-value', '<b>0</b><span>km</span>');
const hdgEl = el('div', 'pl-value', '<b>0</b><span>°</span>');
readout.append(speedEl, altEl, hdgEl);
const tools = el('div', 'pl-tools');
const levelBtn = el('button', 'pl-icon', ICON.level);
levelBtn.setAttribute('aria-label', 'Livella il velivolo');
const pauseBtn = el('button', 'pl-icon', ICON.pause);
pauseBtn.setAttribute('aria-label', 'Pausa');
const helpBtn = el('button', 'pl-icon', ICON.help);
helpBtn.setAttribute('aria-label', 'Come si pilota');
tools.append(levelBtn, pauseBtn, helpBtn);
const turbEl = el('div', 'sf2-turb', '<span>TURBOLENZA (indicativa)</span><i><b></b><b></b><b></b><b></b><b></b></i>');
const bar = el('div', 'pl-bar');
const slowBtn = el('button', 'pl-round', `${ICON.slow}<span>RALLENTA</span>`);
const recoverBtn = el('button', 'pl-main', 'RECUPERA');
recoverBtn.setAttribute('aria-label', 'Riporta il velivolo in volo controllato');
const boostBtn = el('button', 'pl-round', `${ICON.boost}<span>BOOST</span>`);
bar.append(slowBtn, recoverBtn, boostBtn);
const stickRing = el('div', 'pl-stick', '<span></span>');
stickRing.hidden = true;
const toast = el('div', 'pl-toast');
toast.hidden = true;
const pauseCover = el('div', 'pl-pause', '<b>In pausa</b><span>Tocca ▶ per riprendere</span>');
pauseCover.hidden = true;
const start = el(
  'div',
  'sf2-start',
  `<h1>STORM FLIGHT</h1>
   <p>Pilota il Concept C dall'oceano aperto fino all'occhio dell'uragano Milton: bande esterne, nubi dense, parete dell'occhio. Nessun percorso obbligato.</p>
   <small>Volo arcade con velocità di gioco elevate (tempo compresso); la turbolenza è un effetto di gioco legato alla zona. Nubi e vento derivano da GOES-16 e HURDAT2 con le approssimazioni della ricostruzione S1.1.</small>
   <div class="sf2-choices">
     <button type="button" class="pl-main" data-start="fly">VOLA<span>pilotaggio libero</span></button>
     <button type="button" class="pl-main sf2-cinema-btn" data-start="cinema">CINEMA<span>esperienza guidata · ~2 min</span></button>
   </div>
   <button type="button" class="sf2-sound" data-sound>${ICON_SOUND.off}<span>AUDIO OFF · tocca per attivare</span></button>
   <details class="sf2-sources">
     <summary>Dati, approssimazioni ed effetti</summary>
     <p><b class="t-doc">DATI</b> Uragano Milton, 7 ottobre 2024, 20:01 UTC: posizione, vento massimo 155 kt, pressione 895 hPa e raggio dei venti massimi (NHC HURDAT2); estensione delle nubi, spessore ottico e quota delle sommità (GOES-16, NOAA); posizione del Sole.</p>
     <p><b class="t-app">APPROSSIMAZIONI</b> Struttura verticale e base delle nubi, parete dell'occhio (più ampia del reale), vento al suolo (profilo di Rankine modificato), temperatura (mare ~29,5 °C, 5,5 °C/km), intensità e fase delle precipitazioni, cortine di pioggia, spruzzi, grandine e fulmini: ricostruzioni plausibili, non osservazioni.</p>
     <p><b class="t-art">EFFETTI ARTISTICI</b> Velocità e salita verticale in CINEMA, scie della pioggia (contributo della velocità limitato), turbolenza di gioco, esposizione automatica, audio sintetizzato. Non è una simulazione aeronautica né una documentazione delle condizioni incontrate da un aereo reale.</p>
   </details>`,
);
const guide = el(
  'div',
  'pl-guide',
  `<h2>Come si pilota</h2>
   <ul>
     <li><b>Trascina</b> in un punto qualsiasi dello schermo: su per salire, giù per scendere, a destra e a sinistra per inclinarti e virare. Al rilascio il velivolo torna livellato.</li>
     <li>Tieni premuto <b>BOOST</b> o <b>RALLENTA</b>. Nelle nubi dense il BOOST è limitato.</li>
     <li><b>LIVELLA</b> raddrizza le ali; <b>RECUPERA</b> riporta in volo controllato (crociera, raffiche smorzate, quota sicura).</li>
     <li>La <b>bussola</b> indica dove si trova l'occhio rispetto al muso, la distanza e se ti stai avvicinando; il <b>radar</b> (richiudibile) mostra lo schema delle bande, con il nord in alto.</li>
     <li><b>VAI ALL'OCCHIO</b> orienta il velivolo verso il centro (virate e quota controllate); si interrompe toccandolo di nuovo o muovendo la cloche.</li>
     <li>Tastiera facoltativa: frecce o WASD, Maiusc = BOOST, Ctrl = RALLENTA, L, R, P, G (VAI ALL'OCCHIO).</li>
     <li><b>Audio</b>: pulsante con l'altoparlante in alto a destra (volume e «movimento ridotto» per telecamera, vibrazioni e lampi). Pioggia, ghiaccio, grandine, fulmini e onde sono ricostruzioni illustrative legate a zona, quota, vento e temperatura stimati: <b>non sono dati storici</b> (i fulmini reali di Milton non sono riprodotti). «Lampi attenuati» riduce i lampi per chi è fotosensibile.</li>
     <li><b>CINEMA</b> (dalla schermata iniziale): regia automatica di ~2 minuti; PILOTA restituisce i comandi nella stessa posizione.</li>
   </ul>
   <p>Simulazione semplificata: non aerodinamica reale, non una previsione meteorologica.</p>
   <button type="button" class="pl-main">Ho capito</button>`,
);
guide.hidden = true;
// VAI ALL'OCCHIO: assistenza facoltativa, interrompibile con lo stesso pulsante o muovendo la cloche.
const autoBtn = el('button', 'sf2-auto', '<b>VAI ALL’OCCHIO</b><span>navigazione assistita</span>');
autoBtn.setAttribute('aria-pressed', 'false');
// Audio e impostazioni (volume, movimento ridotto): pulsante sempre visibile in alto a destra.
const soundBtn = el('button', 'pl-icon sf2-sound-icon', ICON_SOUND.off);
soundBtn.setAttribute('aria-label', 'Audio e impostazioni');
tools.prepend(soundBtn);
const settings = el(
  'div',
  'sf2-settings',
  `<button type="button" class="sf2-sound" data-sound>${ICON_SOUND.off}<span>AUDIO OFF</span></button>
   <label>Volume <input type="range" min="0" max="100" value="70" data-volume /></label>
   <label class="sf2-check"><input type="checkbox" data-motion /> Movimento ridotto <small>(telecamera, vibrazioni)</small></label>
   <label class="sf2-check"><input type="checkbox" data-gentle /> Lampi attenuati <small>(fotosensibilità: un solo impulso morbido, luce ridotta)</small></label>
   <small>Audio sintetizzato nel browser; fenomeni meteo ricostruiti in modo illustrativo.</small>`,
);
settings.hidden = true;
// Meteo locale (in alto a sinistra, sotto la zona).
const meteoEl = el('span', 'sf2-meteo', '');
brand.insertBefore(meteoEl, noteEl);
// CINEMA: titolo della scena, comandi essenziali, finale, dissolvenza.
const cineTitle = el('div', 'sf2-cine-title', '<small></small><b></b><span></span>');
const cineBar = el(
  'div',
  'sf2-cine-bar',
  `<button type="button" data-cine="pause">${ICON.pause}<span>PAUSA</span></button>
   <button type="button" data-cine="sound">${ICON_SOUND.off}<span>AUDIO</span></button>
   <button type="button" data-cine="pilot"><span>PILOTA</span></button>
   <button type="button" data-cine="replay"><span>RIVEDI</span></button>
   <button type="button" data-cine="exit"><span>ESCI</span></button>`,
);
const cineNote = el('div', 'sf2-cine-note', 'CINEMA · rappresentazione artistica: velocità narrative, non simulazione aeronautica · meteo ricostruito');
const cineEnd = el(
  'div',
  'sf2-cine-end',
  `<b>FINE</b><span>Uragano Milton · 7 ottobre 2024, 20:01 UTC</span>
   <div><button type="button" class="pl-main" data-cine="replay">RIVEDI CINEMA</button><button type="button" class="pl-main sf2-secondary" data-cine="exit">SCHERMATA INIZIALE</button></div>`,
);
cineEnd.hidden = true;
const fadeEl = el('div', 'sf2-fade');
hud.append(brand, readout, tools, turbEl, bar, autoBtn, stickRing, toast, pauseCover, start, guide, settings, cineTitle, cineBar, cineNote, cineEnd);
document.body.append(fadeEl);
document.body.append(hud);
document.body.classList.add('pl-active');

let storm: StormScene | null = null;
let flight: Flight | null = null;
let view: AircraftView | null = null;
let probe: ReturnType<typeof createProbe> | null = null;
let nav: Nav | null = null;
const setAutoUi = (on: boolean) => {
  autoBtn.setAttribute('aria-pressed', String(on));
  autoBtn.innerHTML = on ? '<b>ASSISTENZA ATTIVA</b><span>tocca o muovi la cloche per interrompere</span>' : '<b>VAI ALL’OCCHIO</b><span>navigazione assistita</span>';
  hud.dataset.auto = on ? 'on' : 'off';
};
const toggleAuto = () => {
  if (!flight || !flying || paused) return;
  const on = !flight.auto;
  flight.setAuto(on);
  setAutoUi(on);
  showToast(on ? 'Navigazione assistita verso l’occhio' : 'Assistenza interrotta: comandi al pilota', 1.8);
};
let flying = false;
let paused = false;
let precip: Precip | null = null;
let cinema: Cinema | null = null;
let columnAt: ReturnType<typeof createColumnSampler> | null = null;
const audio = createAudio();
// S2.5: fulmini localizzati (creati quando la mappa è pronta).
let lightning: ReturnType<typeof createLightning> | null = null;
let boltView: ReturnType<typeof createBoltView> | null = null;
let bolt: Bolt | null = null;
let boltVisible = 0;
// Modalità senza lampi intensi (fotosensibilità): predefinita con la preferenza di movimento ridotto.
let gentleFlashes = matchMedia('(prefers-reduced-motion: reduce)').matches;
let reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
(settings.querySelector('[data-motion]') as HTMLInputElement).checked = reducedMotion;
let weather: Weather | null = null;
let flashT = 99;
let flashLevel = 0;
/** Solo verifiche: lampo tenuto al livello indicato (0 = normale). */
let flashHold = 0;
let boltShown = 0;
let lastGusts = 0;
let lightningCount = 0;
/** Il velivolo è in scena e simulato (volo manuale o CINEMA dopo la prima scena). */
const aircraftLive = () => flying || (cinema?.flying ?? false);
const updateSoundUi = () => {
  const on = audio.enabled;
  soundBtn.innerHTML = on ? ICON_SOUND.on : ICON_SOUND.off;
  soundBtn.classList.toggle('is-on', on);
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-sound]')) {
    b.innerHTML = `${on ? ICON_SOUND.on : ICON_SOUND.off}<span>${on ? 'AUDIO ON · tocca per disattivare' : 'AUDIO OFF · tocca per attivare'}</span>`;
    b.classList.toggle('is-on', on);
  }
  const cb = cineBar.querySelector('[data-cine="sound"]')!;
  cb.innerHTML = `${on ? ICON_SOUND.on : ICON_SOUND.off}<span>${on ? 'AUDIO ON' : 'AUDIO OFF'}</span>`;
};
const toggleSound = async () => {
  // In pausa o alla schermata iniziale il suono resta sospeso finché non si riprende (stato tenuto dall'audio).
  await audio.setEnabled(!audio.enabled);
  updateSoundUi();
};
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-sound]')) b.addEventListener('click', () => void toggleSound());
soundBtn.addEventListener('click', () => (settings.hidden = !settings.hidden));
(settings.querySelector('[data-volume]') as HTMLInputElement).addEventListener('input', (e) => audio.setVolume(+(e.target as HTMLInputElement).value / 100));
(settings.querySelector('[data-motion]') as HTMLInputElement).addEventListener('change', (e) => (reducedMotion = (e.target as HTMLInputElement).checked));
(settings.querySelector('[data-gentle]') as HTMLInputElement).checked = gentleFlashes;
(settings.querySelector('[data-gentle]') as HTMLInputElement).addEventListener('change', (e) => (gentleFlashes = (e.target as HTMLInputElement).checked));
const controls: Controls = { stickX: 0, stickY: 0, boost: false, slow: false };
const keys = new Set<string>();
let toastTimer = 0;
const showToast = (text: string, s = 2.2) => {
  toast.textContent = text;
  toast.hidden = false;
  toastTimer = s;
};
const setPaused = (p: boolean) => {
  if (p !== paused) void audio.hold(p);
  paused = p;
  pauseBtn.innerHTML = p ? ICON.play : ICON.pause;
  pauseBtn.setAttribute('aria-label', p ? 'Riprendi' : 'Pausa');
  pauseCover.hidden = !p;
  if (p) releaseStick();
};

// ── Telecamera in terza persona: scostamento smorzato nel riferimento del velivolo (in metri).
const cam = { offset: new Vector3(0, 5, 22), lookAhead: new Vector3(), roll: 0, fov: 60, exposure: 0.55, shake: new Vector3() };
const tmp = new Vector3();
const tmp2 = new Vector3();
const tmp3 = new Vector3();
const camPos = new Vector3();
const lookPos = new Vector3();
const upV = new Vector3();
const attitude = new Quaternion();

function updateCamera(dt: number) {
  const f = flight!;
  const { up } = f.frame();
  const speed = f.speed;
  const boostK = Math.min(1, Math.max(0, (speed - CRUISE) / (BOOST - CRUISE)));
  const slowK = Math.min(1, Math.max(0, (CRUISE - speed) / (CRUISE - SLOW)));
  const portrait = camera().aspect < 1 ? 1 + (0.75 * (1 - Math.max(0.45, camera().aspect))) / 0.55 : 1;
  // In nube densa la telecamera si avvicina: il velivolo resta leggibile nella nebbia.
  const cloudK = 1 - Math.exp(-(probe?.result.sigmaCamera ?? 0) * 0.04);
  const dist = (21 + 8 * boostK) * portrait * (1 - 0.35 * cloudK);
  // Direzione di inseguimento dalla traiettoria comandata (non dalle raffiche): niente oscillazioni.
  const fwd = f.forward(tmp, f.heading, f.pitch * 0.6);
  const want = tmp2.copy(fwd).multiplyScalar(-dist).addScaledVector(up, 4.6);
  // Inerzia: in turbolenza la telecamera insegue più morbidamente (il velivolo si muove nell'inquadratura).
  cam.offset.lerp(want, 1 - Math.exp(-(3.2 - 1.4 * f.turbulence) * dt));
  const ahead = f.forward(new Vector3(), f.heading, f.pitch * 0.85).multiplyScalar(10 + 14 * Math.min(1, speed / CRUISE)).addScaledVector(up, 1.2);
  cam.lookAhead.lerp(ahead, 1 - Math.exp(-6 * dt));
  // Scossa lieve e lenta in turbolenza (≤ ~0,3°), per non affaticare la vista.
  const T = f.turbulence;
  // Vibrazione leggera e irregolare (rumore smorzato, non sinusoidi ripetitive), più forte nelle raffiche.
  cam.shake.copy(shakeNoise(dt, reducedMotion ? 0 : 0.05 * T + 0.07 * f.gustKick));
  camPos.copy(f.pos).addScaledVector(cam.offset, 1e-3);
  // Mai sotto il mare.
  const alt = Math.hypot(camPos.x, camPos.y + 6371, camPos.z) - 6371;
  if (alt < 0.004) camPos.addScaledVector(up, 0.004 - alt);
  lookPos.copy(f.pos).addScaledVector(cam.lookAhead, 1e-3).addScaledVector(cam.shake, 1e-3);
  cam.roll = damp(cam.roll, f.bank * (reducedMotion ? 0.12 : 0.4), 3, dt);
  const viewDir = new Vector3().subVectors(lookPos, camPos).normalize();
  upV.copy(up).applyAxisAngle(viewDir, cam.roll);
  const base = camera().aspect < 1 ? 76 : 60;
  cam.fov = damp(cam.fov, base + 14 * boostK - 4 * slowK, 2, dt);
  // Esposizione automatica lenta: dentro le nubi scure l'immagine si adatta senza salti.
  const [r, g, b] = probe?.result.radiance ?? [1, 1, 1];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const inCloud = 1 - Math.exp(-(probe?.result.sigmaCamera ?? 0) * 0.4);
  const targetExp = 0.55 * (1 + inCloud * (Math.min(4, Math.max(1, (0.6 / Math.max(lum, 0.02)) ** 0.75)) - 1));
  // Adattamento più rapido verso la luce (uscendo da una nube) che verso il buio, come l'occhio.
  cam.exposure = damp(cam.exposure, targetExp, targetExp < cam.exposure ? 3 : 1, dt);
  storm!.setPose({ pos: camPos, look: lookPos, up: upV, fov: cam.fov, rate: 1, exposure: cam.exposure, fast: Math.min(1, Math.max(0, (speed - 0.6) / 1.8)) });
}
const camera = () => storm!.camera;
/** Processo di Ornstein-Uhlenbeck a 2 componenti (tempo di correlazione ~0,12 s), in metri. */
const shakeState = new Vector3();
function shakeNoise(dt: number, sigma: number) {
  const tau = 0.12;
  const g = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;
  const k = Math.sqrt((2 * dt) / tau);
  shakeState.x += (-shakeState.x / tau) * dt + sigma * k * g();
  shakeState.y += (-shakeState.y / tau) * dt + sigma * k * g();
  shakeState.z = 0;
  return shakeState;
}

// ── Cloche virtuale (come CITY FLIGHT): trascinamento dal punto di contatto; i pulsanti non la azionano.
let drag: { id: number; x: number; y: number } | null = null;
const stickRadius = () => Math.max(60, Math.min(canvas.clientWidth, canvas.clientHeight) * 0.2);
const releaseStick = () => {
  drag = null;
  controls.stickX = controls.stickY = 0;
  stickRing.hidden = true;
};
canvas.addEventListener('pointerdown', (e) => {
  if (!flying || paused || drag) return;
  e.preventDefault();
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  stickRing.hidden = false;
  stickRing.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  (stickRing.firstElementChild as HTMLElement).style.transform = '';
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const r = stickRadius();
  let dx = (e.clientX - drag.x) / r;
  let dy = (drag.y - e.clientY) / r;
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    dx /= len;
    dy /= len;
  }
  controls.stickX = dx;
  controls.stickY = dy;
  (stickRing.firstElementChild as HTMLElement).style.transform = `translate(${dx * 46}px, ${-dy * 46}px)`;
});
const onRelease = (e: PointerEvent) => {
  if (drag && e.pointerId === drag.id) releaseStick();
};
canvas.addEventListener('pointerup', onRelease);
canvas.addEventListener('pointercancel', onRelease);
const hold = (button: HTMLElement, set: (v: boolean) => void) => {
  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    button.setPointerCapture(e.pointerId);
    button.classList.add('is-held');
    set(true);
  });
  const up = () => {
    button.classList.remove('is-held');
    set(false);
  };
  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', up);
  button.addEventListener('contextmenu', (e) => e.preventDefault());
};
hold(boostBtn, (v) => (controls.boost = v));
hold(slowBtn, (v) => (controls.slow = v));
const level = () => {
  flight?.level();
  showToast('Volo livellato', 1.4);
};
const recover = () => {
  flight?.recover();
  showToast('Volo controllato ripristinato', 1.8);
};
levelBtn.addEventListener('click', level);
recoverBtn.addEventListener('click', recover);
autoBtn.addEventListener('click', toggleAuto);
pauseBtn.addEventListener('click', () => setPaused(!paused));
helpBtn.addEventListener('click', () => (guide.hidden = !guide.hidden));
guide.querySelector('button')!.addEventListener('click', () => (guide.hidden = true));
addEventListener('keydown', (e) => {
  if (!flying) return;
  keys.add(e.key.toLowerCase());
  if (e.key === 'l' || e.key === 'L') level();
  if (e.key === 'r' || e.key === 'R') recover();
  if (e.key === 'p' || e.key === 'P') setPaused(!paused);
  if (e.key === 'g' || e.key === 'G') toggleAuto();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

const begin = () => {
  if (!storm || flying) return;
  // Nuova partenza: posizione, quota, velocità, prua, assetto, turbolenza, assistenza e strumenti azzerati.
  flight!.reset();
  nav!.reset();
  setAutoUi(false);
  cam.offset.set(0, 5, 22);
  cam.lookAhead.set(0, 0, 0);
  cam.roll = 0;
  cam.exposure = 0.55;
  lightning?.reset();
  bolt = null;
  flashT = 99;
  lastGusts = 0;
  flying = true;
  void audio.hold(false);
  setPaused(false);
  hud.dataset.phase = 'flying';
  start.hidden = true;
  guide.hidden = true;
  showToast('Rotta verso nord-ovest: l’uragano è all’orizzonte', 3);
};
const toStart = () => {
  if (cinema?.active) stopCinema();
  flying = false;
  void audio.hold(true);
  settings.hidden = true;
  releaseStick();
  controls.boost = controls.slow = false;
  flight?.setAuto(false);
  setAutoUi(false);
  setPaused(false);
  storm?.setPose(null);
  hud.dataset.phase = 'start';
  start.hidden = false;
  zoneEl.textContent = '';
  stateEl.textContent = '';
};
start.querySelector('[data-start="fly"]')!.addEventListener('click', begin);
start.querySelector('[data-start="cinema"]')!.addEventListener('click', () => startCinema());
exitBtn.addEventListener('click', toStart);

// ── CINEMA.
let cineScene = -1;
function startCinema() {
  if (!storm || !cinema) return;
  if (flying) toStart();
  cinema.start();
  nav!.reset();
  lightning?.reset();
  bolt = null;
  flashT = 99;
  cineScene = -1;
  setPaused(false);
  hud.dataset.phase = 'cinema';
  start.hidden = true;
  guide.hidden = true;
  cineEnd.hidden = true;
  settings.hidden = true;
  setCinePaused(false);
  cam.exposure = 0.5;
  void audio.hold(false);
}
function stopCinema() {
  cinema?.stop();
  cineEnd.hidden = true;
  fadeEl.style.opacity = '0';
  cineScene = -1;
}
function setCinePaused(p: boolean) {
  if (!cinema) return;
  if (p !== cinema.paused) void audio.hold(p);
  cinema.setPaused(p);
  const b = cineBar.querySelector('[data-cine="pause"]')!;
  b.innerHTML = `${p ? ICON.play : ICON.pause}<span>${p ? 'RIPRENDI' : 'PAUSA'}</span>`;
}
/** CINEMA → VOLA: stessa posizione, stessa prua e velocità; la telecamera d'inseguimento parte dalla posa attuale. */
function cinemaToPilot() {
  if (!cinema?.active || !flight || !storm) return;
  const f = flight;
  const camDist = storm.camera.position.distanceTo(f.pos);
  const wasFlying = cinema.flying;
  stopCinema();
  f.setGuide(null);
  if (!wasFlying || camDist > 1.5) {
    // Il velivolo non è nell'inquadratura (vista dallo spazio): dissolvenza esplicita invece di un salto.
    fadeEl.style.transition = 'none';
    fadeEl.style.opacity = '1';
    requestAnimationFrame(() => {
      fadeEl.style.transition = 'opacity 0.9s ease';
      fadeEl.style.opacity = '0';
    });
    if (!wasFlying) f.setMotion(CRUISE, f.heading);
    cam.offset.set(0, 5, 22);
    cam.lookAhead.set(0, 0, 0);
  } else {
    cam.offset.subVectors(storm.camera.position, f.pos).multiplyScalar(1000);
    cam.lookAhead.copy(storm.camera.getWorldDirection(new Vector3())).multiplyScalar(30);
    cam.fov = storm.camera.fov;
  }
  cam.roll = 0;
  flying = true;
  setPaused(false);
  hud.dataset.phase = 'flying';
  void audio.hold(false);
  showToast('Comandi al pilota', 1.6);
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-cine]')) {
  b.addEventListener('click', () => {
    const k = b.dataset.cine;
    if (k === 'pause') setCinePaused(!cinema?.paused);
    else if (k === 'sound') void toggleSound();
    else if (k === 'pilot') cinemaToPilot();
    else if (k === 'replay') startCinema();
    else if (k === 'exit') toStart();
  });
}
const cinePos = new Vector3();
const cineLook = new Vector3();
/** Posa della regia → telecamera della scena; esposizione automatica come nel volo. */
function applyCinemaPose(dt: number) {
  const pose = cinema!.update(dt);
  cinePos.copy(pose.pos);
  cineLook.copy(pose.look);
  const upLocal = tmp.copy(cinePos).add(new Vector3(0, RE, 0)).normalize();
  const viewDir = tmp2.subVectors(cineLook, cinePos).normalize();
  // Vista quasi verticale: «alto» verso il nord, per non far ruotare l'immagine.
  if (Math.abs(viewDir.dot(upLocal)) > 0.96) upLocal.set(0, 0, -1);
  upV.copy(upLocal);
  const camAlt = cinePos.length() > 0 ? Math.hypot(cinePos.x, cinePos.y + RE, cinePos.z) - RE : 0;
  const [r, g, b] = probe?.result.radiance ?? [1, 1, 1];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const inCloud = 1 - Math.exp(-(probe?.result.sigmaCamera ?? 0) * 0.4);
  const target = camAlt > 40 ? 0.5 : 0.55 * (1 + inCloud * (Math.min(4, Math.max(1, (0.6 / Math.max(lum, 0.02)) ** 0.75)) - 1));
  // Uscendo dal buio (parete → occhio) l'adattamento è rapido: niente secondi di immagine bruciata.
  cam.exposure = damp(cam.exposure, target, target < cam.exposure ? (cam.exposure > target * 1.6 ? 8 : 3) : 1, dt);
  const portrait = storm!.camera.aspect < 1 ? 1.25 : 1;
  const fast = Math.min(1, Math.max(0, (flight!.speed - 0.6) / 1.8));
  storm!.setPose({ pos: cinePos, look: cineLook, up: upV, fov: Math.min(95, pose.fov * portrait), rate: 1, exposure: cam.exposure, fast });
  fadeEl.style.transition = 'none';
  fadeEl.style.opacity = String(cinema!.fade);
  if (cinema!.scene !== cineScene) {
    cineScene = cinema!.scene;
    const sc = SCENES[cineScene]!;
    cineTitle.querySelector('small')!.textContent = `SCENA ${cineScene + 1} DI 8`;
    cineTitle.querySelector('b')!.textContent = sc.title;
    cineTitle.querySelector('span')!.textContent = sc.subtitle;
    cineTitle.classList.remove('is-shown');
    void cineTitle.offsetWidth;
    cineTitle.classList.add('is-shown');
  }
  if (cinema!.finished && cineEnd.hidden) cineEnd.hidden = false;
}

/** Condizioni meteo nel punto della telecamera (le precipitazioni e la visibilità sono attorno a chi guarda). */
function weatherAtCamera(): Weather {
  const f = flight!;
  const c = storm!.camera.position;
  const mapAngle = storm!.internals.shared.mapAngle.value;
  const alt = Math.hypot(c.x, c.y + RE, c.z) - RE;
  const near = c.distanceTo(f.pos) < 1.5;
  const col = columnAt!(c.x, c.z, mapAngle);
  const eyeR = 6 + 0.55 * Math.max(0, alt);
  const zone = near ? f.zone : col.core > 0.5 && col.r < eyeR - 1.5 && alt < col.top + 0.5 ? 'eye' : alt > col.top + 0.6 || col.tau < 0.3 ? 'above' : col.tau > 8 ? 'dense' : 'bands';
  const w = weatherAt({ x: c.x, z: c.z, alt, r: col.r, tau: col.tau, top: col.top, core: col.core, zone, turb: f.turbulence, sigma: probe?.result.sigmaCamera ?? 0 });
  return shaftModulate(w, probe?.result.sigmaCamera ?? 0, alt < cloudBaseKm(col.tau, col.top, col.core) - 0.25);
}

function resize() {
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
}
new ResizeObserver(resize).observe(canvas);

let frame = 0;
let fxMs = 0;
let atmNow = 0.2;
let simNow = 0;
let hailEvents = 0;
let strideWant = 3;
let frameAvg = 16.7;
let fxAdaptAt = 0;
let strideSince = 0;
async function boot() {
  const milton = await loadMilton();
  resize();
  flight = createFlight(milton);
  view = createAircraftView(renderer, milton.sun);
  storm = createStormScene(renderer, milton, {
    mobile,
    ...(params.get('debug') ? { debug: +params.get('debug')! } : {}),
    ...(params.get('scale') ? { fixedScale: +params.get('scale')! } : {}),
    // In volo la parallasse delle nubi vicine è forte: blocco 2×2 e più peso al frame corrente in movimento.
    stride: params.get('stride') ? +params.get('stride')! : 3,
    motionBlend: 0.85,
    motionSmooth: 0.7,
    parallaxMode: !params.has('noparallax'),
    overlay: () => {
      if (aircraftLive() && !params.has('noaircraft')) view!.render(cam.exposure);
    },
  });
  probe = createProbe(renderer, storm);
  nav = createNav(hud, milton.map);
  columnAt = createColumnSampler(milton.map, milton);
  precip = createPrecip(view.scene, mobile);
  lightning = createLightning({
    sample(x, z) {
      const mapAngle = storm!.internals.shared.mapAngle.value;
      const col = columnAt!(x, z, mapAngle);
      const w = weatherAt({ x, z, alt: 6, r: col.r, tau: col.tau, top: col.top, core: col.core, zone: 'dense', turb: 0, sigma: 0 });
      return { convective: w.convective * (col.tau > 2 ? 1 : 0), top: col.top, base: cloudBaseKm(col.tau, col.top, col.core), eye: col.core > 0.5 && col.r < 6 + 0.55 * 6 - 1 };
    },
    worldAt(x, z, h, out = new Vector3()) {
      return out.set(x, RE, z).normalize().multiplyScalar(RE + h).sub(new Vector3(0, RE, 0));
    },
  });
  boltView = createBoltView(view.boltScene);
  // Oceano dinamico: 12 treni d'onda su desktop, 8 sul telefono (ridotti dal controllo adattivo se serve).
  storm.internals.shared.s25Waves.value = params.has('nowaves') ? 0 : mobile ? 8 : 12;
  cinema = createCinema(flight);
  // Luce diffusa dentro le nubi vicine alla telecamera (solo S2: la S1.1 resta invariata).
  storm.internals.shared.interiorLight.value = 1;
  // Nubi lontane (oltre 6 km): luce completa un campione su tre (le si attraversa quasi in orizzontale).
  storm.internals.shared.farReuse.value = 1;
  // Ottava fine (25–100 m) solo finché resta più grande di un pixel: dal basso o di lato, oltre, diventa puntini.
  storm.internals.shared.fineFade.value.set(0.006, 0.02);
  // Erosione del dettaglio solo nei primi km (oltre, i suoi fori diventano puntini scuri).
  storm.internals.shared.erodeFade.value.set(0.002, 0.008);
  storm.internals.shared.s21Flags.value = params.has('flags') ? +params.get('flags')! : 1;
  // Nubi lontane: senza ottava fine oltre 25 km, senza dettaglio oltre 60 km (da lì il dettaglio è sotto il pixel).
  storm.internals.shared.farLod.value.set(25, 60);
  // Tempo reale: rumore delle nubi con una sola lettura (vedi noiseAt nello shader).
  storm.internals.shared.staticFlow.value = 1;
  // S2.3: riproiezione con la distanza vera del mare (le viste dall'alto non si stirano più in movimento).
  storm.internals.recon.uniforms.s23Fix!.value = params.has('nofix') ? 0 : 1;
  storm.internals.shared.s23Vis.value = params.has('novis') ? 0 : 1;
  storm.internals.shared.rainRange.value = 5;
  loading.hidden = true;
  if (params.has('fly')) begin();
  else if (params.has('cinema')) startCinema();

  let last = performance.now();
  let hudAt = 0;
  let simTime = 0;
  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (toastTimer > 0 && (toastTimer -= dt) <= 0) toast.hidden = true;
    const s = storm!;
    const f = flight!;
    if (flying) {
      // Tastiera facoltativa: si somma alla cloche.
      const kx = (keys.has('arrowright') || keys.has('d') ? 1 : 0) - (keys.has('arrowleft') || keys.has('a') ? 1 : 0);
      const ky = (keys.has('arrowup') || keys.has('w') ? 1 : 0) - (keys.has('arrowdown') || keys.has('s') ? 1 : 0);
      const input: Controls = {
        stickX: drag ? controls.stickX : kx * 0.8,
        stickY: drag ? controls.stickY : ky * 0.7,
        boost: controls.boost || keys.has('shift'),
        slow: controls.slow || keys.has('control'),
      };
      if (!paused) {
        simTime += dt;
        f.setLocalSigma(probe!.result.sigmaAircraft);
        const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
        for (let i = 0; i < steps; i++) f.step(dt / steps, FX.has('noturb') ? { ...input } : input, s.internals.shared.mapAngle.value);
        updateCamera(dt);
      }
    } else if (cinema!.active) {
      // CINEMA: il velivolo vola con la guida della regia (stesso modello, stesse raffiche).
      if (!cinema!.paused && cinema!.flying) {
        simTime += dt;
        f.setLocalSigma(probe!.result.sigmaAircraft);
        const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
        const none: Controls = { stickX: 0, stickY: 0, boost: false, slow: false };
        for (let i = 0; i < steps; i++) f.step(dt / steps, none, s.internals.shared.mapAngle.value);
      }
      applyCinemaPose(cinema!.paused ? 0 : dt);
    }
    // Blocco 2×2 solo dentro le nubi (forte parallasse vicina), 3×3 fuori (costo minore).
    if (aircraftLive() && !params.has('stride')) {
      // Cambio con isteresi di 1 s: a 3 km/s tra nubi sottili la densità oscilla e cambi continui lascerebbero
      // tasselli nella ricostruzione.
      const sc = probe!.result.sigmaCamera;
      const want = sc > 1.5 ? 2 : sc < 0.5 ? 3 : strideWant;
      if (want !== strideWant) {
        strideWant = want;
        strideSince = now;
      }
      if (now - strideSince > 1000) {
        s.setStride(strideWant);
        s.internals.shared.fogJitter.value = strideWant === 2 ? 1 : 0;
      }
    } else if (!aircraftLive()) s.setStride(3);
    s.update(dt, now);
    const frozen = paused || (cinema!.active && cinema!.paused);
    simNow = simTime;
    const live = aircraftLive();
    const sh = s.internals.shared;
    // ── Meteo attorno alla telecamera: velo delle precipitazioni, particelle, fulmini, audio.
    const tFx = performance.now();
    if (live || cinema!.active) {
      weather = weatherAtCamera();
      const w = weather;
      const [lr, lg, lb] = probe!.result.radiance;
      // Colore del velo: luce diffusa nella nube, un po' più scuro sotto la pioggia battente.
      sh.rainColor.value.set(lr, lg, lb).multiplyScalar(0.8);
      // Velo: cresce in ~1 s entrando nella pioggia, si dissolve in ~0,5 s uscendone.
      const ext = damp(sh.rainExt.value, w.extinction, w.extinction > sh.rainExt.value ? 1.5 : 5, dt);
      sh.rainExt.value = FX.has('noveil') || ext < 0.01 ? 0 : ext;
      const camNear = s.camera.position.distanceTo(f.pos) < 2;
      if (precip && !FX.has('noprecip')) {
        const velMs = camNear ? tmp.copy(f.velocity).multiplyScalar(1000) : tmp.set(0, 0, 0);
        precip.update(frozen ? 0 : dt, w.phase, w.intensity, tmp2.copy(f.wind).multiplyScalar(1000), velMs, f.frame().up, [lr, lg, lb], view!.camera, renderer.domElement.height);
      }
      // Fulmini (luce sulle nubi e sul velivolo, tuono ritardato dalla distanza).
      // S2.5: fulmini nati in punti reali attorno alla telecamera (convezione), luce localizzata nelle nubi
      // e sul mare, canali visibili solo dove plausibile, tuono con il ritardo della distanza vera.
      const camPos = s.camera.position;
      const camAltKm = Math.hypot(camPos.x, camPos.y + RE, camPos.z) - RE;
      if (!frozen && !FX.has('nolightning') && lightning) {
        // Regia: qualche lampo nella tempesta, scariche più fitte nella parete (mai continue: intervallo ≥ 1,2 s).
        const cineBoost = cinema?.active ? ([1, 1, 1.5, 3, 3, 1, 1, 1][cinema.scene] ?? 1) : 2;
        const ev = lightning.step(simTime, dt, camPos, camAltKm, (camNear ? f.zone : '') === 'eye', cineBoost);
        if (ev) {
          bolt = ev;
          lightningCount++;
          audio.thunder(ev.distKm, ev.strength * (gentleFlashes ? 0.7 : 1));
          // Canale visibile: nube-mare se siamo sotto le nubi, ramificato se siamo sopra le sommità.
          const colC = columnAt!(camPos.x, camPos.z, sh.mapAngle.value);
          const below = camAltKm < cloudBaseKm(colC.tau, colC.top, colC.core) + 0.3;
          const above = camAltKm > colC.top - 0.5;
          boltVisible = (ev.kind === 'cg' && below) || (ev.kind === 'cc' && above) ? 1 : 0;
          boltView?.show(boltVisible ? ev.segments : [], ev.base);
        }
        flashT += dt;
      }
      flashLevel = bolt ? (flashHold > 0 ? flashHold : flashEnvelope(bolt, simTime, gentleFlashes)) : 0;
      if (bolt && simTime - bolt.t0 > 1.5 && flashHold === 0) bolt = null;
      sh.flashPower.value = flashLevel * (gentleFlashes ? 3 : 9);
      if (bolt) sh.flashPos.value.copy(bolt.pos);
      sh.flashRange.value = 3.5;
      s.internals.composite.uniforms.flash!.value = 0;
      // Luce del lampo nelle nubi: alone sullo schermo attorno al punto del lampo, ampio quanto ~3 km alla sua
      // distanza; attenuato dalla nube tra la telecamera e il lampo.
      const cu = s.internals.composite.uniforms;
      if (bolt && flashLevel > 0) {
        const dKm = bolt.pos.distanceTo(camPos);
        const ndc = tmp.copy(bolt.pos).project(s.camera);
        const behind = tmp2.subVectors(bolt.pos, camPos).dot(s.camera.getWorldDirection(tmp3)) < 0;
        // Lampo vicino (entro ~2 km) o alle spalle: si vede solo la luce diffusa attorno, ampia e tenue.
        const near = Math.max(0, 1 - dKm / 2.5);
        cu.flashNdc!.value.set(ndc.x, ndc.y, behind && near <= 0 ? 0 : 1);
        if (behind) cu.flashNdc!.value.set(0, 0, near > 0 ? 1 : 0);
        cu.flashSize!.value = Math.min(3, Math.atan(3 / Math.max(dKm, 0.3)) / Math.tan((s.camera.fov * Math.PI) / 360) + (behind ? 2 : near * 2));
        const fogC = Math.exp(-(probe?.result.sigmaCamera ?? 0) * Math.min(4, dKm) * 0.5);
        cu.flashGlow!.value = flashLevel * (gentleFlashes ? 0.25 : 1) * (0.35 + 0.65 * fogC) * Math.exp(-dKm / 25) * (behind ? 0.4 : 1);
      } else cu.flashGlow!.value = 0;
      cu.aspect!.value = s.camera.aspect;
      // Il velivolo riceve la luce solo se il lampo è vicino (illuminazione localizzata).
      view!.setFlash(bolt ? flashLevel * Math.exp(-bolt.pos.distanceTo(camPos) / 6) : 0, bolt ? tmp.subVectors(bolt.pos, camPos).normalize() : undefined);
      // Nebbia della nube tra la telecamera e il canale.
      const fogT = Math.exp(-(probe?.result.sigmaCamera ?? 0) * Math.min(5, bolt?.distKm ?? 0) * 0.5);
      boltShown = bolt ? flashLevel * boltVisible * fogT * (gentleFlashes ? 0.3 : 1.6) : 0;
      boltView?.update(camPos, boltShown, (2 * Math.tan((s.camera.fov * Math.PI) / 360)) / Math.max(1, renderer.domElement.height));
      // Raffiche improvvise → soffio.
      if (f.gustEvents !== lastGusts) {
        lastGusts = f.gustEvents;
        audio.gust(Math.min(1, 0.5 + f.turbulence));
      }
      // Rumore meteorologico: forte contrasto nell'occhio, atmosfera tranquilla sopra le nubi.
      const atmTarget = live ? (f.zone === 'eye' ? 0.05 : f.zone === 'clear' ? 0.15 : f.zone === 'above' ? 0.25 : 1) : 0.2;
      atmNow = damp(atmNow, atmTarget, atmTarget < atmNow ? 2.5 : 0.8, dt);
      const atm = atmNow;
      // Grandine a episodi: chicchi visibili e colpi sonori nello stesso istante.
      if (!frozen && w.phase === 'hail' && Math.random() < dt * 0.9) {
        const k = 3 + Math.floor(Math.random() * 6);
        precip?.burst(1);
        audio.hail(k, 0.5);
        hailEvents++;
      }
      if (!FX.has('noaudio')) audio.update({ power: Math.min(1, Math.max(0, (f.speed - SLOW) / (BOOST - SLOW)) * 1.1 + 0.05), airspeed: Math.min(2.2, f.speed / CRUISE), windMs: f.windKmS * 1000, turbulence: f.turbulence, rain: w.intensity, phase: w.phase, atmosphere: atm, near: camNear ? 1 : Math.exp(-s.camera.position.distanceTo(f.pos) / 2), sea: Math.max(0, 1 - camAltKm / 1.0) });
    } else {
      sh.rainExt.value = 0;
      s.internals.composite.uniforms.flash!.value = 0;
      s.internals.composite.uniforms.flashGlow!.value = 0;
      sh.flashPower.value = 0;
      boltView?.update(s.camera.position, 0, 0.001);
      precip?.update(0, 'none', 0, tmp, tmp, tmp, [1, 1, 1], view!.camera, 1);
    }
    fxMs = fxMs * 0.95 + (performance.now() - tFx) * 0.05;
    // Qualità adattiva degli effetti: con frame lenti si riducono prima le particelle (fino al 25%), poi
    // interviene la risoluzione adattiva delle nubi; con frame rapidi si risale lentamente.
    frameAvg = frameAvg * 0.95 + dt * 1000 * 0.05;
    if (precip && now - fxAdaptAt > 500) {
      fxAdaptAt = now;
      // Prima le particelle, poi i treni d'onda (fino a 6); la qualità delle nubi resta alla risoluzione adattiva.
      const sh2 = storm!.internals.shared;
      if (frameAvg > 18.2) {
        if (precip.quality > 0.45) precip.setQuality(precip.quality * 0.8);
        else if (sh2.s25Waves.value > 6) sh2.s25Waves.value -= 2;
      } else if (frameAvg < 17.2) {
        if (sh2.s25Waves.value > 0 && sh2.s25Waves.value < (mobile ? 8 : 12) && !params.has('nowaves')) sh2.s25Waves.value += 1;
        else precip.setQuality(precip.quality + 0.05);
      }
    }
    if (live) view!.update(f.pos, f.attitude(attitude), s.camera, probe!.result, simTime, frozen ? 0 : dt, 1 + Math.min(1, f.speed / BOOST), reducedMotion ? 0 : f.turbulence, sh.rainExt.value);
    s.render();
    if (live) probe!.run(f.pos, s.camera.position);

    if (flying && now - hudAt > 120) {
      hudAt = now;
      const st = f.state();
      speedEl.firstElementChild!.textContent = String(Math.round(st.speedKmh));
      altEl.firstElementChild!.textContent = st.alt.toFixed(st.alt < 10 ? 2 : 1);
      const hdg = ((-st.heading % 360) + 360) % 360;
      hdgEl.firstElementChild!.textContent = `${Math.round(hdg)} ${CARDINAL[Math.round(hdg / 45) % 8]}`;
      zoneEl.textContent = ZONE_LABEL[st.zone];
      if (weather) meteoEl.textContent = `${PHASE_LABEL[weather.phase]}${weather.rateMmH >= 0.5 ? ` · ~${Math.round(weather.rateMmH)} mm/h` : ''} · ${Math.round(weather.tempC)} °C stimati`;
      // Rotta verso l'occhio, in gradi dal nord geografico della scena (senso orario).
      const toEye = ((Math.atan2(-st.x, st.z) / DEG) + 360) % 360;
      const status = paused ? 'In pausa' : st.warning || (f.auto ? 'Navigazione assistita' : '') || (st.zone === 'eye' ? 'In volo · calma relativa' : st.turb > 0.6 ? 'In volo · turbolenza forte' : 'In volo');
      stateEl.textContent = `${status} · rotta per l’occhio ${Math.round(toEye)}°`;
      hud.dataset.warning = st.warning;
      nav!.update({ x: st.x, z: st.z, heading: f.heading, mapAngle: s.internals.shared.mapAngle.value, eyeRadiusKm: 6 + 0.55 * Math.max(0, st.alt) }, now);
      // Assistenza interrotta dalla cloche (nel modello di volo): l'interfaccia lo segnala.
      if (autoBtn.getAttribute('aria-pressed') === 'true' && !f.auto) {
        setAutoUi(false);
        if (f.autoNote === 'manual') showToast('Cloche: assistenza interrotta, comandi al pilota', 1.8);
      }
      if (f.auto) autoBtn.querySelector('span')!.textContent = f.autoNote === 'orbit' ? 'nell’occhio: orbita lenta · tocca per interrompere' : 'rotta verso l’occhio · tocca per interrompere';
      const lvl = Math.min(5, Math.ceil(st.turb * 5.5));
      turbEl.dataset.level = String(lvl);
      turbEl.querySelectorAll('i b').forEach((b, i) => b.classList.toggle('on', i < lvl));
    }
  };
  frame = requestAnimationFrame(tick);
  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(frame);
    if (!document.hidden) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  });
}

// Solo per le verifiche automatiche del laboratorio.
Object.assign(window, {
  __s2: {
    begin,
    toStart,
    stick: (x: number, y: number) => {
      controls.stickX = x;
      controls.stickY = y;
      drag = x || y ? { id: -1, x: 0, y: 0 } : null;
    },
    boost: (v: boolean) => (controls.boost = v),
    slow: (v: boolean) => (controls.slow = v),
    level,
    recover,
    pause: setPaused,
    auto: toggleAuto,
    storm: () => storm,
    radar: (v: boolean) => nav?.setOpen(v),
    cinemaStart: startCinema,
    cinemaPilot: cinemaToPilot,
    cinemaPause: setCinePaused,
    cinema: () => (cinema ? { active: cinema.active, scene: cinema.scene, sceneTime: cinema.sceneTime, total: cinema.total, finished: cinema.finished, fade: cinema.fade, paused: cinema.paused } : null),
    weather: () => weather,
    viewScene: () => view?.scene,
    fx: () => ({ waves: storm?.internals.shared.s25Waves.value, bolt: bolt ? { kind: bolt.kind, dist: bolt.distKm, visible: boltVisible, shown: boltShown, segs: bolt.segments.length / 2 } : null, gentleFlashes, hailEvents, atm: atmNow, peak: audio.peak(), loud: audio.loud(), precipQuality: precip?.quality, fxMs, flash: flashLevel, lightning: lightningCount, rainExt: storm?.internals.shared.rainExt.value, precip: precip?.counts, audio: { enabled: audio.enabled, state: audio.contextState, oneShots: audio.activeOneShots, volume: audio.volume, level: audio.level(), flags: audio.flags }, reducedMotion }),
    sound: () => toggleSound(),
    audioDiag: () => audio.diag(),
    thunderLevel: () => audio.thunderLevel(),
    volume: (v: number) => audio.setVolume(v),
    motion: (v: boolean) => (reducedMotion = v),
    gentle: (v: boolean) => (gentleFlashes = v),
    holdFlash: (v: number) => (flashHold = v),
    forceBolt: (kind: 'intra' | 'cg' | 'cc', distKm: number) => {
      // Solo verifiche: lampo di prova a distanza nota davanti alla telecamera.
      if (!lightning || !storm) return;
      const c = storm.camera.position;
      const fwd = storm.camera.getWorldDirection(new Vector3());
      // Un po' di lato (~25°), per non finire dietro al velivolo.
      const side = new Vector3().crossVectors(fwd, storm.camera.up).normalize();
      const p = c.clone().addScaledVector(fwd, distKm * 0.9).addScaledVector(side, distKm * 0.42);
      const col = columnAt!(p.x, p.z, storm.internals.shared.mapAngle.value);
      const base = Math.max(1.5, cloudBaseKm(col.tau, col.top, col.core));
      const at = (h: number) => new Vector3(p.x, RE, p.z).normalize().multiplyScalar(RE + h).sub(new Vector3(0, RE, 0));
      const segs: Vector3[] = [];
      if (kind === 'cg') branchChannel(at(base + 2.5), at(0), 0.12, 6, segs, 3);
      bolt = { kind, pos: at(base), segments: segs, strength: 1, strokes: [{ at: 0, power: 1, len: 0.15 }, { at: 0.12, power: 0.6, len: 0.1 }], t0: simNow, distKm, base: kind === 'cg' ? base : Infinity };
      boltVisible = kind === 'cg' ? 1 : 0;
      boltView?.show(segs, base);
      audio.thunder(distKm, 1);
      lightningCount++;
    },
    state: () => (flight ? { ...flight.state(), auto: flight.auto, autoNote: flight.autoNote, flying, paused, probe: probe?.result, exposure: cam.exposure, fov: cam.fov } : null),
    stats: () => storm?.stats() ?? null,
    teleport: (x: number, z: number, h: number, headingDeg: number) => flight?.teleport(x, z, h, headingDeg),
    glError: () => renderer.getContext().getError(),
    info: () => ({ ...renderer.info.memory, programs: renderer.info.programs?.length ?? 0 }),
    dispose: () => {
      cancelAnimationFrame(frame);
      probe?.dispose();
      boltView?.dispose();
      nav?.dispose();
      precip?.dispose();
      audio.dispose();
      view?.dispose();
      storm?.dispose();
      hud.remove();
      storm = null;
    },
  },
});

boot().catch((err: unknown) => {
  loading.hidden = false;
  loading.textContent = `Impossibile preparare la scena: ${String(err)}`;
  console.error(err);
});
