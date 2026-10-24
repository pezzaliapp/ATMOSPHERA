# ATMOSPHERA

**L'atmosfera prende vita.**

Visualizzazione immersiva dell'atmosfera terrestre da dati satellitari reali.
Autore: Alessandro Pezzali — PezzaliAPP. Licenza MIT.

## Preview Beta

La prima anteprima racconta undici ore dell'uragano Milton (7 ottobre 2024, dall'alba al
tramonto sul Golfo del Messico), durante l'intensificazione fino alla categoria 5:

- **STORY**: racconto accelerato di 24 secondi con regia della camera, all'apertura.
- **EXPLORE**: camera libera sulla stessa scena, con la timeline: seguire l'occhio, inquadrature
  (sopra l'occhio, parete, intero uragano, come il satellite, orizzonte), rilievo ×1 o ×2,
  bussola, doppio clic per centrare, tastiera (frecce, + e −, F). Due visualizzazioni, con la
  stessa camera e lo stesso istante:
  - **Satellite**: le immagini GOES-16 originali, con il massimo dettaglio disponibile;
  - **Volume 3D**: un volume ricostruito dalle stesse osservazioni (spessore ottico dall'albedo,
    quota della sommità dalla temperatura), attraversato con ray marching e illuminato dal Sole
    di quell'istante, con ombre proprie e proiettate. È una ricostruzione, non una misura
    tridimensionale: il satellite vede solo la sommità delle nubi. Risoluzione adattiva al costo
    misurato sulla GPU, profilo leggero sui telefoni (`src/volume/`).
- **REPLAY**: riproduzione scientifica a 5, 10, 20 o 30 minuti al secondo, con l'ora reale
  di ogni osservazione e l'indicazione dei fotogrammi interpolati.
- **LIVE** e altri eventi: in sviluppo, non ancora disponibili.

Dati: 35 osservazioni NOAA GOES-16 (una ogni 20 minuti), best track NOAA HURDAT2, superficie
NASA. Ogni grandezza è marcata come osservata, ricostruita o illustrativa. Dettagli in
[DATA_SOURCES.md](DATA_SOURCES.md); componenti di terze parti in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Nessun account, cookie, tracciamento o pubblicità. App statica (PWA) installabile, utilizzabile
offline dopo la prima visita completa.

Indirizzi condivisibili: `#/story/milton-2024`, `#/explore/milton-2024`, `#/replay/milton-2024`.

## Eventi

Ogni evento è una cartella `public/data/events/<id>/` con un manifest `event.json` (luogo,
periodo, satellite, fonti, regia e didascalie della STORY, etichette) e i suoi dati (traccia,
superficie, sequenza satellitare); il catalogo `public/data/events/index.json` li elenca.
La struttura è verificata da `src/events/manifest.ts` e dai test. Aggiungere un evento non
richiede modifiche al codice.

## Sviluppo

```sh
npm ci
npm run dev      # http://localhost:5173/
npm run check    # typecheck, test, build in dist/
npm run preview  # build di produzione in locale
```

La preparazione dei dati satellitari (Python, solo in locale) è descritta in
[scripts/data/README.md](scripts/data/README.md). File grezzi, ambienti Python e video di lavoro
restano in `data-raw/` e `scripts/data/.venv/`, esclusi da Git.

## Pubblicazione

Sito statico su **Cloudflare Pages** (piano gratuito), alla radice di
**https://atmosphera.pezzalihub.app** (base Vite `/`). Caricamento diretto della cartella `dist/`
con Wrangler: nessuna build sui server Cloudflare, nessuna GitHub Action, nessuna Pages Function.

```sh
npm run check                                   # test e build in dist/ (con _headers e licenze)
wrangler pages deploy dist --project-name atmosphera --branch main
```

`dist/_headers` (generato da `scripts/postbuild.mjs` a partire da `security-headers.json`)
imposta CSP e intestazioni di sicurezza, cache lunga per `assets/` e nessuna cache per
`sw.js` e `manifest.webmanifest`, così gli aggiornamenti della PWA arrivano subito.
