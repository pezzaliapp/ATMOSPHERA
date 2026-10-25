import { Color, MeshStandardMaterial, type Texture } from 'three';

/**
 * Materiale delle facciate (FLIGHT 2.0, originale): materiale fisico di three.js con finestre
 * calcolate nello shader in coordinate del mondo. Nessuna texture: ogni finestra è diversa.
 *
 * Attributo per edificio `aBuilding` (vec4):
 *   x seme (0–1), y frazione di finestre accese, z stile (0 uffici in vetro, 1 residenziale, 2 cemento),
 *   w quota del piano terra (negozi sotto questa quota).
 * Lontano, quando le finestre sono più piccole di un pixel, si usa la loro luminosità media.
 */

const common = /* glsl */ `
  varying vec3 vWPos;
  varying vec3 vWNormal;
  varying vec4 vBuilding;
`;

const vertexHead = /* glsl */ `
  attribute vec4 aBuilding;
  ${common}
`;

const vertexBody = /* glsl */ `
  #include <begin_vertex>
  {
    vec4 wp = vec4(transformed, 1.0);
    vec3 wn = objectNormal;
    #ifdef USE_INSTANCING
      wp = instanceMatrix * wp;
      wn = mat3(instanceMatrix) * wn;
    #endif
    vWPos = (modelMatrix * wp).xyz;
    vWNormal = normalize(mat3(modelMatrix) * wn);
    vBuilding = aBuilding;
  }
`;

