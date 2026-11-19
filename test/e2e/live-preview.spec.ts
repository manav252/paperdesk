import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { isolateProjects } from './isolate-projects';

// Typst's live preview with the real browser compiler (a Web Worker running Typst as WebAssembly): typing updates
// the PDF without Recompile, quickly, without freezing the page or losing the scroll position, and an error keeps
// the last good PDF. Timings are printed so they can be reported.
const abstractLine =
  readFileSync('templates/typst-report/main.typ', 'utf8')
    .split('\n')
    .findIndex((line) => line.startsWith('Riverbend University ran')) + 1;

async function goToLine(page: Page, line: number) {
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+G');
  await page.keyboard.type(String(line));
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
}
/** Opens the dashboard: with no projects the app opens its sample project, so go back from it. */
async function dashboard(page: Page) {
  const synced = page.waitForResponse(
    (r) => /\/api\/projects$/.test(new URL(r.url()).pathname) && r.request().method() === 'GET',
  );
  await page.goto('/');
  await synced;
  await page.waitForTimeout(300);
  if (await page.getByRole('button', { name: 'Back to projects' }).isVisible())
    await page.getByRole('button', { name: 'Back to projects' }).click();
}
const picture = (page: Page, n: number) =>
  page.locator(`canvas[aria-label="PDF page ${n}"]`).evaluate((c: HTMLCanvasElement) => c.toDataURL());

test('Typst updates the preview as you type, keeps the scroll position, and recovers from an error', async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== 'desktop-light' || !!process.env.E2E_BASE_URL, 'Runs once, in the local build.');
  test.setTimeout(180_000);
  await isolateProjects(page, request);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let serverCompiles = 0;
  page.on('request', (r) => {
    if (/\/compile$/.test(r.url())) serverCompiles++;
  });
  await page.addInitScript(() => {
    localStorage.setItem('paperdesk-projects', '[]');
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-help-seen', '1');
    // Main-thread tasks over 50 ms, to show whether compiling ever freezes the editor.
    const w = window as unknown as { longTasks: number[] };
    w.longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.longTasks.push(Math.round(entry.duration));
    }).observe({ type: 'longtask', buffered: true });
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );

  // Opening the template renders it in the browser; nothing is sent to the compile server.
  await dashboard(page);
  const opened = Date.now();
  await page.getByRole('button', { name: 'Templates' }).click();
  const gallery = page.getByRole('region', { name: 'Templates' });
  await gallery.getByRole('radio', { name: 'Typst' }).click();
  await gallery.locator('[data-template="typst-report"]').click();
  const status = page.getByRole('region', { name: 'PDF preview' }).getByRole('status');
  await expect(status).toContainText('Compiled in', { timeout: 60_000 });
  await expect(page.locator('canvas[aria-label="PDF page 10"]')).toBeAttached();
  const firstRender = Date.now() - opened;
  await expect(page.getByRole('checkbox', { name: 'Auto-compile' })).toBeChecked();

  // Scroll the preview to page 2, where the abstract is, and remember where it is.
  const scroller = page.locator('.pdf-scroll');
  await page.locator('canvas[aria-label="PDF page 2"]').scrollIntoViewIfNeeded();
  const scrolled = await scroller.evaluate((el) => el.scrollTop);
  const before = await picture(page, 2);
  await page.evaluate(() => ((window as unknown as { longTasks: number[] }).longTasks = []));

  // Type continuously, then measure how long the preview takes to show the last keystroke.
  await goToLine(page, abstractLine);
  await page.keyboard.type(' This sentence was typed into the live preview.', { delay: 40 });
  const typed = Date.now();
  await expect.poll(() => picture(page, 2), { timeout: 10_000, intervals: [25] }).not.toBe(before);
  const toPreview = Date.now() - typed;
  await expect(status).toContainText('Compiled in');
  const scrolledAfter = await scroller.evaluate((el) => el.scrollTop);
  expect(Math.abs(scrolledAfter - scrolled)).toBeLessThanOrEqual(2);
  const longTasks = await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks);

  // Ten more single edits, each timed from keystroke to repaint.
  const edits: number[] = [];
  for (let i = 0; i < 10; i++) {
    const was = await picture(page, 2);
    await page.keyboard.type(` ${i}`);
    const t = Date.now();
    await expect.poll(() => picture(page, 2), { timeout: 10_000, intervals: [20] }).not.toBe(was);
    edits.push(Date.now() - t);
  }

  // A syntax error shows its line in the preview and as a squiggle; the last good PDF stays on screen.
  const good = await picture(page, 2);
  await page.keyboard.press('Enter');
  await page.keyboard.type('#let = 1');
  await expect(page.getByRole('region', { name: 'PDF preview' })).toContainText(`main.typ:${abstractLine + 1}`, {
    timeout: 10_000,
  });
  await expect(page.locator('.monaco-editor .squiggly-error').first()).toBeVisible();
  expect(await picture(page, 2)).toBe(good);
  // Fixing it brings the preview back by itself.
  for (let i = 0; i < 9; i++) await page.keyboard.press('Backspace');
  await expect(status).toContainText('Compiled in', { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Go to error' })).toHaveCount(0);

  // The compile log has the compiler's own time for the latest update.
  await page.getByRole('button', { name: /^Logs/ }).click();
  const timings = await page.locator('.timing-table').innerText();
  await page.keyboard.press('Escape');

  // Turned off, typing no longer updates the preview; Recompile still does, in the browser.
  await page.getByRole('checkbox', { name: 'Auto-compile' }).uncheck();
  const frozen = await picture(page, 2);
  await page.locator('.monaco-editor .view-lines').first().click();
  await goToLine(page, abstractLine);
  await page.keyboard.type(' Not live.');
  await page.waitForTimeout(1500);
  expect(await picture(page, 2)).toBe(frozen);
  await page.getByRole('button', { name: /^Recompile/ }).click();
  await expect.poll(() => picture(page, 2), { timeout: 10_000 }).not.toBe(frozen);
  expect(serverCompiles).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('paperdesk-auto-compile'))).toBe('off');

  const sorted = [...edits].sort((a, b) => a - b);
  console.log(
    [
      `first render after opening the template: ${firstRender} ms`,
      `last keystroke to updated preview while typing continuously: ${toPreview} ms`,
      `single edits, keystroke to repaint: median ${sorted[5]} ms, slowest ${sorted.at(-1)} ms (${edits.join(', ')})`,
      `main-thread tasks over 50 ms while typing: ${longTasks.length ? longTasks.join(', ') + ' ms' : 'none'}`,
      `compile log for the last update:\n${timings}`,
    ].join('\n'),
  );
  expect(toPreview).toBeLessThan(1000);
  expect(errors).toEqual([]);
});

