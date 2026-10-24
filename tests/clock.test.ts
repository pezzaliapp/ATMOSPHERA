import { describe, expect, it } from 'vitest';
import { formatUtc } from '../src/core/clock';

describe('formatUtc', () => {
  it('formatta data e ora in stile italiano', () => {
    expect(formatUtc(new Date('2026-10-23T07:05:00Z'))).toEqual({ date: '23/10/2026', time: '07:05' });
  });
});
