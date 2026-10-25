import './pilot.css';
import {
  AdditiveBlending,
  Color,
  Euler,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
  type Group,
} from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * ATMOSPHERA FLIGHT — pilotaggio touch e mouse (originale). SIMULAZIONE SEMPLIFICATA:
 * non è un modello aerodinamico reale.
 *
 * Comando: si appoggia il dito (o si tiene premuto il mouse) in un punto qualsiasi e si trascina.
 * Lo spostamento dal punto iniziale è una cloche virtuale: su = sale, giù = scende,
 * destra/sinistra = inclinazione e virata coordinata. Al rilascio il velivolo torna in volo livellato.
 * Avanzamento automatico a velocità di crociera; BOOST e RALLENTA tenuti premuti cambiano velocità.
 *
 * Unità: metri, secondi. Prua del modello verso −z.
 */

export interface PilotContext {
  scene: Scene;
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  controls: OrbitControls;
  root: HTMLElement;
  aircraft: { group: Group; update(t: number, dt: number, power: number): void };
  pad: { x: number; y: number; z: number; radius: number };
  /** Ostacoli: [minX, maxX, minZ, maxZ, altezza]. */
  volumes: [number, number, number, number, number][];
  coastX: number;
  parkedHeading: number;
  /** Ostacoli sospesi (oggetti di APP UNIVERSE): sfere {x, y, z, r}. */
  spheres?: { x: number; y: number; z: number; r: number }[] | undefined;
  /** Rimuove gli ascoltatori sul canvas quando si esce dal simulatore. */
  signal?: AbortSignal | undefined;
}

type Phase = 'parked' | 'intro' | 'takeoff' | 'transition' | 'flying' | 'return' | 'hover' | 'descend' | 'crash' | 'explore';

const DEG = Math.PI / 180;
const KMH = 3.6;
const CRUISE = 42;
const BOOST = 74;
const SLOW = 17;
const G = 9.81;
const MAX_BANK = 58 * DEG;
const MAX_PITCH = 26 * DEG;
const CEILING = 650;
const RADIUS = 3.2;

