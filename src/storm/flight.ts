import { DataUtils, Euler, Matrix4, Quaternion, Vector3, type DataTexture } from 'three';
import { MAP_HALF_KM, MAP_SIZE, type MiltonState } from './render/milton';

/**
 * STORM FLIGHT S2 — modello di volo ARCADE (stessa filosofia di CITY FLIGHT, non aerodinamica reale).
 *
 * Unità: km, km/s, secondi. Piano della scena S1.1: +x est, +y su, −z nord, Terra sferica (centro in
 * (0, −RE, 0)). La prua usa la convenzione di CITY FLIGHT: 0 = nord, valori crescenti verso ovest;
 * bancata positiva = virata a destra. Il volo livellato segue la curvatura (l'alto locale è ricalcolato
 * a ogni passo).
 *
 * DINAMICA METEOROLOGICA (approssimata ma fisica): deriva dovuta al vento ciclonico con il profilo di
 * Rankine modificato della S1.1 (vento massimo e raggio dei venti massimi da HURDAT2), afflusso nei
 * bassi strati e deflusso in quota.
 * GAMEPLAY (non meteorologia): velocità di gioco elevate per attraversare 1000 km in pochi minuti, raggio
 * di virata ridotto, turbulenza come raffiche casuali la cui intensità dipende dalla zona attraversata.
 */

export const RE = 6371;
const DEG = Math.PI / 180;
/** Velocità di gioco (km/s): ~430, ~1260 e ~5400 km/h. */
export const SLOW = 0.12;
export const CRUISE = 0.35;
export const BOOST = 1.5;
const MAX_BANK = 55 * DEG;
const MAX_PITCH = 24 * DEG;
const CEILING = 20;
const FLOOR = 0.3;
const AREA_R = 720;

export type Zone = 'clear' | 'above' | 'bands' | 'dense' | 'wall' | 'eye';
export const ZONE_LABEL: Record<Zone, string> = {
  clear: 'Aria limpida sopra l’oceano',
  above: 'Sopra le nubi',
  bands: 'Bande esterne',
  dense: 'Nubi dense del CDO',
  wall: 'Parete dell’occhio',
  eye: 'Occhio',
};
/** Intensità indicativa della turbolenza per zona (scala di gioco 0–1, non una misura). */
const ZONE_TURB: Record<Zone, number> = { clear: 0.02, above: 0.05, bands: 0.25, dense: 0.38, wall: 0.85, eye: 0.08 };

const damp = (c: number, t: number, rate: number, dt: number) => c + (t - c) * (1 - Math.exp(-rate * dt));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Guida automatica della regia CINEMA: il velivolo vola davvero (stesso modello, stesse raffiche) verso un punto
 * o in orbita attorno al centro, con quota e velocità di riferimento. Le velocità possono superare quelle di
 * gioco: è una rappresentazione artistica, non una simulazione aeronautica.
 */
export interface Guide {
  mode: 'point' | 'orbit' | 'hold';
  x?: number;
  z?: number;
  /** Raggio dell'orbita (km), antioraria. */
  radius?: number;
  alt: number;
  speed: number;
  /** Accelerazione massima (km/s²). */
  accel?: number;
  maxBank?: number;
  /** Beccheggio massimo (gradi) per salite e discese della regia. */
  maxPitch?: number;
  /** Guadagno di quota (gradi per km di differenza). */
  climbGain?: number;
  /**
   * Velocità verticale diretta (km/s) verso `alt`, indipendente dal beccheggio: spinta di sostentamento del VTOL
   * Concept C (come il decollo verticale di CITY FLIGHT). Solo regia CINEMA, scelta artistica.
   */
  vz?: number;
}

export interface Controls {
  /** Cloche virtuale: x destra (virata), y su (salita), −1…1. */
  stickX: number;
  stickY: number;
  boost: boolean;
  slow: boolean;
}

