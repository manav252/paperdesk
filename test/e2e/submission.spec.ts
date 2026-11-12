import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// "Check before submitting": every kind of problem is listed with a link to its place and a fix where there is one,
// a clean project passes, and the exports download. Compiling and the export service are faked here; the real
// export (compile, pick files, compile the ZIP again) is covered by npm run test:compile.
const errorsByPage = new WeakMap<Page, string[]>();
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const unembedded = readFileSync('test/fixtures/pdf/unembedded-font.pdf');
type Stored = { name: string; content: string; encoding?: string };
const messy: Stored[] = [
  {
    name: 'main.tex',
    content:
      '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\section{Intro}\\label{sec:intro}\nSee \\ref{sec:gone} and \\cite{nobody2020, knuth1984}.\n\\includegraphics{figures/missing}\n\\includegraphics{figures/plot}\n\\includegraphics{/Users/me/plot.png}\n\\input{sections/übersicht}\n\\input{sections/method}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n',
  },
  { name: 'sections/', content: '' },
  { name: 'sections/method.tex', content: 'Method text.\n' },
  { name: 'sections/übersicht.tex', content: 'Overview.\n' },
  { name: 'figures/', content: '' },
  { name: 'figures/plot.png', content: png, encoding: 'base64' },
  {
    name: 'refs.bib',
    content: '@book{knuth1984,\n  title = {The TeXbook}\n}\n\n@article{lamport1986,\n  title = {LaTeX}\n}\n',
  },
  { name: 'old-draft.tex', content: 'Old.' },
  { name: 'main.aux', content: '\\relax' },
];
const clean: Stored[] = [
  {
    name: 'main.tex',
    content:
      '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\\label{sec:intro}\nSee \\ref{sec:intro} and \\cite{knuth1984}.\n\\input{sections/method}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n',
  },
  { name: 'sections/', content: '' },
  { name: 'sections/method.tex', content: 'Method text.\n' },
  { name: 'refs.bib', content: '@book{knuth1984,\n  title = {The TeXbook}\n}\n' },
];

async function start(page: Page, files: Stored[], compile: { warnings?: object[]; pdf?: Buffer } = {}) {
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue(),
  );
  const pdf = compile.pdf ?? unembedded;
  await page.route('**/api/projects/*/compile', (route) =>
    route.fulfill({
      json: {
        success: true,
        log: 'ok',
        errors: [],
        warnings: compile.warnings ?? [],
        durationMs: 40,
        session: 's',
        pdf: pdf.toString('base64'),
      },
    }),
  );
  await page.route('**/api/projects/*/pdf*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf }),
  );
  await page.addInitScript((list) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem(
      'paperdesk-projects',
      JSON.stringify([
        {
          id: `submit-${Date.now().toString(36)}`,
          name: 'My Paper',
          modified: Date.now(),
          mainFile: 'main.tex',
          files: list,
        },
      ]),
    );
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-help-seen', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
  }, files);
  await page.goto('/');
  await page
    .getByRole('button', { name: /My Paper/ })
    .first()
    .click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
}
// The refused export (422) is expected; the browser logs every failed request.
test.afterEach(async ({ page }) => {
  expect((errorsByPage.get(page) ?? []).filter((e) => !e.includes('status of 422'))).toEqual([]);
});

const stored = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('paperdesk-projects')!)[0].files as Stored[]);
async function openMenuItem(page: Page, menu: string, item: RegExp | string) {
  if ((page.viewportSize()?.width ?? 1440) <= 860) await page.getByRole('button', { name: 'Menu' }).click();
  else await page.locator('.editor-menus .text-menu').filter({ hasText: menu }).first().click();
  await page.getByRole('menuitem', { name: item }).click();
}
async function openCheck(page: Page) {
  await openMenuItem(page, 'File', 'Check before submitting');
  const panel = page.getByRole('dialog', { name: 'Check before submitting' });
  await expect(panel).toBeVisible();
  return panel;
}

