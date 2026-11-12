import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { cleanExternalProjects } from './external-api';

// Real SyncTeX in both directions on a 4-page, two-file document, compiled by the real TeX engine:
// locally through Docker, or against E2E_BASE_URL/E2E_API_URL when set.
const FIXTURE = path.resolve('test/fixtures/compile/synctex-sections');
const main = readFileSync(path.join(FIXTURE, 'main.tex'), 'utf8');
const results = readFileSync(path.join(FIXTURE, 'chapters/results.tex'), 'utf8');
const png = readFileSync(path.join(FIXTURE, 'figures/sample.png')).toString('base64');
const lineOf = (source: string, text: string) => source.split('\n').findIndex((line) => line.includes(text)) + 1;
const errorsByPage = new WeakMap<Page, string[]>();
const syncInFlight = new WeakMap<Page, { n: number }>();

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-light', 'Real compiles run once; other profiles cover layout.');
  test.setTimeout(300_000);
  const project = {
    id: `sync-${Date.now().toString(36)}`,
    name: 'Sync check',
    modified: Date.now(),
    mainFile: 'main.tex',
    files: [
      { name: 'main.tex', content: main },
      { name: 'chapters/', content: '' },
      { name: 'chapters/results.tex', content: results },
      { name: 'figures/', content: '' },
      { name: 'figures/sample.png', content: png, encoding: 'base64' },
    ],
  };
  await page.addInitScript((value) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('paperdesk-projects', JSON.stringify([value]));
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-help-seen', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
  }, project);
  // Never read or change the tester's own projects on a live site.
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue(),
  );
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  const inFlight = { n: 0 };
  syncInFlight.set(page, inFlight);
  page.on('request', (r) => {
    if (r.url().includes('/synctex')) inFlight.n++;
  });
  for (const done of ['requestfinished', 'requestfailed'] as const)
    page.on(done, (r) => {
      if (r.url().includes('/synctex')) inFlight.n--;
    });
  page.on('response', (r) => {
    if (r.url().includes('/synctex') && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(`/#/paper/${project.id}/`);
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await compile(page);
});

test.afterEach(async ({ page, request }) => {
  if (process.env.E2E_BASE_URL) {
    await page.waitForTimeout(800);
    await cleanExternalProjects(page, request);
  }
  expect(errorsByPage.get(page) ?? []).toEqual([]);
});

async function compile(page: Page) {
  const done = page.waitForResponse((r) => /\/compile$/.test(new URL(r.url()).pathname) && r.status() === 200, {
    timeout: 240_000,
  });
  await page
    .getByRole('button', { name: /Recompile/ })
    .first()
    .click();
  // The body can be lost if the connection resets after the answer; the PDF appearing below is the real check.
  const body = await (await done).json().catch(() => null);
  if (body) expect(body.success).toBe(true);
  await expect(page.locator('canvas[aria-label="PDF page 4"]')).toBeAttached();
  await expect(page.locator('canvas[aria-label="PDF page 1"]')).not.toHaveClass(/is-loading/);
}

async function setZoom(page: Page, percent: number) {
  const label = page.locator('.zoom-label');
  for (let i = 0; i < 40; i++) {
    const text = await label.textContent();
    const now = text?.endsWith('%') ? Number.parseInt(text) : null;
    if (now === percent) return;
    await page.getByRole('button', { name: now !== null && now > percent ? 'Zoom out' : 'Zoom in' }).click();
  }
  throw new Error(`Could not set zoom to ${percent}%`);
}

const textOn = (page: Page, pdfPage: number, text: RegExp) =>
  page.locator(`[aria-label="Selectable text on PDF page ${pdfPage}"] span`).filter({ hasText: text }).first();

/** Double-clicks PDF text and returns the editor line the jump lands on (and checks the line is highlighted). */
async function jumpFrom(page: Page, pdfPage: number, text: RegExp) {
  const target = textOn(page, pdfPage, text);
  await target.scrollIntoViewIfNeeded();
  // Let any lookup from the previous double-click (one per click and one for the selected word) finish first.
  const idle = () => expect.poll(() => syncInFlight.get(page)!.n, { timeout: 60_000 }).toBe(0);
  await idle();
  const response = page.waitForResponse(
    (r) =>
      r.url().includes('/synctex') &&
      r.request().postDataJSON().mode === 'inverse' &&
      r.request().postDataJSON().page === pdfPage,
  );
  await target.dblclick();
  const body = await (await response).json();
  await idle();
  expect(body.found).toBe(true);
  await expect(page.locator('.sync-source-highlight').first()).toBeVisible();
  await expect
    .poll(async () => Number((await page.locator('.status-bar').textContent())?.match(/Ln (\d+)/)?.[1]))
    .toBe(body.line);
  return body as { file: string; line: number };
}

/** Puts the cursor on a 1-based line of the open file. */
async function cursorTo(page: Page, line: number) {
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+G');
  await page.keyboard.type(String(line));
  await page.keyboard.press('Enter');
  await expect(page.locator('.status-bar')).toContainText(`Ln ${line},`);
}

const near = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected), `line ${actual}, expected ${expected} ±1`).toBeLessThanOrEqual(1);

