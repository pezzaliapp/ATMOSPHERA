/**
 * Shader di STORM FLIGHT S1.1 (GLSL ES 3.0). Unità: km. Piano locale: +x est, +y su, −z nord, centro
 * dell'occhio nell'origine; la Terra è una sfera di raggio RE con centro in (0, −RE, 0).
 *
 * Modello delle nubi (per ogni punto):
 *   1. colonna di grande scala dalla mappa GOES-16 (τ', sommità), ruotata rigidamente nel tempo;
 *   2. nucleo parametrico entro ~40 km (parete dell'occhio inclinata, occhio libero, raggio dei venti
 *      massimi da HURDAT2): l'occhio reale (~10 km) è sotto la risoluzione dei dati;
 *   3. profilo verticale della colonna (stessa ipotesi di src/volume/columns.ts) con una base a ~0,5 km;
 *   4. dettaglio procedurale (rumore 3D a più scale: celle, torri, lobi della parete, erosione dei bordi):
 *      è un'approssimazione visiva, non un dato.
 *
 * Pipeline per frame: oceano e cielo (piena risoluzione) → tracciamento delle nubi su 1 pixel ogni N×N
 * (a rotazione) → ricostruzione temporale con riproiezione → composizione e mappatura tonale.
 */

export const fullscreenVertex = /* glsl */ `
  in vec3 position;
  uniform mat4 projectionInverse;
  uniform mat4 cameraWorld;
  out vec2 vUv;
  out vec3 vRay;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    vec4 view = projectionInverse * vec4(position.xy, 1.0, 1.0);
    vRay = (cameraWorld * vec4(view.xyz / view.w, 0.0)).xyz;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const commonGlsl = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler3D;

  uniform sampler2D stormMap;
  uniform sampler3D noiseTex;
  uniform vec3 sunDir;
  uniform vec3 cameraPos;
  uniform float cameraAlt;
  uniform float mapAngle;
  uniform float coreAngle;
  uniform float rmw;
  uniform float vmax;
  uniform float rate;
  uniform vec2 flowPhase;
  uniform vec2 flowWeight;
  uniform vec3 flowOffset0;
  uniform vec3 flowOffset1;
  uniform float frame;
  /** STORM FLIGHT S2: luce diffusa dentro le nubi vicine alla telecamera (0 nella S1.1). */
  uniform float interiorLight;
  /** STORM FLIGHT S2: oltre 6 km, o con la telecamera nella nebbia, luce completa un campione su tre (0 nella S1.1). */
  uniform float farReuse;
  /** STORM FLIGHT S2: 1 con la telecamera dentro la nebbia (rumore di campionamento senza struttura). */
  uniform float fogJitter;
  /** Impronta del pixel (km) in cui svanisce l'ottava fine: S1.1 0,03–0,12; S2 più presto (niente puntini). */
  uniform vec2 fineFade;
  /** Impronta (km) in cui svanisce l'erosione del dettaglio: nessuna dissolvenza nella S1.1. */
  uniform vec2 erodeFade;
  /** S2.1: 1 mappa cubica; 2 e 4 solo per le verifiche (niente dettaglio; niente dettaglio nell'ombra). */
  uniform int s21Flags;
  /** S2.1: distanze (km) oltre cui le nubi perdono l'ottava fine e poi tutto il dettaglio (0 = mai). */
  uniform vec2 farLod;
  uniform float staticFlow;
  /** S2.2: precipitazioni attorno alla telecamera, estinzione (1/km) entro RAIN_RANGE e colore (0 altrove). */
  uniform float rainExt;
  /** S2.3: base delle nubi più alta fuori dal CDO, cortine di pioggia sotto le bande, spruzzi marini (0 altrove). */
  uniform float s23Vis;
  /** S2.5: oceano dinamico (numero di treni d'onda, 0 = oceano della S1.1–S2.4) e lampi localizzati. */
  uniform float s25Waves;
  /** S2.5.1: oceano spettrale filtrato (numero di onde, 0 = oceano della S2.5). */
  uniform float s251Ocean;
  uniform vec3 flashPos;
  uniform float flashPower;
  uniform float flashRange;
  const vec3 FLASH_COLOR = vec3(0.72, 0.8, 1.0);
  /** Luce del lampo in un punto: decrescita con la distanza e diffusione nella nube (approssimazione). */
  vec3 flashLight(vec3 p) {
    if (flashPower <= 0.0) return vec3(0.0);
    float d = length(p - flashPos);
    return FLASH_COLOR * flashPower * exp(-d / flashRange) / (1.0 + d * d / (flashRange * flashRange * 4.0));
  }
  uniform vec3 rainColor;
  /** Portata del velo (km): 25 nella S2.2; nella S2.3 pochi km (oltre provvedono le cortine volumetriche). */
  uniform float rainRange;
  #define RAIN_RANGE rainRange
  float rainVeil(float t) { return rainExt > 0.0 ? 1.0 - exp(-rainExt * min(t, RAIN_RANGE)) : 0.0; }

  const float RE = 6371.0;
  const float MAP_HALF = 512.0;
  const float SHELL_TOP = 19.5;
  const float STORM_R = 490.0;
  const float PI = 3.14159265;
  const float EXT_K = 2.6;
  const float EYE_R0 = 6.0;
  const float EYE_SLOPE = 0.55;
  const float OMEGA_CAP = 0.012;
  const vec3 SUN_COLOR = vec3(1.0, 0.96, 0.9) * 3.2;
  const vec3 SKY_AMBIENT = vec3(0.3, 0.46, 0.8) * 0.9;

  // Atmosfera (valori standard): diffusione di Rayleigh al livello del mare e foschia marittima.
  const vec3 BETA_R = vec3(5.8e-3, 13.5e-3, 33.1e-3);
  const float BETA_M = 5.0e-3;
  const float H_R = 8.0;
  const float H_M = 1.3;
  const vec3 SKY_ISO = vec3(0.035, 0.07, 0.15);

  float sq(float x) { return x * x; }
  vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
  float altitudeOf(vec3 p) { return length(p + vec3(0.0, RE, 0.0)) - RE; }

  /** Vento al suolo, profilo di Rankine modificato (approssimazione) con VMAX e RMW da HURDAT2. */
  float windSpeed(float r) {
    r = max(r, 0.05);
    // Nell'occhio il vento cala rapidamente verso il centro (profilo più ripido, approssimazione).
    return r < rmw ? vmax * pow(r / rmw, 2.6) : vmax * pow(rmw / r, 0.55);
  }

  float phaseHG(float mu, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
  }

  /**
   * Colonna d'aria (km equivalenti al livello del mare) da un punto (coordinate geocentriche) all'infinito
   * lungo una direzione che si allontana dal punto di tangenza: funzione di Chapman approssimata (Schüler).
   */
  float chUp(vec3 oc, vec3 dir, float H) {
    float r = length(oc);
    float mu = max(dot(oc, dir) / r, 0.0);
    float x = (r - RE) / H;
    float c = sqrt(1.5707963 * (RE / H + x));
    return H * c / (c * mu + 1.0) * exp(-x);
  }

  /** Colonne di Rayleigh e di foschia lungo il segmento o → o + d·t (diviso al punto di tangenza). */
  vec2 columnSeg(vec3 o, vec3 d, float t) {
    vec3 oc = o + vec3(0.0, RE, 0.0);
    vec3 ob = oc + d * t;
    float tc = -dot(oc, d);
    if (tc <= 0.0) return max(vec2(chUp(oc, d, H_R) - chUp(ob, d, H_R), chUp(oc, d, H_M) - chUp(ob, d, H_M)), 0.0);
    if (tc >= t) return max(vec2(chUp(ob, -d, H_R) - chUp(oc, -d, H_R), chUp(ob, -d, H_M) - chUp(oc, -d, H_M)), 0.0);
    vec3 tp = oc + d * tc;
    vec2 a = vec2(chUp(tp, -d, H_R) - chUp(oc, -d, H_R), chUp(tp, -d, H_M) - chUp(oc, -d, H_M));
    vec2 b = vec2(chUp(tp, d, H_R) - chUp(ob, d, H_R), chUp(tp, d, H_M) - chUp(ob, d, H_M));
    return max(a, 0.0) + max(b, 0.0);
  }

  /** Trasmittanza dell'aria verso il Sole da un punto (geocentrico). */
  vec3 sunTransmittance(vec3 oc) {
    return exp(-(BETA_R * chUp(oc, sunDir, H_R) + BETA_M * 1.11 * chUp(oc, sunDir, H_M)));
  }

  /**
   * Prospettiva aerea a diffusione singola con trasmittanza solare costante lungo il segmento (valutata nel
   * punto più basso). shade: luce solare residua sotto le nubi (vale per la foschia bassa).
   */
  vec3 aerial(vec3 o, vec3 d, float t, float shade, out vec3 trans) {
    vec2 col = columnSeg(o, d, t);
    vec3 tauR = BETA_R * col.x;
    float tauM = BETA_M * col.y;
    vec3 tau = tauR + tauM * 1.11;
    trans = exp(-tau);
    float mu = dot(d, sunDir);
    float pR = 0.0597 * (1.0 + mu * mu);
    float pM = mix(phaseHG(mu, 0.76), phaseHG(mu, -0.2), 0.15);
    vec3 oc = o + vec3(0.0, RE, 0.0);
    vec3 low = oc + d * clamp(-dot(oc, d), 0.0, t);
    vec3 sunT = sunTransmittance(low);
    vec3 frac = (1.0 - trans) / max(tau, vec3(1e-6));
    vec3 single = SUN_COLOR * sunT * (tauR * pR * 1.8 * mix(shade, 1.0, 0.6) + tauM * pM * shade) * frac;
    return single + SKY_ISO * (tauR + tauM) * frac * mix(shade, 1.0, 0.5);
  }

  /** Mappa osservata, ruotata in senso antiorario (visto dall'alto) di mapAngle. */
  vec4 mapAt(vec2 xz) {
    vec2 uv = rot(xz, mapAngle) / (2.0 * MAP_HALF) + 0.5;
    return texture(stormMap, uv);
  }

  float eyeRadius(float h) { return EYE_R0 + EYE_SLOPE * max(h, 0.0); }

  struct Column { float tau; float top; float tauBlur; float mask; float r; float core; float albedo; };

  /**
   * Mappa con filtro cubico (B-spline, 4 letture bilineari): i contorni delle nubi seguono curve morbide e non
   * la griglia di 2 km dei texel, che a volo radente si vedrebbe come gradini rettangolari.
   */
  vec4 mapSmooth(vec2 xz) {
    vec2 size = vec2(textureSize(stormMap, 0));
    vec2 st = (rot(xz, mapAngle) / (2.0 * MAP_HALF) + 0.5) * size - 0.5;
    vec2 i = floor(st);
    vec2 f = st - i;
    vec2 w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
    vec2 w1 = (3.0 * f * f * f - 6.0 * f * f + 4.0) / 6.0;
    vec2 w2 = (-3.0 * f * f * f + 3.0 * f * f + 3.0 * f + 1.0) / 6.0;
    vec2 w3 = f * f * f / 6.0;
    vec2 g0 = w0 + w1;
    vec2 g1 = w2 + w3;
    vec2 h0 = (i - 0.5 + w1 / g0) / size;
    vec2 h1 = (i + 1.5 + w3 / g1) / size;
    return g0.y * (g0.x * texture(stormMap, h0) + g1.x * texture(stormMap, vec2(h1.x, h0.y)))
         + g1.y * (g0.x * texture(stormMap, vec2(h0.x, h1.y)) + g1.x * texture(stormMap, h1));
  }

  Column columnFrom(vec4 m, vec3 p);
  Column column(vec3 p) { return columnFrom(mapAt(p.xz), p); }

  Column columnFrom(vec4 m, vec3 p) {
    Column c;
    c.r = length(p.xz);
    c.core = 1.0 - smoothstep(20.0, 44.0, c.r);
    // Nucleo: CDO opaco, sommità più alta sopra la parete (torri convettive), poi la mappa osservata.
    c.tau = mix(m.r, 30.0, c.core);
    c.top = mix(m.g, 15.6 + 1.1 * exp(-sq((c.r - rmw * 1.3) / 6.0)), c.core);
    c.tauBlur = mix(m.b, 28.0, c.core);
    c.mask = max(1.0 - smoothstep(400.0, 480.0, c.r), c.core);
    // Albedo osservata ovunque tranne nell'occhio (che in GOES è più piccolo del nostro): un disco a
    // valore costante sul nucleo si vedrebbe dall'alto come un anello.
    c.albedo = mix(m.a, 0.92, 1.0 - smoothstep(8.0, 16.0, c.r));
    return c;
  }

  /**
   * S2.3: quota della base delle nubi (km). Nel CDO e in parete resta a ~0,6 km; nelle bande e nelle colonne
   * sottili sale fino a ~2,4 km (valori tipici: cumuli ~0,6–1 km, nubi stratiformi più alte). Approssimazione.
   */
  float cloudBase(Column c) {
    if (s23Vis < 0.5) return 0.6;
    float strat = (1.0 - c.core) * (1.0 - smoothstep(10.0, 30.0, c.tau));
    // Mai oltre metà della sommità (le nubi basse restano visibili).
    return min(mix(0.7, 2.2, strat), max(0.6, c.top * 0.45));
  }

  /** Estinzione (1/km) alla quota h, con la sommità top (profilo di src/volume/columns.ts). */
  float profile(Column c, float top, float h, float edge) {
    float deep = smoothstep(1.0, 10.0, c.tau);
    float L = mix(1.0, max(top * 0.6, 1.0), deep);
    float topEdge = 1.0 - smoothstep(top - edge, top + 0.04, h);
    float w = exp(-max(top - h, 0.0) / L);
    float norm = L * (1.0 - exp(-max(top, 0.3) / L));
    float cb = cloudBase(c);
    float base = s23Vis > 0.5 ? smoothstep(cb - 0.3, cb + 0.3, h) : smoothstep(0.3, 0.9, h);
    return EXT_K * c.tau * w * topEdge / norm * base * c.mask;
  }

  /** Parete dell'occhio: raggio che cresce con la quota (effetto stadio), contorno lievemente poligonale. */
  float eyeMask(vec3 p, float r, float h, float width) {
    if (r > eyeRadius(h) + width + 1.0) return 1.0;
    float th = atan(-p.z, p.x);
    float wob = 0.5 * sin(4.0 * (th - coreAngle)) + 0.3 * sin(6.0 * (th - 1.3 * coreAngle) + 1.7);
    return smoothstep(-width * 0.5, width, r + wob * smoothstep(1.0, 8.0, h) - eyeRadius(h));
  }

  float macroSigma(vec3 p) {
    float h = altitudeOf(p);
    Column c = column(p);
    if (h > c.top + 0.4 || c.mask < 0.001) return 0.0;
    // Le colonne sottili sono cumuli sparsi: l'ombra media cresce con la frazione coperta.
    float cov = 1.0 - exp(-0.3 * c.tau);
    return profile(c, c.top, h, 0.7) * eyeMask(p, c.r, h, 2.0) * cov * (1.0 + 2.0 * c.core);
  }

  /**
   * Coordinate del rumore: spirale logaritmica (le strutture si allungano lungo bande con inclinazione
   * di ~20°, come nelle bande e nei cirri d'uscita) e trascinamento della rotazione differenziale.
   */
  vec3 advect(vec3 p, float r, float phase, vec3 offset, float twist) {
    float om = min(windSpeed(r) * 1e-3 / max(r, 0.5) * rate, OMEGA_CAP);
    float a = om * phase - twist * log(max(r, 30.0));
    return vec3(rot(p.xz, a), p.y).xzy + offset;
  }

  vec4 noiseAt(vec3 p, float r, vec3 scale, float twist) {
    // S2.1 (tempo reale): una sola lettura, rumore solidale con la rotazione della mappa. L'incrocio di due
    // fasi serve solo con il tempo accelerato delle viste di osservazione.
    if (staticFlow > 0.0) return texture(noiseTex, vec3(rot(p.xz, mapAngle - twist * log(max(r, 30.0))), p.y).xzy * scale);
    vec4 na = texture(noiseTex, advect(p, r, flowPhase.x, flowOffset0, twist) * scale);
    vec4 nb = texture(noiseTex, advect(p, r, flowPhase.y, flowOffset1, twist) * scale);
    return na * flowWeight.x + nb * flowWeight.y;
  }

  /**
   * Lobi della parete in coordinate cilindriche (angolo, quota): bombature di qualche km che ruotano con
   * il nucleo. Il numero di periodi attorno all'occhio è intero: nessuna cucitura a θ = ±π.
   */
  float wallLobes(vec3 p, float h) {
    float th = atan(-p.z, p.x) - coreAngle;
    float u = th / 6.2831853;
    float big = texture(noiseTex, vec3(u * 3.0, h / 13.0, 0.17)).r;
    float mid = texture(noiseTex, vec3(u * 7.0, h / 6.5, 0.53)).g;
    return big * 0.6 + mid * 0.4;
  }

  /**
   * Contesto di colonna: mappa osservata e modulazioni orizzontali (celle, ammassi, variazioni lente).
   * Dipende solo dalla posizione orizzontale: i primi passi verso il Sole (< 0,2 km) lo riutilizzano.
   */
  struct Ctx { Column c; float cells; float cluster; float big; };

  Ctx context(vec3 p) {
    Ctx x;
    x.c = columnFrom((s21Flags & 1) != 0 && length(p - cameraPos) < 40.0 ? mapSmooth(p.xz) : mapAt(p.xz), p);
    vec2 mq = rot(p.xz, mapAngle);
    // Celle convettive della sommità (cupole di ~7 km), ammassi delle bande (~20 km) e variazioni lente
    // (~80 km), solidali con la mappa.
    // Perlin-Worley (canale R) e non Worley puro: niente celle esagonali regolari visibili dall'alto.
    x.cells = texture(noiseTex, vec3(rot(mq, 2.1) / 30.0, 0.63)).r;
    vec4 cl = texture(noiseTex, vec3(rot(mq, 4.0) / 95.0, 0.41));
    x.cluster = cl.r * 0.6 + cl.a * 0.4;
    x.big = texture(noiseTex, vec3(rot(mq, 0.9) / 150.0, 0.21)).a;
    return x;
  }

  /**
   * Densità completa. x = estinzione (1/km), y = vicinanza alla parete interna (luce riflessa nell'occhio),
   * z = albedo osservata.
   */
  vec3 densityCtx(vec3 p, Ctx x, float footprint, int level) {
    float h = altitudeOf(p);
    Column c = x.c;
    c.r = length(p.xz);
    if (c.mask < 0.001 || h < 0.25 || h > c.top + 4.0) return vec3(0.0);
    // S2.3: cortine di pioggia sotto la base, dove la colonna è spessa (stima dalla colonna GOES, illustrativa):
    // fasce irregolari di qualche km, inclinate dal vento ciclonico, più dense sotto le celle convettive.
    // Restituite con albedo negativa: lo shader le illumina con un modello leggero (niente ombra propria).
    float cb = cloudBase(c);
    if (s23Vis > 0.5 && h < cb + 0.2 && c.tau > 2.0) {
      float er0 = eyeRadius(h);
      if (c.r < er0 + 1.0) return vec3(0.0);
      vec2 wdir = vec2(p.z, -p.x) / max(c.r, 1.0);
      vec2 q = rot(p.xz, mapAngle) - wdir * (cb - h) * 0.7;
      float shafts = texture(noiseTex, vec3(q / 11.0, 0.13)).r * 0.65 + texture(noiseTex, vec3(q / 3.7, 0.57)).g * 0.35;
      float conv = smoothstep(9.0, 15.0, c.top) * smoothstep(8.0, 22.0, c.tau);
      float rain = smoothstep(3.0, 14.0, c.tau) * 0.35 + conv + 0.8 * c.core;
      float rs = rain * smoothstep(0.34, 0.66, shafts) * 3.6 * (1.0 - smoothstep(cb - 0.1, cb + 0.2, h)) * smoothstep(0.25, 0.5, h);
      if (h < cb - 0.3) return vec3(rs, 0.0, -1.0);
    }
    float relief = mix(0.5, 1.4, smoothstep(2.0, 16.0, c.tau));
    float er = eyeRadius(h);
    // In parete le strutture sono allungate in verticale (torri, cortine di pioggia).
    float wall = c.core * (1.0 - smoothstep(0.0, 9.0, abs(c.r - er - 3.0)));
    float canopy = smoothstep(c.top - 3.0, c.top - 0.5, h) * smoothstep(6.0, 12.0, c.top);
    float twist = 2.0;
    vec3 sc = vec3(mix(1.0 / 11.0, 1.0 / 6.0, wall), mix(1.0 / 5.0, 1.0 / 8.0, wall), mix(1.0 / 11.0, 1.0 / 6.0, wall));
    float n = noiseAt(p, c.r, sc, twist).r;
    float thick = smoothstep(8.0, 20.0, c.tau);
    float dome = x.cells;
    float conv = smoothstep(4.0, 10.0, c.top);
    // Rilievo della sommità: torri sparse (overshooting tops), cupole, ammassi e tessitura osservata.
    float turret = pow(clamp(n, 0.0, 1.0), 3.0) * 2.4 - 0.25;
    float top = c.top + turret * relief + ((dome - 0.55) * 1.4 + (x.big - 0.5) * 1.6 + (x.cluster - 0.5) * mix(3.0, 1.2, thick)) * conv + (c.albedo - 0.75) * canopy;
    // Cumuli a cavolfiore: la sommità segue sfere addossate (Worley 3D invertito, celle di ~3,5 km),
    // con sporgenze e rientranze che si fanno ombra a vicenda.
    float bill = 0.5;
    if (footprint < 2.5) {
      float g = noiseAt(p, c.r, vec3(1.0 / 13.0, 1.0 / 11.0, 1.0 / 13.0), twist).g;
      // Profilo a cupola (sfere addossate; il taglio di un cono disegnerebbe anelli e scaglie), centrato
      // sul valore medio. Vale per la sommità e per la faccia della parete.
      bill = mix(sqrt(max(1.0 - sq(1.0 - g), 0.0)) - 0.32, 0.5, smoothstep(1.2, 2.5, footprint));
      top += (bill - 0.5) * 3.4 * mix(0.35, 1.0, conv);
    }
    // Uscite anticipate (il dettaglio costa 4 letture): sopra la sommità più alta raggiungibile, dentro
    // l'occhio oltre la sporgenza massima, o in una colonna sottile dove la forma è già nulla.
    if (h > top + 0.65) return vec3(0.0);
    float cov = 1.0 - exp(-0.3 * c.tau);
    // Il rumore di forma ha molti zeri: la soglia usa una copertura raddoppiata (taratura visiva).
    float cv = min(1.0, cov * 2.0);
    float shapeN = clamp((mix(n, x.cluster, 0.35 * (1.0 - thick)) - (1.0 - cv)) / max(cv, 0.08), 0.0, 1.0);
    if (thick < 0.001 && shapeN <= 0.0) return vec3(0.0);
    float lobes = c.r < er + 9.0 ? wallLobes(p, h) : 0.5;
    float bulge = (lobes - 0.5) * mix(2.6, 5.0, smoothstep(2.0, 12.0, h)) + (n - 0.5) * 0.6 + (bill - 0.5) * 2.8;
    if (c.r + bulge - er < -0.9) return vec3(0.0);
    float dw = level > 0 && (s21Flags & 2) == 0 ? 1.0 - smoothstep(0.15, 0.7, footprint / 2.4) : 0.0;
    float d = 0.5;
    if (dw > 0.0) {
      d = noiseAt(p, c.r, vec3(1.0 / mix(2.4, 2.6, wall), 1.0 / mix(1.8, 2.4, wall), 1.0 / mix(2.4, 2.6, wall)), 0.0).g;
      // La superficie superiore si increspa di qualche centinaio di metri.
      top += (d - 0.55) * dw;
    }
    // Ottava fine (~100 m) solo da vicino: bordi frastagliati dei cumuli nelle viste ravvicinate.
    float fw = level > 1 ? 1.0 - smoothstep(fineFade.x, fineFade.y, footprint) : 0.0;
    float f = 0.5;
    if (fw > 0.0) {
      f = noiseAt(p, c.r, vec3(1.0 / 0.75, 1.0 / 0.75, 1.0 / 0.75), 0.0).b;
      top += (f - 0.5) * 0.25 * fw;
    }
    float sig = profile(c, top, h, mix(0.6, 0.12, conv));
    // Nubi spesse (CDO, parete): interno continuo, il rumore modella solo lo strato superficiale
    // (altrimenti la parete diventa una spugna con fori profondi chilometri).
    float inner = smoothstep(0.4, 2.0, top - h);
    float shape = mix(shapeN, mix(0.72 + 0.28 * shapeN, 1.0, inner), thick);
    shape = mix(shape, 0.6 + 0.4 * shape, canopy * cov * (1.0 - thick));
    if (dw > 0.0) {
      // Dettaglio: cumuliforme nelle bande e in parete, fibroso (meno eroso) nello scudo di cirri.
      float erode = mix(mix(0.85, 0.3, canopy), 0.9, wall * (1.0 - canopy)) * dw;
      // Nubi sottili viste da vicino (S2, a pochi km): meno erosione, altrimenti si sbriciolano in coriandoli.
      float near = interiorLight > 0.0 ? (1.0 - thick) * (1.0 - smoothstep(0.02, 0.15, footprint)) : 0.0;
      erode *= 1.0 - 0.6 * near;
      // S2: l'erosione fine svanisce con la distanza (a qualche km i suoi fori diventano puntini scuri).
      erode *= 1.0 - smoothstep(erodeFade.x, erodeFade.y, footprint);
      shape = clamp(shape - (1.0 - shape) * (1.0 - d) * erode - (1.0 - d) * 0.08 * dw * (1.0 - smoothstep(erodeFade.x, erodeFade.y, footprint)), 0.0, 1.0);
      shape = clamp(shape - (1.0 - shape) * (1.0 - f) * 0.4 * fw * mix(1.0, 0.2, near), 0.0, 1.0);
    }
    // Parete: lobi ampi che sporgono nell'occhio (più marcati in quota) e irregolarità minori.
    bulge += (d - 0.5) * dw + (f - 0.5) * 0.3 * fw;
    // Interno delle nubi spesse: grumi e vuoti, lontano dalle superfici visibili (sommità e faccia della
    // parete) e solo vicino alla telecamera: volando dentro la nube danno profondità e velocità.
    // Solo attorno alla telecamera (S2): visti da lontano, anche dal basso, gli interni restano uniformi.
    float deep = interiorLight > 0.0 ? smoothstep(1.2, 2.5, top - h) * smoothstep(1.2, 2.4, c.core > 0.0 ? c.r + bulge - er : 99.0) * thick * dw * (1.0 - smoothstep(0.8, 2.0, length(p - cameraPos))) : 0.0;
    // Scala di ~100–600 m, confrontabile con la visibilità dentro la nube (decine o centinaia di metri).
    if (deep > 0.0) shape *= mix(1.0, 0.15 + 0.85 * smoothstep(0.52, 0.76, 0.35 * d + 0.65 * f), deep);
    float em = eyeMask(p, c.r + bulge, h, 0.25);
    // Parete e nucleo: nubi dense con contorni netti (estinzione tipica dei cumulonembi, decine per km).
    // Contorni netti dei cumuli (le zone fibrose dello scudo di cirri restano morbide).
    shape = mix(shape, smoothstep(0.12, 0.42, shape), max(wall, conv * 0.8) * (1.0 - canopy * 0.8));
    // Colonne sottili: cumuli opachi che coprono una frazione dell'area (stesso spessore ottico medio),
    // non un velo uniforme e semitrasparente.
    sig *= shape * em * (1.0 + 2.0 * c.core + 1.5 * wall) * mix(1.0 / max(cov, 0.2), 1.0, thick);
    float face = c.core * exp(-max(c.r + bulge - er, 0.0) / 1.2);
    return vec3(sig, face, c.albedo);
  }



  /**
   * Spessore ottico verso il Sole: 10 passi che raddoppiano da 20 m fino a ~20 km. I primi tre (entro
   * ~150 m, con il contesto del punto) usano la forma completa: è lì che si decide quanto una superficie
   * inclinata rispetto al Sole risulta più scura (ombreggiatura dei lobi). Gli altri usano la grande scala.
   */
  float sunDepth(vec3 p, Ctx x, float footprint, bool cheap) {
    float tau = 0.0;
    float ds = 0.02;
    vec3 q = p;
    for (int i = 0; i < 10; i++) {
      q += sunDir * ds;
      tau += (i < (cheap ? 1 : 3) ? densityCtx(q, x, footprint, i < 2 && (s21Flags & 4) == 0 ? 1 : 0).x : macroSigma(q)) * ds;
      ds *= 2.0;
    }
    return tau;
  }

  /**
   * Luce diffusa in profondità (approssimazione di diffusione: trasmissione ~1/(1 + k·τ), k ≈ 0,06–0,11 con
   * g ≈ 0,85; qui il valore basso, a favore della leggibilità).
   * Le ottave di diffusione multipla la sottostimano molto dentro le nubi spesse, che risulterebbero quasi
   * nere: serve solo quando la telecamera è dentro o vicinissima alle nubi (pilotaggio S2).
   */
  vec3 interiorDiffuse(vec3 p, Column c) {
    float h = altitudeOf(p);
    float tauAbove = EXT_K * c.tau * clamp((c.top - h) / max(c.top, 1.0), 0.0, 1.0) * (1.0 + 2.0 * c.core);
    return (SUN_COLOR * max(sunDir.y, 0.0) * 0.22 + SKY_AMBIENT * 0.45) / (1.0 + 0.025 * tauAbove);
  }

  /** Spessore ottico verso l'alto (visibilità del cielo, grande scala). */
  float upDepth(vec3 p) {
    if (staticFlow > 0.0 && length(p - cameraPos) > 25.0) return macroSigma(p + normalize(p + vec3(0.0, RE, 0.0)) * 1.8) * 7.2;
    vec3 up = normalize(p + vec3(0.0, RE, 0.0));
    return macroSigma(p + up * 0.5) * 1.0 + macroSigma(p + up * 1.8) * 2.0 + macroSigma(p + up * 4.8) * 4.2;
  }

  /** Intersezione stabile con la sfera di raggio RE + h (centro in (0, −RE, 0)). */
  vec2 sphere(vec3 o, vec3 d, float h) {
    vec3 oc = o + vec3(0.0, RE, 0.0);
    float b = dot(oc, d);
    float c = (cameraAlt - h) * (2.0 * RE + cameraAlt + h);
    float disc = b * b - c;
    if (disc < 0.0) return vec2(-1.0, -2.0);
    float s = sqrt(disc);
    float q = -b - sign(b) * s;
    float t0 = q;
    float t1 = c / q;
    return vec2(min(t0, t1), max(t0, t1));
  }
`;