test('every kind of problem is listed, links jump to the source, and fixes change the project', async ({ page }) => {
  // Keep this project in the browser, as it is offline, so nothing but the panel's fixes changes its files.
  await page.route('**/api/projects/*', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ json: { name: 'My Paper', modified: Date.now(), mainFile: 'main.tex' } })
      : route.continue(),
  );
  await start(page, messy, {
    warnings: [{ file: 'sections/method.tex', line: 1, message: 'Overfull \\hbox (12.0pt too wide) in paragraph' }],
  });

  // Before compiling, the panel says so and offers to compile; the file checks already work.
  let panel = await openCheck(page);
  await expect(panel.locator('li[data-kind="not-compiled"]')).toBeVisible();
  await expect(panel.locator('li[data-kind="missing-file"]')).toContainText(
    'Figure “figures/missing” isn’t in the project.',
  );
  await panel.getByRole('button', { name: 'Compile now' }).click();
  await expect(panel.locator('li[data-kind="not-compiled"]')).toHaveCount(0);

  const expected: [string, string][] = [
    ['undefined-reference', 'Reference “sec:gone” has no \\label.'],
    ['undefined-citation', 'Citation “nobody2020” isn’t in the bibliography.'],
    ['missing-file', 'Figure “figures/missing” isn’t in the project.'],
    ['log-warning', 'Overfull \\hbox (12.0pt too wide) in paragraph'],
    ['absolute-path', '“/Users/me/plot.png” is an absolute path.'],
    ['build-file', 'main.aux is left over from compiling'],
    ['non-ascii-name', 'sections/übersicht.tex has characters outside plain ASCII'],
    ['font-not-embedded', 'Font “Helvetica” isn’t embedded in the PDF.'],
    ['unused-file', 'old-draft.tex isn’t used by main.tex.'],
    ['unused-bib-entry', 'Bibliography entry “lamport1986” is never cited.'],
  ];
  for (const [kind, text] of expected)
    await expect(panel.locator(`li[data-kind="${kind}"]`).first()).toContainText(text);
  await expect(panel.getByTestId('submission-summary')).toContainText('3 errors, 5 warnings, 2 suggestions.');
  await expect(panel.locator('li')).toHaveCount(expected.length);

  // A location link closes the panel and puts the cursor on that line.
  await panel.locator('li[data-kind="undefined-reference"]').getByRole('button', { name: 'main.tex, line 5' }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByText('Ln 5, Col 1')).toBeVisible();

  // Fixes: remove the unused entry, rename to ASCII (the document follows), delete the build file after confirming.
  panel = await openCheck(page);
  await panel.locator('li[data-kind="unused-bib-entry"]').getByRole('button', { name: 'Remove entry' }).click();
  await expect(panel.locator('li[data-kind="unused-bib-entry"]')).toHaveCount(0);
  await panel.locator('li[data-kind="non-ascii-name"]').getByRole('button', { name: 'Rename to plain ASCII' }).click();
  await expect(panel.locator('li[data-kind="non-ascii-name"]')).toHaveCount(0);
  await panel.locator('li[data-kind="build-file"]').getByRole('button', { name: 'Delete file' }).click();
  await page.getByRole('dialog', { name: 'Delete file?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(panel.locator('li[data-kind="build-file"]')).toHaveCount(0);
  await expect
    .poll(async () => (await stored(page)).map((f) => f.name).sort())
    .toEqual([
      'figures/',
      'figures/plot.png',
      'main.tex',
      'old-draft.tex',
      'refs.bib',
      'sections/',
      'sections/method.tex',
      'sections/ubersicht.tex',
    ]);
  const files = await stored(page);
  expect(files.find((f) => f.name === 'refs.bib')!.content).toBe('@book{knuth1984,\n  title = {The TeXbook}\n}\n');
  expect(files.find((f) => f.name === 'main.tex')!.content).toContain('\\input{sections/ubersicht}\n');
  await expect(panel.getByTestId('submission-summary')).toContainText('3 errors, 3 warnings, 1 suggestion.');
});

test('a clean project passes, and the exports download or explain why not', async ({ page }) => {
  await start(page, clean, { pdf: readFileSync('test/fixtures/compile/rich/figures/diagram.pdf') });
  const panel = await openCheck(page);
  await panel.getByRole('button', { name: 'Compile now' }).click();
  await expect(panel.getByTestId('submission-summary')).toContainText('No problems found.');
  await expect(panel.locator('li')).toHaveCount(0);

  // arXiv ZIP: the project's files are sent, and the ZIP that comes back is downloaded.
  let sent: { kind: string; mainFile: string; engine: string; files: Stored[] } | null = null,
    fail = false;
  await page.route('**/api/projects/*/export', (route) => {
    sent = route.request().postDataJSON();
    return fail
      ? route.fulfill({
          status: 422,
          json: {
            error: 'The exported files didn’t compile on their own, so the ZIP wasn’t created.',
            errors: [{ file: 'sections/method.tex', line: 1, message: 'Undefined control sequence.' }],
          },
        })
      : route.fulfill({
          status: 200,
          contentType: 'application/zip',
          body: Buffer.from('PK\u0005\u0006' + '\u0000'.repeat(18), 'latin1'),
        });
  });
  let download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'arXiv ZIP' }).click();
  expect((await download).suggestedFilename()).toBe('My-Paper-arxiv.zip');
  await expect(panel.getByText('The arXiv ZIP compiled on its own and was downloaded.')).toBeVisible();
  expect(sent!.kind).toBe('arxiv');
  expect(sent!.mainFile).toBe('main.tex');
  expect(sent!.files.map((f) => f.name)).toEqual(['main.tex', 'sections/method.tex', 'refs.bib']);
  download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Journal ZIP' }).click();
  expect((await download).suggestedFilename()).toBe('My-Paper-journal.zip');
  expect(sent!.kind).toBe('journal');

  // A ZIP that doesn't build is not downloaded: the reason and the error's location are shown instead.
  fail = true;
  await panel.getByRole('button', { name: 'arXiv ZIP' }).click();
  const alert = panel.getByRole('alert');
  await expect(alert).toContainText('didn’t compile on their own');
  await expect(alert).toContainText('Undefined control sequence.');

  // Single .tex file: \input is replaced by the file's text.
  download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Single .tex file' }).click();
  const flat = await download;
  expect(flat.suggestedFilename()).toBe('My-Paper-flattened.tex');
  const text = readFileSync(await flat.path(), 'utf8');
  expect(text).toContain('See \\ref{sec:intro} and \\cite{knuth1984}.\nMethod text.\n\\bibliographystyle{plain}');
  expect(text).not.toContain('\\input');

  await alert.getByRole('button', { name: 'sections/method.tex, line 1' }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator('.view-line').filter({ hasText: 'Method text.' })).toBeVisible();
});
