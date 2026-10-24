// Completa la build in dist/ per Cloudflare Pages:
// - licenze: il codice di terze parti nel bundle (three.js, Workbox) richiede che l'avviso di
//   copyright accompagni ogni copia pubblicata;
// - _headers: intestazioni di sicurezza e di cache lette da Cloudflare Pages (non pubblicato).
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

for (const [source, target] of [
  ['LICENSE', 'dist/LICENSE.txt'],
  ['THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.txt'],
  ['DATA_SOURCES.md', 'dist/DATA_SOURCES.txt'],
]) {
  copyFileSync(source, target);
}

const security = JSON.parse(readFileSync('security-headers.json', 'utf8'));
const csp = [...security.csp, ...security.headerOnlyCsp].join('; ');
const lines = [
  '/*',
  `  Content-Security-Policy: ${csp}`,
  ...Object.entries(security.headers).map(([k, v]) => `  ${k}: ${v}`),
  '',
  // File con hash nel nome: non cambiano mai, cache lunga.
  '/assets/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
  // Service worker e manifest sempre riconvalidati: gli aggiornamenti della PWA arrivano subito.
  '/sw.js',
  '  Cache-Control: no-cache',
  '/manifest.webmanifest',
  '  Cache-Control: no-cache',
  '',
];
writeFileSync('dist/_headers', lines.join('\n'));
