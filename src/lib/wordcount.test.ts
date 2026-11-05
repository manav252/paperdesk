import { describe, expect, it } from 'vitest';
import { parseTexcount } from './wordcount';

describe('texcount summary', () => {
  it('reads the totals and ignores Perl warnings', () => {
    const output = 'Possible precedence problem between ! and pattern match (m//) at /usr/bin/texcount line 1430.\nTotal\nSum count: 837\nWords in text: 819\nWords in headers: 9\nWords outside text (captions, etc.): 8\nNumber of headers: 5\nNumber of floats/tables/figures: 2\nNumber of math inlines: 0\nNumber of math displayed: 1\nFiles: 2\n';
    expect(parseTexcount(output)).toEqual({ total: 837, text: 819, headers: 9, captions: 8, headerCount: 5, floats: 2, mathInline: 0, mathDisplay: 1, files: 2 });
  });

  it('returns null without word totals', () => {
    expect(parseTexcount('File not found: main.tex')).toBeNull();
  });
});
