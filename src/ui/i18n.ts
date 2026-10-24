/** Testi dell'interfaccia. L'italiano è la lingua di riferimento. */

export const it = {
  appName: 'ATMOSPHERA',
  brand: 'PezzaliAPP',
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

  modes: 'Modalità',
  modeStory: 'Story',
  modeReplay: 'Replay',
  modeLive: 'Live',
  soon: 'presto',

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
  legendObserved: 'Nuvole GOES-16 delle 20:01 UTC (visibile + infrarosso), traccia e intensità NOAA, superficie NASA, posizione del Sole.',
  legendReconstructed:
    'Quota delle nubi stimata dalla temperatura; opacità derivata da soglie; movimento medio tra due punti della traccia.',
  legendIllustrative: 'Esagerazione verticale ×{x}, rilievo e ombre delle nubi, foschia, alone atmosferico, stelle.',
  layers: 'Livelli',
  layerClouds: 'Nuvole',
  layerTrack: 'Traccia',
  layerLabels: 'Etichette',

  timelineTitle: 'Intensità lungo la traccia',
  timelineSoon: 'Timeline interattiva in arrivo',

  aboutTitle: 'Informazioni su ATMOSPHERA',
  aboutBody:
    'ATMOSPHERA è un’applicazione originale dell’ecosistema PezzaliAPP. Questo prototipo (E0) ricostruisce un singolo istante dell’uragano Milton, il 7 ottobre 2024 alle 20:00 UTC, quando raggiunse il picco di intensità nel Golfo del Messico.',
  honestyTitle: 'Dati e ricostruzioni',
  honestyBody:
    'Le nuvole sono immagini reali del satellite GOES-16, riproiettate sulla regione. L’aspetto tridimensionale è una ricostruzione: la quota delle nubi è stimata dalla loro temperatura e amplificata per renderla visibile. Ogni grandezza mostrata riporta se è osservata, ricostruita o illustrativa.',
  privacyTitle: 'Privacy',
  privacyBody:
    'Nessun account, nessun cookie, nessun tracciamento. L’app è statica e funziona interamente nel browser; le preferenze (tema) restano sul tuo dispositivo.',
  sourcesTitle: 'Fonti',
  sourceGoes:
    'Nuvole: NOAA GOES-16 ABI, prodotto L2 Cloud and Moisture Imagery, settore CONUS, canali 2 e 13 — NOAA Open Data Dissemination.',
  sourceTrack: 'Traccia e intensità: NOAA National Hurricane Center, best track HURDAT2 (AL142024).',
  sourceDay:
    'Superficie: NASA Earth Observatory — Blue Marble: Next Generation, ottobre 2004, con topografia e batimetria.',
  sourceNight: 'Luci notturne: NASA Earth Observatory — Earth at Night / Black Marble 2016 (dati Suomi NPP VIIRS).',
  sourceNote: 'L’uso di dati e immagini NOAA e NASA non implica alcuna approvazione da parte di tali enti.',
  licenseTitle: 'Licenza',
  licenseBody: 'Codice © 2026 Alessandro Pezzali, rilasciato con licenza MIT. Utilizza three.js (MIT).',
  version: 'Versione',
} as const;

export type Strings = typeof it;
export const t: Strings = it;
