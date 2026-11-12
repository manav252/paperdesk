import { describe, expect, it } from 'vitest';
import {
  appendEntries,
  bibKeys,
  escapeBibtex,
  formatEntry,
  fromArxiv,
  fromCrossref,
  makeKey,
  parseIdentifier,
  protectCapitals,
} from './bibtex';

describe('citation identifiers', () => {
  it('reads DOIs, doi.org links and arXiv ids', () => {
    expect(parseIdentifier('10.1145/3292500.3330701')).toEqual({ kind: 'doi', id: '10.1145/3292500.3330701' });
    expect(parseIdentifier(' https://doi.org/10.1038/S41586-020-2649-2. ')).toEqual({
      kind: 'doi',
      id: '10.1038/s41586-020-2649-2',
    });
    expect(parseIdentifier('arXiv:1706.03762v5')).toEqual({ kind: 'arxiv', id: '1706.03762' });
    expect(parseIdentifier('https://arxiv.org/abs/2301.01234')).toEqual({ kind: 'arxiv', id: '2301.01234' });
    expect(parseIdentifier('hep-th/9901001')).toEqual({ kind: 'arxiv', id: 'hep-th/9901001' });
    expect(parseIdentifier('https://doi.org/10.48550/arXiv.1706.03762')).toEqual({ kind: 'arxiv', id: '1706.03762' });
    expect(parseIdentifier('not a doi')).toBeNull();
    expect(parseIdentifier('')).toBeNull();
  });
});

describe('BibTeX entries', () => {
  it('escapes special characters and protects capitals', () => {
    expect(escapeBibtex('R&D costs 5% of <i>GDP</i> #1_a')).toBe('R\\&D costs 5\\% of GDP \\#1\\_a');
    expect(protectCapitals('A study of Bayesian methods for DNA in LaTeX: Results')).toBe(
      'A study of {Bayesian} methods for {DNA} in {LaTeX}: {Results}',
    );
    expect(protectCapitals('BERT rediscovers')).toBe('{BERT} rediscovers');
    expect(makeKey('Müller-Lüdenscheidt', '2019', 'The art of résumé')).toBe('mullerludenscheidt2019art');
  });

  it('builds an article from Crossref', () => {
    const entry = fromCrossref({
      type: 'journal-article',
      title: ['Array programming with NumPy'],
      author: [
        { family: 'Harris', given: 'Charles R.' },
        { family: 'van der Walt', given: 'Stéfan' },
      ],
      'container-title': ['Nature'],
      issued: { 'date-parts': [[2020, 9]] },
      volume: '585',
      issue: '7825',
      page: '357-362',
      publisher: 'Springer',
      DOI: '10.1038/s41586-020-2649-2',
    });
    expect(formatEntry(entry)).toBe(
      '@article{harris2020array,\n  author = {Harris, Charles R. and van der Walt, Stéfan},\n  title = {Array programming with {NumPy}},\n  journal = {Nature},\n  year = {2020},\n  volume = {585},\n  number = {7825},\n  pages = {357--362},\n  doi = {10.1038/s41586-020-2649-2}\n}',
    );
    expect(
      fromCrossref({ type: 'proceedings-article', title: ['T'], 'container-title': ['Proc. X'], publisher: 'ACM' })
        .fields,
    ).toEqual([
      ['title', 'T'],
      ['booktitle', 'Proc. X'],
      ['publisher', 'ACM'],
    ]);
    expect(fromCrossref({ type: 'book', title: ['B'] }).type).toBe('book');
  });

  it('builds a preprint from arXiv, and reports a missing id', () => {
    const atom =
      '<feed><entry><id>http://arxiv.org/abs/1706.03762v5</id><published>2017-06-12T17:57:34Z</published><title>Attention Is All\n  You Need</title><author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author><arxiv:primary_category term="cs.CL" scheme="x"/></entry></feed>';
    expect(formatEntry(fromArxiv(atom, '1706.03762')!)).toBe(
      '@misc{vaswani2017attention,\n  author = {Vaswani, Ashish and Shazeer, Noam},\n  title = {Attention {Is} {All} {You} {Need}},\n  year = {2017},\n  eprint = {1706.03762},\n  archivePrefix = {arXiv},\n  primaryClass = {cs.CL}\n}',
    );
    expect(fromArxiv('<feed></feed>', '0000.00000')).toBeNull();
  });

  it('finds keys and appends entries', () => {
    const bib = '@comment{x,}\n@article{knuth84,\n title={A}}\n@Book{ lamport94 ,\n}';
    expect(bibKeys(bib)).toEqual(['knuth84', 'lamport94']);
    expect(appendEntries('@a{x,\n}\n\n\n', ['@b{y,\n}', '@c{z,\n}\n'])).toBe('@a{x,\n}\n\n@b{y,\n}\n\n@c{z,\n}\n');
    expect(appendEntries('', ['@b{y,\n}'])).toBe('@b{y,\n}\n');
  });
});
