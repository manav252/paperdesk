import { describe, expect, it } from 'vitest';
import { maskTypst, sourceWords, typstOutline, typstWordCount } from './typstSource';

describe('Typst source reading', () => {
  it('keeps printed text and blanks out code without moving anything', () => {
    const source = [
      '#set page(paper: "a4", margin: (x: 2cm, y: 3cm)) // layout',
      '= Methods <sec:methods>',
      'We use *bold* and _italic_ text, see @sec:methods and $x^2 + y$.',
      '#figure(image("fig/a.png", width: 80%), caption: [A small caption.]) <fig:a>',
      '#counter(page).update(1)',
      '#include "chapters/one.typ"',
      '/* hidden',
      'block */ Visible again.',
    ].join('\n');
    const masked = maskTypst(source);
    expect(masked.length).toBe(source.length);
    expect(masked.split('\n').map((l) => l.length)).toEqual(source.split('\n').map((l) => l.length));
    const words = masked.split(/\s+/).filter(Boolean);
    expect(words).toEqual([
      'Methods',
      'We',
      'use',
      'bold',
      'and',
      'italic',
      'text,',
      'see',
      'and',
      '.',
      'A',
      'small',
      'caption.',
      'Visible',
      'again.',
    ]);
  });

  it('lists printed words with the line and column they start at', () => {
    const words = sourceWords([
      { name: 'main.typ', content: '#set text(size: 11pt)\n\n= Intro\nHello Wörld, it’s fine.' },
      { name: 'refs.bib', content: '@article{x, title = {Not read}}' },
    ]);
    expect(words.map((w) => [w.text, w.line, w.column])).toEqual([
      ['intro', 3, 3],
      ['hello', 4, 1],
      ['world', 4, 7],
      ["it's", 4, 14],
      ['fine', 4, 19],
    ]);
  });

  it('finds headings for the outline', () => {
    const outline = typstOutline(
      ['= Introduction <intro>', 'text', '== Background', '// = Not a heading', '#heading(level: 3)[Deep *one*]'].join(
        '\n',
      ),
    );
    expect(outline).toEqual([
      { level: 0, title: 'Introduction', line: 1 },
      { level: 1, title: 'Background', line: 3 },
      { level: 2, title: 'Deep one', line: 5 },
    ]);
  });

  it('counts words in text, headings and captions across included files', () => {
    const count = typstWordCount(
      [
        { name: 'main.typ', content: '= Title Here\nOne two three.\n#include "parts/a.typ"\n$ x = 1 $ and $y$.' },
        {
          name: 'parts/a.typ',
          content: '== Part\nFour five.\n#figure(image("../f.png"), caption: [Cap words here.])',
        },
        { name: 'unused.typ', content: 'Never counted at all.' },
      ],
      'main.typ',
    )!;
    expect(count).toMatchObject({
      text: 6,
      headers: 3,
      captions: 3,
      total: 12,
      headerCount: 2,
      floats: 1,
      mathInline: 1,
      mathDisplay: 1,
      files: 2,
    });
    expect(typstWordCount([], 'main.typ')).toBeNull();
  });
});
