import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * STORM FLIGHT S2.4 — build di TEST separata dalla versione stabile.
 *
 * Produce soltanto la pagina di laboratorio storm-s24 (e i 3 file di dati di Milton che usa) in dist-storm-test/,
 * mai in dist/. Si pubblica come deployment di anteprima del progetto Cloudflare Pages esistente con un ramo
 * diverso da main (es. `--branch storm-s24-test`): l'indirizzo è <ramo>.atmosphera.pages.dev e la produzione
 * (ramo main, atmosphera.pezzalihub.app) non viene toccata. Nessun service worker: niente cache della PWA stabile.
 *
 *   npx vite build --config vite.storm-test.config.ts
 */

const OUT = 'dist-storm-test';
const DATA = 'data/events/milton-2024';

function testExtras(): Plugin {
  return {
    name: 'storm-test-extras',
    apply: 'build',
    closeBundle() {
      mkdirSync(resolve(OUT, DATA, 'seq'), { recursive: true });
      for (const f of ['track.json', 'seq/20241007T2001Z-albedo.jpg', 'seq/20241007T2001Z-bt.jpg']) copyFileSync(resolve('public', DATA, f), resolve(OUT, DATA, f));
      // Indirizzo pulito: la radice porta alla pagina di test.
      writeFileSync(resolve(OUT, '_redirects'), '/ /lab/storm-s24.html 302\n');
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
    rollupOptions: { input: { storm: resolve('lab/storm-s24.html') } },
  },
  plugins: [testExtras()],
});
