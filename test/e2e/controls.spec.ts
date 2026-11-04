import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Clicks through the main controls and checks each one visibly does something. Compiles are faked so the test is
// about the interface; real compiles are covered by rendering.spec.ts and the compile fixture suite.
const errorsByPage = new WeakMap<Page, string[]>();
let compiles = 0;
let compileFails = false;

test.beforeEach(async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop-light', 'Control coverage runs once; layout profiles are covered elsewhere.');
  if (!process.env.E2E_BASE_URL) {
    const response = await request.get('/api/projects');
    if (response.ok()) await Promise.all((await response.json() as { id: string }[]).map(project => request.delete(`/api/projects/${project.id}`)));
  }
  compiles = 0;
  compileFails = false;
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('paperdesk-projects', JSON.stringify([{ id: `controls-${Date.now()}`, name: 'Controls', modified: Date.now(), mainFile: 'main.tex', files: [
      { name: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\\label{sec:intro}\nHello world\n\\end{document}\n' },
      { name: 'refs.bib', content: '@article{knuth84,\n  title = {Literate Programming},\n}\n' },
    ] }]));
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('**/api/projects/*/compile', route => { compiles++; return route.fulfill({ json: compileFails ? { success: false, log: '! Package x Error: broken source.', errors: [{ file: 'main.tex', line: 2, message: 'broken source' }], warnings: [], durationMs: 50 } : { success: true, log: 'ok', errors: [], warnings: [], durationMs: 50, session: 's', pdf: twoPagePdf().toString('base64') } }); });
  await page.route('**/api/projects/*/pdf*', route => route.fulfill({ status: 200, contentType: 'application/pdf', body: twoPagePdf() }));
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
});

test.afterEach(async ({ page }) => { expect(errorsByPage.get(page) ?? []).toEqual([]); });

const source = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('paperdesk-projects')!)[0].files.find((f: { name: string }) => f.name === 'main.tex').content as string);

async function openControls(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Controls' }).click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
}

async function menu(page: Page, name: string, item: string | RegExp) {
  await page.locator('.editor-menus .text-menu').filter({ hasText: name }).click();
  await page.getByRole('menu').locator('[role^="menuitem"]').filter({ hasText: item }).first().click();
}

