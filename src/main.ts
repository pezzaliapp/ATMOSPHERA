import './styles.css';
import { NoColorSpace, SRGBColorSpace, Vector3 } from 'three';
import { subsolarPoint } from './core/astro';
import { CameraRig } from './core/camera-rig';
import { Engine } from './core/engine';
import { latLonToVector } from './core/geo';
import { stormAt, type StormTrack } from './data/storm';
import { MILTON_2024 as EVENT } from './events/milton-2024';
import { createAtmosphere } from './globe/atmosphere';
import { createEarth } from './globe/earth';
import { createStars } from './globe/stars';
import { createCloudLayer } from './layers/clouds';
import { createLabelLayer } from './layers/labels';
import { createTrackLayer } from './layers/track';
import { registerServiceWorker } from './pwa/register';
import { createHud, showFatalError } from './ui/hud';
import { t } from './ui/i18n';
import { createThemeController } from './ui/theme';

const app = document.getElementById('app')!;
const canvas = document.getElementById('globe') as HTMLCanvasElement;
const loader = document.getElementById('loader')!;
const loaderBar = loader.querySelector<HTMLElement>('.loader__bar span')!;

interface CloudMeta {
  bounds: { west: number; south: number; east: number; north: number };
  size: [number, number];
  observed: string;
}

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
  const size = engine.quality.textureSize;

  let track: StormTrack;
  let meta: CloudMeta;
  let textures;
  try {
    [track, meta] = await Promise.all([
      fetchJson<StormTrack>(`${data}track.json`),
      fetchJson<CloudMeta>(`${data}clouds-meta.json`),
    ]);
    textures = await engine.loadTextures(
      [
        { url: `${base}textures/earth-day-${size}.jpg`, colorSpace: SRGBColorSpace },
        { url: `${base}textures/earth-night-${size}.jpg`, colorSpace: SRGBColorSpace },
        { url: `${data}surface.jpg`, colorSpace: SRGBColorSpace },
        // Dati, non colori: nessuna conversione di spazio colore.
        { url: `${data}clouds-albedo.jpg`, colorSpace: NoColorSpace },
        { url: `${data}clouds-bt.jpg`, colorSpace: NoColorSpace },
      ],
      (f) => loaderBar.style.setProperty('--progress', String(f)),
    );
  } catch {
    hideLoader();
    showFatalError(app, t.errorTextures);
    return;
  }
  const [dayMap, nightMap, surface, cloudAlbedo, cloudBT] = textures as [
    (typeof textures)[0],
    (typeof textures)[0],
    (typeof textures)[0],
    (typeof textures)[0],
    (typeof textures)[0],
  ];

  const bounds: [number, number, number, number] = [meta.bounds.west, meta.bounds.south, meta.bounds.east, meta.bounds.north];
  const q = engine.quality;

  // Scena
  const earth = createEarth({
    dayMap,
    nightMap,
    segments: q.sphereSegments,
    region: { surface, cloudAlbedo, cloudBT, bounds, exaggeration: EVENT.cloudExaggeration },
  });
  const clouds = createCloudLayer({
    albedo: cloudAlbedo,
    bt: cloudBT,
    bounds,
    size: meta.size,
    exaggeration: EVENT.cloudExaggeration,
    segments: q.cloudSegments,
  });
  const atmosphere = createAtmosphere(q.sphereSegments / 2);
  const stars = createStars();
  const trackLayer = createTrackLayer(track, EVENT.time, q.pixelRatio);
  engine.scene.add(stars.points, earth.mesh, clouds.mesh, atmosphere.mesh, trackLayer.group);

  // Sole all'ora storica dell'evento.
  const sub = subsolarPoint(EVENT.time);
  const sun = new Vector3(...latLonToVector(sub.lat, sub.lon));
  earth.setSunDirection(sun);
  clouds.setSunDirection(sun);
  atmosphere.setSunDirection(sun);

  // Camera: inquadratura diversa per schermi verticali.
  const home = () => (canvas.clientWidth < canvas.clientHeight ? EVENT.cameraPortrait : EVENT.camera);
  const rig = new CameraRig(engine.camera, canvas, home());
  const storm = stormAt(track, EVENT.time);
  const labels = createLabelLayer(app, [
    ...EVENT.labels,
    ...(storm ? [{ text: track.name, lat: storm.lat, lon: storm.lon, kind: 'storm' as const }] : []),
  ]);

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
    },
    { ...EVENT, exaggeration: EVENT.cloudExaggeration },
    track,
  );
  if (storm) hud.setStorm(storm);
  hud.setView(rig.isGlobe);
  rig.onUserInput = () => hud.hideHint();

  // La scena spaziale resta scura in entrambi i temi; il tema riguarda l'interfaccia.
  const theme = createThemeController((_, preference) => hud.setTheme(preference));

  let wasGlobe = rig.isGlobe;
  engine.onFrame((dt) => {
    const moved = rig.update(dt);
    if (moved) trackLayer.update(engine.camera, rig.state.distance);
    if (rig.isGlobe !== wasGlobe) {
      wasGlobe = rig.isGlobe;
      hud.setView(wasGlobe);
    }
    return moved;
  });
  engine.onAfterRender(() => labels.update(engine.camera, canvas.clientWidth, canvas.clientHeight, rig.state.distance));
  trackLayer.update(engine.camera, rig.state.distance);

  engine.start();
  hideLoader();

  registerServiceWorker({
    onNeedRefresh: (update) => hud.showToast(t.updateAvailable, { label: t.update, run: update }),
    onOfflineReady: () => hud.showToast(t.offlineReady),
  });
}

void start();
