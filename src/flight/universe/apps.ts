/**
 * APP UNIVERSE — configurazione delle applicazioni nella città.
 * Per aggiungere un'app in futuro basta una nuova voce (e, se serve, un nuovo tipo di oggetto in objects.ts).
 *
 * URL verificati il 24/10/2026 (repository GitHub pezzaliapp e progetti locali, risposta HTTP e intestazioni):
 * - ILCUBO, SYDERA: GitHub Pages, nessuna X-Frame-Options né frame-ancestors → anteprima incorporabile.
 * - NEXUM: Content-Security-Policy «frame-ancestors 'none'» → solo scheda con collegamento.
 * - NOWCAST: alla prima verifica rispondeva con errore Cloudflare 1033 (tunnel non attivo); più tardi HTTP 200,
 *   nessuna X-Frame-Options né frame-ancestors (incorporabile), ma nessun CORS → anteprima solo su richiesta.
 *   In WebKit la pagina di NOWCAST smette di rispondere (anche aperta da sola) → su WebKit solo scheda.
 */

export type AppObjectKind = 'atmosphere' | 'cube' | 'network' | 'orbital';

export interface AppEntry {
  id: string;
  name: string;
  /** Indirizzo pubblico verificato; null = predisposto ma non ancora verificato (collegamento disattivato). */
  url: string | null;
  tagline: string;
  description: string;
  object: AppObjectKind;
  /** Centro dell'oggetto nella città (metri). */
  position: [number, number, number];
  /** Raggio d'ingombro (metri): collisioni, selezione, etichette. */
  radius: number;
  /** Colore d'accento per etichette, elenco e monitor. */
  accent: string;
  /**
   * Modalità di apertura nel monitor.
   * - mode 'iframe': anteprima incorporata (solo se il sito lo consente); 'card': scheda con collegamento.
   * - check 'cors': prima dell'anteprima si verifica la risposta del sito (richiede Access-Control-Allow-Origin);
   *   'reach': si verifica solo che il server sia raggiungibile (sito senza CORS).
   * - onRequest: l'anteprima si carica solo su richiesta (servizio con disponibilità non verificabile dalla pagina).
   * - noEmbedOnWebKit: motivo per cui su WebKit (Safari, tutti i browser iOS) si mostra solo la scheda.
   */
  open: { mode: 'iframe' | 'card'; check?: 'cors' | 'reach'; onRequest?: boolean; reason: string; noEmbedOnWebKit?: string };
}

export const APPS: AppEntry[] = [
  {
    id: 'nowcast',
    name: 'NOWCAST',
    url: 'https://nowcast.pezzalihub.app',
    tagline: 'Grandine e downburst, minuto per minuto',
    description:
      'Nowcasting di grandine e downburst: le condizioni favorevoli con ore di anticipo dai modelli meteorologici, poi le singole celle temporalesche seguite sul radar mentre nascono, crescono e collassano.',
    object: 'atmosphere',
    position: [-380, 224, -330],
    radius: 17,
    accent: '#7fd3ff',
    open: {
      mode: 'iframe',
      check: 'reach',
      onRequest: true,
      reason: 'Servizio ospitato in proprio: la disponibilità non è verificabile da qui. Puoi caricare l’anteprima o aprire il sito.',
      // Verificato il 24/10/2026: in WebKit la pagina di NOWCAST smette di rispondere anche aperta da sola; incorporata,
      // condividendo il processo, bloccherebbe anche il volo. Su WebKit quindi solo scheda e collegamento.
      noEmbedOnWebKit: 'Su questo browser l’anteprima di NOWCAST rallenterebbe il volo: si apre in una nuova scheda.',
    },
  },
  {
    id: 'ilcubo',
    name: 'ILCUBO',
    url: 'https://www.alessandropezzali.it/ILCUBO/',
    tagline: 'Gioca, personalizza e risolvi il cubo',
    description: 'Cubo magico 3D personalizzabile con colori, numeri, lettere, testi, emoji e immagini. Si gioca nel browser, anche come app installata.',
    object: 'cube',
    position: [250, 186, 132],
    radius: 17,
    accent: '#ff6a4d',
    open: { mode: 'iframe', check: 'cors', reason: '' },
  },
  {
    id: 'nexum',
    name: 'NEXUM',
    url: 'https://nexum.pezzalihub.app',
    tagline: 'One object. Many relations. One timeline.',
    description:
      'Un mondo di oggetti, relazioni ed eventi costruito da dati pubblici e gratuiti, da osservare attraverso mappa, grafo, linea del tempo e ricerca. Open source e local-first.',
    object: 'network',
    position: [170, 252, -520],
    radius: 17,
    accent: '#f0b44c',
    open: { mode: 'card', reason: 'Il sito non consente l’incorporamento in altre pagine: si apre in una nuova scheda.' },
  },
  {
    id: 'sydera',
    name: 'SYDERA',
    url: 'https://www.alessandropezzali.it/SYDERA/',
    tagline: 'Astrologia · numerologia',
    description:
      'Astrologia occidentale e numerologia pitagorica affiancate, tenendo sempre distinti il calcolo e l’interpretazione simbolica. Tutto resta nel browser: nessun account, nessun server, nessun tracciamento.',
    object: 'orbital',
    position: [560, 300, 110],
    radius: 21,
    accent: '#b9c6ff',
    open: { mode: 'iframe', check: 'cors', reason: '' },
  },
];
