import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { isolateProjects } from './isolate-projects';

// Typst projects in the interface. Compiles are faked here so the test is about the editor; real Typst compiles
// (success, error, timeout and every Typst template) run in `npm run test:compile`.
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
);

/** Opens the app on the dashboard: once the project list has loaded the app may reopen a project by itself. */
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

test('a Typst project: language choice, highlighting, compile, and an error that jumps to its line', async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== 'desktop-light', 'Runs once.');
  await isolateProjects(page, request);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) localStorage.setItem('paperdesk-projects', '[]');
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-help-seen', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
    // These tests cover Recompile; the live preview has its own tests (live-preview.spec.ts).
    localStorage.setItem('paperdesk-auto-compile', 'off');
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  // Typst compiles in the browser: nothing may reach the compile server.
  let serverCompiles = 0;
  page.on('request', (r) => {
    if (/\/compile$/.test(r.url())) serverCompiles++;
  });

  // New project: LaTeX is preselected, Typst creates main.typ.
  await dashboard(page);
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create a new project' });
  const languages = dialog.getByRole('radiogroup', { name: 'Document language' });
  await expect(languages.getByRole('radio', { name: 'LaTeX' })).toBeChecked();
  await languages.getByRole('radio', { name: 'Typst' }).click();
  await dialog.getByLabel('Project name').fill('Typst notes');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTitle('Rename project')).toContainText('Typst notes');
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toContainText('#set page');
  await expect(page.getByRole('button', { name: 'Rename main.typ' })).toBeAttached();
  // Typst highlighting: the heading line is coloured as a heading.
  await expect(editor.locator('.view-lines span[class*="mtk"]').filter({ hasText: '= Introduction' })).toHaveCount(1);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('paperdesk-projects')!).find((p: { name: string }) => p.name === 'Typst notes'),
  );
  expect(stored).toMatchObject({ language: 'typst', mainFile: 'main.typ' });
  await expect(page.locator('.status-bar')).toContainText('Typst');
  await expect(page.locator('.status-bar')).not.toContainText('LaTeX');

  // Recompile compiles in the browser, and the PDF shows in the same preview.
  await page.getByRole('button', { name: /^Recompile/ }).click();
  await expect(page.getByRole('region', { name: 'PDF preview' }).getByRole('status')).toContainText('Compiled in', {
    timeout: 60_000,
  });
  await expect(page.locator('canvas[aria-label="PDF page 1"]')).toBeVisible();
  expect(serverCompiles).toBe(0);

  // The compiler menu offers Typst only; LaTeX-only tools are switched off.
  await page.getByRole('button', { name: 'Compiler options' }).click();
  await expect(
    page.getByRole('menuitemcheckbox', { name: 'Typst' }).or(page.getByRole('menuitem', { name: 'Typst' })),
  ).toBeVisible();
  await expect(page.getByText('XeLaTeX')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A failed compile lists Typst's errors and warnings; clicking one goes to its line.
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+G');
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  await page.keyboard.type('#nope');
  await page.keyboard.press('ControlOrMeta+Home');
  await page.getByRole('button', { name: /^Recompile/ }).click();
  await page.getByRole('button', { name: 'View log' }).click();
  const log = page.getByRole('dialog', { name: 'Compile log' });
  await expect(log.getByRole('list', { name: 'errors' })).toContainText('unknown variable: nope');
  await log.getByRole('button', { name: /unknown variable: nope/ }).click();
  await expect(log).toBeHidden();
  await expect(page.locator('.status-bar')).toContainText('Ln 5, Col 1');

  // Templates: the language filter narrows the gallery, and a Typst template opens as a Typst project.
  await page.getByRole('button', { name: 'Back to projects' }).click();
  await page.getByRole('button', { name: 'Templates' }).click();
  const gallery = page.getByRole('region', { name: 'Templates' });
  await gallery.getByRole('radio', { name: 'Typst' }).click();
  await expect(gallery.locator('.template-card')).toHaveCount(3);
  await expect(gallery.locator('[data-template="typst-ieee"] .template-lang')).toHaveText('Typst');
  await gallery.getByRole('radio', { name: 'LaTeX' }).click();
  await expect(gallery.locator('[data-template^="typst-"]')).toHaveCount(0);
  await expect(gallery.locator('[data-template="article"] .template-lang')).toHaveText('LaTeX');
  await gallery.getByRole('radio', { name: 'Typst' }).click();
  await gallery.locator('[data-template="typst-report"]').click();
  await expect(page.getByTitle('Rename project')).toContainText('Project Report (Typst)');
  await expect(page.locator('.monaco-editor').first()).toContainText('Campus Bike-Share Pilot');
  await expect(page.getByRole('button', { name: 'Rename references.bib' })).toBeAttached();
  // A new project from a template compiles once by itself, in the browser too.
  await expect(page.getByRole('region', { name: 'PDF preview' }).getByRole('status')).toContainText('Compiled in', {
    timeout: 60_000,
  });
  expect(serverCompiles).toBe(0);
  expect(errors).toEqual([]);
});

