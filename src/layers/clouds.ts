import { DoubleSide, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3, Vector4 } from 'three';
import { HAZE_COLOR } from '../globe/earth';
import { aerialPerspective, cloudModel } from '../globe/shading';
import { cloudSequenceGlsl, type CloudSequence } from './cloud-sequence';

/**
 * Nuvole osservate da GOES-16 su una regione, come superficie 3D animata:
 * - colore e opacità dalle grandezze osservate (albedo visibile + temperatura infrarossa),
 *   con il visibile di giorno e l'infrarosso dove il Sole è basso o assente;
 * - quota della sommità ricostruita dalla temperatura, con esagerazione verticale ILLUSTRATIVA;
 * - tra due osservazioni, fotogrammi intermedi ILLUSTRATIVI spostati lungo il moto stimato;
 * - rilievo e ombreggiatura calcolati per pixel dal Sole all'istante rappresentato.
 */

const vertexShader = /* glsl */ `
  uniform vec4 bounds;
  uniform float exaggeration;
  uniform vec3 sunDirection;

  varying vec2 vUv;
  varying vec3 vPositionW;
  varying vec3 vUp;

  ${cloudModel}
  ${cloudSequenceGlsl}

  const float RAD = 57.29577951308232;

  void main() {
    vUv = uv;
    float lon = mix(bounds.x, bounds.z, uv.x) / RAD;
    float lat = mix(bounds.y, bounds.w, uv.y) / RAD;
    vec3 up = vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
    float day = smoothstep(0.02, 0.22, dot(up, normalize(sunDirection)));
    // Livello di mipmap ≈ passo della griglia: quota filtrata, senza aliasing a "punte".
    vec2 s = sampleSequenceLod(uv, flowAt(flowCur, uv), 2.0);
    float bt = decodeBT(s.y);
    // Le nubi sottili restano basse: il rilievo cresce con l'opacità.
    float solid = smoothstep(0.15, 0.7, cloudOpacity(s.x, bt, day));
    // Base minima di 1 km sopra la superficie: evita intersezioni con la Terra.
    float r = 1.0 + (1.0 + cloudTopKm(bt) * exaggeration * solid) / EARTH_RADIUS_KM;
    vec4 world = modelMatrix * vec4(up * r, 1.0);
    vPositionW = world.xyz;
    vUp = up;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
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
  ${cloudSequenceGlsl}

  const float RAD = 57.29577951308232;

  float heightAt(vec2 uv, vec2 vc, float day) {
    vec2 s = sampleSequenceLod(uv, vc, 1.0);
    float bt = decodeBT(s.y);
    float solid = smoothstep(0.15, 0.7, cloudOpacity(s.x, bt, day));
    return cloudTopKm(bt) * exaggeration * solid;
  }

  void main() {
    vec3 n = normalize(vUp);
    vec3 l = normalize(sunDirection);
    float sunCos = dot(n, l);
    // Visibile dove il Sole è abbastanza alto, infrarosso vicino al terminatore e di notte.
    float day = smoothstep(0.02, 0.22, sunCos);

    vec2 s = sampleSequence(vUv);
    float albedo = s.x;
    float bt = decodeBT(s.y);
    float opacity = cloudOpacity(albedo, bt, day) * regionMask(vUv) * opacityScale;
    if (opacity < 0.015) discard;

    vec3 east = normalize(vec3(n.z, 0.0, -n.x));
    vec3 north = cross(n, east);

    // Rilievo dalla quota ricostruita (differenze finite, in km per km).
    float latRad = mix(bounds.y, bounds.w, vUv.y) / RAD;
    float kmX = texel.x * (bounds.z - bounds.x) / RAD * EARTH_RADIUS_KM * cos(latRad);
    float kmY = texel.y * (bounds.w - bounds.y) / RAD * EARTH_RADIUS_KM;
    vec2 step = texel * 2.0;
    vec2 vc = flowAt(flowCur, vUv);
    float dhx = (heightAt(vUv + vec2(step.x, 0.0), vc, day) - heightAt(vUv - vec2(step.x, 0.0), vc, day)) / (4.0 * kmX);
    float dhy = (heightAt(vUv + vec2(0.0, step.y), vc, day) - heightAt(vUv - vec2(0.0, step.y), vc, day)) / (4.0 * kmY);
    // Rilievo attenuato: dà volume senza l'effetto "montagna innevata".
    vec3 normal = normalize(n - (east * dhx + north * dhy) * 0.6);

    vec3 v = normalize(cameraPosition - vPositionW);
    float lambert = max(dot(normal, l), 0.0);
    float sunUp = smoothstep(-0.1, 0.15, sunCos);
    // Luce più calda con il Sole basso (alba e tramonto).
    vec3 sunColor = mix(vec3(1.0, 0.72, 0.5), vec3(1.0, 0.97, 0.92), smoothstep(0.05, 0.35, sunCos));

    // Le nubi spesse sono quasi bianche; quelle sottili lasciano trasparire un grigio più freddo.
    // Di notte la luminosità non viene dal visibile: tono uniforme dall'infrarosso.
    // Il CDO ha albedo 0,66–0,94: la curva espande i toni alti invece di saturarli, e il
    // contrasto locale (albedo meno la sua media su ~10 km) accentua la struttura OSSERVATA
    // senza aggiungerne: è l'equivalente di una maschera di nitidezza.
    float albedoMean = sampleSequenceLod(vUv, vc, 2.5).x;
    float detail = clamp(albedo - albedoMean, -0.15, 0.15);
    float tone = pow(smoothstep(0.3, 1.0, albedo), 2.0);
    float bright = mix(0.8, 0.45 + 0.5 * tone + detail * 1.2, day);
    vec3 base = vec3(bright) * mix(vec3(0.86, 0.9, 1.0), vec3(1.0), opacity);
    vec3 ambient = vec3(0.30, 0.36, 0.48);
    // Guadagno contenuto: il CDO a mezzogiorno resta nella parte lineare della curva ACES
    // invece di finire nella spalla, dove tutti i bianchi diventano uguali.
    vec3 color = base * (ambient * (0.12 + 0.88 * sunUp) + sunColor * lambert * 0.78 * sunUp);
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
  sequence: CloudSequence;
  exaggeration: number;
  segments: [number, number];
}

export function createCloudLayer({ sequence, exaggeration, segments }: CloudLayerOptions) {
  const b = sequence.index.bounds;
  const [w, h] = sequence.index.albedoSize;
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      ...sequence.uniforms,
      bounds: { value: new Vector4(b.west, b.south, b.east, b.north) },
      texel: { value: new Vector2(1 / w, 1 / h) },
      exaggeration: { value: exaggeration },
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
  const geometry = new PlaneGeometry(1, 1, segments[0], segments[1]);
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
    setExaggeration(value: number) {
      material.uniforms.exaggeration!.value = value;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
