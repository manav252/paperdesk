import { describe, expect, it } from 'vitest';
import { mentionQuery, tokenize } from './chatText';

const files = ['main.tex', 'chapters/intro.tex', 'figures/plot.png', 'a/notes.txt', 'b/notes.txt'];
const handles = ['ada', 'bob.smith'];

describe('chat message parts', () => {
  it('links project files, with or without a line number', () => {
    expect(tokenize('see main.tex:42 and intro.tex.', files, handles)).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'file', text: 'main.tex:42', file: 'main.tex', line: 42 },
      { type: 'text', text: ' and ' },
      { type: 'file', text: 'intro.tex', file: 'chapters/intro.tex', line: null },
      { type: 'text', text: '.' },
    ]);
  });
  it('leaves unknown or ambiguous names as text', () => {
    expect(tokenize('other.tex and notes.txt, v1.2 e.g. this', files, handles)).toEqual([
      { type: 'text', text: 'other.tex and notes.txt, v1.2 e.g. this' },
    ]);
  });
  it('marks mentions of people on the project only', () => {
    expect(tokenize('@ada ping @bob.smith. not @carol or x@ada', files, handles)).toEqual([
      { type: 'mention', text: '@ada', handle: 'ada' },
      { type: 'text', text: ' ping ' },
      { type: 'mention', text: '@bob.smith', handle: 'bob.smith' },
      { type: 'text', text: '. not @carol or x@ada' },
    ]);
  });
  it('never produces markup: tags stay text', () => {
    expect(tokenize('<img src=x onerror=alert(1)>', files, handles)).toEqual([
      { type: 'text', text: '<img src=x onerror=alert(1)>' },
    ]);
  });
});

describe('mention autocomplete', () => {
  it('finds the name being typed before the caret', () => {
    expect(mentionQuery('hi @ad', 6)).toEqual({ start: 3, query: 'ad' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('hi @ad more', 11)).toBeNull();
    expect(mentionQuery('mail x@ad', 9)).toBeNull();
  });
});
