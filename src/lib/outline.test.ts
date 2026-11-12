import { describe, expect, it } from 'vitest';
import { outlineOf } from './outline';

describe('outlineOf', () => {
  it('lists headings with their nesting level and line', () => {
    const tex =
      '\\section{Intro}\n% \\section{Old}\n\\subsection*{The \\emph{key} idea}\n\\section[Short]{Methods and \\textbf{Data}}';
    expect(outlineOf(tex)).toEqual([
      { level: 0, title: 'Intro', line: 1 },
      { level: 1, title: 'The key idea', line: 3 },
      { level: 0, title: 'Methods and Data', line: 4 },
    ]);
  });
});
