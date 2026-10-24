import {
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { cloudModel } from '../globe/shading';
import { cloudSequenceGlsl, type CloudSequence } from '../layers/cloud-sequence';

/**
 * Colonne di nube ricostruite dalle osservazioni GOES-16, una per pixel dei dati.
 *
 * Per ogni punto della regione (griglia dell'albedo, ~2,8 km):
 *   R  spessore ottico ridotto τ' = (1−g)τ (RICOSTRUITO): inversione a due flussi dell'albedo
 *      osservata, R = τ' / (2 + τ'), nube non assorbente. È lo spessore che conta per la
 *      trasparenza apparente (principio di similitudine): con R = 0,15 il mare resta visibile,
 *      con R = 0,9 (CDO) la nube è opaca. Di notte o con il Sole basso: dall'opacità infrarossa.
 *   G  quota della sommità in km (RICOSTRUITA dalla temperatura di brillanza, 6,5 K/km).
 *   B  scala verticale della nube in km (IPOTESI ILLUSTRATIVA: i dati non vedono sotto la sommità).
 *   A  albedo osservata (OSSERVATA): la tessitura del CDO viene dai dati, non da rumore.
 *
 * Una seconda passata calcola, per la superficie, la luce solare che attraversa le colonne
 * (ombre) e la frazione di cielo visibile (ILLUSTRATIVO).
 */

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** GLSL condiviso: colonna → densità alla quota h (km reali). */
export const columnGlsl = /* glsl */ `
  uniform sampler2D columns;
  uniform vec4 columnBounds;

  const float RE_KM = 6371.0;
  const float RAD_C = 57.29577951308232;

  vec2 columnUv(vec3 dir) {
    float lat = asin(clamp(dir.y, -1.0, 1.0)) * RAD_C;
    float lon = atan(-dir.z, dir.x) * RAD_C;
    return vec2((lon - columnBounds.x) / (columnBounds.z - columnBounds.x),
                (lat - columnBounds.y) / (columnBounds.w - columnBounds.y));
  }

  bool inRegion(vec2 uv) { return all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0))); }

  /**
   * Coefficiente di estinzione (per km di quota reale) alla quota h, dentro la colonna c.
   * La colonna conserva lo spessore ottico osservato τ'. Profilo verticale (IPOTESI): massimo
   * sotto la sommità e decrescente verso il basso con scala L, senza una base netta che i dati
   * non osservano. Sommità sfumata di qualche centinaio di metri (la quota viene da ~5,5 km).
   */
  float extinction(vec4 c, float h) {
    float L = max(c.z, 0.3);
    float topEdge = 1.0 - smoothstep(c.y - 0.5, c.y + 0.25, h);
    float w = exp(-max(c.y - h, 0.0) / L);
    float norm = L * (1.0 - exp(-max(c.y, 0.3) / L));
    return c.x * w * topEdge / norm * step(0.0, h);
  }

  /** Spessore ottico della colonna sopra la quota h (per la luce del cielo). */
  float depthAbove(vec4 c, float h) {
    float L = max(c.z, 0.3);
    float f = (1.0 - exp(-max(c.y - h, 0.0) / L)) / (1.0 - exp(-max(c.y, 0.3) / L));
    return c.x * clamp(f, 0.0, 1.0);
  }
`;

const columnFragment = /* glsl */ `
  uniform vec4 bounds;
  uniform vec3 sunDirection;
  uniform vec2 texel;
  varying vec2 vUv;

  ${cloudModel}
  ${cloudSequenceGlsl}

  const float RAD = 57.29577951308232;

  void main() {
    float lon = mix(bounds.x, bounds.z, vUv.x) / RAD;
    float lat = mix(bounds.y, bounds.w, vUv.y) / RAD;
    vec3 up = vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
    float day = smoothstep(0.02, 0.22, dot(up, normalize(sunDirection)));

    vec2 s = sampleSequence(vUv);
    float albedo = s.x;
    float bt = decodeBT(s.y);
    // Per lo spessore ottico, albedo filtrata su ~1,5 pixel: colonne vicine con spessori molto
    // diversi produrrebbero pareti verticali a righe (la tessitura resta quella non filtrata).
    vec2 o = texel * 0.75;
    float albedoSoft = 0.4 * albedo + 0.15 * (sampleSequence(vUv + o).x + sampleSequence(vUv - o).x
      + sampleSequence(vUv + vec2(o.x, -o.y)).x + sampleSequence(vUv + vec2(-o.x, o.y)).x);
    float mask = regionMask(vUv);
    float notHotGround = smoothstep(304.0, 297.0, bt);

    // Visibile: riflettanza della nube al di sopra di quella del mare (≈0,06).
    float r = clamp((albedoSoft - 0.06) / 0.94, 0.0, 0.93);
    float tauVis = 2.0 * r / (1.0 - r);
    // Infrarosso: opacità → spessore ottico equivalente (meno informativo, solo di notte).
    float tauIr = -2.0 * log(max(1.0 - 0.97 * smoothstep(288.0, 225.0, bt), 0.03));
    float tau = mix(tauIr, tauVis, day) * notHotGround * mask;
    // Sotto τ' ≈ 0,1 il segnale è rumore del fondo (mare, riflesso del Sole): nessuna nube.
    tau *= smoothstep(0.06, 0.2, tau);

    // Quota dalla temperatura filtrata alla sua risoluzione (~5,5 km): il JPEG a 8 bit ha passi di
    // 0,5 K (≈80 m) che, illuminati di lato, apparirebbero come terrazzamenti inesistenti.
    vec2 ob = texel * 1.5;
    float btSoft = 0.0;
    for (int j = -1; j <= 1; j++)
      for (int i = -1; i <= 1; i++) btSoft += sampleSequence(vUv + vec2(float(i), float(j)) * ob).y;
    float top = cloudTopKm(decodeBT(btSoft / 9.0));
    // Scala verticale (IPOTESI): le colonne spesse (convezione profonda, CDO) si estendono quasi
    // fino alla superficie; gli strati sottili (cirri, veli) restano concentrati sotto la sommità.
    float deep = smoothstep(1.0, 10.0, tau);
    float scale = mix(1.0, max(top * 0.6, 1.0), deep);
    gl_FragColor = vec4(tau, top, scale, albedo * mask);
  }
`;

const groundFragment = /* glsl */ `
  uniform vec3 sunDirection;
  uniform float exaggeration;
  varying vec2 vUv;

  ${columnGlsl}

  const float RAD = 57.29577951308232;

  void main() {
    float lon = mix(columnBounds.x, columnBounds.z, vUv.x) / RAD;
    float lat = mix(columnBounds.y, columnBounds.w, vUv.y) / RAD;
    vec3 up = vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
    vec3 l = normalize(sunDirection);
    float sinElev = dot(up, l);
    float tauSun = 0.0;
    if (sinElev > 0.02) {
      // Percorso verso il Sole attraverso le colonne, nella geometria della scena
      // (quote esagerate): passi in km di scena, estinzione divisa per l'esagerazione.
      float t = 0.0;
      for (int i = 0; i < 32; i++) {
        float stepKm = 0.5 + float(i) * 0.4;
        t += stepKm;
        vec3 q = up + l * (t / RE_KM);
        float h = (length(q) - 1.0) * RE_KM / exaggeration;
        if (h > 19.0) break;
        vec2 uv = columnUv(normalize(q));
        if (!inRegion(uv)) break;
        tauSun += extinction(texture2D(columns, uv), h) / exaggeration * stepKm;
      }
    } else tauSun = 1e3;
    // Diffusione multipla: anche sotto nubi spesse arriva un po' di luce diffusa.
    float direct = exp(-tauSun);
    float diffuse = 0.5 * exp(-0.06 * tauSun);
    // Cielo visibile: frazione schermata dalle colonne attorno (media su ~20 km).
    float tauAround = textureLod(columns, vUv, 3.0).x;
    float sky = exp(-0.05 * tauAround);
    gl_FragColor = vec4(direct, diffuse, sky, 1.0);
  }
`;

export interface ColumnPass {
  columns: WebGLRenderTarget;
  ground: WebGLRenderTarget;
  setSunDirection(direction: Vector3): void;
  setExaggeration(value: number): void;
  /** Ricalcola colonne e luce al suolo per l'istante corrente della sequenza. */
  render(renderer: WebGLRenderer): void;
  dispose(): void;
}

export function createColumnPass(sequence: CloudSequence): ColumnPass {
  const [w, h] = sequence.index.albedoSize;
  const b = sequence.index.bounds;
  const bounds = new Vector4(b.west, b.south, b.east, b.north);
  const target = (mipmaps: boolean, scale: number) =>
    new WebGLRenderTarget(Math.round(w * scale), Math.round(h * scale), {
      type: HalfFloatType,
      format: RGBAFormat,
      depthBuffer: false,
      generateMipmaps: mipmaps,
      minFilter: mipmaps ? LinearMipmapLinearFilter : LinearFilter,
      magFilter: LinearFilter,
    });
  const columns = target(true, 1);
  const ground = target(false, 0.5);
  const sun = new Vector3(1, 0, 0);

  const columnMaterial = new ShaderMaterial({
    vertexShader: quadVertex,
    fragmentShader: columnFragment,
    uniforms: { ...sequence.uniforms, bounds: { value: bounds }, sunDirection: { value: sun }, texel: { value: new Vector2(1 / w, 1 / h) } },
    depthTest: false,
    depthWrite: false,
  });
  const groundMaterial = new ShaderMaterial({
    vertexShader: quadVertex,
    fragmentShader: groundFragment,
    uniforms: {
      columns: { value: columns.texture },
      columnBounds: { value: bounds },
      sunDirection: { value: sun },
      exaggeration: { value: 2 },
    },
    depthTest: false,
    depthWrite: false,
  });
  const geometry = new PlaneGeometry(2, 2);
  const quad = new Mesh(geometry, columnMaterial);
  quad.frustumCulled = false;
  const scene = new Scene();
  scene.add(quad);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  return {
    columns,
    ground,
    setSunDirection(direction) {
      sun.copy(direction);
    },
    setExaggeration(value) {
      groundMaterial.uniforms.exaggeration!.value = value;
    },
    render(renderer) {
      const previous = renderer.getRenderTarget();
      const toneMapping = renderer.toneMapping;
      renderer.toneMapping = 0;
      quad.material = columnMaterial;
      renderer.setRenderTarget(columns);
      renderer.render(scene, camera);
      quad.material = groundMaterial;
      renderer.setRenderTarget(ground);
      renderer.render(scene, camera);
      renderer.setRenderTarget(previous);
      renderer.toneMapping = toneMapping;
    },
    dispose() {
      columns.dispose();
      ground.dispose();
      columnMaterial.dispose();
      groundMaterial.dispose();
      geometry.dispose();
    },
  };
}
