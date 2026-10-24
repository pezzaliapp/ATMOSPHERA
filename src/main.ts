import './styles.css';
import { SRGBColorSpace, Vector3 } from 'three';
import { subsolarPoint } from './core/astro';
import { cameraAt } from './core/camera-path';
import { lerpState, type CameraState } from './core/camera-pose';
import { CameraRig } from './core/camera-rig';
import { Engine } from './core/engine';
import { latLonToVector } from './core/geo';
import { Playback, type PlaybackMode } from './core/playback';
import type { SequenceIndex } from './data/sequence';
import { stormAt, type StormTrack } from './data/storm';
import { MILTON_2024 as EVENT } from './events/milton-2024';
import { createAtmosphere } from './globe/atmosphere';
import { createEarth } from './globe/earth';
import { createStars } from './globe/stars';
import { createCloudSequence } from './layers/cloud-sequence';
import { createCloudLayer } from './layers/clouds';
import { createLabelLayer } from './layers/labels';
import { createTrackLayer } from './layers/track';
import { registerServiceWorker } from './pwa/register';
import { createHud, showFatalError, type StoryCaptionView } from './ui/hud';
import { t } from './ui/i18n';
import { createThemeController } from './ui/theme';

const app = document.getElementById('app')!;
const canvas = document.getElementById('globe') as HTMLCanvasElement;
const loader = document.getElementById('loader')!;
const loaderBar = loader.querySelector<HTMLElement>('.loader__bar span')!;

/** Anteprima registrabile (solo sviluppo): ?capture blocca l'orologio e lo comanda da script. */
const CAPTURE = import.meta.env.DEV && new URLSearchParams(location.search).has('capture');

function hideLoader(): void {
  loader.classList.add('is-done');
  // Il timer copre i casi in cui transitionend non arriva (scheda in background, animazioni ridotte).
  const remove = () => loader.remove();
  loader.addEventListener('transitionend', remove, { once: true });
  window.setTimeout(remove, 800);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return (await response.json()) as T;
}

const easeInOut = (f: number) => (f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2);

