import { defineConfig, type Plugin } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

import security from './security-headers.json' with { type: 'json' };

// Pubblicazione su Cloudflare Pages alla radice del sottodominio https://atmosphera.pezzalihub.app
const BASE = '/';

// Content Security Policy iniettata solo nella build di produzione:
// in sviluppo Vite inserisce stili inline per l'HMR. Su Cloudflare Pages la stessa politica
// arriva anche come intestazione HTTP (dist/_headers, generato da scripts/postbuild.mjs).
const CSP = security.csp.join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'atmosphera-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  base: BASE,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: ['es2022', 'safari15', 'chrome100'],
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  plugins: [
    contentSecurityPolicy(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      // Le icone sono già coperte da globPatterns: evita voci duplicate nella precache.
      includeManifestIcons: false,
      manifest: {
        id: BASE,
        name: 'ATMOSPHERA',
        short_name: 'ATMOSPHERA',
        description: 'L’atmosfera prende vita: l’uragano Milton in 3D da dati satellitari reali NOAA GOES-16. Di Alessandro Pezzali — PezzaliAPP.',
        lang: 'it',
        dir: 'ltr',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'any',
        background_color: '#070b14',
        theme_color: '#070b14',
        categories: ['weather', 'education', 'navigation'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Shell dell'app, texture 2k e dati dell'evento in precache: offline dal primo avvio.
        globPatterns: ['**/*.{js,css,html,svg,png}', 'textures/*-2k.jpg', 'data/**/*.{json,jpg}'],
        // Fotogrammi della sequenza: cache progressiva (sotto), non tutti al primo avvio.
        // CITY FLIGHT: scaricato solo quando lo si apre (cache dopo il primo uso, sotto).
        // Le nuvole statiche di E0 non sono più usate dalla scena.
        globIgnores: ['data/events/*/seq/*.{jpg,png}', 'data/events/*/clouds-*', 'assets/city-flight-*'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: `${BASE}index.html`,
        // I file di licenza (copiati da scripts/postbuild.mjs) si aprono come pagine:
        // non vanno sostituiti dall'app.
        navigateFallbackDenylist: [/\.txt$/],
        cleanupOutdatedCaches: true,
        // Al primo avvio il service worker prende subito il controllo della pagina, così i
        // fotogrammi scaricati finiscono nella cache. Gli aggiornamenti restano su richiesta
        // dell'utente (registerType 'prompt': nessun skipWaiting automatico).
        clientsClaim: true,
        runtimeCaching: [
          {
            // Fotogrammi satellitari: in cache man mano che vengono visti.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && /\/data\/events\/[^/]+\/seq\/.+\.(jpg|png)$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'atmosphera-frames',
              expiration: { maxEntries: 400 },
            },
          },
          {
            // CITY FLIGHT: modulo del simulatore, in cache dal primo uso (poi disponibile anche offline).
            urlPattern: ({ url, sameOrigin }) => sameOrigin && /\/assets\/city-flight-[^/]+\.(js|css)$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'atmosphera-city-flight',
              expiration: { maxEntries: 4 },
            },
          },
          {
            // Texture 4k: scaricate solo dai dispositivi che le usano, poi servite dalla cache.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && /\/textures\/.+-4k\.jpg$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'atmosphera-textures',
              expiration: { maxEntries: 8 },
            },
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
