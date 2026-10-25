import { BoxGeometry, Color, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import { SUN_DIR, skyGlsl } from './sky';

/**
 * Mare al tramonto (FLIGHT 2.0, originale): onde procedurali animate, riflesso del cielo con
 * Fresnel, scia del Sole, foschia della scena. Qualche barca con luci di via.
 */

const vertexShader = /* glsl */ `
  #include <fog_pars_vertex>
  varying vec3 vWPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWPos = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <fog_pars_fragment>
  uniform float uTime;
  varying vec3 vWPos;
  ${skyGlsl}

  // Normale delle onde: somma di onde direzionali a scale diverse (niente texture).
  vec3 waveNormal(vec2 p, float t, float fade) {
    vec2 g = vec2(0.0);
    // Dimensione del pixel sulla superficie: le onde più fini del pixel si spengono (niente moiré).
    float px = length(fwidth(p));
    const int N = 9;
    for (int i = 0; i < N; i++) {
      float fi = float(i);
      float a = fi * 2.399 + 0.37 * sin(fi * 7.3);
      vec2 dir = vec2(cos(a), sin(a));
      float freq = 0.12 * pow(1.83, fi);
      float amp = 0.22 / pow(1.55, fi);
      float ph = dot(dir, p) * freq + t * (0.6 + 0.35 * fi);
      float nyquist = 1.0 - smoothstep(0.15, 0.5, freq * px);
      g += dir * cos(ph) * freq * amp * nyquist * mix(1.0, 0.0, fade * step(3.5, fi));
    }
    return normalize(vec3(-g.x * 2.2, 1.0, -g.y * 2.2));
  }

  void main() {
    vec3 v = normalize(cameraPosition - vWPos);
    float dist = length(cameraPosition - vWPos);
    // Lontano le onde piccole si attenuano (niente scintillio rumoroso all'orizzonte).
    float fade = smoothstep(800.0, 4000.0, dist);
    vec3 n = waveNormal(vWPos.xz, uTime, fade);
    n = normalize(mix(n, vec3(0.0, 1.0, 0.0), fade * 0.7));
    vec3 r = reflect(-v, n);
    r.y = abs(r.y);
    float fresnel = 0.02 + 0.42 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    vec3 deep = vec3(0.006, 0.01, 0.02);
    vec3 col = mix(deep, skyColor(r), fresnel);
    // Scia del Sole: riflesso speculare stretto più un alone largo.
    float s = max(dot(r, normalize(sunDir)), 0.0);
    col += vec3(1.0, 0.62, 0.32) * (pow(s, 900.0) * 30.0 + pow(s, 90.0) * 1.4);
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

export function createSea(coastX: number) {
  const group = new Group();
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: UniformsUtils.merge([UniformsLib.fog, { uTime: { value: 0 }, sunDir: { value: SUN_DIR }, sunGain: { value: 1 } }]),
    fog: true,
  });
  const sea = new Mesh(new PlaneGeometry(14000, 14000, 1, 1), material);
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(coastX - 7000 + 2, -0.6, 0);
  group.add(sea);

  // Barche ferme al largo: luce bianca in testa d'albero, verde e rossa ai lati.
  const boats: Matrix4[] = [];
  let a = 9;
  const rnd = () => ((a = (a * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 26; k++) boats.push(new Matrix4().makeTranslation(coastX - 200 - rnd() * 2600, 2 + rnd() * 2, (rnd() - 0.5) * 3200));
  const white = new InstancedMesh(new BoxGeometry(1.2, 1.2, 1.2), new MeshBasicMaterial({ color: new Color(4, 3.6, 3) }), boats.length);
  boats.forEach((m, i) => white.setMatrixAt(i, m));
  group.add(white);
  return { group, material };
}
