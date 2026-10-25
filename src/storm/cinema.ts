import { Vector3 } from 'three';
import { RE, type Flight, type Guide } from './flight';

/**
 * STORM FLIGHT — modalità CINEMA, S2.3 (rappresentazione artistica, non simulazione aeronautica).
 *
 * Nessun filmato: il velivolo vola nel modello di volo con una guida automatica (raffiche e turbolenza comprese)
 * e la telecamera segue regole di ripresa calcolate a ogni frame dalla posizione reale del velivolo.
 * Velocità narrative (fino a ~2,5 km/s) e salite ripide nell'occhio sono scelte artistiche dichiarate.
 * Nessuna dissolvenza nascosta: dalla vista dallo spazio al velivolo la telecamera scende con continuità.
 *
 * Percorso (scelto per evitare lunghi tratti dentro le nubi dense, dove l'immagine è nebbia uniforme):
 * 1 orbita attorno all'uragano dallo spazio · 2 discesa fino al velivolo sopra l'oceano, giro attorno al modello ·
 * 3 accelerazione a bassa quota verso le bande · 4 sotto le bande, tra le cortine di pioggia, fino a ~35 km ·
 * 5 attraversamento della parete a bassa quota · 6 uscita nell'occhio vista dall'interno · 7 salita a spirale
 * lungo le pareti fino alla loro sommità · 8 uscita sopra le sommità e allontanamento fino allo spazio.
 */

export interface Pose {
  pos: Vector3;
  look: Vector3;
  fov: number;
}

type RigKind = 'space' | 'dive' | 'orbit' | 'chase' | 'side' | 'close' | 'inward' | 'above' | 'world' | 'pullback';
interface Rig {
  kind: RigKind;
  p: Record<string, number>;
  fov: number;
  t0?: number;
  /** Posizioni memorizzate (km) per 'dive' e 'world'. */
  a?: Vector3;
  b?: Vector3;
}

export interface Scene {
  title: string;
  subtitle: string;
}

export const SCENES: Scene[] = [
  { title: 'L’immensità', subtitle: 'L’uragano Milton dall’alta atmosfera · 7 ottobre 2024' },
  { title: 'Il velivolo', subtitle: 'Concept C sopra il Golfo del Messico' },
  { title: 'L’avvicinamento', subtitle: 'Verso le bande esterne' },
  { title: 'La tempesta', subtitle: 'Sotto le bande temporalesche' },
  { title: 'La parete dell’occhio', subtitle: 'Il muro di nubi convettive' },
  { title: 'L’ingresso nell’occhio', subtitle: 'Dal caos alla calma' },
  { title: 'Il volo nell’occhio', subtitle: 'Lungo pareti alte 16 km' },
  { title: 'Il finale', subtitle: 'Sopra le nubi, verso lo spazio' },
];

const DEG = Math.PI / 180;
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Punto a quota h sopra (x, z) del piano (Terra sferica). */
function worldAt(x: number, z: number, h: number, out = new Vector3()) {
  return out.set(x, RE, z).normalize().multiplyScalar(RE + h).sub(new Vector3(0, RE, 0));
}
const EYE = worldAt(0, 0, 0);