async function start(): Promise<void> {
  let engine: Engine;
  try {
    engine = new Engine(canvas);
  } catch {
    hideLoader();
    showFatalError(app, t.errorWebgl);
    return;
  }
  canvas.addEventListener('atmosphera:contextlost', () => showFatalError(app, t.errorContextLost));

  const base = import.meta.env.BASE_URL;
  const data = `${base}${EVENT.dataPath}`;
  const seqUrl = `${base}${EVENT.sequencePath}`;
  const size = engine.quality.textureSize;

  let track: StormTrack;
  let index: SequenceIndex;
  let textures;
  try {
    [track, index] = await Promise.all([
      fetchJson<StormTrack>(`${data}track.json`),
      fetchJson<SequenceIndex>(`${seqUrl}frames.json`),
    ]);
    textures = await engine.loadTextures(
      [
        { url: `${base}textures/earth-day-${size}.jpg`, colorSpace: SRGBColorSpace },
        { url: `${base}textures/earth-night-${size}.jpg`, colorSpace: SRGBColorSpace },
        { url: `${data}surface.jpg`, colorSpace: SRGBColorSpace },
      ],
      (f) => loaderBar.style.setProperty('--progress', String(f * 0.6)),
    );
  } catch {
    hideLoader();
    showFatalError(app, t.errorTextures);
    return;
  }
  const [dayMap, nightMap, surface] = textures as [(typeof textures)[0], (typeof textures)[0], (typeof textures)[0]];

  const sequence = createCloudSequence(index, seqUrl);
  const times = sequence.times;
  const playback = new Playback({ start: times[0]!, end: times.at(-1)! }, EVENT.story.seconds, Date.parse(EVENT.story.start));
  try {
    // La riproduzione parte appena sono pronti i primi fotogrammi.
    await sequence.whenReady(playback.time);
  } catch {
    hideLoader();
    showFatalError(app, t.errorTextures);
    return;
  }
  loaderBar.style.setProperty('--progress', '1');

  const b = index.bounds;
  const bounds: [number, number, number, number] = [b.west, b.south, b.east, b.north];
  const q = engine.quality;

  // Scena
  const earth = createEarth({
    dayMap,
    nightMap,
    segments: q.sphereSegments,
    region: { surface, clouds: sequence, bounds, exaggeration: EVENT.cloudExaggeration },
  });
  const clouds = createCloudLayer({ sequence, exaggeration: EVENT.cloudExaggeration, segments: q.cloudSegments });
  const atmosphere = createAtmosphere(q.sphereSegments / 2);
  const stars = createStars();
  const trackLayer = createTrackLayer(track, new Date(playback.time), q.pixelRatio);
  engine.scene.add(stars.points, earth.mesh, clouds.mesh, atmosphere.mesh, trackLayer.group);

  const sun = new Vector3();
  const setSun = (time: Date) => {
    const s = subsolarPoint(time);
    sun.set(...latLonToVector(s.lat, s.lon));
    earth.setSunDirection(sun);
    clouds.setSunDirection(sun);
    atmosphere.setSunDirection(sun);
  };

  // Camera: inquadratura diversa per schermi verticali.
  const portrait = () => canvas.clientWidth < canvas.clientHeight;
  const home = () => (portrait() ? EVENT.cameraPortrait : EVENT.camera);
  const storyCamera = (u: number): CameraState => {
    const s = cameraAt(EVENT.story.camera, u);
    // In verticale lo schermo è stretto: camera un po' più lontana e meno inclinata.
    return portrait() ? { ...s, distance: s.distance * 1.25, tilt: s.tilt * 0.9 } : s;
  };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rig = new CameraRig(engine.camera, canvas, reducedMotion ? home() : storyCamera(0));

  const labels = createLabelLayer(app, [
    ...EVENT.labels,
    { text: track.name, lat: EVENT.camera.lat, lon: EVENT.camera.lon, kind: 'storm' as const },
  ]);

  // Con «riduci movimento» nulla parte da solo: si apre sul primo istante, in pausa.
  if (reducedMotion) {
    playback.mode = 'replay';
    playback.playing = false;
  }
  // Regia: attiva in STORY finché l'utente non prende la camera; «Riprendi regia» la riporta.
  let directing = !reducedMotion;
  let resume: { from: CameraState; start: number } | null = null;

  const setMode = (mode: PlaybackMode) => {
    playback.mode = mode;
    if (mode === 'story') {
      if (playback.time >= playback.range.end || playback.time < playback.storyRange.start) playback.restartStory();
      playback.playing = true;
      if (!reducedMotion) {
        directing = true;
        resume = { from: { ...rig.state }, start: performance.now() };
      }
    } else {
      directing = false;
    }
    engine.invalidate();
  };
  playback.onEnd = () => {
    // Fine del racconto: si resta sull'ultimo istante, in REPLAY, con la camera libera.
    if (playback.mode === 'story') setMode('replay');
  };

  const hud = createHud(
    app,
    {
      onZoomIn: () => rig.zoomBy(0.75),
      onZoomOut: () => rig.zoomBy(1.33),
      onReset: () => rig.flyTo(home(), 1600),
      onToggleView: () => {
        if (rig.isGlobe) rig.flyTo(home(), 2400);
        else rig.flyTo({ ...EVENT.globe, lat: home().lat, lon: home().lon }, 2400);
        hud.setView(rig.isGlobe);
      },
      onThemeCycle: () => theme.cycle(),
      onLayer: (layer, visible) => {
        if (layer === 'clouds') {
          clouds.setVisible(visible);
          earth.setCloudShadows(visible);
        } else if (layer === 'track') trackLayer.setVisible(visible);
        else labels.setVisible(visible);
        engine.invalidate();
      },
      onMode: setMode,
      onPlayPause: () => {
        if (!playback.playing && playback.time >= playback.range.end) playback.seek(playback.range.start);
        playback.playing = !playback.playing;
        engine.invalidate();
      },
      onSeek: (u) => {
        // Spostarsi nel tempo è un gesto da REPLAY: la regia si ferma.
        if (playback.mode === 'story') setMode('replay');
        playback.seekProgress(u);
        engine.invalidate();
      },
      onSpeed: (v) => {
        playback.replaySpeed = v;
        engine.invalidate();
      },
      onResumeDirector: () => setMode('story'),
    },
    { ...EVENT, time: new Date(playback.time), exaggeration: EVENT.cloudExaggeration },
    track,
    { start: new Date(times[0]!), end: new Date(times.at(-1)!), observations: times.map((ms) => new Date(ms)) },
  );
  hud.setView(rig.isGlobe);
  // Titolo d'apertura: i primi secondi del racconto (o del primo avvio), fino al primo gesto.
  const INTRO_SECONDS = 4.2;
  const openedAt = performance.now();
  let introDismissed = false;
  const introVisible = (now: number) => {
    if (introDismissed) return false;
    if (playback.mode === 'story') return playback.storyProgress * EVENT.story.seconds < INTRO_SECONDS;
    return !CAPTURE && now - openedAt < INTRO_SECONDS * 1000;
  };
  rig.onUserInput = () => {
    introDismissed = true;
    hud.hideHint();
    if (directing) {
      directing = false;
      resume = null;
    }
  };

  // La scena spaziale resta scura in entrambi i temi; il tema riguarda l'interfaccia.
  const theme = createThemeController((_, preference) => hud.setTheme(preference));

  const captions = EVENT.story.captions.map((c) => ({ ...c, from: Date.parse(c.from) }));
  const captionAt = (ms: number): StoryCaptionView | null => {
    let current: StoryCaptionView | null = null;
    for (const c of captions) if (ms >= c.from) current = c;
    return current;
  };

  /** Porta la scena all'istante della riproduzione; false se i fotogrammi non sono pronti. */
  let lastStormMinute = -1;
  let stalled = false;
  let warnedNetwork = false;
  const syncScene = (now: number): boolean => {
    const time = new Date(playback.time);
    // Nel racconto la miscela B-spline uniforma la nitidezza; in pausa in REPLAY le
    // osservazioni compaiono pure.
    const smoothing = playback.mode === 'replay' && !playback.playing ? 0 : 1;
    if (!sequence.setTime(playback.time, smoothing)) return false;
    setSun(time);
    trackLayer.setTime(time);
    const minute = Math.floor(playback.time / 60_000);
    if (minute !== lastStormMinute) {
      lastStormMinute = minute;
      const storm = stormAt(track, time);
      if (storm) {
        hud.setStorm(storm);
        labels.move('storm', storm.lat, storm.lon);
      }
    }
    const obs = sequence.observedIndex(playback.time);
    const i = sequence.slots.indices[1];
    hud.setPlayback({
      mode: playback.mode,
      playing: playback.playing,
      time,
      progress: playback.progress,
      observed: obs !== null ? new Date(times[obs]!) : null,
      between: obs === null ? [new Date(times[i]!), new Date(times[Math.min(i + 1, times.length - 1)]!)] : null,
      speed: playback.replaySpeed,
    });
    hud.setCaption(playback.mode === 'story' ? captionAt(playback.time) : null);
    hud.setIntro(introVisible(now));
    hud.setDirector(playback.mode === 'story' && !directing && !reducedMotion);

    if (directing) {
      const target = storyCamera(playback.storyProgress);
      if (resume) {
        const f = Math.min(1, (now - resume.start) / 1500);
        rig.set(lerpState(resume.from, target, easeInOut(f)));
        if (f >= 1) resume = null;
      } else rig.set(target);
    }
    return true;
  };

  let wasGlobe = rig.isGlobe;
  if (!CAPTURE) {
    engine.onFrame((dt) => {
      const now = performance.now();
      // Se i fotogrammi successivi non sono ancora arrivati, l'orologio aspetta.
      const before = playback.time;
      const advanced = stalled ? false : playback.update(dt);
      stalled = !syncScene(now);
      if (stalled && advanced) playback.time = before;
      if (stalled && sequence.failing && !warnedNetwork) {
        // Connessione lenta o assente: un avviso discreto, la riproduzione riprende da sola.
        warnedNetwork = true;
        hud.showToast(t.framesUnavailable);
      }
      if (!sequence.failing) warnedNetwork = false;
      const moved = rig.update(dt);
      trackLayer.update(engine.camera, rig.state.distance);
      if (rig.isGlobe !== wasGlobe) {
        wasGlobe = rig.isGlobe;
        hud.setView(wasGlobe);
      }
      return advanced || moved || playback.playing || resume !== null;
    });
  }
  engine.onAfterRender(() =>
    labels.update(engine.camera, canvas.clientWidth, canvas.clientHeight, rig.state.distance, hud.obstacles()),
  );
  syncScene(performance.now());
  trackLayer.update(engine.camera, rig.state.distance);

  if (CAPTURE) {
    // Comandi per la registrazione locale (scripts in scratchpad): istante e modalità fissati da fuori.
    playback.playing = false;
    Object.assign(window, {
      __atmosphera: {
        storySeconds: EVENT.story.seconds,
        range: playback.range,
        /** STORY al secondo s del racconto, con regia. */
        async story(s: number) {
          playback.mode = 'story';
          directing = true;
          resume = null;
          const r = playback.storyRange;
          playback.seek(r.start + ((r.end - r.start) * s) / EVENT.story.seconds);
          await sequence.whenReady(playback.time);
          while (!syncScene(0)) await new Promise((r) => setTimeout(r, 20));
          trackLayer.update(engine.camera, rig.state.distance);
          engine.renderNow();
        },
        /** REPLAY a un istante UTC (ms), con una camera fissa. */
        async replay(ms: number, camera: CameraState) {
          playback.mode = 'replay';
          playback.playing = true;
          directing = false;
          playback.seek(ms);
          rig.set(camera);
          await sequence.whenReady(playback.time);
          while (!syncScene(0)) await new Promise((r) => setTimeout(r, 20));
          trackLayer.update(engine.camera, rig.state.distance);
          engine.renderNow();
        },
      },
    });
  }

  engine.start();
  hideLoader();

  registerServiceWorker({
    onNeedRefresh: (update) => hud.showToast(t.updateAvailable, { label: t.update, run: update }),
    onOfflineReady: () => {
      // I fotogrammi scaricati prima che il service worker fosse attivo non sono in cache:
      // si richiedono di nuovo (di norma li serve la cache HTTP del browser, senza traffico).
      void sequence.warmCache().then(() => hud.showToast(t.offlineReady));
    },
  });
}

void start();
