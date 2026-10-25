import { DataUtils, type DataTexture } from 'three';
import { MAP_HALF_KM, MAP_SIZE } from '../storm-s11/milton';

/**
 * STORM FLIGHT S2.1 — strumenti di navigazione, calcolati dalle coordinate del velivolo e del centro
 * dell'uragano (origine del piano della scena, +x est, −z nord).
 *
 * Bussola: freccia verso l'occhio rispetto al muso (0° = davanti, a destra = in senso orario), distanza e
 * tendenza dalla variazione della distanza. Mini-radar: schema in pianta, nord in alto, scala automatica;
 * le bande sono lo spessore ottico GOES-16 della mappa (ruotata con la tempesta), non un radar meteorologico.
 */

export interface NavInput {
  x: number;
  z: number;
  /** Prua nella convenzione del volo (0 = nord, crescente verso ovest). */
  heading: number;
  mapAngle: number;
  eyeRadiusKm: number;
}

const DEG = Math.PI / 180;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const RANGES = [15, 30, 60, 120, 250, 500, 750];

/** Direzione dell'occhio rispetto al muso, in gradi: 0 davanti, positivo a destra, ±180 dietro. */
export function eyeBearing(x: number, z: number, heading: number): number {
  // Prua che punterebbe al centro: (−sin h, −cos h) ∥ (−x, −z).
  const want = Math.atan2(x, z);
  // Prua crescente = a sinistra: l'angolo a destra è heading − want.
  return wrap(heading - want) / DEG;
}

export function describeBearing(deg: number): string {
  const a = Math.abs(deg);
  if (a <= 15) return 'davanti';
  if (a >= 160) return 'alle spalle';
  const side = deg > 0 ? 'destra' : 'sinistra';
  if (a < 70) return `avanti a ${side}`;
  if (a <= 110) return `a ${side}`;
  return `dietro a ${side}`;
}

