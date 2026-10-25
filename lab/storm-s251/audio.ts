/**
 * STORM FLIGHT S2.4/S2.5 — audio dinamico con Web Audio API, tutto sintetizzato localmente (nessun file, nessun servizio).
 *
 * Diagnosi del difetto della S2.3 («ventola di computer»): tre catene sempre attive da quando il velivolo è in scena
 * fino all'allontanamento finale — il soffio della propulsione (rumore bianco in banda 400–1300 Hz), il fruscio
 * dell'aria (rumore bianco a banda larga) e un ronzio a onda quadra a 31 Hz — con livelli quasi costanti.
 * Nella S2.4 nessun rumore bianco continuo in banda media:
 * - propulsione: toni (sub-basso, armoniche con filtro risonante, pulsazione legata alla potenza) e un rombo
 *   grave di scarico (rumore «marrone» sotto i 150 Hz); variazioni lente e irregolari, non cicliche;
 * - aria e vento: rumore marrone (energia concentrata sui gravi) con inviluppi a raffiche irregolari;
 * - pioggia: impatti di gocce sulla fusoliera (tessiture di impatti generate una volta, più gocce grosse singole);
 * - grandine: colpi sporadici sincronizzati con gli episodi visivi (chiamata hail());
 * - tuoni con ritardo dalla distanza, colpo e scricchiolio della struttura nelle raffiche;
 * - compressore e limitatore in uscita: nessuna distorsione nella parete dell'occhio.
 * Avvio solo dopo un gesto (AUDIO ON); dissolvenze; muto in pausa e alla schermata iniziale; chiusura all'uscita.
 */

export interface AudioState {
  /** Potenza 0–1 (velocità/BOOST). */
  power: number;
  /** Velocità all'aria normalizzata (1 = crociera). */
  airspeed: number;
  /** Vento della tempesta (m/s). */
  windMs: number;
  turbulence: number;
  /** Intensità delle precipitazioni 0–1. */
  rain: number;
  phase: string;
  /** Rumore meteorologico: 0 occhio, ~0,25 sopra le nubi, 1 nella tempesta. */
  atmosphere: number;
  /** Vicinanza della telecamera (ascoltatore) al velivolo: 1 vicino, 0 lontano. */
  near: number;
  /** S2.5: vicinanza al mare (1 a pelo d'acqua, 0 sopra ~1 km) per il rumore delle onde. */
  sea?: number;
}