test('dashboard controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await page.getByRole('button', { name: 'Help' }).click();
  await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Templates' }).click();
  await expect(page.getByRole('heading', { name: 'Start from a template' })).toBeVisible();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Last modified' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Name' }).click();
  await expect(page.getByRole('button', { name: 'Name', exact: true })).toBeVisible();
  await page.getByLabel('Search projects').fill('nothing-matches');
  await expect(page.getByText('No projects found')).toBeVisible();
  await page.getByLabel('Clear search').click();
  const before = await page.locator('.project-row').count();
  await page.getByRole('button', { name: 'Project actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page.locator('.project-row')).toHaveCount(before + 1);
  await page.getByRole('button', { name: 'Help' }).click();
  await page.getByRole('menuitem', { name: 'Take the tour' }).click();
  await expect(page.getByRole('dialog', { name: 'Getting started tour' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip tour', exact: true }).click();
});

test('auto compile waits until a paste has been idle', async ({ page }) => {
  await openControls(page);
  await page.getByRole('button', { name: 'Compiler options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Auto compile: Off' }).click();
  const editor = page.getByRole('textbox', { name: 'Editor content' });
  await editor.click({ force: true });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.insertText('\n% pasted together\nA whole paste should become one idle compile.\n');
  await page.waitForTimeout(1000);
  expect(compiles).toBe(0);
  await expect.poll(() => compiles, { timeout: 10_000 }).toBe(1);
});

test('a failed recompile keeps the previous PDF and marks it out of date', async ({ page }) => {
  await openControls(page);
  await page.getByRole('button', { name: /^Recompile/ }).click();
  await expect(page.locator('.pdf-scroll canvas:not(.is-loading)').first()).toBeVisible();
  compileFails = true;
  await page.getByRole('button', { name: /^Recompile/ }).click();
  await expect(page.locator('.compile-banner')).toContainText('broken source');
  await expect(page.locator('.pdf-state')).toContainText('PDF is out of date');
  await expect(page.locator('.pdf-scroll canvas:not(.is-loading)').first()).toBeVisible();
});

test('a project created while the first sync is still loading is kept', async ({ page }) => {
  await page.route('**/api/projects', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await new Promise(r => setTimeout(r, 2500));
    await route.fulfill({ json: [] });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Templates' }).click();
  await page.getByRole('button', { name: /Article/ }).first().click();
  await expect(page.getByTitle('Rename project')).toContainText('Article');
  await page.waitForTimeout(3500);
  await expect(page.getByTitle('Rename project')).toContainText('Article');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('paperdesk-projects')!).some((p: { name: string }) => /Article/.test(p.name)))).toBe(true);
});

test('editor header, menus, panels and dialogs', async ({ page }) => {
  await openControls(page);
  for (const name of ['File', 'Edit', 'Insert', 'View', 'Help']) {
    await page.locator('.editor-menus .text-menu').filter({ hasText: name }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
  }
  await page.locator('.view-line').filter({ hasText: 'Hello world' }).click();
  await menu(page, 'Insert', 'Section');
  await expect.poll(() => source(page)).toContain('\\section{Section title}');
  await menu(page, 'View', 'Word wrap');
  await menu(page, 'View', 'Editor only');
  await expect(page.getByRole('region', { name: 'PDF preview' })).toHaveCount(0);
  await menu(page, 'View', 'PDF only');
  await expect(page.locator('.monaco-editor')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Editor & PDF' }).click();
  await expect(page.locator('.monaco-editor')).toBeVisible();

  await page.getByRole('button', { name: 'Change theme' }).click();
  await page.getByRole('menuitemradio', { name: /Dark/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Change theme' }).click();
  await page.getByRole('menuitemradio', { name: /Light/ }).click();

  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Assistant' })).toBeVisible();
  await page.getByRole('button', { name: 'Close assistant' }).click();

  await page.getByRole('button', { name: 'Share' }).click();
  const share = page.getByRole('dialog', { name: 'Share a read-only copy' });
  await share.getByRole('button', { name: 'Create link' }).click();
  await expect(share.getByLabel('Read-only copy link')).toHaveValue(/\?copy=[0-9a-f-]{36}$/);
  const link = await share.getByLabel('Read-only copy link').inputValue();
  await share.getByRole('button', { name: 'Close' }).last().click();

  await page.getByRole('button', { name: 'Comments' }).click();
  await page.getByRole('button', { name: 'Add comment at cursor' }).click();
  await page.getByLabel('Comment', { exact: true }).fill('Check this');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Comments' })).toContainText('Check this');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('Main document');
  await page.keyboard.press('Escape');
  await page.getByTitle('Rename project').click();
  await page.getByLabel('Project name').fill('Controls renamed');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByTitle('Rename project')).toContainText('Controls renamed');
  await page.getByRole('button', { name: 'Shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Help and assistant' }).click();
  await expect(page.getByRole('menuitem', { name: 'Take the tour' })).toBeVisible();
  await page.keyboard.press('Escape');

  // The share link opens a copy of the project in another browser profile.
  const other = await page.context().browser()!.newContext();
  const visitor = await other.newPage();
  // A new visitor has no projects yet (the first-visit path that once dropped the ?copy= link).
  await visitor.route('**/api/projects', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue());
  await visitor.addInitScript(() => localStorage.setItem('paperdesk-tour-done', '1'));
  await visitor.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await visitor.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await expect(visitor.getByTitle('Rename project')).toContainText('Controls (copy)');
  await other.close();
});

test('file tree, toolbar, autocomplete, compile and PDF controls', async ({ page }) => {
  await openControls(page);
  await page.getByRole('button', { name: 'New file' }).first().click();
  await page.getByLabel(/File name/).fill('notes.tex');
  await page.getByRole('button', { name: 'Create file' }).click();
  await expect(page.getByRole('tab', { name: 'notes.tex' })).toBeVisible();
  await page.getByRole('button', { name: 'New folder' }).first().click();
  await page.getByLabel('Folder name').fill('figures');
  await page.getByRole('button', { name: 'Create folder' }).click();
  await expect(page.locator('.file-label').getByText('figures', { exact: true })).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload files' }).click();
  await (await chooser).setFiles({ name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') });
  await expect(page.locator('.file-label').getByText('data.csv', { exact: true })).toBeVisible();
  await page.locator('.file-label').getByText('main.tex', { exact: true }).click();
  await page.getByRole('button', { name: 'Hide file tree' }).click();
  await page.getByRole('button', { name: 'Show file tree' }).click();
  await expect(page.getByRole('tree')).toBeVisible();
  await expect(page.getByLabel('File outline')).toContainText('Intro');

  // Bold wraps the selected word.
  await page.locator('.view-line').filter({ hasText: 'Hello world' }).dblclick();
  await page.getByRole('button', { name: 'Bold' }).click();
  await expect.poll(() => source(page)).toMatch(/\\textbf\{(Hello|world)\}/);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => source(page)).not.toContain('\\textbf');
  for (const name of ['Italic', 'Table', 'Equation', 'Bulleted list']) await page.getByRole('button', { name, exact: true }).click();
  await expect.poll(() => source(page)).toContain('\\begin{tabular}');
  const imageChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert image' }).click();
  await (await imageChooser).setFiles({ name: 'User attachment.png', mimeType: 'image/png', buffer: readFileSync(path.resolve('test/fixtures/compile/image-space-upload/user-attachment.png')) });
  await expect(page.locator('.file-label').getByText('user-attachment.png', { exact: true })).toBeVisible();
  await expect.poll(() => source(page)).toContain('\\includegraphics[width=0.8\\linewidth]{user-attachment.png}');

  // Autocomplete offers the project's labels and citation keys.
  await page.getByRole('textbox', { name: 'Editor content' }).click({ force: true });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.type('\nSee \\ref{');
  const labelSuggestion = page.getByRole('listbox', { name: 'Suggest' }).getByRole('option', { name: /sec:intro/ });
  await expect(labelSuggestion).toBeVisible();
  await labelSuggestion.click();
  await page.keyboard.type(' and \\cite{');
  const citationSuggestion = page.getByRole('listbox', { name: 'Suggest' }).getByRole('option', { name: /knuth84/ });
  await expect(citationSuggestion).toBeVisible();
  await citationSuggestion.click();
  await expect.poll(() => source(page)).toContain('See \\ref{sec:intro} and \\cite{knuth84}');

  await page.getByRole('button', { name: /^Recompile/ }).click();
  await expect(page.getByRole('region', { name: 'PDF preview' }).getByRole('status')).toContainText('Compiled in');
  await expect(page.locator('.pdf-page')).toHaveCount(2);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await expect.poll(() => compiles).toBeGreaterThanOrEqual(3);
  await page.getByRole('button', { name: 'Compiler options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'XeLaTeX' }).click();
  await page.getByRole('button', { name: 'Logs' }).click();
  await expect(page.getByRole('dialog', { name: 'Compile log' })).toContainText('Compiled successfully');
  await page.keyboard.press('Escape');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  const pdf = page.getByRole('toolbar', { name: 'PDF controls' });
  await pdf.getByRole('button', { name: 'Zoom in' }).click();
  await expect(pdf).toContainText('%');
  await pdf.getByRole('button', { name: 'Fit whole page' }).click();
  await expect(pdf).toContainText('Page');
  await pdf.getByRole('button', { name: 'Next page' }).click();
  await expect(pdf).toContainText('2 / 2');
  await pdf.getByRole('button', { name: 'Previous page' }).click();
  await expect(pdf).toContainText('1 / 2');
  await pdf.getByRole('button', { name: 'Fit to width' }).click();
  await expect(pdf).toContainText('Width');
  await page.getByRole('button', { name: 'Hide PDF preview' }).click();
  await expect(page.getByRole('region', { name: 'PDF preview' })).toHaveCount(0);
});

/** A two-page PDF with a line of text on each page. */
function twoPagePdf() {
  const pageObj = (n: number, content: number) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
  const text = (s: string) => { const body = `BT /F1 16 Tf 72 720 Td (${s}) Tj ET`; return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`; };
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    pageObj(1, 5), text('Page one'), pageObj(2, 7), text('Page two')];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}
