import { BackSide, Mesh, NormalBlending, ShaderMaterial, SphereGeometry, Vector3 } from 'three';

/**
 * Alone atmosferico (ILLUSTRATIVO), valido sia dallo spazio sia da vicino alla superficie.
 *
 * Per ogni pixel del guscio (renderizzato dall'interno, BackSide) si calcola il punto in cui
 * il raggio visivo passa più vicino alla Terra: la luminosità decresce esponenzialmente con la
 * quota di quel punto, come la densità dell'aria. Così l'orizzonte appare come una sottile
 * fascia luminosa, più bianca vicino alla superficie e più blu verso lo spazio,
 * spenta sul lato notturno.
 */

export const ATMOSPHERE_RADIUS = 1.08;

const vertexShader = /* glsl */ `
  varying vec3 vPositionW;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPositionW = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 sunDirection;
  uniform float scaleHeight;
  uniform float strength;

  varying vec3 vPositionW;

  void main() {
    vec3 origin = cameraPosition;
    vec3 dir = normalize(vPositionW - cameraPosition);
    // Punto del raggio più vicino al centro della Terra (non dietro la camera).
    float t = max(-dot(origin, dir), 0.0);
    vec3 closest = origin + dir * t;
    // Dove il raggio colpisce la Terra la superficie, più vicina, vince il test di profondità.
    // Niente discard: la sfera poligonale della Terra è leggermente più piccola di quella
    // analitica e al bordo resterebbero fessure scure.
    float altitude = max(length(closest) - 1.0, 0.0);

    float density = exp(-altitude / scaleHeight);
    vec3 up = normalize(closest);
    float sunlit = smoothstep(-0.28, 0.32, dot(up, normalize(sunDirection)));

    // Bianco-azzurro radente, blu più in alto; sfumatura calda verso il terminatore.
    vec3 low = vec3(0.78, 0.88, 1.0);
    vec3 high = vec3(0.22, 0.48, 1.0);
    vec3 color = mix(high, low, density);
    float dusk = smoothstep(-0.28, 0.0, dot(up, normalize(sunDirection))) * (1.0 - smoothstep(0.0, 0.3, dot(up, normalize(sunDirection))));
    color = mix(color, vec3(1.0, 0.55, 0.3), dusk * 0.35);

    float alpha = clamp(density * strength * (0.04 + 0.96 * sunlit), 0.0, 1.0);
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

export function createAtmosphere(segments: number) {
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      sunDirection: { value: new Vector3(1, 0, 0) },
      // Altezza di scala visiva (≈ 75 km): molto più spessa di quella reale per essere leggibile.
      scaleHeight: { value: 0.012 },
      strength: { value: 0.95 },
    },
    side: BackSide,
    transparent: true,
    blending: NormalBlending,
    depthWrite: false,
  });
  const geometry = new SphereGeometry(ATMOSPHERE_RADIUS, segments, segments / 2);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'atmosphere';
  // Disegnata dopo superficie e nuvole: si sovrappone solo dove c'è "cielo".
  mesh.renderOrder = 2;

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
