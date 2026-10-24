import { defineConfig, type Plugin } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

// Pubblicazione prevista come sito di progetto GitHub Pages: /ATMOSPHERA/
const BASE = '/ATMOSPHERA/';

// Content Security Policy iniettata solo nella build di produzione:
// in sviluppo Vite inserisce stili inline per l'HMR.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

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
        description: 'Eventi meteorologici in 3D da dati satellitari reali: uragano Milton, ottobre 2024. Un progetto PezzaliAPP.',
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
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: `${BASE}index.html`,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
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