export function createCinema(flight: Flight) {
  let active = false;
  let paused = false;
  let scene = 0;
  let sceneTime = 0;
  let total = 0;
  let finished = false;
  let rig: Rig = { kind: 'space', p: {}, fov: 50 };
  let prevRig: Rig | null = null;
  let blend = 1;
  let blendDur = 3;
  let shot = -1;
  const offset = new Vector3();
  let offsetValid = false;
  let fovNow = 50;
  const A = new Vector3();
  const up = new Vector3();
  const fw = new Vector3();
  const right = new Vector3();
  const tmp = new Vector3();
  const tmp2 = new Vector3();
  const lastPos = new Vector3();
  const lastLook = new Vector3();

  const setRig = (r: Rig, dur = 3) => {
    r.t0 = total;
    prevRig = rig;
    rig = r;
    blend = dur <= 0.01 ? 1 : 0;
    blendDur = Math.max(dur, 0.01);
  };

  const spacePose = (p: Record<string, number>, u: number, out: Pose) => {
    const az = lerp(p.az0!, p.az1!, u) * DEG;
    const R = lerp(p.R0!, p.R1!, u);
    const h = Math.exp(lerp(Math.log(p.h0!), Math.log(p.h1!), u));
    worldAt(R * Math.sin(az), R * Math.cos(az), h, out.pos);
    out.look.copy(EYE);
  };

  const rigPose = (r: Rig, out: Pose) => {
    const m = 1e-3;
    const p = r.p;
    const rt = total - (r.t0 ?? 0);
    switch (r.kind) {
      case 'space':
        spacePose(p, ease(Math.min(1, rt / p.dur!)), out);
        break;
      case 'dive': {
        // Dalla posizione memorizzata (a) a uno scostamento attorno al velivolo: distanza in scala logaritmica,
        // direzione interpolata; lo sguardo passa dal centro dell'uragano al velivolo.
        const u = ease(Math.min(1, rt / p.dur!));
        const s0 = tmp.subVectors(r.a!, A);
        const d0 = s0.length();
        const dir0 = s0.normalize();
        const dir1 = tmp2.copy(fw).multiplyScalar(-Math.cos(p.th!)).addScaledVector(right, Math.sin(p.th!)).multiplyScalar(p.R!).addScaledVector(up, p.H!);
        const d1 = dir1.length() * m;
        dir1.normalize();
        const dist = Math.exp(lerp(Math.log(d0), Math.log(d1), u));
        out.pos.copy(A).addScaledVector(dir0.lerp(dir1, ease(Math.min(1, u * 1.2))).normalize(), dist);
        out.look.copy(EYE).lerp(tmp.copy(A).addScaledVector(up, 0.8 * m), ease(Math.min(1, u * 1.6)));
        break;
      }
      case 'orbit': {
        const u = Math.min(1, rt / p.dur!);
        const th = lerp(p.a0!, p.a1!, u);
        out.pos.copy(A).addScaledVector(fw, -Math.cos(th) * p.R! * m).addScaledVector(right, Math.sin(th) * p.R! * m).addScaledVector(up, p.H! * m);
        out.look.copy(A).addScaledVector(up, 0.8 * m);
        break;
      }
      case 'chase':
        out.pos.copy(A).addScaledVector(fw, -p.D! * m).addScaledVector(up, p.H! * m);
        out.look.copy(A).addScaledVector(fw, p.L! * m).addScaledVector(up, (p.LH ?? 1) * m);
        break;
      case 'side':
        out.pos.copy(A).addScaledVector(right, p.S! * m).addScaledVector(fw, -p.B! * m).addScaledVector(up, p.H! * m);
        out.look.copy(A).addScaledVector(fw, (p.L ?? 2) * m).addScaledVector(up, 0.6 * m);
        break;
      case 'close':
        // Ravvicinata di tre quarti anteriore: il velivolo riempie l'inquadratura, la tempesta dietro.
        out.pos.copy(A).addScaledVector(fw, p.F! * m).addScaledVector(right, p.S! * m).addScaledVector(up, p.H! * m);
        out.look.copy(A).addScaledVector(fw, -1.5 * m).addScaledVector(up, 0.7 * m);
        break;
      case 'inward': {
        // Dal lato del centro dell'occhio verso il velivolo: dietro di lui la parete, sopra il cielo.
        tmp2.set(-A.x, 0, -A.z).normalize();
        out.pos.copy(A).addScaledVector(tmp2, p.D! * m).addScaledVector(fw, -(p.B ?? 0) * m).addScaledVector(up, p.H! * m);
        out.look.copy(A).addScaledVector(up, (p.LH ?? 0) * m);
        break;
      }
      case 'above':
        // Dall'alto: sopra e dietro, sguardo in giù verso il velivolo e il fondo dell'occhio.
        out.pos.copy(A).addScaledVector(fw, -p.D! * m).addScaledVector(up, p.H! * m);
        out.look.copy(A).addScaledVector(fw, p.L! * m);
        break;
      case 'world':
        out.pos.copy(r.a!);
        out.look.copy(A).addScaledVector(up, 0.8 * m);
        break;
      case 'pullback': {
        // Allontanamento lento: da dietro il velivolo fino a ~1100 km d'altezza, sguardo verso il centro.
        const u = ease(Math.min(1, Math.max(0, rt / p.dur!)));
        const dist = 0.03 * Math.pow(1100 / 0.03, u);
        tmp.copy(fw).multiplyScalar(-Math.cos(u * 1.3)).addScaledVector(up, 0.3 + Math.sin(u * 1.3)).normalize();
        out.pos.copy(A).addScaledVector(tmp, dist);
        out.look.copy(A).lerp(EYE, ease(Math.min(1, u * 1.3)));
        break;
      }
    }
    out.fov = r.fov;
    return out;
  };

  const enter = (n: number) => {
    scene = n;
    sceneTime = 0;
    shot = -1;
  };

  const poseA: Pose = { pos: new Vector3(), look: new Vector3(), fov: 50 };
  const poseB: Pose = { pos: new Vector3(), look: new Vector3(), fov: 50 };
  const out: Pose = { pos: new Vector3(), look: new Vector3(), fov: 50 };

  return {
    get active() {
      return active;
    },
    get paused() {
      return paused;
    },
    get scene() {
      return scene;
    },
    get sceneTime() {
      return sceneTime;
    },
    get total() {
      return total;
    },
    get finished() {
      return finished;
    },
    /** Nessuna dissolvenza nella S2.3 (proprietà mantenuta per l'interfaccia). */
    get fade() {
      return 0;
    },
    /** Il velivolo è simulato in tutte le scene (nella prima è fermo, lontano, fuori dall'inquadratura utile). */
    get flying() {
      return active && scene > 0;
    },
    start() {
      active = true;
      paused = false;
      finished = false;
      total = 0;
      offsetValid = false;
      flight.reset();
      // Il velivolo è già sull'oceano, a ~120 km dal centro, verso nord-ovest.
      flight.teleport(85, 85, 1.2, 45);
      flight.setMotion(0.2, 45 * DEG);
      flight.setGuide({ mode: 'hold', alt: 1.2, speed: 0 });
      enter(0);
      rig = { kind: 'space', p: { h0: 1150, h1: 640, R0: 1250, R1: 620, az0: 62, az1: 22, dur: 13 }, fov: 50, t0: 0 };
      prevRig = null;
      blend = 1;
    },
    stop() {
      active = false;
      paused = false;
      flight.setGuide(null);
    },
    setPaused(p: boolean) {
      paused = p;
    },
    update(dt: number): Pose {
      if (!paused && !finished) {
        sceneTime += dt;
        total += dt;
      }
      if (!paused) blend = Math.min(1, blend + dt / blendDur);
      const st = flight.state();
      const h = st.alt;
      const r = st.r;
      const eyeR = 6 + 0.55 * Math.max(0, h);
      A.copy(flight.pos);
      up.copy(flight.frame().up);
      flight.forward(fw, flight.heading, 0);
      right.crossVectors(fw, up).normalize();
      let guide: Guide | null = flight.guide;
      switch (scene) {
        case 0:
          guide = { mode: 'hold', alt: 1.2, speed: 0 };
          if (sceneTime >= 13) {
            enter(1);
            // Discesa continua dalla posizione attuale della telecamera al giro attorno al velivolo.
            setRig({ kind: 'dive', p: { dur: 8, R: 26, H: 4, th: 0.6 }, fov: 50, a: lastPos.clone() }, 0.01);
          }
          break;
        case 1:
          guide = { mode: 'point', x: 0, z: 0, alt: 1.2, speed: sceneTime < 8 ? 0.2 : lerp(0.2, 0.6, ease((sceneTime - 8) / 8)), accel: 0.15, maxBank: 15 };
          if (sceneTime >= 8 && shot === -1) {
            shot = 0;
            setRig({ kind: 'orbit', p: { R: 26, H: 4, a0: 0.6, a1: 0.6 + Math.PI * 0.9, dur: 8 }, fov: 50 }, 0.01);
          }
          if (sceneTime >= 16) {
            enter(2);
            setRig({ kind: 'chase', p: { D: 22, H: 4.5, L: 30 }, fov: 58 }, 3.5);
          }
          break;
        case 2: {
          guide = { mode: 'point', x: 0, z: 0, alt: lerp(1.2, 0.8, ease(sceneTime / 10)), speed: 2.5, accel: 0.35, maxBank: 15 };
          if (sceneTime > 7 && shot !== 1) {
            shot = 1;
            setRig({ kind: 'side', p: { S: 15, B: 7, H: 1.2, L: 2 }, fov: 56 }, 3);
          }
          if (r < 95 || sceneTime > 15) enter(3);
          break;
        }
        case 3: {
          guide = { mode: 'point', x: 0, z: 0, alt: 0.45, speed: 2.5, accel: 0.4, maxBank: 18 };
          // Inquadrature diverse ogni ~7 s: inseguimento basso, ravvicinata, laterale radente, inseguimento.
          const s = Math.min(3, Math.floor(sceneTime / 7));
          if (s !== shot) {
            shot = s;
            if (s === 0) setRig({ kind: 'chase', p: { D: 17, H: 3, L: 30 }, fov: 62 }, 2.5);
            else if (s === 1) setRig({ kind: 'close', p: { F: 7, S: 5, H: 1.3 }, fov: 58 }, 2.5);
            else if (s === 2) setRig({ kind: 'side', p: { S: -16, B: 4, H: 0.4, L: 2 }, fov: 60 }, 2.5);
            else setRig({ kind: 'chase', p: { D: 15, H: 2.5, L: 30 }, fov: 66 }, 2.5);
          }
          if (r < 35 || sceneTime > 30) enter(4);
          break;
        }
        case 4: {
          guide = { mode: 'point', x: 0, z: 0, alt: 0.7, speed: r > 15 ? 1.6 : 0.7, accel: 0.6, maxBank: 18 };
          const s = sceneTime < 8 ? 0 : sceneTime < 15 ? 1 : 2;
          if (s !== shot) {
            shot = s;
            if (s === 0) setRig({ kind: 'chase', p: { D: 13, H: 2.2, L: 30 }, fov: 66 }, 2.5);
            else if (s === 1) setRig({ kind: 'close', p: { F: 8, S: -4.5, H: 1 }, fov: 60 }, 2.5);
            else setRig({ kind: 'chase', p: { D: 12, H: 2, L: 30 }, fov: 68 }, 2.5);
          }
          if (r < eyeR - 1.2 || sceneTime > 34) {
            enter(5);
            // Telecamera ferma nell'occhio, davanti e di lato: il velivolo emerge dalla parete verso di lei.
            const camAt = tmp.copy(A).addScaledVector(fw, 0.9).addScaledVector(right, 0.28).addScaledVector(up, 0.08).clone();
            setRig({ kind: 'world', p: {}, fov: 58, a: camAt }, 0.01);
          }
          break;
        }
        case 5:
          guide = { mode: 'point', x: 0, z: 0, alt: 0.9, speed: 0.3, accel: 0.4, maxBank: 20 };
          if (sceneTime >= 9) {
            enter(6);
            setRig({ kind: 'orbit', p: { R: 45, H: 7, a0: 2.3, a1: 3.6, dur: 10 }, fov: 64 }, 3);
          }
          break;
        case 6: {
          // Salita a spirale lungo le pareti (orbita antioraria, raggio crescente con la quota).
          // Velocità 0,3 km/s: raggio di virata ~4 km, l'orbita resta dentro l'occhio, a ~2,5 km dalle pareti.
          const alt = lerp(1.0, 13.5, ease(sceneTime / 28));
          guide = { mode: 'orbit', radius: Math.max(3, eyeR - 3), alt, speed: 0.3, accel: 0.2, maxBank: 50, maxPitch: 8, vz: 0.6 };
          const s = sceneTime < 10 ? 0 : sceneTime < 19 ? 1 : 2;
          if (s !== shot) {
            shot = s;
            if (s === 1) setRig({ kind: 'inward', p: { D: 38, B: 12, H: 4, LH: 1 }, fov: 58 }, 3.5);
            else if (s === 2) setRig({ kind: 'above', p: { D: 26, H: 60, L: 30 }, fov: 70 }, 3.5);
          }
          if (sceneTime >= 28) enter(7);
          break;
        }
        case 7: {
          // Ancora su fino a ~17,5 km nell'occhio, poi verso l'esterno sopra le sommità; allontanamento.
          const climbing = h < 17.2 && sceneTime < 12;
          guide = climbing
            ? { mode: 'orbit', radius: Math.max(3, eyeR - 3), alt: 17.6, speed: 0.3, accel: 0.25, maxBank: 50, maxPitch: 8, vz: 0.6 }
            : { mode: 'point', x: 400, z: 400, alt: 17.6, speed: lerp(0.8, 2.2, ease(sceneTime / 18)), accel: 0.3, maxBank: 30, maxPitch: 20 };
          if (shot === -1) {
            shot = 0;
            setRig({ kind: 'chase', p: { D: 20, H: 4, L: 30 }, fov: 62 }, 3);
          }
          if (!climbing && shot === 0 && sceneTime > 4) {
            shot = 1;
            setRig({ kind: 'side', p: { S: -30, B: 10, H: 5, L: 2 }, fov: 60 }, 3);
          }
          if (shot === 1 && sceneTime > 14) {
            shot = 2;
            setRig({ kind: 'pullback', p: { dur: 15 }, fov: 50 }, 2.5);
          }
          if (shot === 2 && total - (rig.t0 ?? 0) > 16.5 && !finished) finished = true;
          break;
        }
      }
      flight.setGuide(guide);

      rigPose(rig, poseB);
      if (prevRig && blend < 1) {
        rigPose(prevRig, poseA);
        const b = ease(blend);
        out.pos.copy(poseA.pos).lerp(poseB.pos, b);
        out.look.copy(poseA.look).lerp(poseB.look, b);
        out.fov = lerp(poseA.fov, poseB.fov, b);
      } else {
        out.pos.copy(poseB.pos);
        out.look.copy(poseB.look);
        out.fov = poseB.fov;
      }
      // Smorzamento relativo al velivolo (a 2,5 km/s uno smorzamento assoluto lascerebbe indietro la telecamera).
      tmp.subVectors(out.pos, A);
      const free = rig.kind === 'space' || rig.kind === 'dive' || rig.kind === 'pullback' || rig.kind === 'world';
      if (!offsetValid || free) offset.copy(tmp);
      else offset.lerp(tmp, 1 - Math.exp(-5 * dt));
      offsetValid = true;
      out.pos.copy(A).add(offset);
      // Mai sotto il mare.
      const camAlt = Math.hypot(out.pos.x, out.pos.y + RE, out.pos.z) - RE;
      if (camAlt < 0.03) out.pos.addScaledVector(up, 0.03 - camAlt);
      fovNow = lerp(fovNow, out.fov, 1 - Math.exp(-3 * dt));
      out.fov = fovNow;
      lastPos.copy(out.pos);
      lastLook.copy(out.look);
      return out;
    },
    estimate: 150,
  };
}

export type Cinema = ReturnType<typeof createCinema>;