/** Campionamento della mappa GOES sulla CPU (stessa costruzione del nucleo di column() nello shader). */
export function createColumnSampler(map: DataTexture, milton: MiltonState) {
  const data = map.image.data as unknown as Uint16Array;
  const N = MAP_SIZE;
  const at = (i: number, j: number, c: number) => DataUtils.fromHalfFloat(data[(Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))) * 4 + c]!);
  return (x: number, z: number, mapAngle: number) => {
    const ca = Math.cos(mapAngle);
    const sa = Math.sin(mapAngle);
    const u = ((ca * x - sa * z) / (2 * MAP_HALF_KM) + 0.5) * N - 0.5;
    const v = ((sa * x + ca * z) / (2 * MAP_HALF_KM) + 0.5) * N - 0.5;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const bil = (c: number) => (at(i, j, c) * (1 - fu) + at(i + 1, j, c) * fu) * (1 - fv) + (at(i, j + 1, c) * (1 - fu) + at(i + 1, j + 1, c) * fu) * fv;
    const r = Math.hypot(x, z);
    const core = 1 - smooth(20, 44, r);
    const tau = bil(0) * (1 - core) + 30 * core;
    const top = bil(1) * (1 - core) + (15.6 + 1.1 * Math.exp(-(((r - milton.rmwKm * 1.3) / 6) ** 2))) * core;
    const mask = Math.max(1 - smooth(400, 480, r), core);
    return { tau: tau * mask, top, r, core };
  };
}

