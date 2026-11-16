import { describe, expect, it } from 'vitest';
import { defaultMainFile, parseTypstLog, projectLanguage } from './typstLog';
import { languageOf, mainFileOf, sourceExt } from './project';

describe('Typst compiler output', () => {
  it('reads errors and warnings with their file and line', () => {
    const output = [
      'sections/results.typ:3:7: error: unknown variable: totl',
      'main.typ:12:0: warning: unknown font family: nope font',
      'main.typ:20:4: error: expected expression',
    ].join('\n');
    expect(parseTypstLog(output)).toEqual({
      errors: [
        { file: 'sections/results.typ', line: 3, message: 'unknown variable: totl' },
        { file: 'main.typ', line: 20, message: 'expected expression' },
      ],
      warnings: [{ file: 'main.typ', line: 12, message: 'unknown font family: nope font' }],
    });
  });
  it('keeps problems without a place, hints, and problems inside packages', () => {
    const output = [
      'error: input file not found (searched at ./main.typ)',
      './main.typ:4:1: error: unknown variable: foo',
      '  = hint: if you meant to use subtraction, try adding spaces around the minus sign',
      '@preview/cetz:0.3.1/src/lib.typ:9:2: error: something inside a package',
      'report.typ:1:8: error: failed to download package (https://packages.typst.org/x: Connection refused)',
    ].join('\r\n');
    const { errors, warnings } = parseTypstLog(output, 'report.typ');
    expect(warnings).toEqual([]);
    expect(errors[0]).toEqual({
      file: 'report.typ',
      line: null,
      message: 'input file not found (searched at ./main.typ)',
    });
    expect(errors[1]).toMatchObject({ file: 'main.typ', line: 4 });
    expect(errors[1]!.message).toContain('(hint: if you meant to use subtraction');
    expect(errors[2]).toMatchObject({ file: 'report.typ', line: null });
    expect(errors[2]!.message).toContain('@preview/cetz');
    expect(errors[3]).toMatchObject({ file: 'report.typ', line: 1 });
  });
  it('finds nothing in clean output', () => {
    expect(parseTypstLog('')).toEqual({ errors: [], warnings: [] });
  });
});

describe('project language', () => {
  it('defaults to LaTeX and follows the stored value or the main file', () => {
    expect(projectLanguage(undefined)).toBe('latex');
    expect(projectLanguage('typst')).toBe('typst');
    expect(projectLanguage('latex', 'main.typ')).toBe('latex');
    expect(projectLanguage(undefined, 'paper.typ')).toBe('typst');
    expect(projectLanguage('python', 'main.tex')).toBe('latex');
    expect(defaultMainFile('typst')).toBe('main.typ');
  });
  it('gives each project its main file and source extension', () => {
    expect(languageOf({})).toBe('latex');
    expect(mainFileOf({})).toBe('main.tex');
    expect(sourceExt({})).toBe('.tex');
    expect(mainFileOf({ language: 'typst' })).toBe('main.typ');
    expect(sourceExt({ language: 'typst', mainFile: 'thesis.typ' })).toBe('.typ');
    expect(mainFileOf({ language: 'typst', mainFile: 'thesis.typ' })).toBe('thesis.typ');
  });
});