/** Oceano e cielo, a piena risoluzione. */
export const oceanFragment = /* glsl */ `
  ${commonGlsl}
  uniform sampler2D waveTex;
  uniform float time;
  uniform float pixelAngle;
  in vec2 vUv;
  in vec3 vRay;
  out vec4 outColor;

  /**
   * Pendenze delle onde in coordinate del mondo (nessuna rotazione variabile nello spazio, che creerebbe
   * anelli): due sistemi incrociati, mare vivo e onda lunga, come nel mare confuso di un uragano.
   */
  vec3 waveSlope(vec2 xz, float speed, float footprint) {
    float sea = clamp(speed / 22.0, 0.15, 1.8);
    vec2 s = vec2(0.0);
    float lost = 0.0;
    // Gruppi d'onda irregolari (ampiezza variabile su ~1 km) e spostamento del dominio: senza, la
    // sovrapposizione di due treni periodici disegna un reticolo regolare nel riflesso del Sole.
    vec4 nz = texture(noiseTex, vec3(xz / 2.1, 0.77));
    float groups = 0.4 + 1.2 * nz.a;
    xz += (nz.ra - 0.5) * 0.9;
    vec2 xz2 = rot(xz, 1.2);
    for (int i = 0; i < 3; i++) {
      float L = i == 0 ? 0.32 : i == 1 ? 0.074 : 0.017;
      float vis = 1.0 - smoothstep(L * 0.05, L * 0.4, footprint);
      float drift = time * sqrt(L) * 0.04;
      vec2 a = texture(waveTex, (xz + vec2(drift, 0.0)) / L + float(i) * 0.37).rg * 2.0 - 1.0;
      vec2 b = texture(waveTex, (xz2 + vec2(drift * 0.8, 0.0)) / (L * 1.3) + float(i) * 0.61).rg * 2.0 - 1.0;
      b = rot(b, -1.2);
      s += (a * 0.65 + b * 0.5) * vis * (i == 0 ? 0.55 : i == 1 ? 0.35 : 0.25) * groups;
      lost += (1.0 - vis) * 0.06;
    }
    return vec3(s * sea, lost * sea);
  }

  /**
   * S2.5: mare dinamico. Treni di onde di Gerstner su 12 direzioni FISSE nel mondo (una direzione che variasse
   * nello spazio deformerebbe le fasi e disegnerebbe anelli): l'ampiezza di ciascuno dipende dall'allineamento con
   * il vento locale (dispersione angolare in cos²) e dalla sua velocità; lunghezze 35–300 m, dispersione
   * ω = √(g·k). Uscita: pendenze (xy), altezza normalizzata (z), compressione delle creste (w, per la schiuma).
   * Ogni onda svanisce quando diventa più piccola del pixel (da alta quota resta la rugosità media).
   */
  vec4 oceanWaves(vec2 xz, vec2 wdir, float speed, float footprint, float confused) {
    float Hs = min(0.0246 * speed * speed, 14.0) * 1e-3;
    vec2 slope = vec2(0.0);
    float h = 0.0, comp = 0.0, norm = 0.0;
    for (int i = 0; i < 12; i++) {
      if (float(i) >= s25Waves) break;
      float fi = float(i);
      float ang = fi * 2.39996 + 0.37;
      vec2 D = vec2(cos(ang), sin(ang));
      float align = max(dot(D, wdir), 0.0);
      // Mare confuso (occhio e dintorni della parete): onde da tutte le direzioni.
      float spread = mix(align * align, 0.55, confused);
      float L = 0.035 * pow(8.5, fract(fi * 0.618 + 0.13));
      float vis = 1.0 - smoothstep(L * 0.08, L * 0.35, footprint);
      if (vis <= 0.0 || spread <= 0.01) continue;
      float k = 6.2831853 / L;
      float w = sqrt(9.81e-3 * k);
      float a = Hs * 0.5 * spread * sqrt(L / 0.3) * vis;
      float ph = k * dot(D, xz) - w * time + fi * 1.7;
      float sn = sin(ph), cs = cos(ph);
      slope += D * (a * k * cs);
      h += a * sn;
      comp += a * k * sn;
      norm += a;
    }
    return vec4(slope, norm > 0.0 ? h / norm : 0.0, comp);
  }

  /** Rumore a gradiente 2D con hash intero (PCG 2D): continuo, senza periodo né blocchi; uscita ~[-0,7, 0,7]. */
  uvec2 pcg2(uvec2 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * 1664525u; v.y += v.x * 1664525u;
    v ^= v >> 16u;
    v.x += v.y * 1664525u; v.y += v.x * 1664525u;
    v ^= v >> 16u;
    return v;
  }
  vec2 grad2(ivec2 c) {
    uvec2 h = pcg2(uvec2(c + 1048576));
    float a = float(h.x & 65535u) * (6.2831853 / 65536.0);
    return vec2(cos(a), sin(a));
  }
  float gnoise(vec2 p) {
    ivec2 i = ivec2(floor(p));
    vec2 f = p - floor(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = dot(grad2(i), f), b = dot(grad2(i + ivec2(1, 0)), f - vec2(1.0, 0.0));
    float c = dot(grad2(i + ivec2(0, 1)), f - vec2(0.0, 1.0)), d = dot(grad2(i + ivec2(1, 1)), f - vec2(1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  /** Quantile gaussiano: x tale che P(Z > x) = p (Abramowitz-Stegun 26.2.23, errore < 5·10⁻⁴). */
  float gaussQuantile(float p) {
    float q = clamp(p, 1e-4, 0.9999);
    float t = sqrt(-2.0 * log(min(q, 1.0 - q)));
    float x = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1.0 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
    return q < 0.5 ? x : -x;
  }
  /** Lunghezza del tratto [s0, s1] del raggio (o + s·d, piano xz) che sta dentro il cerchio di raggio R. */
  float insideCircle(vec2 o, vec2 d, float R, float s0, float s1) {
    float a = max(dot(d, d), 1e-8), b = dot(o, d), c = dot(o, o) - R * R;
    float disc = b * b - a * c;
    if (disc <= 0.0) return 0.0;
    float q = sqrt(disc);
    return max(0.0, min(s1, (-b + q) / a) - max(s0, (-b - q) / a));
  }
  /**
   * S2.5.1: mare spettrale filtrato. Spettro di Pierson-Moskowitz discretizzato in N onde (N/2 bande di lunghezza
   * in progressione geometrica da 1,6·λp, due direzioni per banda, direzioni FISSE nel mondo con dispersione cos² attorno al vento
   * locale, ampiezze normalizzate all'altezza significativa). Per ogni pixel le onde più lunghe di ~6 volte
   * l'impronta (anisotropa: allungata in vista radente) danno la normale; la pendenza di quelle più corte e della
   * coda capillare (Cox-Munk) diventa rugosità della BRDF. Nessuna onda sotto il pixel → niente anelli né tessere,
   * e lo stesso mare a tutte le quote (transizione continua dalla geometria alla rugosità).
   * Uscita: x,y pendenza risolta; z varianza della pendenza non risolta; w creste (in deviazioni standard).
   */
  vec4 oceanSpectrum(vec2 xz, vec2 wdir, float U, float swellU, float confused, float fp, out float hNorm, out float resolvedFrac) {
    // Onda dominante: mare di vento (λp ≈ 8,2·U²/g, limitata dal fetch dell'uragano a ~300 m) e, vicino
    // all'occhio, onda lunga generata nella parete (mare confuso).
    float Ue = max(U, swellU);
    float lp = clamp(8.16 * Ue * Ue / 9.81, 25.0, 300.0) * 1e-3;
    float Hs = min(0.0214 * Ue * Ue, 14.0) * 1e-3;
    // Gruppi d'onda su scala chilometrica: il mare non è uniforme (visibile soprattutto dall'alto).
    // (rumore procedurale: nessuna periodicità visibile anche da alta quota)
    float z1 = gnoise(xz / 3.3 + 3.1) * 5.0, z2 = gnoise(xz / 0.93 + 7.7) * 5.0;
    float groups = clamp(1.0 + 0.3 * z1 + 0.12 * z2, 0.4, 1.7);
    // Creste curve, non rettilinee: lieve spostamento del dominio (gradiente < 0,1, nessuna piega).
    vec2 q = xz + vec2(gnoise(xz / 2.3 + 11.3), gnoise(xz / 2.3 - 5.9)) * 0.16 + vec2(gnoise(xz / 0.6 + 2.2), gnoise(xz / 0.6 - 8.1)) * 0.03;
    float N = s251Ocean;
    // Un solo ciclo con ampiezze relative; la normalizzazione (energia totale ↔ Hs: Σ a²/2 = (Hs/4)²) si applica
    // alla fine: pendenze e altezza sono lineari nell'ampiezza, le varianze quadratiche.
    vec2 slope = vec2(0.0);
    float h = 0.0, comp = 0.0, vRes = 0.0, vAll = 0.0, hVar = 0.0, cVar = 0.0, e = 0.0;
    for (int i = 0; i < 32; i++) {
      if (float(i) >= N) break;
      float fi = float(i);
      // Bande di lunghezza (rapporto 0,75) con due onde ciascuna a ±26° attorno a una direzione che ruota di banda
      // in banda (angolo aureo): creste corte e irregolari come nel mare vivo, nessun reticolo.
      float band = floor(fi * 0.5);
      float L = lp * 1.6 * pow(0.75, band) * (mod(fi, 2.0) < 0.5 ? 1.0 : 0.87);
      float ang = band * 2.39996 + 0.37 + (mod(fi, 2.0) < 0.5 ? 0.45 : -0.45);
      vec2 D = vec2(cos(ang), sin(ang));
      float al = max(dot(D, wdir), 0.0);
      float sp = mix(al * al + 0.04, 0.5, confused);
      float a = L * exp(-0.625 * sq(L / lp)) * sp;
      e += 0.5 * a * a;
      float k = 6.2831853 / L;
      float sv = 0.5 * a * a * k * k;
      vAll += sv;
      float vis = smoothstep(3.0 * fp, 6.0 * fp, L);
      if (vis <= 0.0) continue;
      vRes += sv * vis * vis;
      float ph = k * dot(D, q) - sqrt(9.81e-3 * k) * time + fi * 1.7;
      float sn = sin(ph), cs = cos(ph);
      float av = a * vis;
      slope += D * (av * k * cs);
      h += av * sn;
      hVar += 0.5 * av * av;
      // Creste ripide: dove la componente di compressione (∝ a·k·sin) è alta.
      comp += av * k * sn;
      cVar += 0.5 * av * av * k * k;
    }
    float scale = Hs * 0.25 / sqrt(max(e, 1e-12)) * groups;
    slope *= scale;
    vAll *= scale * scale;
    vRes *= scale * scale;
    // Coda capillare e onde non rappresentate: varianza totale delle pendenze di Cox-Munk (satura a ~0,06).
    float mssCM = min(0.003 + 0.00512 * Ue, 0.06) * clamp(1.0 + 0.12 * z1, 0.75, 1.25);
    float tail = max(mssCM - vAll, 0.25 * mssCM);
    hNorm = hVar > 0.0 ? h / sqrt(hVar) : 0.0;
    resolvedFrac = vRes / max(vAll + tail, 1e-9);
    return vec4(slope, vAll - vRes + tail, cVar > 0.0 ? comp / sqrt(cVar) : 0.0);
  }

  /**
   * Strisce di schiuma lungo le linee di flusso del vento (spirali logaritmiche con afflusso di ~20°).
   * Coordinate ψ = ln r + tan(α)·θ (costante lungo una linea di flusso) e θ, scalate perché il salto a
   * θ = ±π cada su un numero intero di periodi del rumore: nessuna cucitura.
   */
  float foamStreaks(vec2 xz, float r) {
    float th = atan(-xz.y, xz.x);
    float psi = log(max(r, 0.2)) + 0.364 * th;
    vec2 q = vec2(psi * 915.0 / (6.2831853 * 0.364), th * 157.0 / 6.2831853);
    return texture(noiseTex, vec3(q.x, q.y, 0.37 + time * 0.0004)).g;
  }

  void main() {
    vec3 d = normalize(vRay);
    vec2 hit = sphere(cameraPos, d, 0.0);
    if (hit.x < 0.0) {
      vec3 tr;
      vec3 sky = aerial(cameraPos, d, 1e5, 1.0, tr);
      float mu = dot(d, sunDir);
      sky += vec3(1.0, 0.97, 0.92) * 60.0 * tr * smoothstep(0.99996, 0.99999, mu);
      outColor = vec4(mix(sky, rainColor, rainVeil(RAIN_RANGE)), 1.0);
      return;
    }
    float t = hit.x;
    vec3 P = cameraPos + d * t;
    vec3 up = normalize(P + vec3(0.0, RE, 0.0));
    float r = length(P.xz);
    float footprint = t * pixelAngle;

    // Vento ciclonico (antiorario) con angolo di afflusso di ~20° (valore tipico, approssimazione).
    float speed = windSpeed(r);
    vec3 ws = waveSlope(P.xz, speed, footprint);
    vec3 n = normalize(up - vec3(ws.x, 0.0, ws.y) * 0.35);
    // S2.5: onde di Gerstner animate, orientate dal vento ciclonico (afflusso ~20°).
    vec2 radial2 = P.xz / max(r, 0.01);
    vec2 wdir = normalize(vec2(radial2.y, -radial2.x) - 0.36 * radial2);
    vec4 gw = vec4(0.0);
    if (s25Waves > 0.0) {
      // Nell'occhio il vento è debole ma il mare è molto agitato: onde generate nella parete che convergono
      // da tutte le direzioni (mare «confuso»). Ricostruzione plausibile, non misurata.
      float confused = 1.0 - smoothstep(rmw * 2.5, 60.0, r);
      float waveSpeed = max(speed, vmax * 0.6 * confused);
      gw = oceanWaves(P.xz, wdir, waveSpeed, footprint, confused);
      // Il dettaglio fine della S1 scorre con il vento (nel tempo), le onde lunghe danno la forma.
      vec3 ws2 = waveSlope(P.xz - wdir * time * 0.004, speed, footprint);
      n = normalize(up - vec3(ws2.x, 0.0, ws2.y) * 0.25 - vec3(gw.x, 0.0, gw.y));
    }
    float rough = clamp(0.07 + ws.z + 0.004 * speed, 0.07, 0.6);
    // S2.5.1: mare spettrale filtrato (sostituisce tessiture e treni d'onda della S2.5 quando attivo).
    bool spec = s251Ocean > 0.0;
    float mss = 0.0, crestS = 0.0, hN = 0.0, resF = 0.0, fp = footprint;
    if (spec) {
      float confused = 1.0 - smoothstep(rmw * 2.5, 60.0, r);
      // Impronta anisotropa: in vista radente il pixel copre molto più mare lungo la direzione di vista.
      fp = footprint / max(abs(dot(d, up)), 0.04);
      vec4 o = oceanSpectrum(P.xz, wdir, speed, vmax * 0.6 * confused, confused, fp, hN, resF);
      n = normalize(up - vec3(o.x, 0.0, o.y));
      mss = o.z;
      crestS = o.w;
    }

    // Luce che attraversa le nubi verso il Sole (densità di grande scala, senza dettaglio).
    float tauSun = 0.0;
    if (dot(up, sunDir) > 0.0) {
      float ds = 0.12;
      vec3 q = P + up * 0.05;
      for (int i = 0; i < 14; i++) {
        q += sunDir * ds;
        if (altitudeOf(q) > SHELL_TOP) break;
        float sg = macroSigma(q);
        // Vicino all'occhio l'ombra della parete segue i suoi lobi (bordo irregolare, non una linea retta).
        float hq = altitudeOf(q);
        float rq = length(q.xz);
        if (sg > 0.0 && rq < eyeRadius(hq) + 7.0)
          sg *= eyeMask(q, rq + (wallLobes(q, hq) - 0.5) * mix(2.6, 5.0, smoothstep(2.0, 12.0, hq)), hq, 0.6) / max(eyeMask(q, rq, hq, 2.0), 0.05);
        tauSun += sg * ds;
        ds = min(ds * 1.45, 4.0);
      }
    }
    vec4 m = mapAt(P.xz);
    float core = 1.0 - smoothstep(20.0, 44.0, r);
    float tauBlur = mix(m.b, 28.0, core);
    // Nell'occhio il cielo è visibile verso l'alto (frazione di volta celeste, approssimata).
    float eyeOpen = 1.0 - smoothstep(eyeRadius(0.0) - 1.0, eyeRadius(0.0) + 4.0, r);
    float direct = exp(-tauSun);
    float skyVis = mix(exp(-0.05 * tauBlur), 0.35, eyeOpen);
    float diffuse = 0.32 * exp(-0.035 * tauSun) * (1.0 - direct);
    vec3 sunT = sunTransmittance(P + vec3(0.0, RE, 0.0));

    vec3 v = -d;
    float nv = max(dot(n, v), 0.001);
    float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
    // S2.5.1: Fresnel medio sulle pendenze non risolte (in vista radente il mare mosso mostra facce rivolte
    // all'osservatore: riflette meno del vetro).
    if (spec) F = 0.02 + 0.98 * pow(1.0 - min(1.0, sqrt(nv * nv + 0.6 * mss)), 5.0);
    vec3 refl = reflect(d, n);
    // ...e riflette in media cielo più alto (più scuro all'orizzonte), come un mare reale.
    if (spec) refl = normalize(refl + up * 0.4 * sqrt(mss));
    float ru = dot(refl, up);
    if (ru < 0.01) refl += up * (0.01 - ru) * 2.0;
    refl = normalize(refl);
    vec3 trR;
    vec3 skyR = aerial(P + up * 0.002, refl, 1e5, 1.0, trR) + SKY_ISO * 0.4;
    // Sotto le nubi il mare riflette la loro base grigia.
    vec3 skyRefl = skyR * skyVis + vec3(0.2, 0.22, 0.25) * (diffuse + 0.04) * (1.0 - skyVis);
    if (spec && eyeOpen > 0.0) {
      // S2.5.1: nell'occhio i raggi riflessi bassi incontrano la parete (alta ~14 km), non il cielo: il mare
      // riflette le nubi grigie della parete sotto il loro angolo di elevazione, il cielo solo sopra.
      vec2 rd = normalize(refl.xz + vec2(1e-5, 0.0));
      float bq = dot(P.xz, rd), cq = dot(P.xz, P.xz) - sq(eyeRadius(6.0));
      float dWall = max(-bq + sqrt(max(bq * bq - cq, 0.0)), 0.3);
      float wallSin = 14.0 / sqrt(14.0 * 14.0 + dWall * dWall);
      float hits = 1.0 - smoothstep(wallSin - 0.06, wallSin + 0.06, ru);
      vec3 wallCol = vec3(0.6, 0.63, 0.68) * (SUN_COLOR * max(sunDir.y, 0.0) * 0.35 + SKY_AMBIENT * 0.4);
      skyRefl = mix(skyRefl, wallCol, hits * eyeOpen);
    }
    vec3 hv = normalize(sunDir + v);
    float nh = max(dot(n, hv), 0.0);
    float a2 = rough * rough;
    float D = exp((nh * nh - 1.0) / (a2 * nh * nh)) / (PI * a2 * pow(nh, 4.0) + 1e-4);
    if (spec) {
      // Beckmann con la varianza delle pendenze non risolte: riflesso del Sole stabile, nessun puntino isolato.
      float c2 = max(nh * nh, 1e-4);
      D = exp(-(1.0 - c2) / (c2 * mss)) / (PI * mss * c2 * c2);
    }
    float nl = max(dot(n, sunDir), 0.0);
    vec3 glint = SUN_COLOR * sunT * D * F * nl / (4.0 * nv * max(dot(up, sunDir), 0.05)) * direct;

    // Corpo dell'acqua: blu profondo del Golfo, variazioni lente di colore (approssimazione).
    float tint = texture(noiseTex, vec3(P.xz / 180.0, 0.31)).a;
    vec3 deep = mix(vec3(0.002, 0.012, 0.03), vec3(0.003, 0.02, 0.036), tint);
    // S2.5.1: oceano aperto sotto cielo coperto: blu-verde scuro, poco saturo.
    if (spec) deep = mix(vec3(0.004, 0.012, 0.021), vec3(0.005, 0.015, 0.024), tint);
    vec3 light = SUN_COLOR * sunT * max(dot(up, sunDir), 0.0) * direct + SKY_AMBIENT * skyVis + vec3(0.7) * diffuse;
    vec3 body = deep * light;
    // S2.5: le creste trasmettono un po' di luce (verde-azzurro): volume delle onde.
    if (s25Waves > 0.0 && !spec) body += vec3(0.004, 0.022, 0.026) * light * smoothstep(0.1, 0.9, gw.z) * smoothstep(8.0, 30.0, speed);
    if (spec) body += vec3(0.004, 0.016, 0.02) * light * smoothstep(0.3, 2.0, hN) * smoothstep(0.05, 0.4, resF) * smoothstep(6.0, 25.0, max(speed, vmax * 0.3));

    // Schiuma e strisce di spruzzi: crescono con il vento (copertura tipica, approssimazione).
    float foamCov = pow(smoothstep(9.0, 55.0, speed), 1.3) * 0.85;
    float streak = foamStreaks(P.xz, r);
    // Larghezza delle strisce ~ r/400: oltre il pixel si usa la copertura media.
    float foamFine = 1.0 - smoothstep(0.3, 1.2, (spec ? fp : footprint) / (r / 400.0 + 0.002));
    float foam = clamp(foamCov * mix(0.55, smoothstep(0.55 - foamCov * 0.5, 0.75, streak), foamFine), 0.0, 1.0);
    if (s25Waves > 0.0) {
      // S2.5: creste che si rompono (compressione elevata) e schiuma trascinata dal vento nel tempo.
      float crest = smoothstep(0.35, 0.9, gw.w) * smoothstep(12.0, 40.0, speed);
      float spume = texture(noiseTex, vec3((P.xz - wdir * time * speed * 3e-4) / 0.09, 0.71 + time * 0.003)).g;
      // La schiuma diffusa si raccoglie sulle creste e si apre nei cavi: le onde restano leggibili anche col mare in burrasca.
      float swell = smoothstep(0.15, 0.85, gw.z);
      foam = clamp(max(foam * (0.45 + 0.8 * spume) * mix(0.35, 1.25, swell), crest * (0.6 + 0.4 * spume)), 0.0, 1.0);
    }
    if (spec) {
      // S2.5.1: copertura delle creste bianche in funzione del vento (Monahan: W ≈ 3,8·10⁻⁶·U^3,41, satura in
      // uragano), a chiazze su scala chilometrica e allungata nelle strisce del vento forte. Dove le onde sono
      // risolte la schiuma sta sulle creste più ripide (soglia scelta per dare la stessa copertura); altrove
      // resta la copertura media, senza tessiture ripetute.
      float W = clamp(3.84e-6 * pow(speed, 3.41), 0.0, 0.45);
      float patchy = clamp(1.0 + 0.35 * gnoise(P.xz / 2.6 + 4.4) * 5.0 + 0.15 * gnoise(P.xz / 0.8 - 1.7) * 5.0, 0.15, 1.7);
      float strk = mix(1.0, mix(0.55, smoothstep(0.35, 0.8, streak) * 1.6, foamFine), smoothstep(18.0, 35.0, speed));
      // Soglia filtrata: il campo della schiuma è la somma di componenti a varianza unitaria (creste delle onde
      // risolte, frangenti di ~18 m e chiazze di ~50 m), ognuna pesata da quanto il pixel la risolve. La varianza
      // delle componenti non risolte allarga la soglia: copertura attesa = Φ((campo − soglia)/√varianza persa).
      // Vicino: frangenti piccoli e netti sulle creste; lontano: la stessa copertura media W, senza linee.
      // W (Monahan) comprende la schiuma residua: i frangenti attivi (bianchi) sono ~1/3, il resto è schiuma grigia.
      float Wl = clamp(W * patchy, 0.002, 0.6);
      float thrCore = gaussQuantile(Wl * 0.35), thrRes = gaussQuantile(Wl);
      float rf = smoothstep(0.08, 0.45, resF);
      float v1 = smoothstep(1.5 * fp, 4.0 * fp, 0.018), v2 = smoothstep(1.5 * fp, 4.0 * fp, 0.05);
      // gnoise ha deviazione standard 0,215 (misurata): × 4,65 → varianza unitaria.
      float field = 0.8 * rf * crestS + 0.45 * v1 * gnoise(rot(P.xz, 0.7) / 0.018) * 4.65 + 0.4 * v2 * gnoise(rot(P.xz, 2.3) / 0.05 + 9.1) * 4.65;
      float lost = 0.64 * (1.0 - rf * rf) + 0.2 * (1.0 - v1 * v1) + 0.16 * (1.0 - v2 * v2);
      float sd = sqrt(max(lost, 0.02));
      float core = 1.0 / (1.0 + exp(-1.702 * (field - thrCore) / sd));
      float residue = 0.3 / (1.0 + exp(-1.702 * (field - thrRes) / sqrt(lost + 0.08)));
      foam = clamp((core * 0.85 + residue * (1.0 - core)) * strk, 0.0, 0.9);
    }

    vec3 col = mix(body + skyRefl * F, vec3(0.6) * light * (spec ? 0.95 : 0.8), foam) + glint * (1.0 - foam);
    // S2.3: spruzzi marini (strappati dalle creste) solo dove il vento al suolo supera ~33 m/s (uragano):
    // velo chiaro sulla superficie, più evidente guardando radente da bassa quota.
    if (s23Vis > 0.5) {
      // S2.5.1: nessuna maschera netta sul raggio dell'occhio (disegnava una fascia): lo spruzzo segue il vento.
      float spray = smoothstep(33.0, 70.0, speed) * (spec ? 1.0 : 1.0 - eyeOpen);
      float graze = 1.0 - smoothstep(0.0, 0.5, dot(-d, up));
      // S2.5: lo spruzzo è trasportato dalle raffiche (tessitura che scorre col vento), non un velo fisso.
      float sprayMove = 1.0;
      if (s25Waves > 0.0 || spec) {
        float g = texture(noiseTex, vec3((P.xz - wdir * time * speed * 1.2e-3) / 0.6, 0.29 + time * 0.01)).r;
        sprayMove = 0.25 + 1.5 * g * g;
        // La tessitura dello spruzzo (~600 m) non deve ripetersi vista dall'alto: oltre ~20 m/pixel resta la media.
        if (spec) sprayMove = mix(sprayMove, 0.75, smoothstep(0.005, 0.02, fp));
      }
      col = mix(col, vec3(0.62, 0.66, 0.7) * light * 0.75, clamp(spray * (spec ? 0.08 + 0.25 * graze : 0.18 + 0.4 * graze) * sprayMove, 0.0, 0.8));
    }

    if (spec) {
      // S2.5.1: cortina di pioggia della parete fino alla superficie. Senza, in vista radente si vedeva il mare
      // lontano «sotto» la base della parete, con una linea netta all'orizzonte. Tratto del raggio sotto ~2 km
      // dentro l'anello della parete (intersezione esatta, nessun campionamento), estinzione ~0,3/km.
      float h0 = altitudeOf(cameraPos);
      float sb = h0 > 2.0 ? t * (h0 - 2.0) / h0 : 0.0;
      float s0 = max(sb, rainExt > 0.0 ? RAIN_RANGE : 0.0);
      float Lw = insideCircle(cameraPos.xz, d.xz, rmw * 2.3, s0, t) - insideCircle(cameraPos.xz, d.xz, EYE_R0 + 1.5, s0, t);
      vec3 curtain = vec3(0.62, 0.66, 0.72) * (SUN_COLOR * max(sunDir.y, 0.0) * 0.22 + SKY_AMBIENT * 0.45) / 4.5;
      col = mix(col, curtain, 1.0 - exp(-0.3 * max(Lw, 0.0)));
    }
    // Prospettiva aerea fino al mare; sotto le nubi la foschia bassa è in ombra.
    // S2.5: il lampo illumina il mare vicino (riflesso diffuso sotto la nube).
    col += flashLight(P + up * 1.5) * (0.04 + 0.2 * F);
    vec3 tr;
    vec3 ins = aerial(cameraPos, d, t, mix(direct, 1.0, 0.2), tr);
    outColor = vec4(mix(col * tr + ins, rainColor, rainVeil(t)), 1.0);
  }
`;

