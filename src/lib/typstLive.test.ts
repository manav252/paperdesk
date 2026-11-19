import { describe, expect, it } from 'vitest';
import { changedFiles, LiveCompiler, liveDiagnostics, type WorkerRequest, type WorkerResponse } from './typstLive';

describe('files sent to the live compiler', () => {
  it('sends each file once, then only what changed, and drops removed files', () => {
    const sent = new Map<string, string>();
    const files = [
      { name: 'main.typ', content: '= Hi' },
      { name: 'figures/', content: '' },
      { name: 'figures/a.png', content: 'iVBORw0KGgo=', encoding: 'base64' as const },
    ];
    const first = changedFiles(files, sent);
    expect(first.sources).toEqual([{ path: '/main.typ', content: '= Hi' }]);
    expect(first.binaries.map((b) => [b.path, b.bytes.length])).toEqual([['/figures/a.png', 8]]);
    expect(first.removed).toEqual([]);
    expect(changedFiles(files, sent)).toEqual({ sources: [], binaries: [], removed: [] });
    const edited = changedFiles([{ name: 'main.typ', content: '= Hi there' }], sent);
    expect(edited.sources).toEqual([{ path: '/main.typ', content: '= Hi there' }]);
    expect(edited.removed).toEqual(['/figures/a.png']);
  });
});

describe('live diagnostics', () => {
  it('become the editor errors and warnings with one-based lines, hints joined to their error', () => {
    expect(
      liveDiagnostics(
        [
          { package: '', path: '/sections/a.typ', range: '4:2-4:9', severity: 'error', message: 'unknown variable: x' },
          { package: '', path: '/main.typ', range: '9:0-9:4', severity: 'hint', message: 'imported here' },
          { package: '', path: '/main.typ', range: '0:0-0:5', severity: 'warning', message: 'unknown font family' },
          { package: '@preview/x:1.0.0', path: '/lib.typ', range: '1:0-1:1', severity: 'error', message: 'boom' },
        ],
        'main.typ',
      ),
    ).toEqual({
      errors: [
        { file: 'sections/a.typ', line: 5, message: 'unknown variable: x (hint: imported here)' },
        { file: 'main.typ', line: null, message: 'boom (in @preview/x:1.0.0)' },
      ],
      warnings: [{ file: 'main.typ', line: 1, message: 'unknown font family' }],
    });
  });
});

/** A worker stand-in that answers each compile when the test says so. */
function fakeWorker() {
  const posted: WorkerRequest[] = [];
  const worker = {
    onmessage: null as ((e: MessageEvent<WorkerResponse>) => void) | null,
    postMessage(message: WorkerRequest) {
      posted.push(message);
    },
    terminate() {},
  };
  const answer = (id: number, pdf: number[] | null = [1]) =>
    worker.onmessage?.({
      data: { type: 'result', id, pdf: pdf && new Uint8Array(pdf), diagnostics: [], ms: 5 },
    } as unknown as MessageEvent<WorkerResponse>);
  return { worker, posted, answer };
}
const tick = () => new Promise((done) => setTimeout(done, 0));

describe('the live compiler queue', () => {
  it('runs one compile at a time and only the newest of the waiting ones', async () => {
    const fake = fakeWorker();
    const live = new LiveCompiler(() => fake.worker as unknown as Worker, '/fonts/');
    const file = (text: string) => [{ name: 'main.typ', content: text }];
    const first = live.compile(file('a'), 'main.typ', 'p1');
    const second = live.compile(file('ab'), 'main.typ', 'p1');
    const third = live.compile(file('abc'), 'main.typ', 'p1');
    await tick();
    const compiles = () => fake.posted.filter((m) => m.type === 'compile');
    expect(compiles()).toHaveLength(1);
    // The second request was replaced by the third before it started.
    expect(await second).toBeNull();
    fake.answer(1);
    // The first result is older than the newest edit, so it is marked stale.
    expect(await first).toMatchObject({ id: 1, stale: true });
    await tick();
    expect(compiles()).toHaveLength(2);
    const sentSecond = compiles()[1]!;
    expect(sentSecond.type === 'compile' && sentSecond.sources).toEqual([{ path: '/main.typ', content: 'abc' }]);
    fake.answer(3);
    expect(await third).toMatchObject({ id: 3, stale: false, ms: 5 });
  });

  it('starts from an empty file set when the project changes', async () => {
    const fake = fakeWorker();
    const live = new LiveCompiler(() => fake.worker as unknown as Worker, '/fonts/');
    const a = live.compile([{ name: 'main.typ', content: 'one' }], 'main.typ', 'p1');
    await tick();
    fake.answer(1);
    await a;
    const b = live.compile([{ name: 'main.typ', content: 'one' }], 'main.typ', 'p2');
    await tick();
    const last = fake.posted.at(-1)!;
    expect(last).toMatchObject({ type: 'compile', reset: true, sources: [{ path: '/main.typ', content: 'one' }] });
    fake.answer(2);
    expect(await b).toMatchObject({ stale: false });
    expect(fake.posted[0]).toEqual({ type: 'init', fontsUrl: '/fonts/' });
  });
});
