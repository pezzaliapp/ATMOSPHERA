/** Testi dell'interfaccia. L'italiano è la lingua di riferimento. */

export const it = {
  appName: 'ATMOSPHERA',
  brand: 'PezzaliAPP',
  tagline: 'L’atmosfera prende vita.',
  author: 'Alessandro Pezzali — PezzaliAPP',
  beta: 'Preview Beta',
  loading: 'Caricamento della scena…',
  offline: 'Offline',
  zoomIn: 'Avvicina',
  zoomOut: 'Allontana',
  resetView: 'Ripristina inquadratura',
  viewGlobe: 'Vista globo',
  viewRegional: 'Vista regionale',
  info: 'Informazioni',
  close: 'Chiudi',
  themeAuto: 'Tema: automatico',
  themeLight: 'Tema: chiaro',
  themeDark: 'Tema: scuro',
  gestureHint: 'Trascina per ruotare e inclinare · due dita o tasto destro per spostarti · pizzica o rotella per lo zoom',
  gestureHintTouch: 'Trascina per ruotare · due dita per spostare e zoomare',
  updateAvailable: 'È disponibile una nuova versione.',
  update: 'Aggiorna',
  offlineReady: 'ATMOSPHERA è pronta per l’uso offline.',
  errorWebgl:
    'Il browser o il dispositivo non supporta WebGL 2, necessario per la scena 3D. Prova con una versione recente di Safari, Chrome, Edge o Firefox.',
  errorTextures: 'Impossibile caricare i dati della scena. Controlla la connessione e riprova.',
  errorContextLost: 'La scheda grafica ha interrotto il rendering.',
  reload: 'Ricarica',
  framesUnavailable: 'Immagini satellitari non ancora scaricate: la riproduzione riprende appena la connessione lo consente.',

  modes: 'Modalità',
  modeStory: 'Story',
  modeReplay: 'Replay',
  modeLive: 'Live',
  soon: 'In sviluppo',
  liveSoon: 'Live — in sviluppo: non ancora disponibile in questa anteprima',

  wind: 'Vento max',
  pressure: 'Pressione',
  position: 'Posizione',
  motion: 'Movimento',
  utc: 'UTC',
  eyeTag: 'Occhio',

  observed: 'Osservato',
  reconstructed: 'Ricostruito',
  illustrative: 'Illustrativo',
  legendTitle: 'Che cosa stai guardando',
  legendObserved:
    'Nuvole GOES-16 del 7 ottobre 2024, una scansione ogni 20 minuti (visibile + infrarosso), traccia e intensità NOAA, superficie NASA, posizione del Sole.',
  legendReconstructed:
    'Quota delle nubi stimata dalla temperatura e corretta per la parallasse del satellite; opacità derivata da soglie; valori tra due punti della traccia.',
  legendIllustrative:
    'Fotogrammi tra due scansioni (spostati lungo il moto stimato), esagerazione verticale ×{x}, rilievo e ombre delle nubi, contrasto delle nubi accentuato (senza aggiungere dettagli), foschia, alone, stelle.',
  layers: 'Livelli',
  layerClouds: 'Nuvole',
  layerTrack: 'Traccia',
  layerLabels: 'Etichette',

  timelineTitle: 'Pressione al centro',
  play: 'Riproduci',
  pause: 'Pausa',
  speed: 'Velocità',
  minPerSecond: 'min/s',
  seek: 'Istante rappresentato',
  observedFrame: 'Osservazione GOES-16',
  interpolatedFrame: 'Interpolato tra {a} e {b}',
  resumeDirector: 'Riprendi regia',
  storyAgain: 'Rivedi il racconto',
  storySource: 'Dati: best track NOAA',
  storyMode: 'Racconto accelerato',
  replayMode: 'Riproduzione scientifica',

  aboutTitle: 'Informazioni su ATMOSPHERA',
  aboutBody:
    'ATMOSPHERA è un progetto originale di Alessandro Pezzali, nell’ecosistema PezzaliAPP, dedicato alla visualizzazione immersiva dell’atmosfera terrestre. Questa Preview Beta ricostruisce undici ore dell’uragano Milton, il 7 ottobre 2024, dall’alba al tramonto sul Golfo del Messico, durante l’intensificazione fino alla categoria 5.',
  honestyTitle: 'Dati e ricostruzioni',
  honestyBody:
    'Le nuvole sono immagini reali del satellite GOES-16, una ogni 20 minuti, riproiettate sulla regione. Tra due immagini il movimento è un’interpolazione illustrativa lungo il moto stimato dalle immagini stesse: nessuna rotazione o dettaglio inventato. L’aspetto tridimensionale è una ricostruzione: la quota delle nubi è stimata dalla loro temperatura e amplificata per renderla visibile. Ogni grandezza mostrata riporta se è osservata, ricostruita o illustrativa.',
  privacyTitle: 'Privacy',
  privacyBody:
    'Nessun account, nessun cookie, nessun tracciamento. L’app è statica e funziona interamente nel browser; le preferenze (tema) restano sul tuo dispositivo.',
  sourcesTitle: 'Fonti',
  sourceGoes:
    'Nuvole: NOAA GOES-16 ABI, prodotto L2 Cloud and Moisture Imagery multicanale, settore CONUS, canali 2 e 13 — NOAA Open Data Dissemination.',
  sourceTrack: 'Traccia e intensità: NOAA National Hurricane Center, best track HURDAT2 (AL142024).',
  sourceDay:
    'Superficie: NASA Earth Observatory — Blue Marble: Next Generation, ottobre 2004, con topografia e batimetria.',
  sourceNight: 'Luci notturne: NASA Earth Observatory — Earth at Night / Black Marble 2016 (dati Suomi NPP VIIRS).',
  sourceNote: 'L’uso di dati e immagini NOAA e NASA non implica alcuna approvazione da parte di tali enti.',
  devTitle: 'In sviluppo',
  devBody:
    'Non ancora disponibili in questa anteprima: la modalità LIVE con osservazioni satellitari recenti e altri eventi meteorologici. Quando saranno pronti compariranno qui.',
  licenseTitle: 'Licenza',
  licenseBody: 'Codice © 2026 Alessandro Pezzali, rilasciato con licenza MIT. Utilizza three.js e Workbox (MIT).',
  licenseFile: 'Licenza',
  noticesFile: 'Componenti di terze parti',
  dataFile: 'Fonti dei dati',
  version: 'Versione',
} as const;

export type Strings = typeof it;
export const t: Strings = it;