const fragmentHead = /* glsl */ `
  ${common}
  uniform float uTime;
  uniform float uWindowGain;
  vec3 gWinLight;
  float gGlass;

  float fhash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  /** Colore della luce interna: calda (la maggioranza), neutra, fredda, qualche tinta. */
  vec3 roomColor(float h) {
    if (h < 0.42) return vec3(1.0, 0.7, 0.4);
    if (h < 0.64) return vec3(1.0, 0.86, 0.66);
    if (h < 0.8) return vec3(0.75, 0.86, 1.0);
    if (h < 0.88) return vec3(0.5, 0.66, 1.0);
    if (h < 0.93) return vec3(0.45, 0.95, 0.85);
    if (h < 0.97) return vec3(1.0, 0.42, 0.62);
    return vec3(0.65, 1.0, 0.5);
  }

  void computeWindows() {
    gWinLight = vec3(0.0);
    gGlass = 0.0;
    vec3 n = normalize(vWNormal);
    if (abs(n.y) > 0.5) return; // tetti
    float seed = vBuilding.x;
    float litFrac = vBuilding.y;
    float style = vBuilding.z;
    float groundH = vBuilding.w;
    bool sideX = abs(n.x) > abs(n.z);
    vec2 fc = sideX ? vec2(vWPos.z * sign(n.x), vWPos.y) : vec2(-vWPos.x * sign(n.z), vWPos.y);
    float faceId = sideX ? (n.x > 0.0 ? 1.0 : 2.0) : (n.z > 0.0 ? 3.0 : 4.0);

    float yRel = vWPos.y - groundH;
    if (yRel < 0.0) {
      // Piano terra: vetrine grandi, quasi tutte accese, luce calda.
      float bayG = 6.0;
      vec2 g = vec2(fc.x / bayG, (vWPos.y - 0.4) / max(groundH - 0.9, 1.0));
      vec2 f = fract(g);
      float win = smoothstep(0.03, 0.06, f.x) * (1.0 - smoothstep(0.94, 0.97, f.x)) * smoothstep(0.0, 0.05, g.y) * (1.0 - smoothstep(0.78, 0.84, g.y));
      float h = fhash12(floor(g) + seed * 91.0 + faceId * 7.0);
      float lit = step(h, 0.78);
      gGlass = win;
      gWinLight = roomColor(fract(h * 7.1)) * win * lit * (1.1 + 0.9 * fract(h * 13.0)) * uWindowGain;
      return;
    }

    float bay = style < 0.5 ? 3.0 : (style < 1.5 ? 3.6 : 4.2);
    float floorH = style < 0.5 ? 3.8 : 3.2;
    vec2 g = vec2(fc.x / bay, yRel / floorH);
    vec2 cell = floor(g);
    vec2 f = fract(g);
    // Proporzioni della finestra: vetrate a nastro negli uffici, finestre singole altrove.
    vec2 lo = style < 0.5 ? vec2(0.04, 0.12) : vec2(0.2, 0.22);
    vec2 hi = style < 0.5 ? vec2(0.96, 0.9) : vec2(0.8, 0.82);
    vec2 aa = fwidth(g) * 1.2;
    vec2 m = smoothstep(lo, lo + aa, f) * (1.0 - smoothstep(hi - aa, hi, f));
    float win = m.x * m.y;
    // Uffici: montante centrale che divide la vetrata in due.
    if (style < 0.5) win *= 1.0 - (1.0 - smoothstep(0.0, aa.x * 1.5, abs(f.x - 0.5) - 0.012));

    // Accensione: per stanza (due campate) e per piano, con piani interi accesi negli uffici.
    float room = floor(cell.x / (style < 0.5 ? 3.0 : 2.0));
    float h = fhash12(vec2(room, cell.y) + seed * 173.0 + faceId * 19.0);
    float floorLit = fhash12(vec2(cell.y, seed * 31.0 + faceId));
    float lit = style < 0.5 ? step(h, litFrac * mix(0.4, 1.5, floorLit)) : step(h, litFrac);
    // Luce interna: più chiara in alto (soffitto), tende abbassate in alcune finestre.
    float blind = step(0.72, fract(h * 37.0)) * (1.0 - smoothstep(0.45, 0.5, f.y));
    float inner = (0.55 + 0.45 * smoothstep(lo.y, hi.y, f.y)) * (1.0 - 0.7 * blind);
    float intensity = (0.6 + 1.6 * fract(h * 11.7)) * inner;
    // Piccole variazioni dentro la finestra (arredi, lampade): non è un rettangolo uniforme.
    float detail = 0.82 + 0.18 * fhash12(floor(f * vec2(4.0, 3.0)) + cell * 3.1 + seed);
    vec3 light = roomColor(fract(h * 5.3)) * intensity * detail;

    // Lontano (finestre sotto il pixel): luminosità media della facciata, niente moiré.
    float far = smoothstep(0.35, 0.9, max(fwidth(g).x, fwidth(g).y));
    float coverage = (hi.x - lo.x) * (hi.y - lo.y);
    vec3 avgLight = vec3(1.0, 0.76, 0.5) * litFrac * 2.3 * coverage * 0.75;
    gWinLight = mix(light * win * lit, avgLight, far) * uWindowGain;
    gGlass = mix(win, coverage, far);
  }
`;

export interface FacadeOptions {
  envMap: Texture;
  color?: Color;
  roughness?: number;
  /** Colore del muro per vertice (geometrie unite); con InstancedMesh si usa setColorAt. */
  vertexColors?: boolean;
}

export function createFacadeMaterial(options: FacadeOptions): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: options.color ?? new Color(0.45, 0.43, 0.44),
    roughness: options.roughness ?? 0.88,
    metalness: 0.0,
    envMap: options.envMap,
    envMapIntensity: 0.35,
    vertexColors: options.vertexColors ?? false,
  });
  const uniforms = { uTime: { value: 0 }, uWindowGain: { value: 0.42 } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${vertexHead}`).replace('#include <begin_vertex>', vertexBody);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentHead}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         computeWindows();
         // Vetro: scuro, con un velo azzurro; il riflesso arriva dalla mappa d'ambiente.
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012, 0.015, 0.022), gGlass);`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.06, gGlass);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n metalnessFactor = mix(metalnessFactor, 0.85, gGlass);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n totalEmissiveRadiance += gWinLight;`);
  };
  material.customProgramCacheKey = () => `facade-v1-${options.vertexColors ? 'vc' : 'ic'}`;
  material.userData.uniforms = uniforms;
  return material;
}
