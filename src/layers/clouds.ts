import { DoubleSide, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3, Vector4, type Texture } from 'three';
import { HAZE_COLOR } from '../globe/earth';
import { aerialPerspective, cloudModel } from '../globe/shading';

/**
 * Nuvole osservate da GOES-16 su una regione, come superficie 3D:
 * - colore e opacità dalle grandezze osservate (albedo visibile + temperatura infrarossa);
 * - quota della sommità ricostruita dalla temperatura, con esagerazione verticale ILLUSTRATIVA;
 * - rilievo e ombreggiatura calcolati per pixel dal Sole all'ora dell'osservazione.
 */

const vertexShader = /* glsl */ `
  uniform sampler2D cloudBT;
  uniform sampler2D cloudAlbedo;
  uniform vec4 bounds;
  uniform float exaggeration;

  varying vec2 vUv;
  varying vec3 vPositionW;
  varying vec3 vUp;

  ${cloudModel}

  const float RAD = 57.29577951308232;

  void main() {
    vUv = uv;
    float lon = mix(bounds.x, bounds.z, uv.x) / RAD;
    float lat = mix(bounds.y, bounds.w, uv.y) / RAD;
    vec3 up = vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
    // Livello di mipmap ≈ passo della griglia: quota filtrata, senza aliasing a "punte".
    float bt = decodeBT(textureLod(cloudBT, uv, 2.0).r);
    float albedo = textureLod(cloudAlbedo, uv, 2.0).r;
    // Le nubi sottili restano basse: il rilievo cresce con l'opacità.
    float solid = smoothstep(0.15, 0.7, cloudOpacity(albedo, bt, 1.0));
    // Base minima di 1 km sopra la superficie: evita intersezioni con la Terra.
    float r = 1.0 + (1.0 + cloudTopKm(bt) * exaggeration * solid) / EARTH_RADIUS_KM;
    vec4 world = modelMatrix * vec4(up * r, 1.0);
    vPositionW = world.xyz;
    vUp = up;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D cloudAlbedo;
  uniform sampler2D cloudBT;
  uniform vec4 bounds;
  uniform vec2 texel;
  uniform float exaggeration;
  uniform vec3 sunDirection;
  uniform vec3 hazeColor;
  uniform float opacityScale;

  varying vec2 vUv;
  varying vec3 vPositionW;
  varying vec3 vUp;

  ${aerialPerspective}
  ${cloudModel}

  const float RAD = 57.29577951308232;

  float heightAt(vec2 uv) {
    float bt = decodeBT(textureLod(cloudBT, uv, 1.0).r);
    float solid = smoothstep(0.15, 0.7, cloudOpacity(textureLod(cloudAlbedo, uv, 1.0).r, bt, 1.0));
    return cloudTopKm(bt) * exaggeration * solid;
  }

  void main() {
    float albedo = texture2D(cloudAlbedo, vUv).r;
    float bt = decodeBT(texture2D(cloudBT, vUv).r);
    float opacity = cloudOpacity(albedo, bt, 1.0) * regionMask(vUv) * opacityScale;
    if (opacity < 0.015) discard;

    vec3 n = normalize(vUp);
    vec3 east = normalize(vec3(n.z, 0.0, -n.x));
    vec3 north = cross(n, east);

    // Rilievo dalla quota ricostruita (differenze finite, in km per km).
    float latRad = mix(bounds.y, bounds.w, vUv.y) / RAD;
    float kmX = texel.x * (bounds.z - bounds.x) / RAD * EARTH_RADIUS_KM * cos(latRad);
    float kmY = texel.y * (bounds.w - bounds.y) / RAD * EARTH_RADIUS_KM;
    vec2 step = texel * 2.0;
    float dhx = (heightAt(vUv + vec2(step.x, 0.0)) - heightAt(vUv - vec2(step.x, 0.0))) / (4.0 * kmX);
    float dhy = (heightAt(vUv + vec2(0.0, step.y)) - heightAt(vUv - vec2(0.0, step.y))) / (4.0 * kmY);
    // Rilievo attenuato: dà volume senza l'effetto "montagna innevata".
    vec3 normal = normalize(n - (east * dhx + north * dhy) * 0.6);

    vec3 l = normalize(sunDirection);
    vec3 v = normalize(cameraPosition - vPositionW);
    float lambert = max(dot(normal, l), 0.0);
    float sunUp = smoothstep(-0.1, 0.15, dot(n, l));

    // Le nubi spesse sono quasi bianche; quelle sottili lasciano trasparire un grigio più freddo.
    float bright = mix(0.62, 1.0, smoothstep(0.2, 0.85, albedo));
    vec3 base = vec3(bright) * mix(vec3(0.86, 0.9, 1.0), vec3(1.0), opacity);
    vec3 ambient = vec3(0.30, 0.36, 0.48);
    vec3 color = base * (ambient * (0.35 + 0.65 * sunUp) + vec3(1.0, 0.97, 0.92) * lambert * 1.05 * sunUp);
    // Bordo argenteo controluce (ILLUSTRATIVO).
    float rim = pow(1.0 - max(dot(normal, v), 0.0), 4.0) * max(dot(-v, l), 0.0);
    color += vec3(1.0) * rim * 0.25 * sunUp;

    color = applyHaze(color, n, v, l, hazeColor);
    gl_FragColor = vec4(color, opacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface CloudLayerOptions {
  albedo: Texture;
  bt: Texture;
  bounds: [number, number, number, number];
  /** Dimensioni delle texture, in pixel. */
  size: [number, number];
  exaggeration: number;
  segments: [number, number];
}

export function createCloudLayer(options: CloudLayerOptions) {
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      cloudAlbedo: { value: options.albedo },
      cloudBT: { value: options.bt },
      bounds: { value: new Vector4(...options.bounds) },
      texel: { value: new Vector2(1 / options.size[0], 1 / options.size[1]) },
      exaggeration: { value: options.exaggeration },
      sunDirection: { value: new Vector3(1, 0, 0) },
      hazeColor: { value: HAZE_COLOR },
      opacityScale: { value: 1 },
    },
    transparent: true,
    // Scrive la profondità: le torri più alte nascondono correttamente ciò che sta dietro.
    depthWrite: true,
    side: DoubleSide,
  });
  // Griglia piana usata solo per le UV: la posizione sulla sfera è calcolata nello shader.
  const geometry = new PlaneGeometry(1, 1, options.segments[0], options.segments[1]);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'clouds';
  mesh.renderOrder = 1;
  // La griglia è deformata nello shader: il frustum culling sui vertici originali sarebbe errato.
  mesh.frustumCulled = false;

  return {
    mesh,
    setSunDirection(direction: Vector3) {
      (material.uniforms.sunDirection!.value as Vector3).copy(direction);
    },
    setVisible(visible: boolean) {
      mesh.visible = visible;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
