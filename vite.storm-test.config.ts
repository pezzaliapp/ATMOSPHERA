import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * STORM FLIGHT — build di TEST separata dalla versione stabile (S2.4, S2.5, …).
 *
 * Produce soltanto una pagina di laboratorio (e i 3 file di dati di Milton che usa) in una cartella propria,
 * mai in dist/: S2.4 → dist-storm-test/ (come pubblicata), S2.5 → dist-storm-s25-test/, S2.5.1 → dist-storm-s251-test/.
 * La pagina si sceglie con STORM_TEST=s24 | s25 | s251 (predefinita s251). Si pubblica come deployment di anteprima del progetto Cloudflare Pages esistente con un ramo
 * diverso da main (es. `--branch storm-s251-test`): l'indirizzo è <ramo>.atmosphera.pages.dev e la produzione
 * (ramo main, atmosphera.pezzalihub.app) non viene toccata. Nessun service worker: niente cache della PWA stabile.
 *
 *   STORM_TEST=s251 npx vite build --config vite.storm-test.config.ts
 */

const VERSION = process.env.STORM_TEST ?? 's251';
if (!/^s2(4|5|51)$/.test(VERSION)) throw new Error(`STORM_TEST non valido: ${VERSION}`);
const PAGE = `lab/storm-${VERSION}.html`;
const OUT = VERSION === 's24' ? 'dist-storm-test' : `dist-storm-${VERSION}-test`;
const DATA = 'data/events/milton-2024';

function testExtras(): Plugin {
  return {
    name: 'storm-test-extras',
    apply: 'build',
    closeBundle() {
      mkdirSync(resolve(OUT, DATA, 'seq'), { recursive: true });
      for (const f of ['track.json', 'seq/20241007T2001Z-albedo.jpg', 'seq/20241007T2001Z-bt.jpg']) copyFileSync(resolve('public', DATA, f), resolve(OUT, DATA, f));
      // Indirizzo pulito: la radice porta alla pagina di test.
      writeFileSync(resolve(OUT, '_redirects'), `/ /${PAGE} 302\n`);
      // Versione di prova: non indicizzata dai motori di ricerca.
      writeFileSync(resolve(OUT, '_headers'), '/*\n  X-Robots-Tag: noindex, nofollow\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n');
    },
  };
}

export default defineConfig({
  base: '/',
  publicDir: false,
  build: {
    outDir: OUT,
    // Nessuna cancellazione automatica della cartella di uscita (si crea nuova).
    emptyOutDir: false,
    target: ['es2022', 'safari15', 'chrome100'],
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: { storm: resolve(PAGE) } },
  },
  plugins: [testExtras()],
});
