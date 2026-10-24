import { describe, expect, it } from 'vitest';
import { it as strings } from '../src/ui/i18n';

describe('testi italiani', () => {
  it('nessuna stringa vuota', () => {
    for (const [key, value] of Object.entries(strings)) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('i crediti NOAA e NASA sono presenti e non implicano approvazione', () => {
    expect(strings.sourceGoes).toContain('GOES-16');
    expect(strings.sourceTrack).toContain('HURDAT2');
    expect(strings.sourceDay).toContain('NASA');
    expect(strings.sourceNight).toContain('NASA');
    expect(strings.sourceNote).toMatch(/non implica/);
  });

  it('la legenda distingue le tre provenienze', () => {
    expect(strings.observed).toBe('Osservato');
    expect(strings.reconstructed).toBe('Ricostruito');
    expect(strings.illustrative).toBe('Illustrativo');
  });
});
