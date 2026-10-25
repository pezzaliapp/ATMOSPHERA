import { BufferAttribute, BufferGeometry, Color, MeshBasicMaterial, MeshPhysicalMaterial, DoubleSide, Vector2, Vector3, type Texture } from 'three';

/**
 * Strumenti di forma per i concept VTOL (FLIGHT 2.0): superfici raccordate tra sezioni,
 * profili alari, materiali comuni. Tutto originale, generato dal codice.
 */

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Facce verso l'esterno: se le normali puntano in media verso il baricentro si invertono i triangoli. */
export function orientOutward(g: BufferGeometry): BufferGeometry {
  g.computeVertexNormals();
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const c = new Vector3();
  for (let i = 0; i < p.count; i++) c.add(new Vector3(p.getX(i), p.getY(i), p.getZ(i)));
  c.divideScalar(p.count);
  let score = 0;
  for (let i = 0; i < p.count; i++) score += (p.getX(i) - c.x) * n.getX(i) + (p.getY(i) - c.y) * n.getY(i) + (p.getZ(i) - c.z) * n.getZ(i);
  if (score < 0) {
    const index = g.getIndex()!;
    const arr = index.array as Uint16Array | Uint32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const t = arr[i + 1]!;
      arr[i + 1] = arr[i + 2]!;
      arr[i + 2] = t;
    }
    index.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

/** Superficie chiusa tra anelli con lo stesso numero di punti; tappi facoltativi alle estremità. */
export function loft(rings: Vector3[][], capStart = false, capEnd = false): BufferGeometry {
  const n = rings[0]!.length;
  const pos: number[] = [];
  for (const ring of rings) for (const p of ring) pos.push(p.x, p.y, p.z);
  const idx: number[] = [];
  for (let r = 0; r < rings.length - 1; r++)
    for (let i = 0; i < n; i++) {
      const a = r * n + i;
      const b = r * n + ((i + 1) % n);
      const c = (r + 1) * n + i;
      const d = (r + 1) * n + ((i + 1) % n);
      idx.push(a, c, b, b, c, d);
    }
  const cap = (ring: number) => {
    const center = new Vector3();
    for (const p of rings[ring]!) center.add(p);
    center.divideScalar(n);
    const ci = pos.length / 3;
    pos.push(center.x, center.y, center.z);
    for (let i = 0; i < n; i++) idx.push(ci, ring * n + i, ring * n + ((i + 1) % n));
  };
  if (capStart) cap(0);
  if (capEnd) cap(rings.length - 1);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  return orientOutward(g);
}

/** Profilo NACA a 4 cifre, anello chiuso (dorso dal bordo d'attacco, ventre a ritroso). */
export function airfoil(m: number, p: number, t: number, count = 16): Vector2[] {
  const upper: Vector2[] = [];
  const lower: Vector2[] = [];
  for (let i = 0; i <= count; i++) {
    const x = (1 - Math.cos((i / count) * Math.PI)) / 2;
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const yc = m === 0 ? 0 : x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / (1 - p) ** 2) * (1 - 2 * p + 2 * p * x - x * x);
    upper.push(new Vector2(x, yc + yt));
    lower.push(new Vector2(x, yc - yt));
  }
  return [...upper, ...lower.slice(1, -1).reverse()];
}

/** Materiali comuni dei concept (stessa luce d'ambiente della città). */
export function conceptMaterials(env: Texture, body: Color) {
  return {
    body: new MeshPhysicalMaterial({ color: body, metalness: 0.75, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.05, envMap: env, envMapIntensity: 1.1 }),
    dark: new MeshPhysicalMaterial({ color: new Color(0.035, 0.04, 0.05), metalness: 0.8, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.1, envMap: env, envMapIntensity: 1.0 }),
    glass: new MeshPhysicalMaterial({
      color: new Color(0.01, 0.02, 0.035),
      metalness: 0.4,
      roughness: 0.02,
      transparent: true,
      opacity: 0.82,
      envMap: env,
      envMapIntensity: 1.8,
      specularIntensity: 0.35,
      clearcoat: 0.4,
      clearcoatRoughness: 0.08,
      depthWrite: false,
      side: DoubleSide,
    }),
    interior: new MeshPhysicalMaterial({ color: new Color(0.1, 0.1, 0.11), roughness: 0.7, envMap: env, envMapIntensity: 0.3 }),
    seat: new MeshPhysicalMaterial({ color: new Color(0.55, 0.52, 0.48), roughness: 0.5, sheen: 0.5, envMap: env, envMapIntensity: 0.4 }),
    led: new MeshBasicMaterial({ color: new Color(0.5, 2.2, 3.4) }),
    ledWarm: new MeshBasicMaterial({ color: new Color(3.4, 2.4, 1.6) }),
    lift: new MeshBasicMaterial({ color: new Color(0.25, 1.1, 2.0), transparent: true, opacity: 0.9 }),
    navRed: new MeshBasicMaterial({ color: new Color(4, 0.2, 0.15) }),
    navGreen: new MeshBasicMaterial({ color: new Color(0.2, 4, 0.6) }),
    screen: new MeshBasicMaterial({ color: new Color(0.25, 0.75, 1.2) }),
  };
}
export type ConceptMaterials = ReturnType<typeof conceptMaterials>;