/** Immagine delle bande (spessore ottico osservato) dalla mappa della scena, generata una volta. */
function bandsImage(map: DataTexture): HTMLCanvasElement {
  const N = 128;
  const step = MAP_SIZE / N;
  const data = map.image.data as unknown as Uint16Array;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      let tau = 0;
      for (let v = 0; v < step; v++) for (let u = 0; u < step; u++) tau += DataUtils.fromHalfFloat(data[((j * step + v) * MAP_SIZE + i * step + u) * 4]!);
      tau /= step * step;
      const a = Math.min(1, Math.max(0, (tau - 0.4) / 14));
      const k = (j * N + i) * 4;
      // Bande chiare, nubi spesse più luminose.
      img.data[k] = 190 + 60 * a;
      img.data[k + 1] = 205 + 45 * a;
      img.data[k + 2] = 225 + 30 * a;
      img.data[k + 3] = Math.round(255 * Math.pow(a, 0.6) * 0.85);
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function createNav(host: HTMLElement, map: DataTexture) {
  const compass = document.createElement('div');
  compass.className = 'sf2-compass';
  compass.innerHTML = `
    <div class="sf2-compass__dial" aria-hidden="true">
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="44" class="ring"/>
        <path d="M50 4v8M50 88v8M4 50h8M88 50h8" class="tick"/>
        <path d="M50 30l-6 9h12z" class="nose"/>
        <g class="arrow"><path d="M50 10l9 16h-6v14h-6V26h-6z"/></g>
      </svg>
    </div>
    <div class="sf2-compass__text"><b class="dist">—</b><span class="where">—</span><span class="trend">—</span></div>`;
  compass.setAttribute('role', 'status');
  compass.setAttribute('aria-label', 'Direzione dell’occhio');
  const arrow = compass.querySelector<SVGGElement>('.arrow')!;
  const distEl = compass.querySelector<HTMLElement>('.dist')!;
  const whereEl = compass.querySelector<HTMLElement>('.where')!;
  const trendEl = compass.querySelector<HTMLElement>('.trend')!;

  const radar = document.createElement('div');
  radar.className = 'sf2-radar';
  radar.innerHTML = `
    <button type="button" class="sf2-radar__toggle" aria-expanded="true">RADAR <span>schema</span></button>
    <div class="sf2-radar__body"><canvas></canvas><small class="scale"></small></div>`;
  const toggle = radar.querySelector<HTMLButtonElement>('.sf2-radar__toggle')!;
  const canvas = radar.querySelector('canvas')!;
  const scaleEl = radar.querySelector<HTMLElement>('.scale')!;
  let open = true;
  const setOpen = (v: boolean) => {
    open = v;
    radar.classList.toggle('is-closed', !v);
    toggle.setAttribute('aria-expanded', String(v));
  };
  toggle.addEventListener('click', () => setOpen(!open));
  toggle.title = 'Mini-radar schematico (bande da GOES-16, non un radar meteorologico)';
  host.append(compass, radar);

  const bands = bandsImage(map);
  let lastR: number | null = null;
  let lastT = 0;
  let trend = 0;
  let range = 500;

  const draw = (n: NavInput, r: number) => {
    const ctx = canvas.getContext('2d')!;
    const css = canvas.clientWidth || 140;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (canvas.width !== Math.round(css * dpr)) canvas.width = canvas.height = Math.round(css * dpr);
    const S = canvas.width;
    // Scala: la più piccola che contiene il velivolo e l'occhio con margine (con isteresi).
    const need = r * 1.2 + 4;
    const fit = RANGES.find((v) => v >= need) ?? RANGES[RANGES.length - 1]!;
    if (fit > range || fit < range * 0.45) range = fit;
    const kmToPx = S / 2 / range;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(8, 22, 38, 0.82)';
    ctx.fillRect(0, 0, S, S);
    // Centrato sul velivolo, nord in alto: punto (x, z) → (S/2 + (x − ax)·k, S/2 + (z − az)·k).
    const ox = S / 2 - n.x * kmToPx;
    const oz = S / 2 - n.z * kmToPx;
    ctx.save();
    ctx.translate(ox, oz);
    // La mappa della scena è campionata in rot(xz, mapAngle): l'immagine ruota di −mapAngle (stessa convenzione).
    ctx.rotate(-n.mapAngle);
    ctx.imageSmoothingEnabled = true;
    const half = MAP_HALF_KM * kmToPx;
    ctx.drawImage(bands, -half, -half, half * 2, half * 2);
    ctx.restore();
    // Anelli di distanza dall'occhio.
    ctx.strokeStyle = 'rgba(160, 210, 255, 0.28)';
    ctx.lineWidth = Math.max(1, S / 160);
    for (const k of [50, 150, 300]) {
      if (k * kmToPx < S * 0.04) continue;
      ctx.beginPath();
      ctx.arc(ox, oz, k * kmToPx, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Occhio (fuori scala: almeno qualche pixel).
    const er = Math.max(n.eyeRadiusKm * kmToPx, S * 0.03);
    ctx.fillStyle = 'rgba(255, 207, 122, 0.25)';
    ctx.strokeStyle = '#ffcf7a';
    ctx.lineWidth = Math.max(1.5, S / 70);
    ctx.beginPath();
    ctx.arc(ox, oz, er, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffcf7a';
    ctx.beginPath();
    ctx.arc(ox, oz, Math.max(1.5, S / 90), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // Velivolo al centro, orientato con la prua: direzione (−sin h, −cos h) in (x, z), cioè in pixel (nord in alto).
    ctx.save();
    ctx.translate(S / 2, S / 2);
    // Il triangolo punta in alto (0, −1); ruotato di −h diventa (−sin h, −cos h).
    ctx.rotate(-n.heading);
    const a = S * 0.06;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath();
    ctx.moveTo(0, -a * 1.3);
    ctx.lineTo(a * 0.85, a);
    ctx.lineTo(0, a * 0.45);
    ctx.lineTo(-a * 0.85, a);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Nord.
    ctx.fillStyle = 'rgba(230, 240, 255, 0.85)';
    ctx.font = `${Math.round(S * 0.085)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('N', S / 2, S * 0.11);
    scaleEl.textContent = `raggio ${range} km`;
  };

  return {
    /** Azzera la tendenza (nuova partenza). */
    reset() {
      lastR = null;
      trend = 0;
      range = 500;
    },
    update(n: NavInput, now: number) {
      const r = Math.hypot(n.x, n.z);
      const rel = eyeBearing(n.x, n.z, n.heading);
      arrow.setAttribute('transform', `rotate(${rel.toFixed(1)} 50 50)`);
      distEl.textContent = r < 10 ? `${r.toFixed(1)} km` : `${Math.round(r)} km`;
      const inEye = r < n.eyeRadiusKm;
      whereEl.textContent = inEye ? 'sei nell’occhio' : `occhio ${describeBearing(rel)}`;
      // Tendenza: variazione della distanza (km/s), media su ~1 s.
      if (lastR !== null && now > lastT) {
        const rate = (r - lastR) / ((now - lastT) / 1000);
        trend += (rate - trend) * Math.min(1, (now - lastT) / 1000);
      }
      lastR = r;
      lastT = now;
      const state = inEye ? 'eye' : trend < -0.015 ? 'in' : trend > 0.015 ? 'out' : 'flat';
      trendEl.textContent = state === 'in' ? '▼ AVVICINAMENTO' : state === 'out' ? '▲ ALLONTANAMENTO' : state === 'eye' ? '● NELL’OCCHIO' : '= DISTANZA STABILE';
      compass.dataset.trend = state;
      if (open) draw(n, r);
      return { r, rel, trend: state };
    },
    setOpen,
    get open() {
      return open;
    },
    dispose() {
      compass.remove();
      radar.remove();
    },
  };
}

export type Nav = ReturnType<typeof createNav>;
