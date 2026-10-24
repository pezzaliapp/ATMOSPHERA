import { Vector3 } from 'three';
import { subsolarPoint } from '../core/astro';
import type { Engine } from '../core/engine';
import { latLonToVector } from '../core/geo';
import { createAtmosphere } from '../globe/atmosphere';
import { createEarth } from '../globe/earth';
import { createStars } from '../globe/stars';
import type { CloudSequence } from '../layers/cloud-sequence';
import { createCloudLayer } from '../layers/clouds';
import { createTrackLayer } from '../layers/track';
import type { LoadedEvent } from './load-event';

/**
 * Scena 3D di un evento: Terra, nuvole osservate della regione, atmosfera, stelle, traccia.
 * Non sa nulla delle modalità né dell'interfaccia: riceve l'istante e lo rappresenta.
 */
export function createEventScene(engine: Engine, event: LoadedEvent, sequence: CloudSequence, startTime: number) {
  const { manifest, index } = event;
  const b = index.bounds;
  const bounds: [number, number, number, number] = [b.west, b.south, b.east, b.north];
  const q = engine.quality;
  const exaggeration = manifest.cloudExaggeration;

  const earth = createEarth({
    dayMap: event.dayMap,
    nightMap: event.nightMap,
    segments: q.sphereSegments,
    region: { surface: event.surface, clouds: sequence, bounds, exaggeration },
  });
  const clouds = createCloudLayer({ sequence, exaggeration, segments: q.cloudSegments });
  const atmosphere = createAtmosphere(q.sphereSegments / 2);
  const stars = createStars();
  const track = createTrackLayer(event.track, new Date(startTime), q.pixelRatio);
  engine.scene.add(stars.points, earth.mesh, clouds.mesh, atmosphere.mesh, track.group);

  const sun = new Vector3();
  return {
    sequence,
    earth,
    clouds,
    track,
    /** Direzione del Sole all'istante rappresentato. */
    setSun(time: Date) {
      const s = subsolarPoint(time);
      sun.set(...latLonToVector(s.lat, s.lon));
      earth.setSunDirection(sun);
      clouds.setSunDirection(sun);
      atmosphere.setSunDirection(sun);
    },
    /** Esagerazione verticale del rilievo ricostruito (nuvole e lunghezza delle ombre). */
    setExaggeration(value: number) {
      clouds.setExaggeration(value);
      earth.setCloudExaggeration(value);
    },
    setCloudsVisible(visible: boolean) {
      clouds.setVisible(visible);
      earth.setCloudShadows(visible);
    },
  };
}

export type EventScene = ReturnType<typeof createEventScene>;
