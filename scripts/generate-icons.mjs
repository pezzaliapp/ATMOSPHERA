// Genera le icone PNG della PWA disegnandole in modo procedurale (nessuna dipendenza).
// Uso: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/icons/', import.meta.url);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profondità
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Globo stilizzato: oceano con luce laterale, terminatore e alone atmosferico. */
function drawIcon(size, { globeScale, rounded }) {
  const px = Buffer.alloc(size * size * 4);
  const bg = [7, 11, 20];
  const sun = [0.78, 0.35, 0.52];
  const sunLen = Math.hypot(...sun);
  const L = sun.map((v) => v / sunLen);
  const ss = 3; // sovracampionamento per bordi morbidi

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = ((x + (sx + 0.5) / ss) / size) * 2 - 1;
          const v = ((y + (sy + 0.5) / ss) / size) * 2 - 1;
          let alpha = 1;
          if (rounded) {
            const r = 0.44; // raggio degli angoli, in unità normalizzate
            const qx = Math.max(Math.abs(u) - (1 - r), 0);
            const qy = Math.max(Math.abs(v) - (1 - r), 0);
            alpha = Math.hypot(qx, qy) <= r ? 1 : 0;
          }
          let c = bg.slice();
          const d = Math.hypot(u, v) / globeScale;
          if (d < 1) {
            const nz = Math.sqrt(1 - d * d);
            const n = [u / globeScale, -v / globeScale, nz];
            const lambert = n[0] * L[0] + n[1] * L[1] + n[2] * L[2];
            const deep = [10, 36, 87];
            const shallow = [95, 168, 255];
            const lit = smooth(-0.15, 0.6, lambert);
            c = mix([4, 10, 26], mix(deep, shallow, clamp(lambert)), lit);
            // bande di nuvole stilizzate
            const band = Math.sin(n[1] * 9 + Math.sin(n[0] * 3) * 0.8);
            c = mix(c, [232, 242, 255], smooth(0.82, 0.97, band) * 0.5 * lit);
            // foschia al bordo
            c = mix(c, [111, 178, 255], Math.pow(1 - nz, 3) * 0.6 * lit);
          } else {
            const glow = Math.exp(-(d - 1) * 18) * smooth(-0.6, 0.6, (u * L[0] - v * L[1]) / Math.hypot(u, v));
            c = mix(c, [111, 178, 255], glow * 0.55);
          }
          acc = [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2], acc[3] + alpha];
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      px[i] = Math.round(acc[0] / n);
      px[i + 1] = Math.round(acc[1] / n);
      px[i + 2] = Math.round(acc[2] / n);
      px[i + 3] = Math.round((acc[3] / n) * 255);
    }
  }
  return encodePng(size, px);
}

mkdirSync(OUT, { recursive: true });
const icons = [
  ['icon-192.png', 192, { globeScale: 0.7, rounded: true }],
  ['icon-512.png', 512, { globeScale: 0.7, rounded: true }],
  // Maskable: sfondo pieno e globo dentro la "safe zone" (cerchio dell'80%).
  ['icon-maskable-512.png', 512, { globeScale: 0.56, rounded: false }],
  // iOS applica da sé gli angoli arrotondati.
  ['apple-touch-icon.png', 180, { globeScale: 0.66, rounded: false }],
];
for (const [name, size, opts] of icons) {
  writeFileSync(new URL(name, OUT), drawIcon(size, opts));
  console.log(`icons/${name} (${size}×${size})`);
}