/**
 * Nubi: ray marching di un pixel ogni blocco N×N della ricostruzione (posizione a rotazione).
 * Uscite: luce diffusa e trasmittanza; distanza rappresentativa (per la riproiezione).
 */
export const cloudFragment = /* glsl */ `
  ${commonGlsl}
  uniform mat4 projectionInverse;
  uniform mat4 cameraWorld;
  uniform float pixelAngle;
  uniform int maxSteps;
  uniform vec2 reconSize;
  uniform vec2 traceOffset;
  uniform float traceStride;
  layout(location = 0) out vec4 outColor;
  layout(location = 1) out vec4 outDepth;

  void main() {
    // Posizione nel pixel variabile a ogni passata (sequenza R2): l'accumulo temporale fa da antialias.
    float pass = floor(frame / (traceStride * traceStride));
    vec2 sub = fract(vec2(0.7548777, 0.5698403) * pass + 0.5);
    vec2 px = floor(gl_FragCoord.xy) * traceStride + traceOffset + sub;
    vec4 view = projectionInverse * vec4(px / reconSize * 2.0 - 1.0, 1.0, 1.0);
    vec3 d = normalize((cameraWorld * vec4(view.xyz / view.w, 0.0)).xyz);
    vec3 o = cameraPos;
    vec2 outer = sphere(o, d, SHELL_TOP);
    vec4 result = vec4(0.0, 0.0, 0.0, 1.0);
    float depthOut = 0.0;
    if (outer.y > 0.0) {
      float t0 = max(outer.x, 0.0);
      float t1 = outer.y;
      vec2 ground = sphere(o, d, 0.0);
      if (ground.x > 0.0) t1 = min(t1, ground.x);
      // Solo entro il disco della tempesta.
      vec2 oc = o.xz;
      vec2 dc = d.xz;
      float a = dot(dc, dc);
      float b = dot(oc, dc);
      float c = dot(oc, oc) - STORM_R * STORM_R;
      float disc = b * b - a * c;
      if (disc > 0.0 && a > 1e-8) {
        float s = sqrt(disc);
        t0 = max(t0, (-b - s) / a);
        t1 = min(t1, (-b + s) / a);
      } else if (c > 0.0) t1 = -1.0;

      if (t1 > t0) {
        float len = t1 - t0;
        float dtBase = max(len / float(maxSteps), 0.03);
        // Rumore a bassa discrepanza: diverso per pixel e per passata (l'accumulo temporale lo media).
        float ign = fract(52.9829189 * fract(dot(floor(px), vec2(0.06711056, 0.00583715))));
        float jitter = fract(ign + 0.6180339887 * pass);
        if (fogJitter > 0.0) {
          // S2 con la telecamera nella nebbia: resta poca storia e la trama diagonale di quel rumore si vedrebbe;
          // rumore senza struttura (hash), che appare come grana fine. Fuori dalla nebbia si usa l'altro, che
          // l'accumulo temporale media meglio sui bordi delle nubi.
          uvec2 q = uvec2(floor(px)) * uvec2(1597334673u, 3812015801u) ^ uvec2(uint(pass) * 2654435761u);
          uint hn = (q.x ^ q.y) * 1597334673u;
          hn ^= hn >> 15u;
          hn *= 2246822519u;
          hn ^= hn >> 13u;
          jitter = float(hn) * (1.0 / 4294967296.0);
        }
        float dt0 = clamp(max(dtBase, t0 * pixelAngle * 0.5), 0.03, 2.5);
        float t = t0 + jitter * min(dt0, max(0.06, t0 * 0.03));
        vec3 scatter = vec3(0.0);
        float T = 1.0;
        float depthAcc = 0.0;
        float wAcc = 0.0;
        float mu = dot(d, sunDir);
        float ph = mix(phaseHG(mu, -0.2), phaseHG(mu, 0.72), 0.65);
        // Passo fine all'ingresso in una nube: indietro di un passo, poi passi limitati dallo spessore
        // ottico (≤ ~1 per passo), così la luce è valutata vicino alla superficie e non a profondità casuale.
        float fine = 0.0;
        float sigPrev = 0.0;
        vec3 Slast = vec3(0.0);
        bool lit = false;
        bool truncated = false;
        bool startInside = false;
        float tHalf = 0.0;
        float litAge = 0.0;
        for (int i = 0; i < 400; i++) {
          if (i >= maxSteps) { truncated = true; break; }
          if (t > t1 || T < 0.02) break;
          float fp = t * pixelAngle;
          float dt = clamp(max(dtBase, fp * 0.5), 0.03, 2.5);
          dt = min(dt, max(0.06, t * 0.03));
          // Con la telecamera già dentro la nube non c'è una superficie da raffinare: passi dallo spessore ottico.
          if (fine > 0.0) dt = clamp(0.9 / max(sigPrev, 1e-3), max(fp * 0.6, 0.012), startInside ? max(0.045, t * 0.03) : max(dt * 0.25, fp * 0.6));
          vec3 p = o + d * t;
          if (fine == 0.0 && macroSigma(p) < 1e-4 && altitudeOf(p) > 0.4) {
            // Spazio vuoto (sopra la sommità, nell'occhio): passo lungo. Margine per il rilievo.
            Column c = column(p);
            float h = altitudeOf(p);
            bool clear = c.mask < 0.001 || h > c.top + 4.0 || (c.r < eyeRadius(h) - 4.0 && h > 2.4);
            if (clear) { t += dt * 2.2; continue; }
          }
          Ctx ctx = context(p);
          // S2.1: dettaglio per distanza (nubi lontane a volo radente: centinaia di km di raggio).
          int lvl = farLod.x > 0.0 ? (t > farLod.y ? 0 : t > farLod.x ? 1 : 2) : 2;
          vec3 dens = densityCtx(p, ctx, fp, lvl);
          float sig = dens.x;
          if (i == 0 && sig > 1e-3) startInside = true;
          if (sig > 1e-3 && fine == 0.0 && i > 0) {
            fine = 1.0;
            sigPrev = 0.0;
            t = max(t0, t - dt * 0.95);
            continue;
          }
          if (fine > 0.0 && sig <= 1e-3) fine = max(fine - 0.25, 0.0);
          // Passo opaco al primo contatto (vista lontana): ricerca della superficie per bisezione, così la
          // luce è valutata sul bordo visibile e non a una profondità casuale (che spegne il rilievo).
          if (sig * dt > 2.0 && T > 0.6) {
            float ta = t - dt, tb = t;
            for (int k = 0; k < 3; k++) {
              float tm = 0.5 * (ta + tb);
              if (densityCtx(o + d * tm, ctx, fp, 1).x * dt > 1.0) tb = tm; else ta = tm;
            }
            dt = t + dt - tb;
            t = tb;
            p = o + d * t;
            dens = densityCtx(p, ctx, fp, lvl);
            sig = dens.x;
          }
          sigPrev = sig;
          if (sig > 1e-3) {
            vec3 S;
            litAge += 1.0;
            if (dens.z < 0.0) {
              // Cortine di pioggia: luce del cielo e del Sole filtrate dalle nubi sovrastanti (grigio-azzurro).
              float skyV = exp(-0.12 * upDepth(p + normalize(p + vec3(0.0, RE, 0.0)) * 2.0));
              S = (SUN_COLOR * 0.05 * skyV * max(sunDir.y, 0.0) + SKY_AMBIENT * (0.12 + 0.5 * skyV)) * vec3(0.92, 0.96, 1.0);
            } else if ((T < 0.25 || (farReuse > 0.0 && (t > 6.0 || startInside) && litAge < 3.0)) && lit) {
              // Dietro una superficie quasi opaca (contributo < 25%): luce del campione precedente, attenuata.
              S = Slast * (T < 0.25 ? 0.85 : 1.0);
            } else {
              // Già in parte opaca: ombra più grossolana (solo il primo passo con la forma completa).
              float tauS = sunDepth(p, ctx, fp, T < 0.35 || (farLod.x > 0.0 && t > farLod.x));
              // Diffusione multipla approssimata (somma di ottave attenuate).
              float ms = 0.0;
              float aa = 1.0, bb = 1.0, cc = 1.0;
              for (int k = 0; k < 4; k++) {
                ms += aa * exp(-bb * tauS) * mix(1.0 / (4.0 * PI), ph, cc);
                aa *= 0.5; bb *= 0.4; cc *= 0.5;
              }
              // Cielo: visibilità verso l'alto; nell'occhio anche la luce riflessa dalle pareti al sole,
              // che arriva dall'asse dell'occhio: le rientranze dei lobi ne ricevono meno.
              float skyVis = exp(-0.16 * upDepth(p));
              float hgt = altitudeOf(p);
              float occ = 1.0;
              if (dens.y > 0.03) {
                vec3 inward = normalize(vec3(-p.x, 0.0, -p.z) + vec3(0.0, 0.35, 0.0));
                // Scala dei lobi (un campione sul dettaglio fine disegnerebbe scaglie scure).
                float tb = densityCtx(p + inward * 0.5, ctx, fp, 0).x * 0.5;
                occ = exp(-0.8 * tb);
              }
              vec3 amb = SKY_AMBIENT * (0.035 + 0.5 * skyVis) * mix(0.45, 1.0, smoothstep(0.0, 12.0, hgt)) * mix(1.0, occ, 0.6 * dens.y);
              vec3 bounce = SUN_COLOR * vec3(0.95, 0.97, 1.0) * 0.06 * dens.y * occ;
              // Tessitura osservata (albedo GOES a ~2,8 km, deviazione ~0,06 nel CDO) nelle nubi spesse:
              // ombre e torri reali delle 20:01 UTC, riportate come variazione di luminosità.
              float tex = mix(1.0, clamp(1.0 + 1.6 * (dens.z - 0.88), 0.75, 1.15), smoothstep(0.4, 0.8, dens.z));
              S = (SUN_COLOR * ms * 3.0 + amb + bounce) * tex;
              float wIn = interiorLight * exp(-t / 0.8);
              if (wIn > 0.01) {
                // Le nubi vicine alla telecamera ricevono la luce diffusa; più lontano prevale la stima
                // (più scura) della diffusione multipla: grumi chiari davanti, profondità grigia dietro.
                S = max(S, interiorDiffuse(p, ctx.c) * wIn);
              }
              Slast = S;
              lit = true;
              litAge = 0.0;
            }
            float ext = exp(-sig * dt);
            scatter += T * S * (1.0 - ext);
            float wgt = T * (1.0 - ext);
            // S2.1: distanza in cui l'opacità accumulata supera il 30% (la superficie che si vede).
            if (tHalf == 0.0 && T * ext < 0.7) tHalf = t;
            depthAcc += t * wgt;
            wAcc += wgt;
            T *= ext;
          }
          t += dt;
        }
        // S2, telecamera dentro la nube: se i passi finiscono ancora in nube, il resto è nube (non lo sfondo
        // di cielo e mare, che disegnerebbe un orizzonte netto attraverso la nebbia).
        if (truncated && interiorLight > 0.0 && sigPrev > 0.05 && lit) {
          scatter += T * Slast;
          depthAcc += t * T;
          wAcc += T;
          T = 0.0;
        }
        if (wAcc > 0.0) {
          float tc = depthAcc / wAcc;
          // S2.1: per la riproiezione la distanza della superficie visibile (opacità 30%); la media pesata
          // includerebbe veli quasi trasparenti vicino alla telecamera e farebbe trattare il cielo come
          // vicinissimo: la storia verrebbe stirata radialmente a ogni spostamento (scie, briciole, tasselli).
          depthOut = interiorLight == 0.0 ? tc : tHalf;
          // Aria tra la camera e le nubi.
          vec3 tr;
          vec3 ins = aerial(o, d, tc, 1.0, tr);
          scatter = scatter * tr + ins * (1.0 - T);
        }
        // Pioggia tra la telecamera e la nube: la nube si vela come il mare alla stessa distanza.
        if (rainExt > 0.0) {
          float v = rainVeil(depthOut > 0.0 ? depthOut : (wAcc > 0.0 ? depthAcc / wAcc : RAIN_RANGE));
          scatter = mix(scatter, rainColor * (1.0 - T), v);
        }
        result = vec4(scatter, T);
      }
    }
    outColor = result;
    outDepth = vec4(depthOut, 0.0, 0.0, 1.0);
  }
`;

