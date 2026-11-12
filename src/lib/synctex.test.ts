import { describe, expect, it } from 'vitest';
import { parseForwardSync, parseInverseSync, toSyncTexPoint } from './synctex';

describe('SyncTeX CLI output', () => {
  it('maps a source position to a PDF point', () => {
    expect(
      parseForwardSync('SyncTeX result begin\nOutput:/work/main.pdf\nPage:2\nx:156.5\ny:88.25\nSyncTeX result end'),
    ).toEqual({ page: 2, x: 156.5, y: 88.25 });
  });

  it('returns the matched box when SyncTeX reports one', () => {
    expect(
      parseForwardSync(
        'SyncTeX result begin\nOutput:/work/main.pdf\nPage:1\nx:133.7\ny:134.7\nh:133.7\nv:137.5\nW:343.7\nH:12.6\nSyncTeX result end',
      ),
    ).toEqual({ page: 1, x: 133.7, y: 137.5, width: 343.7, height: 12.6 });
  });

  it('flips pdf.js user space (origin bottom-left) to SyncTeX points from the top-left', () => {
    // US Letter page: a click near the top of the page must stay near the top, not jump to the bottom.
    expect(toSyncTexPoint([0, 0, 612, 792], 150, 660)).toEqual({ x: 150, y: 132 });
    expect(toSyncTexPoint([10, 20, 622, 812], 160, 680)).toEqual({ x: 150, y: 132 });
  });

  it('maps a PDF point back to a safe project path and source line', () => {
    expect(
      parseInverseSync(
        'SyncTeX result begin\nOutput:/work/main.pdf\nInput:/work/./chapters/intro.tex\nLine:17\nColumn:-1\nSyncTeX result end',
      ),
    ).toEqual({ file: 'chapters/intro.tex', line: 17, column: 1 });
    expect(parseInverseSync('SyncTeX result begin\nInput:/work/../secrets.tex\nLine:1\nSyncTeX result end')).toBeNull();
  });

  it('returns null when there is no nearby SyncTeX record', () => {
    expect(parseForwardSync('SyncTeX result begin\nOutput:/work/main.pdf\nSyncTeX result end')).toBeNull();
    expect(parseInverseSync('SyncTeX result begin\nSyncTeX result end')).toBeNull();
  });
});