export function createAudio() {
  let ctx: AudioContext | null = null;
  let enabled = false;
  let volume = 0.7;
  let suspended = true;
  let wantHold = true;
  let holdToken = 0;
  let nodes: ReturnType<typeof build> | null = null;
  let white: AudioBuffer | null = null;
  let lastT = 0;
  let oneShots = 0;
  let bigDropAcc = 0;
  // Inviluppi irregolari (processi di Ornstein-Uhlenbeck) calcolati in JavaScript: raffiche non periodiche.
  const ou = { wind: 0, air: 0, engine: 0, rattle: 0, sea: 0 };
  let gustEnv = 0;

  const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.22;
  const step = (x: number, tau: number, sigma: number, dt: number) => x + (-x / tau) * dt + sigma * Math.sqrt((2 * dt) / tau) * gauss();

  /** Tessitura di impatti di gocce (rate al secondo), buffer stereo di 4 s, generata una volta. */
  function impactsBuffer(c: AudioContext, rate: number) {
    const sec = 4;
    const buf = c.createBuffer(2, c.sampleRate * sec, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const n = Math.round(rate * sec);
      for (let k = 0; k < n; k++) {
        const at = Math.floor(Math.random() * (d.length - 800));
        const amp = 0.15 + 0.85 * Math.pow(Math.random(), 2.2);
        const len = 60 + Math.floor(Math.random() * 260);
        // Ticchettio: impulso con decadimento esponenziale, alternato (contenuto acuto ma breve).
        for (let i = 0; i < len; i++) d[at + i]! += amp * (Math.random() * 2 - 1) * Math.exp((-i / len) * 6);
      }
    }
    return buf;
  }

  function build(c: AudioContext) {
    const N = c.sampleRate * 3;
    white = c.createBuffer(2, N, c.sampleRate);
    const brown = c.createBuffer(2, N, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const w = white.getChannelData(ch);
      const b = brown.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < N; i++) {
        w[i] = Math.random() * 2 - 1;
        last = (last + 0.02 * w[i]!) / 1.02;
        b[i] = last * 3.5;
      }
    }
    // Uscita: compressore morbido + limitatore (nessun superamento del fondo scala).
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.02;
    comp.release.value = 0.35;
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    const master = c.createGain();
    master.gain.value = 0;
    master.connect(comp).connect(limiter).connect(c.destination);
    const analyser = c.createAnalyser();
    analyser.fftSize = 2048;
    // Letture istantanee (le verifiche campionano a intervalli lunghi: una media mobile falserebbe i confronti).
    analyser.smoothingTimeConstant = 0;
    limiter.connect(analyser);
    const loop = (buf: AudioBuffer) => {
      const s = c.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start(0, Math.random() * (buf.duration - 0.1));
      return s;
    };
    const filter = (type: BiquadFilterType, f: number, q = 0.7) => {
      const b = c.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const gain = (v = 0) => {
      const g = c.createGain();
      g.gain.value = v;
      return g;
    };
    const osc = (type: OscillatorType, f: number) => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = f;
      return o;
    };

    // ── Propulsione Concept C (immaginaria): sub-basso, armoniche risonanti, pulsazione, rombo di scarico.
    const engine = gain(0);
    engine.connect(master);
    const sub = osc('sine', 46);
    const subGain = gain(0.5);
    sub.connect(subGain).connect(engine);
    const sub2 = osc('sine', 92.4);
    const sub2Gain = gain(0.16);
    sub2.connect(sub2Gain).connect(engine);
    const h1 = osc('sawtooth', 92);
    const h2 = osc('sawtooth', 138.6);
    const harmLp = filter('lowpass', 320, 3.5);
    const harmGain = gain(0.07);
    h1.connect(harmLp);
    h2.connect(harmLp);
    // Pulsazione: modulazione d'ampiezza a 6–14 Hz (non un rumore), profondità bassa.
    const pulse = gain(1);
    const pulseLfo = osc('sine', 8);
    const pulseDepth = gain(0.18);
    pulseLfo.connect(pulseDepth).connect(pulse.gain);
    harmLp.connect(pulse).connect(harmGain).connect(engine);
    const exhaustSrc = loop(brown);
    const exhaustLp = filter('lowpass', 140, 0.6);
    const exhaust = gain(0.25);
    exhaustSrc.connect(exhaustLp).connect(exhaust).connect(engine);
    // ── Aria attorno alla fusoliera: rumore marrone in banda, con inviluppo a raffiche.
    const airSrc = loop(brown);
    const airBp = filter('bandpass', 420, 0.55);
    const air = gain(0);
    airSrc.connect(airBp).connect(air).connect(master);
    // ── Vento della tempesta: corpo grave + sibilo della cellula (banda stretta) nelle raffiche.
    const windSrc = loop(brown);
    const windLp = filter('lowpass', 520, 0.5);
    const wind = gain(0);
    windSrc.connect(windLp).connect(wind).connect(master);
    const howlSrc = loop(white);
    const howlBp = filter('bandpass', 620, 7);
    const howl = gain(0);
    howlSrc.connect(howlBp).connect(howl).connect(master);
    // ── Vibrazioni strutturali: tremolio grave irregolare (rumore marrone), solo in turbolenza.
    const rattleSrc = loop(brown);
    const rattleBp = filter('bandpass', 95, 1.2);
    const rattle = gain(0);
    rattleSrc.connect(rattleBp).connect(rattle).connect(master);
    // ── Pioggia sulla fusoliera: due tessiture di impatti (moderata e battente) con risonanza della cellula.
    const dropsLight = loop(impactsBuffer(c, 45));
    const dropsHeavy = loop(impactsBuffer(c, 220));
    const rainBody = filter('peaking', 1300, 1.2);
    rainBody.gain.value = 5;
    const rainHp = filter('highpass', 700, 0.5);
    const rainLight = gain(0);
    const rainHeavy = gain(0);
    dropsLight.connect(rainLight).connect(rainHp);
    dropsHeavy.connect(rainHeavy).connect(rainHp);
    rainHp.connect(rainBody).connect(master);
    // Scroscio lontano (velo della pioggia), basso e grave.
    const showerSrc = loop(brown);
    const showerBp = filter('bandpass', 900, 0.7);
    const shower = gain(0);
    showerSrc.connect(showerBp).connect(shower).connect(master);
    // S2.5: mare vicino alla superficie (rumore marrone grave, onde irregolari) — nessun fruscio in banda media.
    const seaSrc = loop(brown);
    const seaLp = filter('lowpass', 380, 0.6);
    const sea = gain(0);
    seaSrc.connect(seaLp).connect(sea).connect(master);
    const fx = gain(1);
    fx.connect(master);
    // Tuono su un ramo proprio (stesso percorso verso l'uscita) con un analizzatore per le verifiche del ritardo.
    const thunderBus = gain(1);
    thunderBus.connect(fx);
    const thunderAn = c.createAnalyser();
    thunderAn.fftSize = 1024;
    thunderAn.smoothingTimeConstant = 0;
    thunderBus.connect(thunderAn);
    for (const o of [sub, sub2, h1, h2, pulseLfo]) o.start();
    return {
      analyser, master, engine, sub, sub2, h1, h2, harmLp, harmGain, pulseLfo, pulseDepth, exhaust, exhaustLp, air, airBp, wind, windLp,
      howl, howlBp, rattle, rainLight, rainHeavy, rainBody, shower, fx, sea, seaLp, thunderBus, thunderAn,
    };
  }

  const ramp = (p: AudioParam, v: number, tau = 0.25) => ctx && p.setTargetAtTime(v, ctx.currentTime, tau);

  /** Colpo breve: goccia grossa, graupel o grandine (filtro passa-banda sul rumore bianco + tonfo grave per la grandine). */
  function hit(when: number, kind: 'drop' | 'graupel' | 'hail', level: number) {
    if (!ctx || !nodes || !white) return;
    const s = ctx.createBufferSource();
    s.buffer = white;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = kind === 'drop' ? 1600 + Math.random() * 1600 : kind === 'graupel' ? 2200 + Math.random() * 1200 : 1100 + Math.random() * 900;
    f.Q.value = kind === 'drop' ? 1.5 : 3;
    const g = ctx.createGain();
    const dur = kind === 'drop' ? 0.03 : kind === 'graupel' ? 0.025 : 0.07;
    const peak = level * (kind === 'drop' ? 0.25 : kind === 'graupel' ? 0.22 : 0.5);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0005, when + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.random() * 1.6 - 0.8;
    s.connect(f).connect(g).connect(p).connect(nodes.fx);
    oneShots++;
    s.onended = () => {
      s.disconnect();
      oneShots--;
    };
    s.start(when, Math.random() * 2.5, dur + 0.02);
    if (kind === 'hail') {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(160 + Math.random() * 60, when);
      o.frequency.exponentialRampToValueAtTime(70, when + 0.08);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0, when);
      og.gain.linearRampToValueAtTime(0.25 * level, when + 0.003);
      og.gain.exponentialRampToValueAtTime(0.0005, when + 0.1);
      o.connect(og).connect(p);
      oneShots++;
      o.onended = () => {
        o.disconnect();
        oneShots--;
      };
      o.start(when);
      o.stop(when + 0.12);
    }
  }

  return {
    get enabled() {
      return enabled;
    },
    get volume() {
      return volume;
    },
    get activeOneShots() {
      return oneShots;
    },
    get flags() {
      return { suspended, wantHold, gain: nodes?.master.gain.value ?? -1 };
    },
    get contextState() {
      return ctx?.state ?? 'none';
    },
    /** Livello RMS dell'uscita (0–1), per le verifiche. */
    level() {
      if (!nodes || !ctx || ctx.state !== 'running') return 0;
      const buf = new Float32Array(nodes.analyser.fftSize);
      nodes.analyser.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      return Math.sqrt(s / buf.length);
    },
    /** Livello percepito approssimato: energia sopra ~200 Hz (dB relativi), per confrontare le zone. */
    loud() {
      if (!nodes || !ctx || ctx.state !== 'running') return -120;
      const f = new Float32Array(nodes.analyser.frequencyBinCount);
      nodes.analyser.getFloatFrequencyData(f);
      const hz = ctx.sampleRate / 2 / f.length;
      let s = 0;
      for (let i = Math.floor(200 / hz); i < Math.min(f.length, 8000 / hz); i++) s += Math.pow(10, f[i]! / 10);
      return +(10 * Math.log10(s + 1e-12)).toFixed(1);
    },
    /** Solo verifiche: livello RMS del tuono (prima del mix) e tempo del contesto audio. */
    thunderLevel() {
      if (!nodes || !ctx || ctx.state !== 'running') return { rms: 0, t: ctx?.currentTime ?? 0 };
      const buf = new Float32Array(nodes.thunderAn.fftSize);
      nodes.thunderAn.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      return { rms: Math.sqrt(s / buf.length), t: ctx.currentTime };
    },
    /** Picco dell'uscita (verifica dell'assenza di saturazione). */
    peak() {
      if (!nodes || !ctx || ctx.state !== 'running') return 0;
      const buf = new Float32Array(nodes.analyser.fftSize);
      nodes.analyser.getFloatTimeDomainData(buf);
      let m = 0;
      for (const v of buf) m = Math.max(m, Math.abs(v));
      return m;
    },
    /** Diagnosi: guadagni delle catene ed energia d'uscita per bande (dB). */
    diag() {
      if (!nodes || !ctx) return null;
      const n = nodes;
      const g = (p: AudioParam) => +p.value.toFixed(3);
      const f = new Float32Array(n.analyser.frequencyBinCount);
      n.analyser.getFloatFrequencyData(f);
      const hz = ctx.sampleRate / 2 / f.length;
      const band = (lo: number, hi: number) => {
        let s = 0, c = 0;
        for (let i = Math.floor(lo / hz); i < Math.min(f.length, hi / hz); i++) { s += Math.pow(10, f[i]! / 10); c++; }
        return +(10 * Math.log10(s / Math.max(1, c) + 1e-12)).toFixed(1);
      };
      return { engine: g(n.engine.gain), air: g(n.air.gain), wind: g(n.wind.gain), howl: g(n.howl.gain), rattle: g(n.rattle.gain), rainL: g(n.rainLight.gain), rainH: g(n.rainHeavy.gain), shower: g(n.shower.gain), sea: g(n.sea.gain), bands: { '<120': band(20, 120), '120-500': band(120, 500), '500-2k': band(500, 2000), '2k-6k': band(2000, 6000), '>6k': band(6000, 16000) } };
    },
    /** Da chiamare solo dentro un gesto dell'utente (clic su AUDIO ON). */
    async setEnabled(on: boolean) {
      enabled = on;
      if (on) {
        if (!ctx) {
          ctx = new AudioContext({ latencyHint: 'interactive' });
          nodes = build(ctx);
        }
        await ctx.resume();
        if (wantHold) {
          // Attivato fuori dal volo (schermata iniziale, pausa): muto, sospeso dopo 10 s se resta in attesa.
          suspended = true;
          const c = ctx;
          const token = ++holdToken;
          setTimeout(() => {
            if (suspended && wantHold && token === holdToken && c.state === 'running') void c.suspend();
          }, 10000);
          return;
        }
        suspended = false;
        ramp(nodes!.master.gain, volume, 0.6);
      } else if (ctx && nodes) {
        ramp(nodes.master.gain, 0, 0.25);
        const c = ctx;
        setTimeout(() => {
          if (!enabled && c.state === 'running') void c.suspend();
        }, 1200);
        suspended = true;
      }
    },
    setVolume(v: number) {
      volume = Math.min(1, Math.max(0, v));
      if (enabled && nodes && !suspended) ramp(nodes.master.gain, volume, 0.15);
    },
    /** Pausa, schermata iniziale: dissolvenza e sospensione; ripresa: riattivazione e dissolvenza in entrata. */
    async hold(on: boolean) {
      wantHold = on;
      if (!ctx || !nodes || !enabled) return;
      if (on) {
        ramp(nodes.master.gain, 0, 0.15);
        suspended = true;
        const c = ctx;
        const token = ++holdToken;
        setTimeout(() => {
          if (suspended && wantHold && token === holdToken && c.state === 'running') void c.suspend();
        }, 10000);
      } else {
        holdToken++;
        await ctx.resume();
        suspended = false;
        ramp(nodes.master.gain, volume, 0.5);
      }
    },
    /** Aggiornamento del mix (ogni frame). */
    update(s: AudioState) {
      if (!ctx || !nodes || !enabled || suspended) return;
      const n = nodes;
      const now = ctx.currentTime;
      const dt = Math.min(0.1, Math.max(0, now - lastT));
      lastT = now;
      const p = Math.min(1, Math.max(0, s.power));
      const near = Math.min(1, Math.max(0, s.near));
      const atm = Math.min(1, Math.max(0, s.atmosphere));
      const T = Math.min(1, Math.max(0, s.turbulence));
      // Inviluppi irregolari.
      ou.engine = step(ou.engine, 1.8, 0.05, dt);
      ou.air = step(ou.air, 0.9, 0.35 + 0.4 * T, dt);
      ou.wind = step(ou.wind, 1.4, 0.45 + 0.35 * T, dt);
      ou.rattle = step(ou.rattle, 0.25, 1, dt);
      gustEnv = Math.max(0, gustEnv - dt * 0.8);

      // Propulsione: frequenze e filtro con la potenza, deriva lenta irregolare (non un ciclo).
      const f0 = (40 + 22 * p) * (1 + 0.02 * ou.engine);
      ramp(n.sub.frequency, f0, 0.7);
      ramp(n.sub2.frequency, f0 * 2.01, 0.7);
      ramp(n.h1.frequency, f0 * 2, 0.7);
      ramp(n.h2.frequency, f0 * 3.01, 0.7);
      ramp(n.harmLp.frequency, (220 + 520 * p) * (1 + 0.08 * ou.engine), 0.6);
      ramp(n.pulseLfo.frequency, 6 + 8 * p, 0.8);
      ramp(n.harmGain.gain, 0.05 + 0.07 * p, 0.6);
      ramp(n.exhaust.gain, 0.15 + 0.3 * p, 0.6);
      ramp(n.exhaustLp.frequency, 110 + 90 * p, 0.6);
      // Livello contenuto: la propulsione resta udibile ovunque, ma il meteo deve poterla sovrastare.
      ramp(n.engine.gain, (0.17 + 0.13 * p) * near * (0.75 + 0.25 * atm) * (1 + 0.15 * T * Math.tanh(ou.rattle)), 0.6);
      // Aria: cresce con la velocità all'aria, a raffiche (mai un fruscio costante).
      const a = Math.min(2.2, s.airspeed);
      const airEnv = Math.max(0, 0.55 + 0.45 * Math.tanh(ou.air)) + gustEnv;
      ramp(n.air.gain, Math.min(0.6, 0.24 * Math.pow(a, 1.2) * airEnv) * near * (0.2 + 0.8 * Math.max(atm, 0.1)), 0.12);
      ramp(n.airBp.frequency, 300 + 260 * Math.min(1.6, a) + 120 * Math.tanh(ou.air), 0.3);
      // Vento della tempesta: corpo grave a raffiche, sibilo solo nelle punte.
      const windBase = Math.min(1, s.windMs / 70) * atm;
      const windEnv = Math.max(0, 0.45 + 0.55 * Math.tanh(ou.wind)) + 1.2 * gustEnv;
      ramp(n.wind.gain, Math.min(1.3, 1.25 * windBase * windEnv), 0.15);
      ramp(n.windLp.frequency, 260 + 420 * Math.min(1, windEnv), 0.2);
      ramp(n.howl.gain, 0.04 * windBase * Math.max(0, windEnv - 0.7), 0.25);
      ramp(n.howlBp.frequency, 520 + 260 * Math.tanh(ou.wind), 0.4);
      // Vibrazioni: tremolio grave irregolare con la turbolenza.
      ramp(n.rattle.gain, 0.35 * T * T * near * Math.max(0, 0.6 + 0.6 * Math.tanh(ou.rattle)), 0.05);
      // Pioggia: impatti sulla fusoliera (vicino) e scroscio (lontano).
      const liquid = s.phase === 'rain' || s.phase === 'mixed';
      const solid = s.phase === 'graupel' || s.phase === 'ice' || s.phase === 'hail';
      const r = Math.min(1, s.rain) * atm;
      ramp(n.rainLight.gain, (liquid ? 0.5 : solid ? 0.2 : 0) * Math.min(1, r * 2.5) * (1 - Math.min(1, r * 1.4)) * near + (liquid ? 0.08 : 0) * r * near, 0.4);
      ramp(n.rainHeavy.gain, (liquid ? 1.05 : solid ? 0.28 : 0) * Math.min(1, Math.max(0, r - 0.25) * 1.6) * near, 0.4);
      ramp(n.shower.gain, 0.32 * r, 0.6);
      // Mare: solo vicino alla superficie, con il vento; ondate lente e irregolari.
      ou.sea = step(ou.sea, 3.5, 0.6, dt);
      const seaNear = Math.min(1, Math.max(0, s.sea ?? 0));
      ramp(n.sea.gain, 0.32 * seaNear * Math.min(1, s.windMs / 45) * Math.max(0.15, 0.6 + 0.5 * Math.tanh(ou.sea)), 0.4);
      ramp(n.seaLp.frequency, 260 + 200 * Math.max(0, Math.tanh(ou.sea)), 0.5);
      // Gocce grosse e graupel singoli (pochi al secondo, riconoscibili).
      const kind = s.phase === 'graupel' ? 'graupel' : 'drop';
      const rate = s.phase === 'none' || s.phase === 'hail' ? 0 : (liquid ? 9 : 6) * r * near;
      bigDropAcc += rate * dt;
      while (bigDropAcc >= 1) {
        bigDropAcc -= 1;
        hit(now + 0.02 + Math.random() * 0.08, kind, 0.4 + 0.6 * Math.random());
      }
    },
    /** Raffica improvvisa: inviluppo del vento e dell'aria, colpo sordo e breve scricchiolio della struttura. */
    gust(level: number) {
      if (!ctx || !nodes || !enabled || suspended || !white) return;
      gustEnv = Math.min(1.2, gustEnv + 0.7 * level);
      const t0 = ctx.currentTime + 0.05;
      const thud = ctx.createOscillator();
      thud.frequency.setValueAtTime(64, t0);
      thud.frequency.exponentialRampToValueAtTime(36, t0 + 0.35);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0, t0);
      tg.gain.linearRampToValueAtTime(0.28 * level, t0 + 0.02);
      tg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45);
      thud.connect(tg).connect(nodes.fx);
      const cr = ctx.createBufferSource();
      cr.buffer = white;
      const cf = ctx.createBiquadFilter();
      cf.type = 'bandpass';
      cf.frequency.value = 360 + Math.random() * 260;
      cf.Q.value = 9;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0, t0 + 0.08);
      for (let i = 0; i < 5; i++) cg.gain.setValueAtTime((i % 2 ? 0.015 : 0.09) * level, t0 + 0.1 + i * 0.045 + Math.random() * 0.02);
      cg.gain.setValueAtTime(0, t0 + 0.38);
      cr.connect(cf).connect(cg).connect(nodes.fx);
      oneShots += 2;
      thud.onended = () => {
        thud.disconnect();
        oneShots--;
      };
      cr.onended = () => {
        cr.disconnect();
        oneShots--;
      };
      thud.start(t0);
      thud.stop(t0 + 0.5);
      cr.start(t0, Math.random(), 0.45);
    },
    /** Episodio di grandine: `count` colpi nell'arco di `spread` secondi (sincronizzati con l'effetto visivo). */
    hail(count: number, spread = 0.5) {
      if (!ctx || !nodes || !enabled || suspended) return;
      const t = ctx.currentTime + 0.02;
      for (let i = 0; i < count; i++) hit(t + Math.random() * spread, 'hail', 0.5 + 0.5 * Math.random());
    },
    /**
     * Tuono (S2.5): ritardo = distanza / 343 m/s. Vicino (< 3 km): schiocco secco poi rotolamento; lontano: rombo
     * grave e lungo con ondate irregolari (più grave e più lungo con la distanza, le alte frequenze si perdono).
     */
    thunder(distKm: number, strength: number) {
      if (!ctx || !nodes || !white || !enabled || suspended) return;
      const delay = distKm / 0.343;
      if (delay > 40) return;
      const t0 = ctx.currentTime + delay;
      const level = Math.min(1, strength / (1 + distKm / 4));
      const near = distKm < 3;
      const dur = 2.5 + Math.min(10, distKm * 0.6);
      const s = ctx.createBufferSource();
      s.buffer = white;
      s.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = near ? 1400 : Math.max(120, 420 - distKm * 18);
      lp.frequency.setTargetAtTime(near ? 160 : 90, t0 + 0.2, 0.9);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      // Inviluppo a ondate irregolari (rotolamento del tuono): 3–6 rigonfiamenti decrescenti.
      const n = 3 + Math.floor(Math.random() * 4);
      let tt = t0 + (near ? 0.02 : 0.3);
      g.gain.linearRampToValueAtTime(0.75 * level, tt);
      for (let i = 1; i <= n; i++) {
        const at = tt + (dur / n) * (0.6 + 0.8 * Math.random()) * i * 0.6;
        const v = 0.75 * level * Math.pow(0.72, i) * (0.6 + 0.8 * Math.random());
        g.gain.linearRampToValueAtTime(v, at);
      }
      g.gain.setTargetAtTime(0, t0 + dur * 0.7, dur / 5);
      s.connect(lp).connect(g).connect(nodes.thunderBus);
      oneShots++;
      s.onended = () => {
        s.disconnect();
        oneShots--;
      };
      s.start(t0, Math.random() * 2);
      s.stop(t0 + dur * 1.6);
      if (near) {
        // Schiocco iniziale (canale vicino): breve, brillante, senza saturare (limitatore in uscita).
        const c = ctx.createBufferSource();
        c.buffer = white;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 900;
        const cg = ctx.createGain();
        cg.gain.setValueAtTime(0, t0);
        cg.gain.linearRampToValueAtTime(0.5 * level, t0 + 0.004);
        cg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
        c.connect(hp).connect(cg).connect(nodes.thunderBus);
        oneShots++;
        c.onended = () => {
          c.disconnect();
          oneShots--;
        };
        c.start(t0, Math.random());
        c.stop(t0 + 0.4);
      }
    },
    dispose() {
      enabled = false;
      if (ctx) void ctx.close();
      ctx = null;
      nodes = null;
      white = null;
    },
  };
}

export type StormAudio = ReturnType<typeof createAudio>;