/**
 * Ricostruzione temporale: ogni pixel riceve un campione nuovo ogni N² frame; negli altri frame si usa
 * la storia riproiettata con la distanza delle nubi, limitata ai valori dei campioni vicini (niente scie).
 */
export const reconFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D traceColor;
  uniform sampler2D traceDepth;
  uniform sampler2D history;
  uniform mat4 prevViewProj;
  uniform vec3 cameraPos;
  uniform vec2 traceOffset;
  uniform float traceStride;
  uniform vec2 reconSize;
  uniform float historyValid;
  uniform float alphaNew;
  uniform float clampAmount;
  /** In movimento, quota del campione interpolato del frame corrente nei pixel senza campione nuovo. */
  uniform float motionBlend;
  uniform float motionSmooth;
  /** S2.1: «movimento» = errore di riproiezione dovuto alla profondità incerta (non lo spostamento). */
  uniform float parallaxMode;
  uniform float fogJitter;
  uniform float reconDiag;
  /** S2.2: movimento rapido della telecamera (velocità narrative di CINEMA): limite e accumulo più brevi. */
  uniform float fastMotion;
  /** S2.3: distanza vera dello sfondo (mare o cielo) nella riproiezione, invece di 3000 km fissi. */
  uniform float s23Fix;
  uniform float cameraAlt;
  in vec2 vUv;

  /** Distanza del mare lungo il raggio (sfera terrestre, forma stabile), o lontanissimo se il raggio va in cielo. */
  float backgroundDist(vec3 d) {
    if (s23Fix < 0.5) return 3000.0;
    const float RE = 6371.0;
    vec3 oc = cameraPos + vec3(0.0, RE, 0.0);
    float b = dot(oc, d);
    float c = cameraAlt * (2.0 * RE + cameraAlt);
    float disc = b * b - c;
    if (disc < 0.0 || b > 0.0) return 1e5;
    return c / (-b + sqrt(disc));
  }
  in vec3 vRay;
  out vec4 outColor;

  vec4 catmullRom(sampler2D tex, vec2 uv) {
    vec2 size = vec2(textureSize(tex, 0));
    vec2 sp = uv * size;
    vec2 p1 = floor(sp - 0.5) + 0.5;
    vec2 f = sp - p1;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2;
    vec2 q0 = (p1 - 1.0) / size;
    vec2 q3 = (p1 + 2.0) / size;
    vec2 q12 = (p1 + w2 / w12) / size;
    vec4 r = texture(tex, vec2(q12.x, q0.y)) * w12.x * w0.y
           + texture(tex, vec2(q0.x, q12.y)) * w0.x * w12.y
           + texture(tex, q12) * w12.x * w12.y
           + texture(tex, vec2(q3.x, q12.y)) * w3.x * w12.y
           + texture(tex, vec2(q12.x, q3.y)) * w12.x * w3.y;
    return r / (w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y);
  }

  void main() {
    vec2 q = floor(gl_FragCoord.xy);
    vec2 block = floor(q / traceStride);
    ivec2 tsz = textureSize(traceColor, 0);
    ivec2 bt = min(ivec2(block), tsz - 1);
    bool fresh = all(equal(q - block * traceStride, traceOffset));
    vec4 cur = texelFetch(traceColor, bt, 0);

    // Vicinato 3×3 dei campioni di questo frame: media, varianza, estremi.
    vec4 m1 = vec4(0.0), m2 = vec4(0.0), lo = vec4(1e9), hi = vec4(-1e9);
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec4 s = texelFetch(traceColor, clamp(bt + ivec2(x, y), ivec2(0), tsz - 1), 0);
        m1 += s; m2 += s * s; lo = min(lo, s); hi = max(hi, s);
      }
    m1 /= 9.0;
    vec4 sd = sqrt(max(m2 / 9.0 - m1 * m1, 0.0));
    vec4 boxLo = max(lo, m1 - 1.25 * sd), boxHi = min(hi, m1 + 1.25 * sd);
    // A camera ferma nessun limite (i campioni sparsi del vicinato cancellerebbero i bordi netti),
    // in movimento limite stretto (niente scie).
    vec4 span = hi - lo;
    boxLo = mix(vec4(-1e4), boxLo, clampAmount);
    boxHi = mix(vec4(1e4), boxHi, clampAmount);

    // Interpolazione dei campioni di questo frame alla posizione del pixel (ripiego senza storia).
    vec2 tuv = ((q - traceOffset) / traceStride + 0.5) / vec2(tsz);
    vec4 interp = texture(traceColor, tuv);

    // Riproiezione: punto alla distanza rappresentativa delle nubi (o lontano, se non ci sono nubi).
    float depth = texelFetch(traceDepth, bt, 0).r;
    vec3 dir = normalize(vRay);
    float bgd = backgroundDist(dir);
    vec4 clip = prevViewProj * vec4(cameraPos + dir * (depth > 0.0 ? depth : bgd), 1.0);
    vec2 puv = clip.xy / clip.w * 0.5 + 0.5;
    bool inside = clip.w > 0.0 && all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0)));
    vec4 res;
    float motion = clamp(length((puv - vUv) * reconSize) / 3.0, 0.0, 1.0);
    if (parallaxMode > 0.5) {
      // Una rotazione si riproietta esattamente a ogni distanza: conta solo la parallasse della traslazione,
      // stimata tra la nube più vicina del vicinato e la più lontana. Lì (nebbia vicina, bordi tra nubi a
      // distanze diverse) si usa il frame corrente e il limite sui vicini; altrove la storia resta nitida.
      float dmin = 1e5, dmax = 0.0;
      for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
          // Solo i campioni con nubi: il cielo (o il mare) dietro un bordo non ha una distanza propria e
          // contarlo come lontanissimo segnerebbe ogni contorno come «in movimento» (bordi sgranati in virata).
          float dz = texelFetch(traceDepth, clamp(bt + ivec2(x, y), ivec2(0), tsz - 1), 0).r;
          // S2.3: anche lo sfondo, alla sua distanza vera: ai bordi tra nube vicina e cielo la parallasse della
          // traslazione scopre cielo che nella storia era nube (disocclusione) e il limite sui vicini deve agire.
          // (Le rotazioni non danno errore a nessuna distanza.)
          if (dz <= 0.0 && s23Fix > 0.5) dz = bgd;
          if (dz <= 0.0) continue;
          dmin = min(dmin, dz);
          dmax = max(dmax, dz);
        }
      if (dmax <= 0.0) { dmin = bgd; dmax = bgd; }
      vec4 cn = prevViewProj * vec4(cameraPos + dir * dmin * 0.8, 1.0);
      vec4 cf = prevViewProj * vec4(cameraPos + dir * min(dmax * 1.25, s23Fix > 0.5 ? max(bgd, dmax * 1.25) : 3000.0), 1.0);
      float err = length((cn.xy / cn.w - cf.xy / cf.w) * 0.5 * reconSize);
      motion = clamp((err - 0.5) / 1.5, 0.0, 1.0);
      float lim = clamp(err, 0.0, 1.0);
      if (reconDiag > 0.5) { motion = 0.0; lim = 0.0; }
      lim = max(lim, fastMotion);
      motion = max(motion, 0.5 * fastMotion);
      boxLo = mix(vec4(-1e4), max(lo, m1 - 1.25 * sd), lim);
      boxHi = mix(vec4(1e4), min(hi, m1 + 1.25 * sd), lim);
    }
    if (historyValid < 0.5 || !inside) {
      // S2.3: senza storia solo interpolazione (i campioni esatti sparsi tra quelli interpolati fanno un retino).
      res = fresh && s23Fix < 0.5 ? cur : interp;
    } else {
      vec4 hist = clamp(catmullRom(history, puv), boxLo, boxHi);
      // S2.1: dove la riproiezione è affidabile si accumula di più (α fino a 0,1, ~19 campioni): le nubi
      // sottili viste di lato (colpito o mancato a ogni campione) altrimenti restano granulose.
      float aNew = parallaxMode > 0.5 ? mix(0.1, 0.6, motion) : mix(alphaNew, 0.6, motion);
      // S2.1: con parallasse la storia, limitata ai vicini, resta la base (l'interpolazione del frame corrente,
      // a un terzo della risoluzione, darebbe tasselli); se ne usa solo una parte.
      // Nella nebbia (telecamera in nube) la parallasse è estrema e la nebbia uniforme: frame corrente.
      float blendK = parallaxMode > 0.5 && fogJitter < 0.5 ? 0.35 : motionBlend;
      // (In nebbia, S2.1: solo interpolazione anche nei pixel con campione nuovo, niente trama a griglia.)
      float smoothK = parallaxMode > 0.5 ? (fogJitter < 0.5 ? 0.25 : 1.0) : motionSmooth;
      res = fresh ? mix(hist, cur, aNew) : mix(hist, interp, blendK * motion);
      // S2: in movimento anche i pixel con campione nuovo tendono all'interpolazione (niente scacchiera).
      res = mix(res, interp, smoothK * motion);
      // S2.3: disocclusione (cielo che nella storia era nube, o viceversa) dove c'è parallasse di traslazione:
      // la storia non vale; il frame corrente prevale subito, invece di svanire in secondi (tende verticali).
      if (s23Fix > 0.5 && motion > 0.02) {
        float dA = abs(hist.a - interp.a);
        res = mix(res, fresh ? cur : interp, smoothstep(0.15, 0.45, dA) * smoothstep(0.02, 0.3, motion));
      }
      // Nessuna nube nei campioni attuali del vicinato (cielo o mare liberi): ogni nube nella storia è un fantasma.
      if (s23Fix > 0.5) res = mix(res, interp, smoothstep(0.93, 0.985, lo.a));
    }
    outColor = max(res, vec4(0.0));
    if (reconDiag > 2.5) { vec2 dpx = (puv - vUv) * reconSize; outColor = vec4(clamp(abs(dpx.x) / 5.0, 0.0, 1.0), clamp(abs(dpx.y) / 5.0, 0.0, 1.0), 0.0, 0.0); return; }
    if (reconDiag > 1.5) outColor = depth > 0.0 ? vec4(clamp(log2(depth + 1.0) / 12.0, 0.0, 1.0), clamp(1.0 - depth, 0.0, 1.0), 0.0, 0.0) * 4.0 : vec4(0.0, 0.0, 4.0, 0.0);
  }
