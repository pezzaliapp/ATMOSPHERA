import { describe, expect, it } from 'vitest';
import { chooseQuality, type DeviceInfo } from '../src/core/quality';

const desktop: DeviceInfo = { devicePixelRatio: 2, coarsePointer: false, shortSide: 1000, maxTextureSize: 16384 };
const iphone: DeviceInfo = { devicePixelRatio: 3, coarsePointer: true, shortSide: 393, maxTextureSize: 16384 };

describe('chooseQuality', () => {
  it('desktop: texture 4k, niente MSAA su schermo Retina', () => {
    const q = chooseQuality(desktop);
    expect(q.name).toBe('desktop');
    expect(q.textureSize).toBe('4k');
    expect(q.antialias).toBe(false);
  });

  it('smartphone: texture 2k e pixel ratio limitato a 2', () => {
    const q = chooseQuality(iphone);
    expect(q.name).toBe('mobile');
    expect(q.textureSize).toBe('2k');
    expect(q.pixelRatio).toBe(2);
    expect(q.cloudSegments[0] * q.cloudSegments[1]).toBeLessThan(chooseQuality(desktop).cloudSegments[0] * chooseQuality(desktop).cloudSegments[1]);
  });

  it('GPU con texture massime sotto 4096 o poca memoria: 2k', () => {
    expect(chooseQuality({ ...desktop, maxTextureSize: 2048 }).textureSize).toBe('2k');
    expect(chooseQuality({ ...desktop, deviceMemory: 2 }).textureSize).toBe('2k');
  });

  it('schermo a densità standard: MSAA attivo', () => {
    expect(chooseQuality({ ...desktop, devicePixelRatio: 1 }).antialias).toBe(true);
  });
});