test('a LaTeX project still compiles as LaTeX', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop-light', 'Runs once.');
  await isolateProjects(page, request);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) localStorage.setItem('paperdesk-projects', '[]');
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
    // These tests cover Recompile; the live preview has its own tests (live-preview.spec.ts).
    localStorage.setItem('paperdesk-auto-compile', 'off');
  });
  const compiles: { language?: string; mainFile?: string; engine?: string }[] = [];
  await page.route('**/api/projects/*/compile', (route) => {
    compiles.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        success: true,
        log: 'ok',
        errors: [],
        warnings: [],
        durationMs: 20,
        session: 's',
        pdf: PDF.toString('base64'),
      },
    });
  });
  await dashboard(page);
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create a new project' });
  await dialog.getByLabel('Project name').fill('LaTeX notes');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.monaco-editor').first()).toContainText('\\documentclass');
  await page.getByRole('button', { name: /^Recompile/ }).click();
  await expect.poll(() => compiles.length).toBe(1);
  expect(compiles[0]).toMatchObject({ language: 'latex', mainFile: 'main.tex', engine: 'pdflatex' });
  await page.getByRole('button', { name: 'Compiler options' }).click();
  await expect(page.getByText('XeLaTeX')).toBeVisible();
});

// The real compiler: locally through Docker (the image from `npm run compiler:build` includes Typst).
test('every Typst template compiles to a PDF, and a real error jumps to its line', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop-light' || !!process.env.E2E_BASE_URL, 'One real compile run is enough.');
  test.setTimeout(180_000);
  await isolateProjects(page, request);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) localStorage.setItem('paperdesk-projects', '[]');
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-help-seen', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
    // These tests cover Recompile; the live preview has its own tests (live-preview.spec.ts).
    localStorage.setItem('paperdesk-auto-compile', 'off');
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  const status = page.getByRole('region', { name: 'PDF preview' }).getByRole('status');
  for (const [id, text] of [
    ['typst-ieee', 'Low-Power Occupancy Sensing'],
    ['typst-cv', 'Ananya Mehta'],
    ['typst-report', 'Campus Bike-Share Pilot'],
  ]) {
    await dashboard(page);
    await page.getByRole('button', { name: 'Templates' }).click();
    const gallery = page.getByRole('region', { name: 'Templates' });
    await gallery.getByRole('radio', { name: 'Typst' }).click();
    // A template compiles as soon as it opens, in the browser, with no errors or warnings.
    await gallery.locator(`[data-template="${id}"]`).click();
    await expect(status, id).toContainText('Compiled in', { timeout: 60_000 });
    await expect(status, id).not.toContainText('warning');
    await expect(page.getByRole('button', { name: 'Go to error' })).toHaveCount(0);
    await expect(page.locator('.monaco-editor').first()).toContainText(text!);
    await expect(page.locator('.pdf-viewer canvas, .pdf-page canvas, canvas').first()).toBeVisible();
  }

  // Clicking a word in the PDF opens its file at its line, and the sync button shows the cursor's word in the PDF.
  const intro = readFileSync('templates/typst-report/chapters/introduction.typ', 'utf8').split('\n');
  const lineOf = (text: string) => intro.findIndex((l) => l.includes(text)) + 1;
  const word = page
    .locator('[aria-label^="Selectable text on PDF page"] span')
    .filter({ hasText: /approved/ })
    .first();
  await word.scrollIntoViewIfNeeded();
  await word.click();
  await expect(page.locator('.status-bar')).toContainText(`Ln ${lineOf('approved a one-year')},`);
  await expect(page.locator('.view-line').filter({ hasText: 'approved a one-year' })).toBeVisible();
  await expect(page.locator('.sync-source-highlight').first()).toBeVisible();
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+G');
  await page.keyboard.type(String(lineOf('Schemes of this kind')));
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Sync source to PDF' }).click();
  const highlight = page.getByTestId('sync-highlight');
  await expect(highlight).toBeInViewport();
  const printed = await page
    .locator('[aria-label^="Selectable text on PDF page"] span')
    .filter({ hasText: /Schemes of this kind/ })
    .first()
    .boundingBox();
  const box = await highlight.boundingBox();
  const middle = printed!.y + printed!.height / 2;
  expect(middle).toBeGreaterThanOrEqual(box!.y - 2);
  expect(middle).toBeLessThanOrEqual(box!.y + box!.height + 2);

  // Type a line with an error into the open document and recompile.
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('#nosuchthing');
  await page.keyboard.press('Enter');
  const typedOn = Number(/Ln (\d+)/.exec((await page.locator('.status-bar').textContent()) ?? '')?.[1]) - 1;
  expect(typedOn).toBeGreaterThan(0);
  await page.getByRole('button', { name: /^Recompile/ }).click();
  // The compiler reports the line that was typed, and the error takes the cursor back to it.
  // The jump above opened chapters/introduction.typ, so that is the file the error was typed into.
  await expect(page.getByRole('region', { name: 'PDF preview' })).toContainText(
    `chapters/introduction.typ:${typedOn} — unknown variable: nosuchthing`,
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: 'Go to error' }).click();
  await expect(page.locator('.status-bar')).toContainText(`Ln ${typedOn}, Col 1`);
  await page.getByRole('button', { name: 'View log' }).click();
  await expect(page.getByRole('dialog', { name: 'Compile log' })).toContainText('unknown variable: nosuchthing');
  expect(errors).toEqual([]);
});
