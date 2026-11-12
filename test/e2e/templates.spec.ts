import { readdirSync, readFileSync, statSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// The template gallery: cards with previews, category filters and search, and a click that opens a complete,
// multi-file project and compiles it. (That every template really compiles is checked by npm run test:templates.)
const ids = readdirSync('templates').filter(name => !name.startsWith('_') && statSync(`templates/${name}`).isDirectory());
const pdf = readFileSync('test/fixtures/pdf/unembedded-font.pdf');
const errorsByPage = new WeakMap<Page, string[]>();
let compiles = 0;

test.beforeEach(async ({ page }) => {
  compiles = 0;
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('**/api/projects', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue());
  await page.route('**/api/health', route => route.fulfill({ json: { ok: true, compilerReady: true, maxCompileTimeoutMs: 120_000, assistant: { configured: false } } }));
  await page.route('**/api/projects/*/compile', route => { compiles++; return route.fulfill({ json: { success: true, log: 'ok', errors: [], warnings: [], durationMs: 40, session: 's', pdf: pdf.toString('base64') } }); });
  await page.route('**/api/projects/*/pdf*', route => route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf }));
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('paperdesk-projects', '[]');
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-help-seen', '1');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Templates' }).click();
  await expect(page.getByRole('heading', { name: 'Start from a template' })).toBeVisible();
});
test.afterEach(async ({ page }) => { expect(errorsByPage.get(page) ?? []).toEqual([]); });

test('the gallery shows every template with a preview, and filters by category and search', async ({ page }) => {
  const cards = page.locator('.template-card');
  await expect(cards).toHaveCount(ids.length);
  expect(ids.length).toBeGreaterThanOrEqual(9);
  // Every card has a title, a description, tags and a preview image that really loaded.
  for (const id of ids) {
    const card = page.locator(`.template-card[data-template="${id}"]`);
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('strong')).not.toBeEmpty();
    await expect(card.locator('.template-body > span')).not.toBeEmpty();
    expect(await card.locator('.template-tags i').count()).toBeGreaterThanOrEqual(2);
    await expect.poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  }
  await expect(cards.first()).toContainText('IEEE Conference Paper');

  // Category filters.
  const filters = page.getByRole('group', { name: 'Template category' });
  for (const name of ['All', 'Paper', 'CV', 'Report', 'Presentation', 'Letter']) await expect(filters.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  await filters.getByRole('button', { name: /^Presentation/ }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Beamer Presentation');
  await filters.getByRole('button', { name: /^Paper/ }).click();
  await expect(cards).toHaveCount(4);

  // Search narrows within the category; nothing found offers a way back.
  const search = page.getByRole('textbox', { name: 'Search templates' });
  await search.fill('springer');
  await expect(cards).toHaveCount(2);
  await search.fill('resume');
  await expect(cards).toHaveCount(0);
  await expect(page.getByText('No templates match “resume” in Paper.')).toBeVisible();
  await page.getByRole('button', { name: 'Show all templates' }).click();
  await expect(cards).toHaveCount(ids.length);
  await search.fill('resume');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('CV / Resume');
});

test('a card opens a complete multi-file project and compiles it', async ({ page }, info) => {
  await page.locator('.template-card[data-template="ieee-conference"]').click();
  // It compiles by itself once, so the PDF is there without pressing Recompile. On a phone the PDF takes the
  // whole screen; on a desktop it sits beside the source.
  await expect.poll(() => compiles).toBe(1);
  await expect(page.locator('canvas[aria-label="PDF page 1"]')).toBeVisible();
  if (!info.project.name.startsWith('phone')) {
    await expect(page.locator('.view-line').filter({ hasText: '\\documentclass[conference]{IEEEtran}' })).toBeVisible();
    await expect(page.locator('.file-tree')).toContainText('introduction.tex');
  }

  // The project holds every file of the template, images included, under the template's name.
  type Stored = { name: string; content: string; encoding?: string };
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('paperdesk-projects') ?? '[]').length)).toBe(1);
  const project = await page.evaluate(() => JSON.parse(localStorage.getItem('paperdesk-projects')!)[0] as { name: string; mainFile: string; files: Stored[] });
  expect(project.name).toBe('IEEE Conference Paper');
  expect(project.mainFile).toBe('main.tex');
  expect(project.files.map(f => f.name)).toEqual(['main.tex', 'references.bib', 'figures/', 'figures/accuracy.png', 'figures/system-overview.png', 'sections/', 'sections/conclusion.tex', 'sections/experiments.tex', 'sections/introduction.tex', 'sections/methodology.tex', 'sections/related-work.tex']);
  const figure = project.files.find(f => f.name === 'figures/accuracy.png')!;
  expect(figure.encoding).toBe('base64');
  expect(Buffer.from(figure.content, 'base64').equals(readFileSync('templates/ieee-conference/figures/accuracy.png'))).toBe(true);
  expect(project.files.find(f => f.name === 'sections/introduction.tex')!.content).toBe(readFileSync('templates/ieee-conference/sections/introduction.tex', 'utf8'));

  // And it compiled only that once.
  await page.waitForTimeout(2500);
  expect(compiles).toBe(1);
});
