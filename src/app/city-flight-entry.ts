import type { CityFlight } from '../flight/city-flight';
import { t } from '../ui/i18n';

/**
 * Ingresso in CITY FLIGHT dalla PWA: il simulatore si scarica solo al primo uso (import dinamico) e
 * all'uscita libera tutte le risorse. Indirizzo #/city-flight: il tasto Indietro del browser esce dal volo
 * e il collegamento diretto apre il simulatore.
 */

export const CITY_FLIGHT_HASH = '#/city-flight';

export function createCityFlightEntry(options: {
  /** Prima di entrare: il globo va in pausa. */
  onEnter(): void;
  /** Dopo l'uscita: il globo riprende. */
  onLeave(): void;
  /** Indirizzo della scena del globo (per tornarci quando non c'è una voce precedente nella cronologia). */
  routeHash(): string;
}) {
  let flight: CityFlight | null = null;
  let loading = false;
  let pushed = false;
  let overlay: HTMLElement | null = null;

  const showOverlay = (html: string) => {
    overlay ??= document.body.appendChild(document.createElement('div'));
    overlay.className = 'cf-loading';
    overlay.setAttribute('role', 'status');
    overlay.innerHTML = html;
  };
  const hideOverlay = () => {
    overlay?.remove();
    overlay = null;
  };

  const leave = (fromHistory = false) => {
    loading = false;
    flight?.dispose();
    flight = null;
    hideOverlay();
    document.body.classList.remove('cf-on');
    options.onLeave();
    if (fromHistory) return;
    if (pushed) {
      pushed = false;
      history.back();
    } else history.replaceState(null, '', options.routeHash());
  };

  const enter = async (push = true) => {
    if (flight || loading) return;
    loading = true;
    options.onEnter();
    document.body.classList.add('cf-on');
    if (push && location.hash !== CITY_FLIGHT_HASH) {
      history.pushState(null, '', CITY_FLIGHT_HASH);
      pushed = true;
    }
    showOverlay(`<div class="cf-loading__ring" aria-hidden="true"></div><b>CITY FLIGHT</b><p>${t.cityFlightLoading}</p>`);
    try {
      const module = await import('../flight/city-flight');
      // Il messaggio compare prima che la costruzione della città occupi il processore.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      if (!loading) return;
      flight = module.startCityFlight(document.body, { onExit: () => leave() });
      hideOverlay();
    } catch {
      // Di solito: offline prima del primo uso (il simulatore non è ancora nella cache).
      showOverlay(`<b>CITY FLIGHT</b><p>${t.cityFlightUnavailable}</p><button type="button">${t.cityFlightBack}</button>`);
      overlay!.querySelector('button')!.addEventListener('click', () => leave());
    } finally {
      loading = false;
    }
  };

  window.addEventListener('popstate', () => {
    const wantFlight = location.hash === CITY_FLIGHT_HASH;
    if (!wantFlight && (flight || overlay)) {
      pushed = false;
      leave(true);
    } else if (wantFlight && !flight && !loading) void enter(false);
  });

  return {
    enter: () => void enter(true),
    /** Apertura diretta da #/city-flight all'avvio. */
    openFromAddress: () => void enter(false),
    get active() {
      return flight !== null || loading;
    },
  };
}