`;

export const compositeFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D oceanTex;
  uniform sampler2D cloudTex;
  uniform float exposure;
  uniform float frame;
  uniform int debugMode;
  /** S2.2: lampo (0–1), illumina soprattutto le nubi. */
  uniform float flash;
  /** S2.5: lampo localizzato. flashNdc = posizione sullo schermo (xy) e validità (z); flashSize = raggio
   *  apparente (unità NDC verticali); flashGlow = intensità; aspect = larghezza/altezza. */
  uniform vec3 flashNdc;
  uniform float flashSize;
  uniform float flashGlow;
  uniform float aspect;
  in vec2 vUv;
  out vec4 outColor;

  vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }
  vec3 toSrgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }

  /** Ingrandimento bicubico (Catmull-Rom) limitato ai 4 campioni vicini: nitido, senza aloni. */
  vec4 upsample(sampler2D tex, vec2 uv) {
    vec2 size = vec2(textureSize(tex, 0));
    vec2 sp = uv * size;
    vec2 p1 = floor(sp - 0.5) + 0.5;
    vec2 f = sp - p1;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2;
    vec2 q0 = (p1 - 1.0) / size;
    vec2 q3 = (p1 + 2.0) / size;
    vec2 q12 = (p1 + w2 / w12) / size;
    vec4 r = texture(tex, vec2(q12.x, q0.y)) * w12.x * w0.y
           + texture(tex, vec2(q0.x, q12.y)) * w0.x * w12.y
           + texture(tex, q12) * w12.x * w12.y
           + texture(tex, vec2(q3.x, q12.y)) * w3.x * w12.y
           + texture(tex, vec2(q12.x, q3.y)) * w12.x * w3.y;
    r /= w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
    vec2 b = p1 / size;
    vec2 e = 1.0 / size;
    vec4 a00 = texture(tex, b), a10 = texture(tex, b + vec2(e.x, 0.0)), a01 = texture(tex, b + vec2(0.0, e.y)), a11 = texture(tex, b + e);
    return clamp(r, min(min(a00, a10), min(a01, a11)), max(max(a00, a10), max(a01, a11)));
  }

  void main() {
    vec3 sea = texture(oceanTex, vUv).rgb;
    vec4 cl = upsample(cloudTex, vUv);
    cl.a = clamp(cl.a, 0.0, 1.0);
    vec3 c = sea * cl.a + cl.rgb;
    if (debugMode > 0) {
      vec3 v = debugMode == 1 ? sea : debugMode == 2 ? cl.rgb : vec3(cl.a);
      bool bad = any(isnan(v)) || any(isinf(v));
      outColor = bad ? vec4(1.0, 0.0, 1.0, 1.0) : vec4(clamp(v, 0.0, 1.0), 1.0);
      return;
    }
    c += vec3(0.75, 0.82, 1.0) * flash * (0.25 + 1.2 * (1.0 - cl.a));
    if (flashGlow > 0.0 && flashNdc.z > 0.0) {
      // S2.5: la nube attorno al canale si accende (luce diffusa, nella composizione: nessun artefatto della
      // ricostruzione temporale); un alone più debole nell'aria piovosa vicina.
      vec2 dn = (vUv * 2.0 - 1.0 - flashNdc.xy) * vec2(aspect, 1.0) / max(flashSize, 1e-4);
      float q = dot(dn, dn);
      float lit = exp(-q * 1.4) + 0.12 * exp(-q * 0.2);
      // La luce resta nella nube (la sua tessitura); il mare è illuminato a parte, nel suo passaggio.
      float cloudLum = dot(cl.rgb, vec3(0.3, 0.5, 0.2)) / max(1.0 - cl.a, 0.05);
      c += vec3(0.72, 0.8, 1.0) * flashGlow * lit * (1.0 - cl.a) * mix(0.6, 1.3, smoothstep(0.0, 1.5, cloudLum));
    }
    c = toSrgb(aces(c * exposure));
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy + frame * 1.7, vec2(0.06711056, 0.00583715))));
    outColor = vec4(c + (n - 0.5) / 255.0, 1.0);
  }
`;

