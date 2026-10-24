import { Mesh, ShaderMaterial, SphereGeometry, Vector3, type Texture, type Vector4 } from 'three';
import { HAZE_COLOR } from '../globe/earth';
import { aerialPerspective, cloudModel } from '../globe/shading';

/**
 * Superficie per la vista volumetrica: stessa mappa e stessa illuminazione della
 * Terra attuale, ma l'ombra delle nuvole e la luce del cielo vengono dalla luce al suolo calcolata
 * attraverso le colonne ricostruite (columns.ts), coerente con il volume disegnato sopra.
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
  uniform sampler2D groundLight;
  uniform vec4 regionBounds;
  uniform vec3 sunDirection;
  uniform vec3 hazeColor;
  uniform float nightIntensity;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPositionW;

  ${aerialPerspective}
  ${cloudModel}

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vPositionW);
    vec3 l = normalize(sunDirection);

    vec2 latLon = vec2(vUv.y * 180.0 - 90.0, vUv.x * 360.0 - 180.0);
    vec2 ruv = regionUv(latLon, regionBounds);
    float inRegion = regionMask(ruv);

    vec3 day = texture2D(dayMap, vUv).rgb;
    if (inRegion > 0.0) day = mix(day, texture2D(regionMap, ruv).rgb, inRegion);
    vec3 night = texture2D(nightMap, vUv).rgb;

    float cosSun = dot(n, l);
    float daylight = smoothstep(-0.12, 0.10, cosSun);
    float lambert = max(cosSun, 0.0);

    // Luce al suolo dalle colonne: diretta, diffusa sotto le nubi, cielo visibile.
    vec3 g = inRegion > 0.0 ? texture2D(groundLight, ruv).rgb : vec3(1.0, 0.5, 1.0);
    g = mix(vec3(1.0, 0.5, 1.0), g, inRegion);
    float direct = lambert * g.r;
    float diffuse = lambert * (1.0 - g.r) * g.g * 0.35;
    float skyLight = 0.04 * g.b;

    vec3 color = day * (skyLight + 1.05 * (direct + diffuse)) * daylight;

    float darkness = 1.0 - smoothstep(-0.25, 0.05, cosSun);
    color += night * night * nightIntensity * darkness;

    float ocean = smoothstep(0.015, 0.06, day.b - max(day.r, day.g));
    vec3 h = normalize(l + v);
    float spec = pow(max(dot(n, h), 0.0), 60.0) * ocean * daylight * g.r;
    color += vec3(1.0, 0.95, 0.85) * spec * 0.35;

    float twilight = smoothstep(-0.12, 0.0, cosSun) * (1.0 - smoothstep(0.0, 0.12, cosSun));
    color += vec3(0.30, 0.12, 0.04) * twilight * 0.05;

    color = applyHaze(color, n, v, l, hazeColor);
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface EarthVolumeOptions {
  dayMap: Texture;
  nightMap: Texture;
  surface: Texture;
  groundLight: Texture;
  bounds: Vector4;
  segments: number;
}

export function createEarthVolume({ dayMap, nightMap, surface, groundLight, bounds, segments }: EarthVolumeOptions) {
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      dayMap: { value: dayMap },
      nightMap: { value: nightMap },
      regionMap: { value: surface },
      groundLight: { value: groundLight },
      regionBounds: { value: bounds },
      sunDirection: { value: new Vector3(1, 0, 0) },
      hazeColor: { value: HAZE_COLOR },
      nightIntensity: { value: 1.6 },
    },
  });
  const geometry = new SphereGeometry(1, segments, segments / 2);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'earth-volume';
  return {
    mesh,
    setSunDirection(direction: Vector3) {
      (material.uniforms.sunDirection!.value as Vector3).copy(direction);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
