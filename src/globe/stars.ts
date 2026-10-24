import { BufferAttribute, BufferGeometry, Points, PointsMaterial } from 'three';

/** Campo stellare procedurale, deterministico (nessun asset esterno). */
export function createStars(count = 2500, radius = 60) {
  let seed = 0x9e3779b9;
  const random = () => {
    // xorshift32
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = random() * 2 - 1;
    const theta = random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    positions.set([radius * s * Math.cos(theta), radius * u, radius * s * Math.sin(theta)], i * 3);
    const b = 0.35 + random() ** 3 * 0.65;
    const warm = random() * 0.15;
    colors.set([b, b - warm * 0.3, b - warm], i * 3);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const material = new PointsMaterial({
    size: 1.6,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const points = new Points(geometry, material);
  points.name = 'stars';

  return {
    points,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
