import { describe, expect, it } from 'vitest';
import { addGraphicx, appendToBody, figureBlock, figurePath, figureSnippet, hasGraphicx, inDocumentBody, isFigureFile, needsPng } from './figure';

describe('figures', () => {
  it('accepts image formats and marks the ones that need converting', () => {
    for (const name of ['a.png', 'b.JPG', 'c.pdf', 'd.svg', 'e.eps', 'f.heic', 'g.webp']) expect(isFigureFile({ name, type: '' })).toBe(true);
    expect(isFigureFile({ name: 'clipboard', type: 'image/png' })).toBe(true);
    expect(isFigureFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
    expect([needsPng('a.heic'), needsPng('a.webp'), needsPng('x', 'image/webp'), needsPng('a.png'), needsPng('a.pdf')]).toEqual([true, true, true, false, false]);
  });

  it('gives safe, unique names in figures/', () => {
    const used = new Set(['figures/my-plot.png']);
    expect(figurePath('My Plot.png', 'image/png', used)).toBe('figures/my-plot-2.png');
    expect(figurePath('My Plot.png', 'image/png', used)).toBe('figures/my-plot-3.png');
    expect(figurePath('image.png', 'image/png', used, new Date('2026-11-11T09:30:05Z'))).toBe('figures/pasted-20261111-093005.png');
    expect(figurePath('Photo 1.HEIC', 'image/heic', used)).toBe('figures/photo-1.png');
    expect(figurePath('Übersicht (final).pdf', 'application/pdf', used)).toBe('figures/ubersicht-final.pdf');
    expect(figurePath('drawing.svg', 'image/svg+xml', new Set(['figures/drawing.png']))).toBe('figures/drawing-2.svg');
  });

  it('builds a full figure block and a snippet with the cursor in the caption', () => {
    expect(figureBlock('figures/plot.png')).toBe('\\begin{figure}[ht]\n  \\centering\n  \\includegraphics[width=\\linewidth]{figures/plot.png}\n  \\caption{}\n  \\label{fig:plot}\n\\end{figure}\n');
    const snippet = figureSnippet(['figures/a.png', 'figures/b.png']);
    expect(snippet).toContain('\\\\caption{$0\\}');
    expect(snippet.match(/\$0/g)).toHaveLength(1);
    expect(snippet).toContain('\\\\includegraphics[width=\\\\linewidth]{figures/b.png\\}');
  });

  it('detects and adds graphicx', () => {
    expect(hasGraphicx('\\documentclass{article}\n\\usepackage[final]{graphicx}')).toBe(true);
    expect(hasGraphicx('\\usepackage{amsmath, graphicx}')).toBe(true);
    expect(hasGraphicx('\\documentclass{beamer}')).toBe(true);
    expect(hasGraphicx('\\documentclass{article}\n% \\usepackage{graphicx}\n')).toBe(false);
    expect(addGraphicx('\\documentclass[11pt]{article}\n\\begin{document}')).toBe('\\documentclass[11pt]{article}\n\\usepackage{graphicx}\n\\begin{document}');
    expect(addGraphicx('\\documentclass{article}')).toBe('\\documentclass{article}\n\\usepackage{graphicx}\n');
  });

  it('knows the document body and appends before \\end{document}', () => {
    const source = '\\documentclass{article}\n\\begin{document}\nText\n\\end{document}\n';
    expect(inDocumentBody(source, 5)).toBe(false);
    expect(inDocumentBody(source, source.indexOf('Text'))).toBe(true);
    expect(inDocumentBody('A chapter file', 3)).toBe(true);
    expect(appendToBody(source, 'BLOCK\n')).toBe('\\documentclass{article}\n\\begin{document}\nText\n\nBLOCK\n\n\\end{document}\n');
  });
});
