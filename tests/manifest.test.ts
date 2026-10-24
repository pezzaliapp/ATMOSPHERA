import { describe, expect, it } from 'vitest';
import catalogJson from '../public/data/events/index.json';
import miltonJson from '../public/data/events/milton-2024/event.json';
import { eventFolder, parseCatalog, parseEventManifest } from '../src/events/manifest';

describe('manifest degli eventi', () => {
  it('il manifest di Milton è valido e conserva la STORY approvata', () => {
    const m = parseEventManifest(miltonJson);
    expect(m.id).toBe('milton-2024');
    expect(m.story.seconds).toBe(24);
    expect(m.story.start).toBe('2024-10-07T12:50:00Z');
    expect(m.story.camera).toHaveLength(7);
    expect(m.story.captions.map((c) => c.title)).toEqual(['Alba sul Golfo del Messico', 'Intensificazione esplosiva', 'Categoria 5', 'Tramonto']);
    expect(m.satellite).toEqual({ name: 'GOES-16', lon: -75.2 });
    expect(m.cloudExaggeration).toBe(2);
  });
  it('il catalogo elenca Milton', () => {
    const c = parseCatalog(catalogJson);
    expect(c.events.map((e) => e.id)).toEqual(['milton-2024']);
    expect(c.events[0]!.manifest).toBe('milton-2024/event.json');
  });
  it('rifiuta manifest incompleti con un errore che indica il campo', () => {
    const broken = structuredClone(miltonJson) as Record<string, unknown>;
    delete broken.satellite;
    expect(() => parseEventManifest(broken)).toThrow(/event\.satellite/);
    const badKeys = structuredClone(miltonJson) as { story: { camera: { at: number }[] } };
    badKeys.story.camera[2]!.at = 0.1;
    expect(() => parseEventManifest(badKeys)).toThrow(/camera\[2\]\.at/);
    expect(() => parseEventManifest({ ...miltonJson, schema: 2 })).toThrow(/schema/);
  });
  it('ricava la cartella dell’evento dal manifest', () => {
    expect(eventFolder('/data/events/milton-2024/event.json')).toBe('/data/events/milton-2024/');
  });
});
