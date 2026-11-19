import { describe, expect, it } from 'vitest';
import { compileSegments, seconds } from './compileTrace';

describe('compile timing', () => {
  it('splits a compile into segments that add up to the time until the PDF is on screen', () => {
    const { segments, total, complete } = compileSegments(
      { click: 1000, prepared: 1040, answered: 3540, received: 3600, opened: 3900, painted: 4200 },
      { receive: 30, queue: 500, sync: 20, compiler: 1500, read: 10, total: 2100 },
    );
    expect(total).toBe(3200);
    expect(complete).toBe(true);
    expect(Object.fromEntries(segments.map((s) => [s.label, s.ms]))).toEqual({
      'Prepare files in the browser': 40,
      'Network and upload': 400,
      'Server: receive and check the request': 30,
      'Server: wait for other compiles': 500,
      'Server: write changed files': 20,
      'Compiler time': 1500,
      'Server: read the PDF and log': 10,
      'Server: other': 40,
      'Download the result': 60,
      'Open the PDF': 300,
      'Draw the first page': 300,
    });
    expect(segments.reduce((sum, s) => sum + s.ms, 0)).toBe(total);
  });
  it('stops at the last step that happened when the PDF is not shown', () => {
    const { segments, total, complete } = compileSegments({ click: 0, prepared: 10, answered: 510, received: 520 });
    expect(total).toBe(520);
    expect(complete).toBe(false);
    expect(segments.map((s) => s.label)).toEqual([
      'Prepare files in the browser',
      'Network and upload',
      'Download the result',
    ]);
  });
  it('splits a live-preview compile in the browser into its own steps', () => {
    const { segments, total } = compileSegments(
      { click: 0, waited: 200, prepared: 205, answered: 240, received: 240, opened: 300, painted: 340 },
      { compiler: 25 },
      true,
    );
    expect(total).toBe(340);
    expect(Object.fromEntries(segments.map((s) => [s.label, s.ms]))).toEqual({
      'Pause after typing': 200,
      'Prepare changed files': 5,
      'Send to the compiler and back': 10,
      'Compiler time': 25,
      'Download the result': 0,
      'Open the PDF': 60,
      'Draw the first page': 40,
    });
  });
  it('formats seconds to one decimal', () => {
    expect(seconds(5480)).toBe('5.5s');
  });
});
