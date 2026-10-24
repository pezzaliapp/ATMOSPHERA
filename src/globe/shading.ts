/**
 * Frammenti GLSL condivisi tra superficie e nuvole.
 * Effetti ILLUSTRATIVI: approssimano l'aspetto dell'atmosfera, non sono misure.
 */

/**
 * Prospettiva aerea: più lungo è il percorso dello sguardo nell'atmosfera
 * (cioè più radente rispetto alla superficie), più il colore sfuma verso la foschia azzurra.
 */
export const aerialPerspective = /* glsl */ `
  vec3 applyHaze(vec3 color, vec3 n, vec3 v, vec3 l, vec3 hazeColor) {
    float mu = max(dot(n, v), 0.0);
    float airmass = 1.0 / (mu + 0.035);
    float haze = 1.0 - exp(-0.05 * airmass);
    float sunlit = smoothstep(-0.25, 0.35, dot(n, l));
    // Lato in ombra: la foschia diventa scura invece di schiarire.
    vec3 tint = hazeColor * (0.12 + 0.88 * sunlit);
    return mix(color, tint, clamp(haze, 0.0, 0.85));
  }
`;

/**
 * Modello delle nubi a partire dalle grandezze OSSERVATE da GOES-16 (vedi scripts/data/goes_clouds.py):
 *   albedo apparente (canale 2, visibile) e temperatura di brillanza (canale 13, infrarosso).
 * Opacità e altezza sono una RICOSTRUZIONE semplificata:
 *   - di giorno l'opacità segue l'albedo visibile sopra quella del mare (≈0,06): i cirri sottili
 *     restano semitrasparenti anche se freddi; di notte (dayWeight = 0) si usa l'infrarosso;
 *   - le superfici calde (terre assolate) non sono nubi anche se chiare;
 *   - altezza della sommità dal gradiente termico standard 6,5 K/km sopra un mare a 300 K.
 */
export const cloudModel = /* glsl */ `
  const float BT_MIN = 180.0;
  const float BT_MAX = 310.0;
  const float EARTH_RADIUS_KM = 6371.0;

  float decodeBT(float v) { return BT_MIN + v * (BT_MAX - BT_MIN); }

  float cloudOpacity(float albedo, float bt, float dayWeight) {
    float notHotGround = smoothstep(304.0, 297.0, bt);
    float vis = pow(clamp((albedo - 0.09) / 0.55, 0.0, 1.0), 0.85) * notHotGround;
    float ir = smoothstep(288.0, 225.0, bt) * 0.9;
    return clamp(mix(ir, vis, dayWeight), 0.0, 1.0);
  }

  float cloudTopKm(float bt) { return clamp((300.0 - bt) / 6.5, 0.0, 16.0); }

  /** Coordinate (0–1) nella regione; fuori dalla regione restituisce valori esterni a [0, 1]. */
  vec2 regionUv(vec2 latLon, vec4 bounds) {
    return vec2((latLon.y - bounds.x) / (bounds.z - bounds.x), (latLon.x - bounds.y) / (bounds.w - bounds.y));
  }

  /** Sfumatura ai bordi della regione (evita tagli netti). */
  float regionMask(vec2 uv) {
    vec2 e = smoothstep(vec2(0.0), vec2(0.015), uv) * smoothstep(vec2(1.0), vec2(0.985), uv);
    return e.x * e.y;
  }
`;
