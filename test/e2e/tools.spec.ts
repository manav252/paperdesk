import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { cleanExternalProjects } from './external-api';

// Word count, symbol palette, Vim/Emacs key bindings, spell check and PDF search, against the real API:
// locally through Docker, or against E2E_BASE_URL/E2E_API_URL when set.
const FIXTURE = path.resolve('test/fixtures/compile/synctex-sections');
const main = readFileSync(path.join(FIXTURE, 'main.tex'), 'utf8');
const results = readFileSync(path.join(FIXTURE, 'chapters/results.tex'), 'utf8');
const png = readFileSync(path.join(FIXTURE, 'figures/sample.png')).toString('base64');
const errorsByPage = new WeakMap<Page, string[]>();

async function open(page: Page, mainSource = main) {
  const project = {
    id: `tools-${Date.now().toString(36)}`, name: 'Tools check', modified: Date.now(), mainFile: 'main.tex',
    files: [
      { name: 'main.tex', content: mainSource },
      { name: 'chapters/', content: '' }, { name: 'chapters/results.tex', content: results },
      { name: 'figures/', content: '' }, { name: 'figures/sample.png', content: png, encoding: 'base64' },
    ],
  };
  await page.addInitScript(value => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('paperdesk-projects', JSON.stringify([value]));
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-help-seen', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
  }, project);
  await page.goto(`/#/paper/${project.id}/`);
  await expect(page.locator('.monaco-editor')).toBeVisible();
}

const editorText = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('paperdesk-projects')!)[0].files[0].content as string);

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-light', 'Real API features run once; other profiles cover layout.');
  test.setTimeout(240_000);
  await page.route('**/api/projects', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue());
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
});

test.afterEach(async ({ page, request }) => {
  if (process.env.E2E_BASE_URL) { await page.waitForTimeout(800); await cleanExternalProjects(page, request); }
  expect(errorsByPage.get(page) ?? []).toEqual([]);
});

test('word count runs texcount over the main file and its \\input files', async ({ page }) => {
  await open(page);
  await page.locator('.editor-menus .text-menu').filter({ hasText: 'File' }).click();
  await page.getByRole('menuitem', { name: 'Word count' }).click();
  const dialog = page.getByRole('dialog', { name: 'Word count' });
  await expect(dialog.getByTestId('word-total')).toHaveText('837', { timeout: 90_000 });
  await expect(dialog).toContainText('and 1 included file');
  await expect(dialog.getByRole('row', { name: /Words in text/ })).toContainText('819');
});

test('the symbol palette inserts commands at the cursor and can be searched', async ({ page }) => {
  await open(page, '\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n');
  await page.locator('.view-line').nth(2).click();
  await page.getByRole('button', { name: 'Symbol palette' }).click();
  const palette = page.getByRole('region', { name: 'Symbol palette' });
  await palette.getByRole('button', { name: 'Insert \\alpha' }).click();
  await palette.getByRole('tab', { name: 'Arrows' }).click();
  await palette.getByRole('button', { name: 'Insert \\Rightarrow', exact: true }).click();
  await palette.getByRole('textbox', { name: 'Search symbols' }).fill('infinity');
  await expect(palette.getByRole('button', { name: /^Insert / })).toHaveCount(1);
  await palette.getByRole('button', { name: 'Insert \\infty' }).click();
  await expect.poll(() => editorText(page)).toContain('\\alpha\\Rightarrow\\infty');
  await palette.getByRole('button', { name: 'Close symbol palette' }).click();
  await expect(palette).toHaveCount(0);
});

