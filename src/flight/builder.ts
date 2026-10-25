import { BufferAttribute, BufferGeometry, Color } from 'three';

/**
 * Accumulo di parallelepipedi e prismi in un'unica geometria non indicizzata (FLIGHT 2.0).
 * Ogni vertice porta colore e attributi dell'edificio (aBuilding) per il materiale delle facciate.
 */
export class Builder {
  private p: number[] = [];
  private n: number[] = [];
  private c: number[] = [];
  private b: number[] = [];
  color = new Color(1, 1, 1);
  building: [number, number, number, number] = [0, 0, 0, 0];

  private tri(a: number[], b: number[], c: number[], normal: number[]) {
    for (const v of [a, b, c]) {
      this.p.push(v[0]!, v[1]!, v[2]!);
      this.n.push(normal[0]!, normal[1]!, normal[2]!);
      this.c.push(this.color.r, this.color.g, this.color.b);
      this.b.push(...this.building);
    }
  }

  private quad(a: number[], b: number[], c: number[], d: number[], normal: number[]) {
    this.tri(a, b, c, normal);
    this.tri(a, c, d, normal);
  }

  /** Parallelepipedo allineato agli assi: da (x0, y0, z0) a (x1, y1, z1). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, options: { top?: boolean; bottom?: boolean } = {}) {
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]);
    if (options.top !== false) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]);
    if (options.bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
  }

  /** Parallelepipedo centrato (comodo per i dettagli). */
  boxAt(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) {
    this.box(cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2);
  }

  /** Cilindro verticale a facce piane (serbatoi, piattaforme). */
  cylinder(cx: number, cz: number, r: number, y0: number, y1: number, segments = 24) {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const p0 = [cx + Math.cos(a0) * r, cz + Math.sin(a0) * r];
      const p1 = [cx + Math.cos(a1) * r, cz + Math.sin(a1) * r];
      const am = (a0 + a1) / 2;
      this.quad([p1[0]!, y0, p1[1]!], [p0[0]!, y0, p0[1]!], [p0[0]!, y1, p0[1]!], [p1[0]!, y1, p1[1]!], [Math.cos(am), 0, Math.sin(am)]);
      this.tri([cx, y1, cz], [p1[0]!, y1, p1[1]!], [p0[0]!, y1, p0[1]!], [0, 1, 0]);
    }
  }

  /** Parapetto attorno a un tetto rettangolare. */
  parapet(x0: number, z0: number, x1: number, z1: number, y: number, h = 1.1, t = 0.35) {
    this.box(x0, y, z0, x1, y + h, z0 + t);
    this.box(x0, y, z1 - t, x1, y + h, z1);
    this.box(x0, y, z0, x0 + t, y + h, z1);
    this.box(x1 - t, y, z0, x1, y + h, z1);
  }

  get empty(): boolean {
    return this.p.length === 0;
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.n), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.c), 3));
    g.setAttribute('aBuilding', new BufferAttribute(new Float32Array(this.b), 4));
    g.computeBoundingSphere();
    return g;
  }
}
