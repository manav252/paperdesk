import { describe, expect, it } from 'vitest';
import { parseForwardSync, parseInverseSync } from './synctex';

describe('SyncTeX CLI output', () => {
  it('maps a source position to a PDF point', () => {
    expect(parseForwardSync('SyncTeX result begin\nOutput:/work/main.pdf\nPage:2\nx:156.5\ny:88.25\nSyncTeX result end'))
      .toEqual({ page: 2, x: 156.5, y: 88.25 });
  });

  it('maps a PDF point back to a safe project path and source line', () => {
    expect(parseInverseSync('SyncTeX result begin\nOutput:/work/main.pdf\nInput:/work/./chapters/intro.tex\nLine:17\nColumn:-1\nSyncTeX result end'))
      .toEqual({ file: 'chapters/intro.tex', line: 17, column: 1 });
    expect(parseInverseSync('SyncTeX result begin\nInput:/work/../secrets.tex\nLine:1\nSyncTeX result end')).toBeNull();
  });

  it('returns null when there is no nearby SyncTeX record', () => {
    expect(parseForwardSync('SyncTeX result begin\nOutput:/work/main.pdf\nSyncTeX result end')).toBeNull();
    expect(parseInverseSync('SyncTeX result begin\nSyncTeX result end')).toBeNull();
  });
});
