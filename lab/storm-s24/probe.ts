import { NearestFilter, UnsignedByteType, Vector3, WebGLRenderTarget, type RawShaderMaterial, type WebGLRenderer } from 'three';
import type { StormScene } from '../storm-s11/scene';
import { commonGlsl } from '../storm-s11/shaders';

/**
 * Sonda nelle nubi: con le stesse funzioni dello shader delle nubi (S1.1) valuta, nel punto del velivolo e
 * in quello della telecamera, la densità, l'ombra verso il Sole, la visibilità del cielo e la luce diffusa
 * dentro la nube. Così nebbia sul velivolo, luce del modello e turbolenza corrispondono a ciò che si vede.
 * Uscita 3×1 RGBA8, letta in modo asincrono (un paio di frame di ritardo, nessuno stallo della GPU).
 */

const probeFragment = /* glsl */ `
  ${commonGlsl}
  uniform vec3 probeA;
  uniform vec3 probeB;
  in vec2 vUv;
  out vec4 outColor;

  void main() {
    int px = int(gl_FragCoord.x);
    vec3 p = px == 1 ? probeB : probeA;
    Ctx ctx = context(p);
    vec3 dens = densityCtx(p, ctx, 0.01, 2);
    float tauS = sunDepth(p, ctx, 0.01, false);
    float skyVis = exp(-0.16 * upDepth(p));
    if (px < 2) {
      outColor = vec4(clamp(dens.x / 80.0, 0.0, 1.0), clamp(tauS / 40.0, 0.0, 1.0), skyVis, clamp(dens.y, 0.0, 1.0));
      return;
    }
    // Luce diffusa dentro la nube nel punto del velivolo (stessa formula dello shader delle nubi, fase isotropa).
    float ms = 0.0;
    float aa = 1.0, bb = 1.0;
    for (int k = 0; k < 4; k++) { ms += aa * exp(-bb * tauS) / (4.0 * PI); aa *= 0.5; bb *= 0.4; }
    float h = altitudeOf(p);
    vec3 amb = SKY_AMBIENT * (0.035 + 0.5 * skyVis) * mix(0.45, 1.0, smoothstep(0.0, 12.0, h));
    vec3 S = max(SUN_COLOR * ms * 3.0 + amb + SUN_COLOR * 0.045 * dens.y, interiorDiffuse(p, ctx.c) * interiorLight);
    outColor = vec4(clamp(S / 4.0, 0.0, 1.0), 1.0);
  }
`;

export interface ProbeResult {
  /** Estinzione (1/km) al velivolo e alla telecamera. */
  sigmaAircraft: number;
  sigmaCamera: number;
  /** Trasmittanza della luce solare attraverso le nubi, al velivolo. */
  sunT: number;
  skyVis: number;
  /** Luce diffusa nella nube (lineare, come la scena). */
  radiance: [number, number, number];
}

export function createProbe(renderer: WebGLRenderer, storm: StormScene) {
  const { shared, draw, raw } = storm.internals;
  const target = new WebGLRenderTarget(3, 1, { type: UnsignedByteType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter });
  const material: RawShaderMaterial = raw(probeFragment, { ...shared, probeA: { value: new Vector3() }, probeB: { value: new Vector3() } });
  const buffer = new Uint8Array(12);
  let pending = false;
  const result: ProbeResult = { sigmaAircraft: 0, sigmaCamera: 0, sunT: 1, skyVis: 1, radiance: [1, 1, 1] };
  let disposed = false;

  return {
    result,
    /** Da chiamare dopo storm.render() (le uniformi condivise sono aggiornate). */
    run(aircraft: Vector3, camera: Vector3) {
      if (pending || disposed) return;
      (material.uniforms.probeA!.value as Vector3).copy(aircraft);
      (material.uniforms.probeB!.value as Vector3).copy(camera);
      draw(material, target);
      renderer.setRenderTarget(null);
      pending = true;
      renderer
        .readRenderTargetPixelsAsync(target, 0, 0, 3, 1, buffer)
        .then(() => {
          pending = false;
          if (disposed) return;
          result.sigmaAircraft = (buffer[0]! / 255) * 80;
          result.sunT = Math.exp(-(buffer[1]! / 255) * 40);
          result.skyVis = buffer[2]! / 255;
          result.sigmaCamera = (buffer[4]! / 255) * 80;
          result.radiance = [(buffer[8]! / 255) * 4, (buffer[9]! / 255) * 4, (buffer[10]! / 255) * 4];
        })
        .catch(() => (pending = false));
    },
    dispose() {
      disposed = true;
      material.dispose();
      target.dispose();
    },
  };
}
