// Estrae una tempesta da HURDAT2 e la salva come JSON per l'app.
// Uso (Node ≥ 22.18, type stripping nativo):
//   node scripts/data/hurdat2-track.ts data-raw/noaa/hurdat2-1851-2025-092326.txt AL142024 \
//        public/data/events/milton-2024/track.json
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseHurdat2 } from '../../src/data/hurdat2.ts';

const [src, id, out] = process.argv.slice(2);
if (!src || !id || !out) {
  console.error('uso: node scripts/data/hurdat2-track.ts <hurdat2.txt> <ID> <out.json>');
  process.exit(1);
}
const text = readFileSync(src, 'utf8');
const storm = parseHurdat2(text).find((s) => s.id === id);
if (!storm) {
  console.error(`tempesta ${id} non trovata`);
  process.exit(1);
}
const track = {
  id: storm.id,
  name: storm.name.charAt(0) + storm.name.slice(1).toLowerCase(),
  source: `NOAA NHC HURDAT2 — ${basename(src)} (sha256 ${createHash('sha256').update(text).digest('hex')})`,
  points: storm.points,
};
writeFileSync(out, JSON.stringify(track, null, 1) + '\n');
console.log(`${out}: ${track.name}, ${track.points.length} punti`);
