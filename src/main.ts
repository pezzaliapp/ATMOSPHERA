import './styles.css';
import { loadEvent, type LoadedEvent } from './app/load-event';
import { CITY_FLIGHT_HASH, createCityFlightEntry } from './app/city-flight-entry';
import { formatRoute, parseRoute } from './app/route';
import { createEventScene } from './app/scene';
import { cameraAt } from './core/camera-path';
import { lerpState, type CameraState } from './core/camera-pose';
import { CameraRig } from './core/camera-rig';
import { Engine } from './core/engine';
import { Playback, type PlaybackMode } from './core/playback';
import { viewpoint } from './core/viewpoints';
import { stormAt } from './data/storm';
import { createCloudSequence } from './layers/cloud-sequence';
import { createLabelLayer } from './layers/labels';
import { registerServiceWorker } from './pwa/register';
import { createHud, showFatalError, type RenderView, type StoryCaptionView } from './ui/hud';
import { t } from './ui/i18n';
import { createThemeController } from './ui/theme';
import { createVolumeView, volumeSupported } from './volume/volume-view';

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

const easeInOut = (f: number) => (f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2);

/** Durata dei voli verso le inquadrature di EXPLORE, in ms. */
const VIEW_FLIGHT_MS = 1800;

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

  const route = parseRoute(location.hash);
  let event: LoadedEvent;
  try {
    event = await loadEvent(engine, import.meta.env.BASE_URL, route.eventId, (f) =>
      loaderBar.style.setProperty('--progress', String(f * 0.6)),
    );
  } catch {
    hideLoader();
    showFatalError(app, t.errorTextures);
    return;
  }
  const { manifest, track } = event;

  const sequence = createCloudSequence(event.index, event.sequenceUrl);
  const times = sequence.times;
  const playback = new Playback({ start: times[0]!, end: times.at(-1)! }, manifest.story.seconds, Date.parse(manifest.story.start));
  try {
    // La riproduzione parte appena sono pronti i primi fotogrammi.
    await sequence.whenReady(playback.time);
  } catch {
    hideLoader();
    showFatalError(app, t.errorTextures);
    return;
  }
  loaderBar.style.setProperty('--progress', '1');

  const scene = createEventScene(engine, event, sequence, playback.time);
  const trackLayer = scene.track;
  // EXPLORE: immagini satellitari originali o volume ricostruito (creato al primo uso).
  const volumeAvailable = volumeSupported(engine);
  const volumeView = createVolumeView(engine, scene, event, trackLayer.group);
  let renderView: RenderView = 'satellite';
  // Solo in sviluppo: misure del volume per le verifiche di prestazione (assente dalla build).
  if (import.meta.env.DEV) Object.assign(window, { __volume: volumeView });

  // Camera: inquadratura diversa per schermi verticali.
  const portrait = () => canvas.clientWidth < canvas.clientHeight;
  const home = () => (portrait() ? manifest.cameraPortrait : manifest.camera);
  const storyCamera = (u: number): CameraState => {
    const s = cameraAt(manifest.story.camera, u);
    // In verticale lo schermo è stretto: camera un po' più lontana e meno inclinata.
    return portrait() ? { ...s, distance: s.distance * 1.25, tilt: s.tilt * 0.9 } : s;
  };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rig = new CameraRig(engine.camera, canvas, reducedMotion ? home() : storyCamera(0));

  const labels = createLabelLayer(app, [
    ...manifest.labels,
    { text: track.name, lat: manifest.camera.lat, lon: manifest.camera.lon, kind: 'storm' as const },
  ]);

  // Con «riduci movimento» nulla parte da solo: si apre sul primo istante, in pausa.
  if (reducedMotion) {
    playback.mode = 'replay';
    playback.playing = false;
  }
  // Regia: attiva in STORY finché l'utente non prende la camera; «Riprendi regia» la riporta.
  let directing = !reducedMotion;
  let resume: { from: CameraState; start: number } | null = null;
  // EXPLORE: camera centrata sull'occhio, esagerazione verticale scelta (solo in EXPLORE:
  // STORY e REPLAY restano con quella dell'evento).
  let following = false;
  let exploreExaggeration = manifest.cloudExaggeration;
  const applyRelief = (mode: PlaybackMode) => {
    const value = mode === 'explore' ? exploreExaggeration : manifest.cloudExaggeration;
    scene.setExaggeration(value);
    volumeView.setExaggeration(value);
    hud.setExaggeration(value);
  };
  /** Il volume esiste solo in EXPLORE: STORY e REPLAY restano sempre con le immagini satellitari. */
  const applyRender = (mode: PlaybackMode) => {
    const volume = mode === 'explore' && renderView === 'volume' && volumeAvailable;
    if (volume) volumeView.enable();
    else volumeView.disable();
    hud.setRender(volume ? 'volume' : 'satellite');
  };
  /** Dimensione di un pixel dei dati satellitari, in km (righe della griglia albedo). */
  const b = event.index.bounds;
  const dataPixelKm = ((b.north - b.south) / event.index.albedoSize[1]) * 111.2;
  /** Oltre questo ingrandimento (pixel di schermo per pixel dei dati) i dettagli non sono osservati. */
  const MAX_MAGNIFICATION = 6;
  const magnification = () => {
    const fov = (engine.camera.fov * Math.PI) / 180;
    const kmPerCssPixel = (2 * rig.state.distance * 6371 * Math.tan(fov / 2)) / Math.max(1, canvas.clientHeight);
    return dataPixelKm / kmPerCssPixel;
  };

  /** Posizione dell'occhio all'istante (best track interpolata: ricostruita tra i punti). */
  const stormPosition = (ms: number) => {
    const s = stormAt(track, new Date(ms));
    return s ? { lat: s.lat, lon: s.lon } : { lat: rig.state.lat, lon: rig.state.lon };
  };

  const setFollowing = (on: boolean) => {
    following = on;
    hud.setFollow(on);
  };

  const setMode = (mode: PlaybackMode, announce = true) => {
    const changed = mode !== playback.mode;
    playback.mode = mode;
    // In EXPLORE il tempo ricomincia alla fine: si può esplorare senza fermarsi.
    playback.loop = mode === 'explore';
    if (mode === 'story') {
      if (playback.time >= playback.range.end || playback.time < playback.storyRange.start) playback.restartStory();
      playback.playing = true;
      setFollowing(false);
      if (!reducedMotion) {
        directing = true;
        resume = { from: { ...rig.state }, start: performance.now() };
      }
    } else {
      directing = false;
      resume = null;
      if (mode === 'explore' && playback.time >= playback.range.end) playback.seek(playback.range.start);
    }
    if (mode !== 'explore') {
      setFollowing(false);
      hud.setViewpoint(null);
    }
    applyRelief(mode);
    applyRender(mode);
    if (changed && announce) hud.announceMode(mode);
    if (!CAPTURE) history.replaceState(null, '', formatRoute({ mode, eventId: manifest.id }));
    engine.invalidate();
  };
  playback.onEnd = () => {
    // Fine del racconto: si resta sull'ultimo istante, in REPLAY, con la camera libera.
    if (playback.mode === 'story') setMode('replay');
  };

  /** Segui l'occhio: la camera vola sull'occhio e poi resta centrata. */
  const toggleFollow = () => {
    if (playback.mode !== 'explore') setMode('explore');
    const on = !following;
    if (on) {
      const p = stormPosition(playback.time);
      rig.flyTo({ lat: p.lat, lon: p.lon }, 900);
    }
    setFollowing(on);
    engine.invalidate();
  };

  // CITY FLIGHT: il globo si ferma mentre si vola (nessun frame, nessun avanzamento) e riprende al ritorno.
  const cityFlight = createCityFlightEntry({
    onEnter: () => engine.pause(),
    onLeave: () => engine.resume(),
    routeHash: () => formatRoute({ mode: playback.mode, eventId: manifest.id }),
  });

  const flyToView = (state: CameraState) => {
    rig.flyTo(state, VIEW_FLIGHT_MS);
    engine.invalidate();
  };

  const hud = createHud(
    app,
    {
      onZoomIn: () => rig.zoomBy(0.75),
      onZoomOut: () => rig.zoomBy(1.33),
      onReset: () => {
        setFollowing(false);
        rig.flyTo(home(), 1600);
      },
      onToggleView: () => {
        setFollowing(false);
        if (rig.isGlobe) rig.flyTo(home(), 2400);
        else rig.flyTo({ ...manifest.globe, lat: home().lat, lon: home().lon }, 2400);
        hud.setView(rig.isGlobe);
      },
      onThemeCycle: () => theme.cycle(),
      onLayer: (layer, visible) => {
        if (layer === 'clouds') {
          scene.setCloudsVisible(visible);
          volumeView.setCloudsVisible(visible);
        } else if (layer === 'track') {
          trackLayer.setVisible(visible);
          volumeView.setOverlayVisible(visible);
        } else labels.setVisible(visible);
        engine.invalidate();
      },
      onMode: setMode,
      onPlayPause: () => {
        if (!playback.playing && playback.time >= playback.range.end) playback.seek(playback.range.start);
        playback.playing = !playback.playing;
        engine.invalidate();
      },
      onSeek: (u) => {
        // Spostarsi nel tempo durante il racconto è un gesto da REPLAY: la regia si ferma.
        if (playback.mode === 'story') setMode('replay');
        playback.seekProgress(u);
        engine.invalidate();
      },
      onSpeed: (v) => {
        playback.replaySpeed = v;
        engine.invalidate();
      },
      onResumeDirector: () => setMode('story'),
      onExplore: () => setMode('explore'),
      onViewpoint: (id) => {
        if (playback.mode !== 'explore') setMode('explore');
        // Si mira dove sarà l'occhio alla fine del volo, così seguirlo non dà scatti.
        const ahead = playback.playing ? (VIEW_FLIGHT_MS / 1000) * playback.minutesPerSecond * 60_000 : 0;
        const at = Math.min(playback.range.end, playback.time + ahead);
        flyToView(viewpoint(id, stormPosition(at), rig.state, manifest.satellite.lon));
        setFollowing(true);
        hud.setViewpoint(id);
      },
      onFollow: () => toggleFollow(),
      onExaggeration: (value) => {
        exploreExaggeration = value;
        applyRelief(playback.mode);
        engine.invalidate();
      },
      onNorth: () => {
        rig.flyTo({ heading: 0 }, 900);
        engine.invalidate();
      },
      onCityFlight: () => cityFlight.enter(),
      onRender: (view) => {
        if (view === 'volume' && !volumeAvailable) return;
        const changed = view !== renderView;
        renderView = view;
        // Istante, camera e rilievo restano quelli correnti: cambia solo la rappresentazione.
        applyRender(playback.mode);
        syncScene(performance.now());
        if (changed) hud.announceRender(view);
        engine.invalidate();
      },
    },
    {
      ...manifest,
      time: new Date(playback.time),
      exaggeration: manifest.cloudExaggeration,
      satellite: manifest.satellite.name,
      resolutionKm: dataPixelKm,
      volumeAvailable,
    },
    track,
    { start: new Date(times[0]!), end: new Date(times.at(-1)!), observations: times.map((ms) => new Date(ms)) },
  );
  hud.setView(rig.isGlobe);
  hud.setExaggeration(manifest.cloudExaggeration);
  // Titolo d'apertura: i primi secondi del racconto (o del primo avvio), fino al primo gesto.
  const INTRO_SECONDS = 4.2;
  const openedAt = performance.now();
  let introDismissed = false;
  const introVisible = (now: number) => {
    if (introDismissed) return false;
    if (playback.mode === 'story') return playback.storyProgress * manifest.story.seconds < INTRO_SECONDS;
    // Con «riduci movimento» l'app si apre in REPLAY: il titolo compare comunque, per qualche secondo.
    return reducedMotion && !CAPTURE && now - openedAt < INTRO_SECONDS * 1000;
  };
  rig.onUserInput = () => {
    introDismissed = true;
    hud.hideHint();
    // Dopo un gesto la vista non è più l'inquadratura scelta.
    hud.setViewpoint(null);
    if (directing) {
      directing = false;
      resume = null;
    }
  };
  // Spostare a mano il punto osservato interrompe l'inseguimento dell'occhio.
  rig.onPan = () => {
    if (following) setFollowing(false);
  };

  // Tastiera (EXPLORE e REPLAY): frecce per ruotare e inclinare, + e − per lo zoom, F per seguire.
  window.addEventListener('keydown', (e) => {
    if (cityFlight.active || playback.mode === 'story' || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.isContentEditable)) return;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => rig.orbitBy(-8, 0),
      ArrowRight: () => rig.orbitBy(8, 0),
      ArrowUp: () => rig.orbitBy(0, 5),
      ArrowDown: () => rig.orbitBy(0, -5),
      '+': () => rig.zoomBy(0.8),
      '=': () => rig.zoomBy(0.8),
      '-': () => rig.zoomBy(1.25),
      f: () => toggleFollow(),
      F: () => toggleFollow(),
    };
    const action = keys[e.key];
    if (!action) return;
    e.preventDefault();
    action();
    hud.hideHint();
    engine.invalidate();
  });

  // La scena spaziale resta scura in entrambi i temi; il tema riguarda l'interfaccia.
  const theme = createThemeController((_, preference) => hud.setTheme(preference));

  const captions = manifest.story.captions.map((c) => ({ ...c, from: Date.parse(c.from) }));
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
    // Nel racconto la miscela B-spline uniforma la nitidezza; in pausa in REPLAY ed EXPLORE
    // le osservazioni compaiono pure.
    const smoothing = playback.mode !== 'story' && !playback.playing ? 0 : 1;
    if (!sequence.setTime(playback.time, smoothing)) return false;
    scene.setSun(time);
    volumeView.update(playback.time, smoothing);
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
    } else if (following && !rig.isFlying) {
      const p = stormPosition(playback.time);
      rig.setCenter(p.lat, p.lon);
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
      hud.setHeading(rig.state.heading);
      hud.setDetailLimit(playback.mode === 'explore' && magnification() > MAX_MAGNIFICATION);
      return advanced || moved || playback.playing || resume !== null || volumeView.wantsFrame;
    });
  }
  // Il volume si compone sopra la scena appena disegnata, prima delle etichette HTML.
  engine.onAfterRender(() => volumeView.render());
  engine.onAfterRender(() =>
    labels.update(engine.camera, canvas.clientWidth, canvas.clientHeight, rig.state.distance, hud.obstacles()),
  );
  // Indirizzo iniziale: #/explore/<evento> apre direttamente l'esplorazione.
  if (route.mode !== 'story' && !reducedMotion) setMode(route.mode, false);
  syncScene(performance.now());
  trackLayer.update(engine.camera, rig.state.distance);

  if (CAPTURE) {
    // Comandi per la registrazione locale (scripts in scratchpad): istante e modalità fissati da fuori.
    playback.playing = false;
    Object.assign(window, {
      __atmosphera: {
        storySeconds: manifest.story.seconds,
        range: playback.range,
        /** STORY al secondo s del racconto, con regia. */
        async story(s: number) {
          playback.mode = 'story';
          directing = true;
          resume = null;
          const r = playback.storyRange;
          playback.seek(r.start + ((r.end - r.start) * s) / manifest.story.seconds);
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
  // Collegamento diretto al simulatore (#/city-flight): si apre dopo il globo, che resta in pausa sotto.
  if (location.hash === CITY_FLIGHT_HASH) cityFlight.openFromAddress();

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