/** Rumore 3D periodico (64³): R Perlin-Worley (forma), G e B Worley a più ottave (dettaglio), A Perlin. */
export const noiseFragment = /* glsl */ `
  precision highp float;
  precision highp int;
  uniform float layer;
  uniform float size;
  in vec2 vUv;
  out vec4 outColor;

  uvec3 pcg3(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
  }
  vec3 hash3(ivec3 c, int period, uint seed) {
    ivec3 w = ((c % period) + period) % period;
    return vec3(pcg3(uvec3(w) + uvec3(seed, seed * 7u, seed * 13u))) / 4294967295.0;
  }
  float worley(vec3 p, int F, uint seed) {
    vec3 q = p * float(F);
    ivec3 i = ivec3(floor(q));
    vec3 f = fract(q);
    float best = 1e9;
    for (int z = -1; z <= 1; z++)
      for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
          ivec3 o = ivec3(x, y, z);
          vec3 pt = vec3(o) + hash3(i + o, F, seed);
          vec3 dv = pt - f;
          best = min(best, dot(dv, dv));
        }
    return 1.0 - clamp(sqrt(best), 0.0, 1.0);
  }
  float perlin(vec3 p, int F, uint seed) {
    vec3 q = p * float(F);
    ivec3 i = ivec3(floor(q));
    vec3 f = fract(q);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float v[8];
    for (int k = 0; k < 8; k++) {
      ivec3 o = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
      vec3 g = normalize(hash3(i + o, F, seed) * 2.0 - 1.0);
      v[k] = dot(g, f - vec3(o));
    }
    float x0 = mix(mix(v[0], v[1], u.x), mix(v[2], v[3], u.x), u.y);
    float x1 = mix(mix(v[4], v[5], u.x), mix(v[6], v[7], u.x), u.y);
    return mix(x0, x1, u.z) * 0.5 + 0.5;
  }
  float worleyFbm(vec3 p, int F, uint seed) {
    return worley(p, F, seed) * 0.625 + worley(p, F * 2, seed + 1u) * 0.25 + worley(p, F * 4, seed + 2u) * 0.125;
  }
  float perlinFbm(vec3 p, int F, uint seed) {
    return perlin(p, F, seed) * 0.57 + perlin(p, F * 2, seed + 3u) * 0.28 + perlin(p, F * 4, seed + 4u) * 0.15;
  }

  void main() {
    vec3 p = vec3(vUv, (layer + 0.5) / size);
    float pf = perlinFbm(p, 3, 11u);
    float wf = worleyFbm(p, 3, 21u);
    float pw = clamp((pf - (wf - 1.0)) / (1.0 - (wf - 1.0)), 0.0, 1.0);
    pw = clamp((pw - 0.35) / 0.6, 0.0, 1.0);
    outColor = vec4(pw, worleyFbm(p, 4, 31u), worleyFbm(p, 8, 41u), perlinFbm(p, 2, 51u));
  }
`;

/** Pendenze delle onde (256², periodica): somma di onde con dispersione direzionale attorno a +x. */
export const waveFragment = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
  void main() {
    vec2 g = vec2(0.0);
    float hsum = 0.0;
    for (int i = 0; i < 56; i++) {
      float fi = float(i);
      float k = floor(2.0 + pow(h1(fi), 1.6) * 22.0);
      float ang = (h1(fi + 31.0) - 0.5) * 2.2;
      vec2 kv = floor(vec2(cos(ang), sin(ang)) * k + 0.5);
      if (dot(kv, kv) < 1.0) continue;
      float kl = length(kv);
      float amp = pow(cos(ang * 0.6), 2.0) / (kl * kl) * 1.0;
      float ph = h1(fi + 77.0) * 6.2831;
      float arg = 6.2831 * dot(kv, vUv) + ph;
      g += amp * kl * cos(arg) * kv / kl;
      hsum += amp * sin(arg);
    }
    outColor = vec4(g * 2.2 * 0.5 + 0.5, hsum * 4.0 + 0.5, 1.0);
  }
`;
