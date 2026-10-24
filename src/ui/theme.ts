/** Tema chiaro/scuro: "auto" segue le impostazioni del sistema operativo. */

export type ThemePreference = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'atmosphera.theme';
const ORDER: ThemePreference[] = ['auto', 'light', 'dark'];

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'auto') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

export function nextTheme(preference: ThemePreference): ThemePreference {
  return ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length]!;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'auto' || value === 'light' || value === 'dark';
}

export function loadThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Archiviazione non disponibile (navigazione privata): il tema vale solo per la sessione.
  }
}

/**
 * Applica il tema al documento e notifica `onChange` con il tema effettivo,
 * anche quando cambia l'impostazione di sistema in modalità automatica.
 */
export function createThemeController(onChange: (theme: ResolvedTheme, preference: ThemePreference) => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = loadThemePreference();

  const apply = () => {
    const resolved = resolveTheme(preference, media.matches);
    const root = document.documentElement;
    if (preference === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', preference);
    root.style.colorScheme = resolved;
    onChange(resolved, preference);
  };

  media.addEventListener('change', apply);
  apply();

  return {
    get preference() {
      return preference;
    },
    cycle() {
      preference = nextTheme(preference);
      saveThemePreference(preference);
      apply();
    },
  };
}