for (const zoom of [100, 150]) {
  test(`PDF text jumps to its source line at ${zoom}% zoom`, async ({ page }) => {
    await setZoom(page, zoom);

    const conclusion = await jumpFrom(page, 3, /^\s*(4\s*)?Conclusion\s*$/);
    expect(conclusion.file).toBe('main.tex');
    near(conclusion.line, lineOf(main, '\\section{Conclusion}'));

    const first = await jumpFrom(page, 1, /Opening marker sentence/);
    near(first.line, lineOf(main, 'Opening marker sentence'));

    // A filler paragraph on a middle page names itself ("Method continued paragraph 3: …").
    const label = (await textOn(page, 2, /paragraph \d+:/).textContent())!
      .match(/([A-Za-z ]+ paragraph \d+):/)![1]!
      .trim();
    const fromMiddle = await jumpFrom(page, 2, new RegExp(`${label}:`));
    near(fromMiddle.line, lineOf(fromMiddle.file === 'main.tex' ? main : results, `${label}:`));

    const last = await jumpFrom(page, 4, /Conclusion paragraph 3:/);
    near(last.line, lineOf(main, 'Conclusion paragraph 3:'));

    // Text from \input{chapters/results} opens that file at the matching line.
    const chapter = await jumpFrom(page, 3, /Results marker sentence/);
    expect(chapter.file).toBe('chapters/results.tex');
    near(chapter.line, lineOf(results, 'Results marker sentence'));
    await expect(page.locator('.view-line').filter({ hasText: 'Results marker sentence' })).toBeVisible();
  });

  test(`the sync button scrolls the PDF to the cursor line at ${zoom}% zoom`, async ({ page }) => {
    await setZoom(page, zoom);
    await page.locator('.pdf-scroll').evaluate((el) => {
      el.scrollTop = 0;
    });
    await cursorTo(page, lineOf(main, '\\section{Conclusion}'));
    await page.getByRole('button', { name: 'Sync source to PDF' }).click();
    const highlight = page.locator('.pdf-page').nth(2).getByTestId('sync-highlight');
    await expect(highlight).toBeAttached();
    await expect(highlight).toBeInViewport();
    // The highlight covers the Conclusion heading itself.
    const heading = await textOn(page, 3, /^\s*(4\s*)?Conclusion\s*$/).boundingBox();
    const box = await highlight.boundingBox();
    expect(heading && box).toBeTruthy();
    const middleY = heading!.y + heading!.height / 2;
    expect(middleY).toBeGreaterThanOrEqual(box!.y);
    expect(middleY).toBeLessThanOrEqual(box!.y + box!.height);
  });
}

test('sync uses the newest compile after an edit', async ({ page }) => {
  await setZoom(page, 100);
  const before = await jumpFrom(page, 3, /^\s*(4\s*)?Conclusion\s*$/);
  // Insert three lines near the top, so every later source line moves down by three.
  await cursorTo(page, lineOf(main, 'Opening marker sentence'));
  await page.keyboard.press('Home');
  await page.keyboard.type('Inserted sentence after an edit.\n\n\n');
  await compile(page);
  await expect(textOn(page, 1, /Inserted sentence after an edit/)).toBeAttached();
  const after = await jumpFrom(page, 3, /^\s*(4\s*)?Conclusion\s*$/);
  expect(after.line).toBe(before.line + 3);
});