export function createFlight(milton: MiltonState) {
  const column = createColumnSampler(milton.map, milton);
  const windAt = (r: number) => (r < milton.rmwKm ? milton.vmaxMs * (r / milton.rmwKm) ** 2.6 : milton.vmaxMs * (milton.rmwKm / r) ** 0.55);

  // Stato.
  const pos = new Vector3();
  let heading = 0;
  let pitch = 0;
  let bank = 0;
  let speed = CRUISE;
  let levelTimer = 0;
  let recoverTimer = 0;
  // VAI ALL'OCCHIO: rotta verso il centro con virate e quota controllate; nell'occhio, orbita lenta.
  let auto = false;
  let guide: Guide | null = null;
  // Raffiche improvvise (eventi discreti) nelle zone convettive: impulso e contatore per l'audio.
  let gustEvents = 0;
  let gustKick = 0;
  const vel = new Vector3();
  let autoAlt = 7;
  let autoNote = '';
  let recoverClimb = false;
  let turb = 0;
  let zone: Zone = 'clear';
  let warning = '';
  // Raffiche (processi di Ornstein-Uhlenbeck: casuali ma continue, senza scatti).
  const gust = { bank: 0, pitch: 0, vert: 0, yaw: 0 };
  const stick = { x: 0, y: 0 };
  let localSigma = 0;
  // Assetto visibile (comandi + raffiche).
  let shownBank = 0;
  let shownPitch = 0;
  const wind = new Vector3();

  const up = new Vector3();
  const east = new Vector3();
  const north = new Vector3();
  const frame = () => {
    up.set(pos.x, pos.y + RE, pos.z).normalize();
    east.set(1, 0, 0).addScaledVector(up, -up.x).normalize();
    // Con up = (0, 1, 0) ed east = (1, 0, 0): up × east = (0, 0, −1), cioè il nord.
    north.crossVectors(up, east);
  };
  const altitude = () => Math.hypot(pos.x, pos.y + RE, pos.z) - RE;
  const forward = (out = new Vector3(), h = heading, p = pitch) => {
    frame();
    return out.copy(east).multiplyScalar(-Math.sin(h) * Math.cos(p)).addScaledVector(north, Math.cos(h) * Math.cos(p)).addScaledVector(up, Math.sin(p));
  };

  /** Posizione a una data quota sopra il punto (x, z) del piano. */
  const placeAt = (x: number, z: number, h: number) => {
    const d = new Vector3(x, RE, z).normalize();
    pos.copy(d).multiplyScalar(RE + h).y -= RE;
  };

  const reset = () => {
    // PARTENZA: sopra l’oceano a sud-est, ~300 km dal centro, verso nord-ovest (il CDO all'orizzonte).
    placeAt(212, 212, 6);
    heading = 45 * DEG;
    pitch = bank = 0;
    speed = CRUISE;
    turb = 0;
    gust.bank = gust.pitch = gust.vert = gust.yaw = 0;
    levelTimer = recoverTimer = 0;
    recoverClimb = false;
    auto = false;
    autoNote = '';
    guide = null;
    gustKick = 0;
    stick.x = stick.y = 0;
  };
  reset();

  const ou = (x: number, tau: number, sigma: number, dt: number) => x + (-x / tau) * dt + sigma * Math.sqrt((2 * dt) / tau) * gauss();
  const gauss = () => {
    let s = 0;
    for (let i = 0; i < 4; i++) s += Math.random();
    return (s - 2) * 1.732;
  };

  /** Zona attraversata, dalla colonna osservata e dalla geometria dell'occhio della S1.1. */
  const classify = (mapAngle: number) => {
    const h = altitude();
    const c = column(pos.x, pos.z, mapAngle);
    const eyeR = 6 + 0.55 * Math.max(h, 0);
    let z: Zone;
    if (c.core > 0.5 && c.r < eyeR - 1.5 && h < c.top + 0.5) z = 'eye';
    else if (h > c.top + 0.6 || c.tau < 0.3) z = h > 4 && c.tau > 0.3 ? 'above' : 'clear';
    else if (c.core > 0.2 && c.r < eyeR + 12) z = 'wall';
    else if (c.tau > 8) z = 'dense';
    else z = 'bands';
    // Intensità: dalla zona, più forte vicino alla faccia interna della parete e nella nube locale (sonda GPU).
    let target = ZONE_TURB[z];
    if (z === 'wall') target *= 0.75 + 0.25 * (1 - smooth(0, 10, Math.abs(c.r - eyeR - 3)));
    if (z !== 'eye') target = Math.max(target, Math.min(0.55, localSigma * 0.02));
    return { zone: z, target, column: c, h };
  };

  return {
    pos,
    get heading() {
      return heading;
    },
    get speed() {
      return speed;
    },
    get turbulence() {
      return turb;
    },
    get zone() {
      return zone;
    },
    get warning() {
      return warning;
    },
    altitude,
    forward,
    frame() {
      frame();
      return { up, east, north };
    },
    reset,
    /** Solo per le verifiche: posizione (km), quota (km) e prua (gradi, convenzione di CITY FLIGHT). */
    teleport(x: number, z: number, h: number, headingDeg: number) {
      placeAt(x, z, h);
      heading = headingDeg * DEG;
      pitch = bank = 0;
    },
    level() {
      levelTimer = 1.4;
    },
    /** VAI ALL'OCCHIO (true) o comando manuale (false). La quota di crociera è quella attuale, tra 3 e 10 km. */
    setAuto(on: boolean) {
      auto = on;
      autoNote = '';
      if (on) autoAlt = Math.min(10, Math.max(3, altitude()));
    },
    get auto() {
      return auto;
    },
    /** Regia CINEMA (null = comandi al pilota). */
    setGuide(g: Guide | null) {
      guide = g;
      if (g) auto = false;
    },
    get guide() {
      return guide;
    },
    /** Imposta la velocità attuale (km/s) e la prua (rad): solo all'inizio di una scena CINEMA dopo una dissolvenza. */
    setMotion(speedKmS: number, headingRad: number) {
      speed = speedKmS;
      heading = headingRad;
      pitch = bank = 0;
    },
    get gustEvents() {
      return gustEvents;
    },
    get gustKick() {
      return gustKick;
    },
    /** Velocità del velivolo rispetto al suolo (km/s, piano della scena). */
    get velocity() {
      return vel;
    },
    get wind() {
      return wind;
    },
    column: (mapAngle: number) => column(pos.x, pos.z, mapAngle),
    get autoNote() {
      return autoNote;
    },
    /** RECUPERA: ali livellate, crociera, raffiche smorzate; risalita fino ad almeno 1,5 km sul mare. */
    recover() {
      auto = false;
      recoverTimer = 3;
      recoverClimb = true;
      levelTimer = 1.6;
      gust.bank = gust.pitch = gust.vert = gust.yaw = 0;
    },
    /** Densità locale delle nubi (1/km) dalla sonda GPU: rende la turbolenza coerente con ciò che si vede. */
    setLocalSigma(s: number) {
      localSigma = s;
    },

    /** Passo di simulazione (dt ≤ 1/120 s, chiamato più volte per frame). */
    step(dt: number, input: Controls, mapAngle: number) {
      stick.x = damp(stick.x, levelTimer > 0 ? 0 : input.stickX, 10, dt);
      stick.y = damp(stick.y, levelTimer > 0 ? 0 : input.stickY, 10, dt);
      levelTimer = Math.max(0, levelTimer - dt);
      recoverTimer = Math.max(0, recoverTimer - dt);
      const dead = (v: number) => (Math.abs(v) < 0.06 ? 0 : (v - Math.sign(v) * 0.06) / 0.94);
      warning = '';

      const k = classify(mapAngle);
      zone = k.zone;
      turb = damp(turb, recoverTimer > 0 ? k.target * 0.2 : k.target, 1.2, dt);
      const h = k.h;

      // La cloche mossa dal pilota disattiva l'assistenza (restituisce subito il controllo).
      if (auto && (Math.abs(input.stickX) > 0.15 || Math.abs(input.stickY) > 0.15)) {
        auto = false;
        autoNote = 'manual';
      }
      let targetSpeed = input.boost ? BOOST : input.slow ? SLOW : CRUISE;
      // In nube densa e in parete il BOOST è limitato (gameplay: si vede pochissimo).
      if (zone === 'wall' || zone === 'dense') targetSpeed = Math.min(targetSpeed, 0.6);
      let targetBank = dead(stick.x) * MAX_BANK;
      let targetPitch = dead(stick.y) * MAX_PITCH;
      const r0 = Math.hypot(pos.x, pos.z);
      let accelOverride = 0;
      if (guide) {
        let want = heading;
        if (guide.mode === 'point') want = Math.atan2(pos.x - guide.x!, pos.z - guide.z!);
        else if (guide.mode === 'orbit') want = Math.atan2(pos.x, pos.z) + Math.PI / 2 - Math.atan((r0 - guide.radius!) / 1.5);
        const err = wrap(want - heading);
        const mb = (guide.maxBank ?? 45) * DEG;
        targetBank = Math.max(-mb, Math.min(mb, -err * 3));
        const mp = (guide.maxPitch ?? 9) * DEG;
        targetPitch = Math.max(-mp, Math.min(mp, (guide.alt - h) * (guide.climbGain ?? 8.6) * DEG));
        targetSpeed = guide.speed;
        accelOverride = guide.accel ?? 0.6;
      }
      if (auto) {
        // Prua verso il centro: la direzione orizzontale (−sin h, −cos h) in (x, z) deve valere (−x, −z)/r.
        let want = Math.atan2(pos.x, pos.z);
        const eyeR = 6 + 0.55 * Math.max(h, 0);
        if (r0 < eyeR) {
          // Nell'occhio: orbita antioraria a ~3 km dal centro, velocità ridotta.
          const ORBIT = 3;
          want += Math.PI / 2 - Math.atan((r0 - ORBIT) / 1.5);
          targetSpeed = SLOW;
          autoNote = 'orbit';
        } else {
          autoNote = 'route';
          // Nubi dense e parete: crociera (BOOST limitato comunque); all'avvicinarsi all'occhio si rallenta.
          if (r0 < 25) targetSpeed = Math.min(targetSpeed, CRUISE);
        }
        const err = wrap(want - heading);
        targetBank = Math.max(-50 * DEG, Math.min(50 * DEG, -err * 3));
        targetPitch = Math.max(-8 * DEG, Math.min(8 * DEG, (autoAlt - h) * 0.12));
      }
      if (recoverClimb && h < 1.5) recoverTimer = Math.max(recoverTimer, 0.5);
      else recoverClimb = false;
      if (recoverTimer > 0) {
        targetSpeed = CRUISE;
        targetPitch = recoverClimb ? 14 * DEG : 0;
      }
      // Limiti: area di volo, quota minima sul mare, quota massima.
      const r = Math.hypot(pos.x, pos.z);
      if (r > AREA_R) {
        // Prua verso il centro: la direzione orizzontale (−sin h, −cos h) in (x, z) deve valere (−x, −z)/r.
        const toCenter = Math.atan2(pos.x / r, pos.z / r);
        const err = wrap(toCenter - heading);
        targetBank = Math.max(-MAX_BANK * 0.7, Math.min(MAX_BANK * 0.7, -err * 1.4));
        warning = 'Limite dell’area di volo';
      }
      // Con la regia CINEMA la quota è comandata dalla guida (voli radenti fino a ~0,4 km): limite solo a 0,3 km.
      if (guide ? h < FLOOR : h < FLOOR + 0.5) {
        targetPitch = Math.max(targetPitch, ((FLOOR + 0.5 - h) / 0.5) * 14 * DEG);
        warning = 'Quota minima sul mare';
      }
      if (h > CEILING - 0.5) {
        targetPitch = Math.min(targetPitch, -2 * DEG);
        warning = 'Quota massima';
      }

      const accel = accelOverride || (targetSpeed > speed ? (input.boost ? 0.45 : 0.12) : 0.35);
      speed += Math.max(-accel * dt, Math.min(accel * dt, targetSpeed - speed));
      bank = damp(bank, targetBank, 2.4, dt);
      pitch = damp(pitch, targetPitch, 2.0, dt);

      // Raffiche: rollio, beccheggio, correnti verticali e imbardata, proporzionali alla turbolenza.
      const T = turb;
      gust.bank = ou(gust.bank, 0.7, 13 * DEG * T, dt);
      gust.pitch = ou(gust.pitch, 0.5, 4.5 * DEG * T, dt);
      gust.vert = ou(gust.vert, 1.1, 0.028 * T, dt);
      gust.yaw = ou(gust.yaw, 0.9, 0.05 * T, dt);
      // Raffiche improvvise: eventi rari e irregolari (Poisson), più frequenti con la turbolenza forte;
      // spinta verticale e rollio limitati, che il pilota può correggere.
      if (T > 0.3 && Math.random() < dt * (T - 0.3) * 0.9) {
        const s = gauss() > 0 ? 1 : -1;
        gust.vert += s * 0.02 * T;
        gust.bank += -s * (5 + 5 * Math.random()) * DEG * T;
        gustKick = 1;
        gustEvents++;
      }
      gustKick = Math.max(0, gustKick - dt * 1.5);
      const effBank = bank + gust.bank;
      const effPitch = pitch + gust.pitch;

      // Virata coordinata di gioco: raggio ~3 km alla crociera.
      heading += (-0.075 * Math.tan(effBank) * Math.sqrt(CRUISE / Math.max(speed, SLOW)) + gust.yaw * 0.4) * dt;
      const f = forward(new Vector3(), heading, effPitch);
      // Vento ciclonico (antiorario): tangente con afflusso di ~20° nei bassi strati, deflusso in quota.
      const rr = Math.max(r, 0.05);
      const radX = pos.x / rr;
      const radZ = pos.z / rr;
      const inflow = (20 - 35 * smooth(6, 15, h)) * DEG;
      const ws = windAt(rr) * 1e-3 * (1 - 0.35 * smooth(8, 16, h));
      const tx = radZ;
      const tz = -radX;
      wind.set((Math.cos(inflow) * tx - Math.sin(inflow) * radX) * ws, 0, (Math.cos(inflow) * tz - Math.sin(inflow) * radZ) * ws);
      vel.copy(f).multiplyScalar(speed).add(wind).addScaledVector(up, gust.vert);
      if (guide?.vz) vel.addScaledVector(up, Math.max(-guide.vz, Math.min(guide.vz, (guide.alt - h) * 0.4)));
      pos.addScaledVector(vel, dt);
      // Contatto con il mare: recupero automatico (nessuno schianto: è una dimostrazione).
      if (altitude() < 0.06) {
        const d = new Vector3(pos.x, pos.y + RE, pos.z).normalize();
        pos.copy(d).multiplyScalar(RE + 0.06).y -= RE;
        pitch = Math.max(pitch, 8 * DEG);
        recoverTimer = Math.max(recoverTimer, 2);
        warning = 'Recupero automatico';
      }
      shownBank = effBank;
      shownPitch = effPitch;
    },

    /** Orientamento del modello nel piano della scena (prua −z, alto +y del modello). */
    attitude(out: Quaternion) {
      frame();
      const basis = new Matrix4().makeBasis(east, up, north.clone().negate());
      const local = new Quaternion().setFromEuler(new Euler(shownPitch, heading, -shownBank, 'YXZ'));
      return out.setFromRotationMatrix(basis).multiply(local);
    },
    get bank() {
      return shownBank;
    },
    get pitch() {
      return pitch;
    },
    get windKmS() {
      return wind.length();
    },
    state() {
      return { guide: guide?.mode ?? null, gustEvents, x: pos.x, z: pos.z, alt: altitude(), r: Math.hypot(pos.x, pos.z), heading: wrap(heading) / DEG, pitch: pitch / DEG, bank: bank / DEG, effBank: shownBank / DEG, speedKmh: speed * 3600, zone, turb, warning, windMs: wind.length() * 1000 };
    },
  };
}

export type Flight = ReturnType<typeof createFlight>;
