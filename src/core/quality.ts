/**
 * Profilo di qualità grafica, scelto in base alle capacità del dispositivo.
 * Funzione pura: i valori del dispositivo vengono letti altrove (vedi detectDevice).
 */

export interface DeviceInfo {
  devicePixelRatio: number;
  coarsePointer: boolean;
  /** Lato corto della finestra, in pixel CSS. */
  shortSide: number;
  maxTextureSize: number;
  /** navigator.deviceMemory in GB, se disponibile (solo Chromium). */
  deviceMemory?: number | undefined;
}

export interface QualityProfile {
  name: 'mobile' | 'desktop';
  textureSize: '2k' | '4k';
  pixelRatio: number;
  antialias: boolean;
  sphereSegments: number;
  /** Suddivisioni della griglia 3D delle nuvole (colonne, righe). */
  cloudSegments: [number, number];
  anisotropy: number;
}

export function chooseQuality(info: DeviceInfo): QualityProfile {
  const mobile = info.coarsePointer && info.shortSide < 900;
  const lowMemory = info.deviceMemory !== undefined && info.deviceMemory < 4;
  const canUse4k = info.maxTextureSize >= 4096 && !mobile && !lowMemory;

  return {
    name: mobile ? 'mobile' : 'desktop',
    textureSize: canUse4k ? '4k' : '2k',
    // Oltre 2× la differenza non si vede, ma il costo di fill-rate sì (iPhone è a 3×).
    pixelRatio: Math.min(info.devicePixelRatio, 2),
    // Su schermi ad alta densità l'antialiasing MSAA costa molto e serve poco.
    antialias: info.devicePixelRatio < 2,
    sphereSegments: mobile ? 128 : 192,
    cloudSegments: mobile ? [320, 200] : lowMemory ? [384, 240] : [640, 400],
    anisotropy: mobile ? 4 : 8,
  };
}

export function detectDevice(maxTextureSize: number): DeviceInfo {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    devicePixelRatio: window.devicePixelRatio || 1,
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    shortSide: Math.min(window.innerWidth, window.innerHeight),
    maxTextureSize,
    deviceMemory: nav.deviceMemory,
  };
}
