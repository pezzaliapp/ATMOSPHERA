import { Mesh, ShaderMaterial, SphereGeometry, Vector3, Vector4, type Texture } from 'three';
import { cloudSequenceGlsl, type CloudSequence } from '../layers/cloud-sequence';
import { aerialPerspective, cloudModel } from './shading';

/**
 * Superficie terrestre: mappa diurna illuminata dal Sole, luci notturne sul lato in ombra,
 * riflesso speculare sugli oceani, prospettiva aerea.
 * Opzionale: una texture regionale ad alta risoluzione e le ombre delle nuvole osservate.
 * La Terra resta ferma nella scena: è la direzione del Sole a cambiare con l'ora UTC.
 */

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPositionW;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPositionW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D regionMap;
  uniform vec4 regionBounds;
  uniform float regionEnabled;
  uniform float cloudsEnabled;
  uniform float cloudExaggeration;
  uniform vec3 sunDirection;
  uniform vec3 hazeColor;
  uniform float nightIntensity;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPositionW;

  ${aerialPerspective}
  ${cloudModel}
  ${cloudSequenceGlsl}

  const float RAD = 57.29577951308232;

  /** Opacità della nuvola che proietta ombra su questo punto (ILLUSTRATIVO: due passi di ricerca). */
  float cloudShadow(vec2 latLon, vec3 n, vec3 l) {
    float sinElev = dot(n, l);
    if (sinElev <= 0.05) return 0.0;
    vec3 east = normalize(vec3(n.z, 0.0, -n.x));
    vec3 north = cross(n, east);
    vec2 sunDir = normalize(vec2(dot(l, north), dot(l, east)) + 1e-6);
    float cotElev = sqrt(1.0 - sinElev * sinElev) / sinElev;
    float cosLat = max(cos(latLon.x / RAD), 0.2);
    float kmToDeg = RAD / EARTH_RADIUS_KM;

    float hKm = 8.0 * cloudExaggeration;
    vec2 p = latLon + vec2(sunDir.x, sunDir.y / cosLat) * hKm * cotElev * kmToDeg;
    vec2 uv = regionUv(p, regionBounds);
    vec2 vc = flowAt(flowCur, uv);
    hKm = cloudTopKm(decodeBT(sampleSequenceLod(uv, vc, 2.0).y)) * cloudExaggeration;
    p = latLon + vec2(sunDir.x, sunDir.y / cosLat) * hKm * cotElev * kmToDeg;
    uv = regionUv(p, regionBounds);
    vec2 s = sampleSequenceLod(uv, vc, 0.0);
    float op = cloudOpacity(s.x, decodeBT(s.y), smoothstep(0.02, 0.22, sinElev));
    return op * regionMask(uv);
  }

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vPositionW);
    vec3 l = normalize(sunDirection);

    vec2 latLon = vec2(vUv.y * 180.0 - 90.0, vUv.x * 360.0 - 180.0);
    vec2 ruv = regionUv(latLon, regionBounds);
    float inRegion = regionEnabled * regionMask(ruv);

    vec3 day = texture2D(dayMap, vUv).rgb;
    if (inRegion > 0.0) day = mix(day, texture2D(regionMap, ruv).rgb, inRegion);
    vec3 night = texture2D(nightMap, vUv).rgb;

    float cosSun = dot(n, l);
    // Transizione morbida: crepuscolo civile/nautico (circa 6–12° sotto l'orizzonte).
    float daylight = smoothstep(-0.12, 0.10, cosSun);
    float lambert = max(cosSun, 0.0);

    float shadow = cloudsEnabled * inRegion > 0.0 ? cloudShadow(latLon, n, l) * inRegion : 0.0;
    float direct = lambert * (1.0 - 0.6 * shadow);

    vec3 color = day * (0.04 + 1.05 * direct) * daylight;

    // Luci delle città: visibili solo dove è notte.
    float darkness = 1.0 - smoothstep(-0.25, 0.05, cosSun);
    color += night * night * nightIntensity * darkness;

    // Maschera oceani dedotta dal colore (nella Blue Marble il mare è blu scuro).
    float ocean = smoothstep(0.015, 0.06, day.b - max(day.r, day.g));
    vec3 h = normalize(l + v);
    float spec = pow(max(dot(n, h), 0.0), 60.0) * ocean * daylight * (1.0 - shadow);
    color += vec3(1.0, 0.95, 0.85) * spec * 0.35;

    // Tinta calda vicino al terminatore.
    float twilight = smoothstep(-0.12, 0.0, cosSun) * (1.0 - smoothstep(0.0, 0.12, cosSun));
    color += vec3(0.30, 0.12, 0.04) * twilight * 0.05;

    color = applyHaze(color, n, v, l, hazeColor);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface RegionOverlay {
  surface: Texture;
  clouds: CloudSequence;
  /** [ovest, sud, est, nord] in gradi. */
  bounds: [number, number, number, number];
  exaggeration: number;
}

export interface EarthOptions {
  dayMap: Texture;
  nightMap: Texture;
  segments: number;
  region?: RegionOverlay | undefined;
}

export const HAZE_COLOR = new Vector3(0.38, 0.6, 1.0);

export function createEarth({ dayMap, nightMap, segments, region }: EarthOptions) {
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      dayMap: { value: dayMap },
      nightMap: { value: nightMap },
      ...(region?.clouds.uniforms ?? {}),
      regionMap: { value: region?.surface ?? dayMap },
      regionBounds: { value: new Vector4(...(region?.bounds ?? [0, 0, 1, 1])) },
      regionEnabled: { value: region ? 1 : 0 },
      cloudsEnabled: { value: region ? 1 : 0 },
      cloudExaggeration: { value: region?.exaggeration ?? 1 },
      sunDirection: { value: new Vector3(1, 0, 0) },
      hazeColor: { value: HAZE_COLOR },
      nightIntensity: { value: 1.6 },
    },
  });
  const geometry = new SphereGeometry(1, segments, segments / 2);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'earth';

  return {
    mesh,
    setSunDirection(direction: Vector3) {
      (material.uniforms.sunDirection!.value as Vector3).copy(direction);
    },
    setCloudShadows(enabled: boolean) {
      material.uniforms.cloudsEnabled!.value = enabled && region ? 1 : 0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
