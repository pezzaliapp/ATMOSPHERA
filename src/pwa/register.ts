import { registerSW } from 'virtual:pwa-register';

/**
 * Registra il service worker (solo in produzione). Nessun aggiornamento forzato:
 * l'utente decide quando ricaricare la nuova versione.
 */
export function registerServiceWorker(callbacks: {
  onNeedRefresh: (update: () => void) => void;
  onOfflineReady: () => void;
}): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const updateSW = registerSW({
    onNeedRefresh: () => callbacks.onNeedRefresh(() => void updateSW(true)),
    onOfflineReady: callbacks.onOfflineReady,
  });
}
