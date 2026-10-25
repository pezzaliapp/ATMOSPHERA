import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, PlaneGeometry, Points, PointsMaterial } from 'three';

/**
 * Periferia (FLIGHT 2.0): terreno scuro attorno alla città fino all'orizzonte e luci sparse,
 * più dense vicino alla città. Serve al volo: oltre il bordo della città non c'è vuoto.
 * Generata dal codice con seme fisso; la città approvata non cambia.
 */
export function createOutskirts(coastX: number, cityHalfZ: number, cityMaxX: number) {
  const group = new Group();
  const ground = new Mesh(new PlaneGeometry(16000, 24000), new MeshStandardMaterial({ color: new Color(0.035, 0.032, 0.036), roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(coastX + 8000, -0.25, 0);
  ground.receiveShadow = true;
  group.add(ground);
  let a = 4242;
  const rnd = () => ((a = (a * 16807) % 2147483647) / 2147483647);
  const pos: number[] = [];
  const col: number[] = [];
  for (let i = 0; i < 26000; i++) {
    const x = coastX + 30 + rnd() * 9000;
    const z = (rnd() - 0.5) * 18000;
    // Fuori dal perimetro della città, densità che cala con la distanza.
    const dx = Math.max(0, x - cityMaxX);
    const dz = Math.max(0, Math.abs(z) - cityHalfZ);
    const d = Math.hypot(dx, dz);
    if (d < 40 || rnd() > Math.exp(-d / 2600)) continue;
    pos.push(x, 0.5, z);
    const warm = rnd();
    const c = warm < 0.8 ? [1.0, 0.72, 0.42] : warm < 0.93 ? [0.85, 0.9, 1.0] : [1.0, 0.35, 0.25];
    const k = 0.6 + rnd() * 0.9;
    col.push(c[0]! * k, c[1]! * k, c[2]! * k);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  const points = new Points(g, new PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, fog: true }));
  group.add(points);
  return group;
}
