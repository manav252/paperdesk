import { afterEach, describe, expect, it, vi } from 'vitest';
import { readThemePref, THEME_KEY } from './theme';

const stubStorage = (value: string | null) =>
  vi.stubGlobal('localStorage', { getItem: (k: string) => (k === THEME_KEY ? value : null) });

describe('readThemePref', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['light', 'dark', 'auto'] as const)('returns the saved "%s" choice', v => {
    stubStorage(v);
    expect(readThemePref()).toBe(v);
  });

  it('falls back to auto for missing or unknown values', () => {
    stubStorage(null);
    expect(readThemePref()).toBe('auto');
    stubStorage('purple');
    expect(readThemePref()).toBe('auto');
  });

  it('falls back to auto when storage throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(readThemePref()).toBe('auto');
  });
});
