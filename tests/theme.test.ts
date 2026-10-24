import { describe, expect, it } from 'vitest';
import { isThemePreference, nextTheme, resolveTheme } from '../src/ui/theme';

describe('tema', () => {
  it('in automatico segue il sistema', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
  });

  it('una scelta esplicita prevale sul sistema', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('il pulsante cicla automatico → chiaro → scuro → automatico', () => {
    expect(nextTheme('auto')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('auto');
  });

  it('valida i valori salvati', () => {
    expect(isThemePreference('dark')).toBe(true);
    expect(isThemePreference('blu')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
});