test('LaTeX still compiles only when asked', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop-light', 'Runs once.');
  await isolateProjects(page, request);
  let serverCompiles = 0;
  page.on('request', (r) => {
    if (/\/compile$/.test(r.url())) serverCompiles++;
  });
  await page.addInitScript(() => {
    localStorage.setItem('paperdesk-projects', '[]');
    localStorage.setItem('paperdesk-tour-done', '1');
  });
  await dashboard(page);
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create a new project' });
  await dialog.getByLabel('Project name').fill('LaTeX only');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Auto-compile' })).toHaveCount(0);
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.type('% typing');
  await page.waitForTimeout(1500);
  expect(serverCompiles).toBe(0);
});

test('the open file picks the mode: .typ compiles as you type, .tex never does, with nothing left over on switching', async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== 'desktop-light' || !!process.env.E2E_BASE_URL, 'Runs once, in the local build.');
  test.setTimeout(180_000);
  await isolateProjects(page, request);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let serverCompiles = 0;
  page.on('request', (r) => {
    if (/\/compile$/.test(r.url())) serverCompiles++;
  });
  await page.addInitScript(() => {
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-help-seen', '1');
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.removeItem('paperdesk-auto-compile');
    const now = Date.now();
    localStorage.setItem(
      'paperdesk-projects',
      JSON.stringify([
        {
          id: 'mode-typst',
          name: 'Mode Typst',
          modified: now,
          language: 'typst',
          mainFile: 'main.typ',
          files: [
            { name: 'main.typ', content: '= Live\n\nFirst paragraph.\n' },
            { name: 'notes.tex', content: '% Notes kept next to the Typst document.\n' },
          ],
        },
        {
          id: 'mode-latex',
          name: 'Mode LaTeX',
          modified: now - 1,
          mainFile: 'main.tex',
          files: [
            { name: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n' },
          ],
        },
      ]),
    );
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  const state = page.getByTestId('live-state');
  const typeAtEnd = async (text: string) => {
    await page.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.press('Control+G');
    await page.keyboard.type('1');
    await page.keyboard.press('Enter');
    await page.keyboard.press('End');
    await page.keyboard.type(text);
  };

  // A Typst project renders by itself and says so.
  await page.goto('/#/paper/mode-typst/');
  await expect(state).toHaveText('Live', { timeout: 60_000 });
  const first = await picture(page, 1);

  // Its .tex file is manual: typing there neither compiles nor shows the live indicator.
  await page.getByRole('treeitem', { name: /notes\.tex/ }).click();
  await expect(page.locator('.view-line').filter({ hasText: 'Notes kept next' })).toBeVisible();
  await expect(state).toHaveCount(0);
  await typeAtEnd(' more notes');
  await page.waitForTimeout(1200);
  expect(await picture(page, 1)).toBe(first);

  // Back on the .typ file, typing updates the preview: Compiling… then Live.
  await page.getByRole('treeitem', { name: /main\.typ/ }).click();
  await typeAtEnd(' typed');
  await expect(state).toHaveText('Compiling…');
  await expect(state).toHaveText('Live', { timeout: 10_000 });
  await expect.poll(() => picture(page, 1), { timeout: 10_000 }).not.toBe(first);

  // An error says Error and keeps the last good preview.
  const good = await picture(page, 1);
  await page.keyboard.type(' #nope');
  await expect(state).toHaveText('Error', { timeout: 10_000 });
  expect(await picture(page, 1)).toBe(good);
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  await expect(state).toHaveText('Live', { timeout: 10_000 });

  // A LaTeX project in the same session: typing compiles nothing, and no live compile is left running.
  await page.getByRole('button', { name: 'Back to projects' }).click();
  await page
    .getByRole('button', { name: /Mode LaTeX/ })
    .first()
    .click();
  await expect(page.locator('.view-line').filter({ hasText: 'documentclass' })).toBeVisible();
  await expect(state).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Auto-compile' })).toHaveCount(0);
  await typeAtEnd(' % typed');
  await page.waitForTimeout(1500);
  expect(serverCompiles).toBe(0);
  await expect(page.getByRole('region', { name: 'PDF preview' }).getByRole('status')).toHaveCount(0);

  // And back: the Typst project is live again.
  await page.getByRole('button', { name: 'Back to projects' }).click();
  await page
    .getByRole('button', { name: /Mode Typst/ })
    .first()
    .click();
  await expect(state).toHaveText('Live', { timeout: 30_000 });
  expect(serverCompiles).toBe(0);
  expect(errors).toEqual([]);
});