test('Vim and Emacs key bindings switch on and off without reloading the editor', async ({ page }) => {
  await open(page, '\\documentclass{article}\n\\begin{document}\nHello world\n\\end{document}\n');
  const settings = async (value: string) => {
    await page.getByRole('button', { name: 'Help and assistant' }).click().catch(() => undefined);
    await page.locator('.editor-menus .text-menu').filter({ hasText: 'Help' }).click();
    await page.getByRole('menuitem', { name: 'Project settings' }).click();
    await page.getByRole('combobox', { name: 'Key bindings' }).selectOption(value);
    await page.getByRole('button', { name: 'Done' }).click();
  };
  await page.keyboard.press('Escape');
  await settings('vim');
  const status = page.getByTestId('keymap-status');
  // The keymap code downloads on first use; wait until it is active before typing.
  await expect(status).toHaveAttribute('data-keymap', 'vim');
  // Normal mode: "x" deletes the character under the cursor instead of typing it.
  await page.locator('.view-line').filter({ hasText: 'Hello world' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('0');
  await page.keyboard.press('x');
  await expect.poll(() => editorText(page)).toContain('\nello world\n');
  await page.keyboard.press('i');
  await expect(status).toContainText('INSERT');
  await page.keyboard.type('H');
  await expect.poll(() => editorText(page)).toContain('\nHello world\n');

  await settings('emacs');
  await expect(status).toHaveAttribute('data-keymap', 'emacs');
  await page.locator('.view-line').filter({ hasText: 'Hello world' }).click();
  await page.keyboard.press('Control+x');
  await expect(status).toContainText('C-x');
  await page.keyboard.press('Escape');

  await settings('default');
  await expect(status).toHaveCount(0);
  await page.locator('.view-line').filter({ hasText: 'Hello world' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expect.poll(() => editorText(page)).toContain('Hello world!');
});

test('spell check marks prose only and offers suggestions on right-click', async ({ page }) => {
  await open(page, '\\documentclass{article}\n\\begin{document}\nThis sentense cites \\cite{knwth} and $\\alpah$.\nA Paperdeskish word.\n\\end{document}\n');
  const squiggles = page.locator('.monaco-editor .squiggly-warning');
  await expect(squiggles).toHaveCount(2, { timeout: 30_000 });

  const clickSquiggle = async (index: number) => {
    const box = (await squiggles.nth(index).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  };
  await clickSquiggle(0);
  const menu = page.getByRole('menu', { name: 'Spelling suggestions for sentense' });
  await menu.getByRole('menuitem', { name: 'sentence', exact: true }).click();
  await expect.poll(() => editorText(page)).toContain('This sentence cites');
  await expect(squiggles).toHaveCount(1);

  await clickSquiggle(0);
  await page.getByRole('menu', { name: 'Spelling suggestions for Paperdeskish' }).getByRole('menuitem', { name: /Add .Paperdeskish. to dictionary/ }).click();
  await expect(squiggles).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('paperdesk-dictionary'))).toContain('Paperdeskish');
});

test('PDF search finds text across pages with next and previous', async ({ page }) => {
  await open(page);
  const compiled = page.waitForResponse(r => /\/compile$/.test(new URL(r.url()).pathname) && r.status() === 200, { timeout: 180_000 });
  await page.getByRole('button', { name: /Recompile/ }).first().click();
  await compiled;
  await expect(page.locator('canvas[aria-label="PDF page 4"]')).toBeAttached();
  await page.getByRole('button', { name: 'Search the PDF' }).click();
  const box = page.getByRole('searchbox', { name: 'Search the PDF' }).or(page.getByRole('textbox', { name: 'Search the PDF' }));
  await box.fill('marker sentence');
  const count = page.locator('.pdf-search-count');
  await expect(count).toHaveText('1 of 4');
  await expect(page.locator('.pdf-search-hit.current').first()).toBeInViewport();
  await box.press('Enter');
  await expect(count).toHaveText('2 of 4');
  await page.getByRole('button', { name: 'Next match' }).click();
  await page.getByRole('button', { name: 'Next match' }).click();
  await expect(count).toHaveText('4 of 4');
  await expect(page.locator('[aria-label="Selectable text on PDF page 3"] .pdf-search-hit.current, [aria-label="Selectable text on PDF page 4"] .pdf-search-hit.current').first()).toBeInViewport();
  await box.press('Shift+Enter');
  await expect(count).toHaveText('3 of 4');
  await box.fill('no such phrase here');
  await expect(count).toHaveText('No results');
  await box.press('Escape');
  await expect(box).toHaveCount(0);
});