const damp = (current: number, target: number, rate: number, dt: number) => current + (target - current) * (1 - Math.exp(-rate * dt));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (f: number) => (f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

const ICON = {
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" /></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none"/></svg>',
  level: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18M7 12l-2-3M17 12l2-3" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>',
  help: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 .8-1 1.5v.6M12 17.2v.1"/></svg>',
  boost: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7l6 5-6 5M12 7l6 5-6 5"/></svg>',
  slow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h3v10H7zM14 7h3v10h-3z" fill="currentColor" stroke="none"/></svg>',
};

export function startPilot(ctx: PilotContext) {
  const { camera, canvas, controls, root, aircraft, pad } = ctx;
  const group = aircraft.group;

  // ── Stato del volo.
  const pos = new Vector3(pad.x, pad.y + 0.005, pad.z);
  let heading = ctx.parkedHeading;
  let pitch = 0;
  let bank = 0;
  let speed = 0;
  let vertical = 0;
  let phase: Phase = 'parked';
  let phaseTime = 0;
  let paused = false;
  let boostHeld = false;
  let slowHeld = false;
  let levelTimer = 0;
  let throttle = 0;
  const stick = { x: 0, y: 0 };
  const stickSmooth = { x: 0, y: 0 };
  let warning = '';
  // ESPLORA: hovering controllato, prua (facoltativa) verso un punto; alla ripresa si controllano subito le collisioni.
  let exploreFace: Vector3 | null = null;
  let resumeCheck = false;

  const forward = (h = heading, p = pitch) => new Vector3(-Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p));

  // ── Camera.
  const cam = { pos: new Vector3(), look: new Vector3(), up: new Vector3(0, 1, 0), fov: 58, roll: 0 };
  let introFrom: { pos: Vector3; look: Vector3; fov: number } | null = null;
  const chaseTarget = () => {
    const f = forward(heading, pitch * 0.6);
    const fFlat = new Vector3(f.x, 0, f.z).normalize();
    const boostK = Math.min(1, Math.max(0, (speed - CRUISE) / (BOOST - CRUISE)));
    // Schermi verticali: camera più lontana perché l'apertura alare resti tutta nell'inquadratura.
    const portrait = Math.min(1, camera.aspect) < 1 ? 1 + 0.75 * (1 - Math.max(0.45, camera.aspect)) / 0.55 : 1;
    const dist = (15 + 5 * boostK + (phase === 'takeoff' || phase === 'descend' || phase === 'parked' ? 4 : 0)) * portrait;
    const height = 4.2 + (phase === 'takeoff' || phase === 'parked' ? 2.5 : 0);
    const p = pos.clone().addScaledVector(f.lengthSq() > 0 ? f : fFlat, -dist).add(new Vector3(0, height, 0));
    // Lo sguardo segue la traiettoria (anche in salita e in picchiata): il velivolo resta al centro.
    const look = pos.clone().addScaledVector(forward(heading, pitch * 0.85), 10 + speed * 0.12).add(new Vector3(0, 1.2, 0));
    return { p, look };
  };
  /** La camera non attraversa gli edifici: si avvicina al velivolo lungo il segmento. */
  const unobstructed = (from: Vector3, to: Vector3) => {
    const d = new Vector3().subVectors(to, from);
    let tMin = 1;
    for (const [x0, x1, z0, z1, h] of ctx.volumes) {
      const m = 0.8;
      let t0 = 0;
      let t1 = 1;
      const slab = (o: number, dd: number, lo: number, hi: number) => {
        if (Math.abs(dd) < 1e-9) return o >= lo && o <= hi;
        let a = (lo - o) / dd;
        let b = (hi - o) / dd;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
        return t0 <= t1;
      };
      if (slab(from.x, d.x, x0 - m, x1 + m) && slab(from.y, d.y, -10, h + m) && slab(from.z, d.z, z0 - m, z1 + m) && t0 > 0.02) tMin = Math.min(tMin, t0);
    }
    return from.clone().addScaledVector(d, Math.max(0.12, tMin - 0.04));
  };

  // ── Collisioni (semplificate: il velivolo è una sfera di 3,2 m, gli edifici parallelepipedi).
  const collides = (p: Vector3) => {
    if (p.y < 1.2) return true;
    if (p.x < ctx.coastX && p.y < 1.5) return true;
    for (const s of ctx.spheres ?? []) if ((p.x - s.x) ** 2 + (p.y - s.y) ** 2 + (p.z - s.z) ** 2 < (s.r + RADIUS) ** 2) return true;
    for (const [x0, x1, z0, z1, h] of ctx.volumes) {
      if (p.y < h + RADIUS * 0.5 && p.x > x0 - RADIUS && p.x < x1 + RADIUS && p.z > z0 - RADIUS && p.z < z1 + RADIUS) return true;
    }
    return false;
  };

  // ── Effetto d'urto: bagliore che si espande e svanisce.
  const flash = new Mesh(new SphereGeometry(1, 24, 16), new MeshBasicMaterial({ color: new Color(3.5, 1.6, 0.6), transparent: true, blending: AdditiveBlending, depthWrite: false }));
  flash.visible = false;
  ctx.scene.add(flash);

  // ── Interfaccia.
  const hud = el('div', 'pl-hud');
  const brand = el('div', 'pl-brand', '<b>ATMOSPHERA FLIGHT</b><span>Simulazione semplificata · città dimostrativa · propulsione rappresentata</span>');
  // Riga della dichiarazione (o dell'avviso): riferimento diretto, il titolo può ospitare altri comandi.
  const brandNote = brand.querySelector('span')!;
  const readout = el('div', 'pl-readout');
  const speedEl = el('div', 'pl-value', '<b>0</b><span>km/h</span>');
  const altEl = el('div', 'pl-value', '<b>0</b><span>m</span>');
  readout.append(speedEl, altEl);
  const tools = el('div', 'pl-tools');
  const pauseBtn = el('button', 'pl-icon', ICON.pause);
  pauseBtn.setAttribute('aria-label', 'Pausa');
  const levelBtn = el('button', 'pl-icon', ICON.level);
  levelBtn.setAttribute('aria-label', 'Livella il velivolo');
  const helpBtn = el('button', 'pl-icon', ICON.help);
  helpBtn.setAttribute('aria-label', 'Come si pilota');
  tools.append(levelBtn, pauseBtn, helpBtn);
  const bar = el('div', 'pl-bar');
  const slowBtn = el('button', 'pl-round', `${ICON.slow}<span>RALLENTA</span>`);
  const mainBtn = el('button', 'pl-main', 'VOLA');
  const boostBtn = el('button', 'pl-round', `${ICON.boost}<span>BOOST</span>`);
  bar.append(slowBtn, mainBtn, boostBtn);
  const stickRing = el('div', 'pl-stick', '<span></span>');
  stickRing.hidden = true;
  const toast = el('div', 'pl-toast');
  toast.hidden = true;
  const pauseCover = el('div', 'pl-pause', '<b>In pausa</b><span>Tocca ▶ per riprendere</span>');
  pauseCover.hidden = true;
  const guide = el(
    'div',
    'pl-guide',
    `<h2>Come si pilota</h2>
     <div class="pl-guide__demo" aria-hidden="true">
       <svg viewBox="0 0 200 140">
         <circle cx="100" cy="70" r="44" class="ring"/>
         <path d="M100 18v-8M100 122v8M48 70h-8M152 70h8" class="tick"/>
         <path d="M100 38l-8 10h16zM100 102l-8-10h16zM68 70l10-8v16zM132 70l-10-8v16z" class="arrow"/>
         <circle cx="100" cy="70" r="13" class="knob"/>
         <text x="100" y="12" text-anchor="middle">sali</text>
         <text x="100" y="139" text-anchor="middle">scendi</text>
         <text x="24" y="74" text-anchor="middle">vira</text>
         <text x="176" y="74" text-anchor="middle">vira</text>
       </svg>
     </div>
     <ul>
       <li><b>Tocca VOLA</b>: decollo verticale e crociera automatici.</li>
       <li><b>Trascina</b> in un punto qualsiasi dello schermo: su per salire, giù per scendere, a destra e a sinistra per inclinarti e virare.</li>
       <li><b>Rilascia</b>: il velivolo torna in volo livellato.</li>
       <li>Tieni premuto <b>BOOST</b> o <b>RALLENTA</b>. <b>ATTERRA</b> riporta alla piattaforma.</li>
     </ul>
     <p>Simulazione semplificata, non aerodinamica reale.</p>
     <button type="button" class="pl-main">Ho capito</button>`,
  );
  hud.append(brand, readout, tools, bar, stickRing, toast, pauseCover, guide);
  root.append(hud);
  document.body.classList.add('pl-active');

  let toastTimer = 0;
  const showToast = (text: string, seconds = 2.6) => {
    toast.textContent = text;
    toast.hidden = false;
    toastTimer = seconds;
  };
  const setPaused = (p: boolean) => {
    paused = p;
    pauseBtn.innerHTML = p ? ICON.play : ICON.pause;
    pauseBtn.setAttribute('aria-label', p ? 'Riprendi' : 'Pausa');
    pauseCover.hidden = !p;
  };
  guide.querySelector('button')!.addEventListener('click', () => (guide.hidden = true));
  helpBtn.addEventListener('click', () => (guide.hidden = !guide.hidden));
  pauseBtn.addEventListener('click', () => setPaused(!paused));
  levelBtn.addEventListener('click', () => {
    levelTimer = 1.2;
    stick.x = stick.y = 0;
    showToast('Volo livellato', 1.4);
  });

  const fly = () => {
    if (phase !== 'parked') return;
    guide.hidden = true;
    phase = 'intro';
    phaseTime = 0;
    controls.enabled = false;
    introFrom = { pos: camera.position.clone(), look: controls.target.clone(), fov: camera.fov };
  };
  const land = () => {
    if (phase === 'flying' || phase === 'transition' || phase === 'explore') {
      exploreFace = null;
      phase = 'return';
      phaseTime = 0;
      showToast('Rientro automatico alla piattaforma');
    }
  };
  mainBtn.addEventListener('click', () => (phase === 'parked' ? fly() : land()));
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
  hold(boostBtn, (v) => (boostHeld = v));
  hold(slowBtn, (v) => (slowHeld = v));

  // ── Cloche virtuale: trascinamento dal punto di contatto.
  const onCanvas: AddEventListenerOptions = ctx.signal ? { signal: ctx.signal } : {};
  let drag: { id: number; x: number; y: number } | null = null;
  const stickRadius = () => Math.max(60, Math.min(canvas.clientWidth, canvas.clientHeight) * 0.2);
  const flyingPhase = () => phase === 'flying' || phase === 'transition';
  canvas.addEventListener('pointerdown', (e) => {
    if (!flyingPhase() || paused || drag) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    stickRing.hidden = false;
    stickRing.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    (stickRing.firstElementChild as HTMLElement).style.transform = '';
  }, onCanvas);
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
    stick.x = dx;
    stick.y = dy;
    (stickRing.firstElementChild as HTMLElement).style.transform = `translate(${dx * 46}px, ${-dy * 46}px)`;
  }, onCanvas);
  const release = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    stick.x = stick.y = 0;
    stickRing.hidden = true;
  };
  canvas.addEventListener('pointerup', release, onCanvas);
  canvas.addEventListener('pointercancel', release, onCanvas);

  const park = () => {
    pos.set(pad.x, pad.y + 0.005, pad.z);
    heading = ctx.parkedHeading;
    pitch = bank = speed = vertical = 0;
    phase = 'parked';
    phaseTime = 0;
    exploreFace = null;
    resumeCheck = false;
    group.visible = true;
    controls.enabled = true;
    const back = forward(heading, 0).multiplyScalar(-14);
    camera.position.copy(pos).add(back).add(new Vector3(0, 6, 0));
    controls.target.copy(pos).add(new Vector3(0, 1, 0));
    camera.up.set(0, 1, 0);
    camera.fov = 52;
    camera.updateProjectionMatrix();
    controls.update();
    mainBtn.textContent = 'VOLA';
  };

  const crash = () => {
    phase = 'crash';
    phaseTime = 0;
    flash.position.copy(pos);
    flash.visible = true;
    group.visible = false;
    stick.x = stick.y = 0;
    drag = null;
    stickRing.hidden = true;
    showToast('Collisione: ritorno alla piattaforma', 2.4);
  };

  // ── Passo di simulazione.
  const step = (dt: number) => {
    phaseTime += dt;
    stickSmooth.x = damp(stickSmooth.x, levelTimer > 0 ? 0 : stick.x, 10, dt);
    stickSmooth.y = damp(stickSmooth.y, levelTimer > 0 ? 0 : stick.y, 10, dt);
    levelTimer = Math.max(0, levelTimer - dt);
    const dead = (v: number) => (Math.abs(v) < 0.06 ? 0 : (v - Math.sign(v) * 0.06) / 0.94);
    warning = '';

    switch (phase) {
      case 'parked':
        throttle = damp(throttle, 0, 2, dt);
        break;
      case 'intro':
        throttle = damp(throttle, 0.4, 2, dt);
        if (phaseTime > 2.2) {
          phase = 'takeoff';
          phaseTime = 0;
          mainBtn.textContent = 'ATTERRA';
        }
        break;
      case 'takeoff': {
        // Decollo verticale fino a 70 m sopra la piattaforma (sopra i grattacieli vicini).
        const targetY = pad.y + 70;
        const remaining = targetY - pos.y;
        vertical = damp(vertical, Math.min(12, remaining * 0.8 + 0.5), 2.2, dt);
        pos.y += vertical * dt;
        throttle = damp(throttle, 1, 3, dt);
        if (remaining < 1.5) {
          phase = 'transition';
          phaseTime = 0;
          vertical = 0;
        }
        break;
      }
      case 'transition':
      case 'flying':
      case 'return': {
        let targetSpeed = boostHeld ? BOOST : slowHeld ? SLOW : CRUISE;
        let targetBank = dead(stickSmooth.x) * MAX_BANK;
        let targetPitch = dead(stickSmooth.y) * MAX_PITCH;
        if (phase === 'transition') {
          targetBank *= Math.min(1, phaseTime / 2);
          targetPitch *= Math.min(1, phaseTime / 2);
          if (speed > CRUISE * 0.9) {
            phase = 'flying';
            resumeCheck = false;
          }
        }
        if (phase === 'return') {
          // Autopilota: rotta verso il punto di attesa sopra la piattaforma, quota di avvicinamento.
          const hover = new Vector3(pad.x, pad.y + 30, pad.z);
          const to = new Vector3().subVectors(hover, pos);
          const dist = Math.hypot(to.x, to.z);
          const want = Math.atan2(-to.x, -to.z);
          const err = wrap(want - heading);
          targetBank = Math.max(-MAX_BANK * 0.8, Math.min(MAX_BANK * 0.8, -err * 1.6));
          // Avvicinamento alto (sopra i grattacieli), discesa solo sulla verticale dell'isolato.
          const desiredY = dist > 60 ? Math.max(pad.y + 95, Math.min(pos.y, pad.y + 160)) : hover.y;
          targetPitch = Math.max(-MAX_PITCH * 0.6, Math.min(MAX_PITCH * 0.6, ((desiredY - pos.y) / Math.max(30, dist)) * 2));
          targetSpeed = Math.min(CRUISE, Math.max(10, dist * 0.18 + 6)) * Math.max(0.35, Math.cos(err));
          if (dist < 40) {
            phase = 'hover';
            phaseTime = 0;
          }
        }
        // Limiti dell'area di volo: oltre, il velivolo vira dolcemente verso il centro.
        const outside = pos.x > 2100 || pos.x < ctx.coastX - 1700 || Math.abs(pos.z) > 1700;
        if (outside && phase !== 'return') {
          const want = Math.atan2(pos.x - 300, pos.z);
          const err = wrap(want - heading);
          targetBank = Math.max(-MAX_BANK * 0.7, Math.min(MAX_BANK * 0.7, -err * 1.4));
          warning = 'Limite dell’area di volo';
        }
        if (pos.y > CEILING - 20) {
          targetPitch = Math.min(targetPitch, -2 * DEG);
          warning = 'Quota massima';
        }
        const accel = targetSpeed > speed ? (boostHeld ? 9 : 6) : 8;
        speed += Math.max(-accel * dt, Math.min(accel * dt, targetSpeed - speed));
        bank = damp(bank, targetBank, 2.6, dt);
        pitch = damp(pitch, targetPitch, 2.2, dt);
        // Virata coordinata: velocità d'imbardata dalla bancata.
        heading += (-G * Math.tan(bank) / Math.max(speed, 14)) * dt;
        pos.addScaledVector(forward(), speed * dt);
        throttle = damp(throttle, 0.7 + 0.5 * Math.max(0, (speed - CRUISE) / (BOOST - CRUISE)), 3, dt);
        if ((phase !== 'transition' || resumeCheck) && collides(pos)) crash();
        break;
      }
      case 'explore': {
        // Hovering controllato: rallenta fino a fermarsi, ali livellate, prua verso l'oggetto scelto.
        speed = damp(speed, 0, 1.8, dt);
        bank = damp(bank, 0, 3, dt);
        pitch = damp(pitch, 0, 3, dt);
        if (exploreFace) heading += wrap(Math.atan2(-(exploreFace.x - pos.x), -(exploreFace.z - pos.z)) - heading) * (1 - Math.exp(-1.1 * dt));
        pos.addScaledVector(forward(), speed * dt);
        pos.y += Math.sin(phaseTime * 1.3) * 0.12 * dt;
        throttle = damp(throttle, 0.6, 2, dt);
        if (speed > 2 && collides(pos)) crash();
        break;
      }
      case 'hover': {
        // Si ferma sulla verticale della piattaforma e si orienta come al parcheggio.
        speed = damp(speed, 0, 2.5, dt);
        bank = damp(bank, 0, 3, dt);
        pitch = damp(pitch, 0, 3, dt);
        pos.x = damp(pos.x, pad.x, 1.4, dt);
        pos.z = damp(pos.z, pad.z, 1.4, dt);
        pos.y = damp(pos.y, pad.y + 30, 0.9, dt);
        pos.addScaledVector(forward(), speed * dt);
        heading += wrap(ctx.parkedHeading - heading) * (1 - Math.exp(-1.6 * dt));
        if (Math.hypot(pos.x - pad.x, pos.z - pad.z) < 0.8 && speed < 1 && Math.abs(pos.y - pad.y - 30) < 2 && Math.abs(wrap(ctx.parkedHeading - heading)) < 0.05) {
          phase = 'descend';
          phaseTime = 0;
        }
        break;
      }
      case 'descend': {
        const remaining = pos.y - (pad.y + 0.005);
        vertical = Math.min(6, remaining * 0.7 + 0.25);
        pos.y -= vertical * dt;
        pos.x = damp(pos.x, pad.x, 3, dt);
        pos.z = damp(pos.z, pad.z, 3, dt);
        throttle = damp(throttle, 0.6, 2, dt);
        if (remaining < 0.05) {
          park();
          showToast('Atterrato sulla piattaforma', 2);
        }
        break;
      }
      case 'crash': {
        const f = Math.min(1, phaseTime / 1.4);
        flash.scale.setScalar(1.5 + f * 9);
        (flash.material as MeshBasicMaterial).opacity = 1 - f;
        if (phaseTime > 1.6) {
          flash.visible = false;
          park();
        }
        break;
      }
    }
  };

  // ── Camera per fase.
  const updateCamera = (dt: number) => {
    if (phase === 'parked') return false;
    const { p, look } = chaseTarget();
    const anchor = pos.clone().add(new Vector3(0, 1.5, 0));
    const safe = unobstructed(anchor, p);
    safe.y = Math.max(safe.y, 2);
    if (phase === 'intro' && introFrom) {
      const f = ease(Math.min(1, phaseTime / 2.2));
      cam.pos.copy(introFrom.pos).lerp(safe, f);
      cam.look.copy(introFrom.look).lerp(look, f);
      cam.fov = introFrom.fov + ((camera.aspect < 1 ? 66 : 58) - introFrom.fov) * f;
      cam.roll = 0;
    } else if (phase === 'explore') {
      // ESPLORA: inquadratura più alta e leggermente laterale, sguardo verso l'oggetto scelto (il velivolo non lo copre).
      const f = forward(heading, 0);
      const right = new Vector3(-f.z, 0, f.x);
      const side = camera.aspect < 1 ? 0 : 6;
      const want = pos.clone().addScaledVector(f, -24).add(new Vector3(0, 8.5, 0)).addScaledVector(right, side);
      const target = exploreFace ? exploreFace.clone() : pos.clone().addScaledVector(f, 40).add(new Vector3(0, 2, 0));
      const freePos = unobstructed(anchor, want);
      freePos.y = Math.max(freePos.y, 2);
      cam.pos.lerp(freePos, 1 - Math.exp(-2.2 * dt));
      cam.look.lerp(target, 1 - Math.exp(-2.4 * dt));
      cam.fov = damp(cam.fov, camera.aspect < 1 ? 66 : 58, 2, dt);
      cam.roll = damp(cam.roll, 0, 3, dt);
    } else if (phase === 'crash') {
      // La camera si allontana un poco e guarda il bagliore (mai dentro).
      const away = new Vector3().subVectors(cam.pos, flash.position).setLength(26);
      cam.pos.lerp(flash.position.clone().add(away).add(new Vector3(0, 6, 0)), 1 - Math.exp(-2 * dt));
      cam.look.lerp(flash.position, 1 - Math.exp(-3 * dt));
    } else {
      cam.pos.lerp(safe, 1 - Math.exp(-3.4 * dt));
      // Se la posizione smorzata entrerebbe in un edificio, si accetta subito quella libera.
      const check = unobstructed(anchor, cam.pos);
      if (check.distanceToSquared(cam.pos) > 0.01) cam.pos.copy(check);
      cam.look.lerp(look, 1 - Math.exp(-6 * dt));
      const boostK = Math.min(1, Math.max(0, (speed - CRUISE) / (BOOST - CRUISE)));
      const slowK = Math.min(1, Math.max(0, (CRUISE - speed) / (CRUISE - SLOW)));
      const baseFov = camera.aspect < 1 ? 66 : 58;
      cam.fov = damp(cam.fov, baseFov + 16 * boostK - 5 * slowK, 2, dt);
      cam.roll = damp(cam.roll, bank * 0.5, 3, dt);
    }
    camera.position.copy(cam.pos);
    const viewDir = new Vector3().subVectors(cam.look, cam.pos).normalize();
    const up = new Vector3(0, 1, 0).applyAxisAngle(viewDir, cam.roll);
    camera.up.copy(up);
    camera.lookAt(cam.look);
    if (Math.abs(camera.fov - cam.fov) > 0.01) {
      camera.fov = cam.fov;
      camera.updateProjectionMatrix();
    }
    return true;
  };

  park();
  cam.pos.copy(camera.position);
  cam.look.copy(controls.target);

  const q = new Quaternion();
  const euler = new Euler(0, 0, 0, 'YXZ');
  let hudAt = 0;
  return {
    get paused() {
      return paused;
    },
    /** Avanza simulazione e camera; restituisce true se la camera è guidata dal volo. */
    update(dt: number, t: number) {
      if (toastTimer > 0) {
        toastTimer -= dt;
        if (toastTimer <= 0) toast.hidden = true;
      }
      if (paused) return phase !== 'parked';
      const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
      for (let i = 0; i < steps; i++) step(dt / steps);
      euler.set(pitch, heading, -bank);
      q.setFromEuler(euler);
      group.quaternion.copy(q);
      group.position.copy(pos);
      aircraft.update(t, dt, 1 + throttle);
      const driven = updateCamera(dt);
      if (t - hudAt > 0.1) {
        hudAt = t;
        speedEl.firstElementChild!.textContent = String(Math.round(speed * KMH));
        altEl.firstElementChild!.textContent = String(Math.max(0, Math.round(pos.y)));
        hud.dataset.phase = phase;
        hud.dataset.warning = warning;
        brandNote.textContent = warning || 'Simulazione semplificata · città dimostrativa · propulsione rappresentata';
      }
      return driven;
    },
    /** Rimuove interfaccia ed effetti (uscita da CITY FLIGHT). */
    dispose() {
      hud.remove();
      document.body.classList.remove('pl-active');
      ctx.scene.remove(flash);
      flash.geometry.dispose();
      (flash.material as MeshBasicMaterial).dispose();
    },
    /** Comandi per i test automatici (stessa logica dei gesti e dei pulsanti). */
    api: {
      fly,
      land,
      setStick(x: number, y: number) {
        stick.x = x;
        stick.y = y;
      },
      /** Solo per i test: imposta la prua (gradi) per raggiungere un ostacolo noto. */
      testHeading: (deg: number) => (heading = deg * DEG),
      boost: (v: boolean) => (boostHeld = v),
      slow: (v: boolean) => (slowHeld = v),
      pause: (v: boolean) => setPaused(v),
      level: () => levelBtn.click(),
      /** ESPLORA: true = hovering controllato (il trascinamento non comanda più il velivolo); false = ripresa del volo. */
      explore(on: boolean, face?: { x: number; y: number; z: number } | null) {
        if (on) {
          if (phase !== 'flying' && phase !== 'transition' && phase !== 'explore') return false;
          if (phase !== 'explore') {
            phase = 'explore';
            phaseTime = 0;
            drag = null;
            stick.x = stick.y = 0;
            stickRing.hidden = true;
            boostHeld = slowHeld = false;
          }
          exploreFace = face ? new Vector3(face.x, face.y, face.z) : null;
          return true;
        }
        if (phase === 'explore') {
          exploreFace = null;
          phase = 'transition';
          phaseTime = 0;
          resumeCheck = true;
        }
        return true;
      },
      get state() {
        return { phase, x: pos.x, y: pos.y, z: pos.z, speedKmh: speed * KMH, heading: heading / DEG, pitch: pitch / DEG, bank: bank / DEG, paused, fov: camera.fov, cam: camera.position.toArray(), warning };
      },
    },
  };
}

export type Pilot = ReturnType<typeof startPilot>;
