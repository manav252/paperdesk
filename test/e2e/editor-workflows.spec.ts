import { expect, test, type Page } from '@playwright/test';
import { cleanExternalProjects } from './external-api';

const templates = ['IEEE conference', 'Springer', 'Article', 'Report', 'Beamer', 'CV'];
const errorsByPage = new WeakMap<Page, string[]>();
const syncModesByPage = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page, request }) => {
  // A local run gets a fresh API store for every test. Never delete data on an external E2E_BASE_URL.
  if (!process.env.E2E_BASE_URL) {
    const response = await request.get('/api/projects');
    if (response.ok()) {
      const projects = await response.json() as { id: string }[];
      await Promise.all(projects.map(project => request.delete(`/api/projects/${project.id}`)));
    }
  }
  await page.addInitScript(() => {
    localStorage.setItem('paperdesk-projects', '[]');
    localStorage.setItem('paperdesk-tour-done', '1');
  });
  if (process.env.E2E_BASE_URL) {
    // Keep an external site isolated from existing user projects while each test creates its own workspace.
    await page.route('**/api/projects', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue());
  }
  if (!process.env.E2E_BASE_URL) {
    const pdf = onePagePdf();
    await page.route('**/api/health', route => route.fulfill({ json: { ok: true, compilerReady: true, maxCompileTimeoutMs: 120_000, assistant: { configured: false } } }));
    await page.route('**/api/projects/*/compile', route => route.fulfill({ json: { success: true, log: '', errors: [], warnings: [], durationMs: 100 } }));
    await page.route('**/api/projects/*/pdf*', route => route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf }));
  }
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  syncModesByPage.set(page, []);
  if (!process.env.E2E_BASE_URL) {
    await page.route('**/api/projects/*/synctex', async route => {
      const mode = route.request().postDataJSON().mode as string;
      syncModesByPage.get(page)?.push(mode);
      await route.fulfill({ json: mode === 'forward' ? { found: true, page: 1, x: 110, y: 125 } : { found: true, file: 'main.tex', line: 3, column: 1 } });
    });
  }
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
});

test.afterEach(async ({ page, request }) => {
  if (process.env.E2E_BASE_URL) { await page.waitForTimeout(800); await cleanExternalProjects(page, request); }
  expect(errorsByPage.get(page)).toEqual([]);
});

async function openTemplate(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await page.getByRole('button', { name: 'Templates' }).click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/);
}

async function appendToEditor(page: Page, text: string) {
  const editor = page.getByRole('textbox', { name: 'Editor content' });
  await editor.click({ force: true });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.type(text);
}

async function compileAndViewPdf(page: Page) {
  if (test.info().project.name.startsWith('phone')) {
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: 'Compile' }).click();
  } else await page.getByRole('button', { name: /^Recompile/ }).first().click();
  await expect(page.getByRole('region', { name: 'PDF preview' }).getByRole('status')).toContainText('Compiled in', { timeout: 120_000 });
  await expect(page.locator('.pdf-scroll canvas:not(.is-loading)')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('toolbar', { name: 'PDF controls' })).toBeVisible();
}

for (const template of templates) {
  test(`${template} starter can be edited, compiled and rendered`, async ({ page }) => {
    await openTemplate(page, template);
    if (template === 'Springer') {
      const files = await page.evaluate(() => (JSON.parse(localStorage.getItem('paperdesk-projects') ?? '[]')[0]?.files ?? []).map((file: { name: string }) => file.name));
      expect(files).toEqual(expect.arrayContaining(['sn-jnl.cls', 'sn-mathphys-num.bst', 'references.bib']));
    }
    await appendToEditor(page, '\n% Browser compile check\n');
    await compileAndViewPdf(page);
    if (test.info().project.name.startsWith('phone')) await page.getByRole('radio', { name: 'Editor' }).click();
    await page.getByRole('button', { name: 'Sync source to PDF' }).click();
    const pdfPage = page.locator('canvas[aria-label="PDF page 1"]');
    await expect(pdfPage).not.toHaveClass(/is-loading/);
    await pdfPage.click();
    if (test.info().project.name.startsWith('phone')) {
      await expect.poll(() => syncModesByPage.get(page)).toContain('inverse');
      await page.getByRole('radio', { name: 'Editor' }).click();
    }
    await expect(page.locator('.status-bar')).toContainText('Ln 3');
    if (!process.env.E2E_BASE_URL) expect(syncModesByPage.get(page)).toEqual(['forward', 'inverse']);
  });
}

test('template project supports ZIP import/export and PDF download', async ({ page }) => {
  await openTemplate(page, 'Article');
  const archive = zipOneFile('main.tex', '\\documentclass{article}\n\\begin{document}\n\\section{Imported}\nA complete project imported from ZIP.\n\\end{document}\n');
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'browser-check.zip', mimeType: 'application/zip', buffer: archive });
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('paperdesk-projects') ?? '[]')[0]?.files?.some((f: { name: string }) => f.name === 'main.tex' && f.content.includes('complete project imported from ZIP')))).toBe(true);

  await compileAndViewPdf(page);
  const pdfDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  expect((await pdfDownload).suggestedFilename()).toMatch(/\.pdf$/);

  if (test.info().project.name.startsWith('phone')) await page.getByRole('button', { name: 'Menu' }).click();
  else await page.locator('.editor-menus .text-menu').filter({ hasText: 'File' }).click();
  const zipDownloadEvent = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download project' }).click();
  const zipDownload = await zipDownloadEvent;
  expect(zipDownload.suggestedFilename()).toMatch(/\.zip$/);
});

test('theme can be switched and the phone layout keeps editor and PDF controls usable', async ({ page }) => {
  await openTemplate(page, 'Article');
  const initialTheme = await page.locator('html').getAttribute('data-theme');
  const otherTheme = initialTheme === 'dark' ? 'Light' : 'Dark';
  if (test.info().project.name.startsWith('phone')) {
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitemcheckbox', { name: `${otherTheme} theme` }).click();
  } else {
    await page.getByRole('button', { name: 'Change theme' }).click();
    await page.getByRole('menuitemradio', { name: new RegExp(`^${otherTheme}`) }).click();
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', otherTheme.toLowerCase());

  if (test.info().project.name.startsWith('phone')) {
    await expect(page.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Editor' })).toBeVisible();
    await page.getByRole('radio', { name: 'PDF' }).click();
    await expect(page.getByRole('region', { name: 'PDF preview' })).toBeVisible();
    await page.getByRole('radio', { name: 'Editor' }).click();
    await expect(page.locator('.monaco-editor')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test('LaTeX completion suggests commands and find and replace updates the source', async ({ page }) => {
  await openTemplate(page, 'Article');
  const finalLine = page.locator('.view-line').filter({ hasText: /\\end\{document\}/ }).last();
  await finalLine.click();
  await page.keyboard.press('End');
  await page.keyboard.type('\n\\sect');
  await page.keyboard.press('Control+Space');
  const suggestions = page.getByRole('listbox', { name: 'Suggest' });
  await expect(suggestions.getByRole('option', { name: /section/ }).first()).toBeVisible();
  await suggestions.getByRole('option', { name: /section/ }).first().click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('paperdesk-projects') ?? '[]')[0]?.files?.[0]?.content)).toContain('\\section{}');

  await openMenuItem(page, 'Edit', 'Find and replace');
  const widget = page.locator('.find-widget');
  await expect(widget).toBeVisible();
  await widget.getByRole('textbox').nth(0).fill('Article Template');
  await widget.getByRole('textbox').nth(1).fill('Browser Test Template');
  await widget.getByRole('button', { name: /Replace All/ }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('paperdesk-projects') ?? '[]')[0]?.files?.[0]?.content)).toContain('Browser Test Template');
});

async function openMenuItem(page: Page, menu: string, item: string) {
  if (test.info().project.name.startsWith('phone')) await page.getByRole('button', { name: 'Menu' }).click();
  else await page.locator('.editor-menus .text-menu').filter({ hasText: menu }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** A minimal stored ZIP archive, so import tests don't depend on a host `zip` executable. */
function zipOneFile(name: string, body: string): Buffer {
  const filename = Buffer.from(name);
  const contents = Buffer.from(body);
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30 + filename.length + contents.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(contents.length, 18); local.writeUInt32LE(contents.length, 22); local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30); contents.copy(local, 30 + filename.length);
  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(contents.length, 20); central.writeUInt32LE(contents.length, 24); central.writeUInt16LE(filename.length, 28);
  filename.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function onePagePdf(): Buffer {
  const content = 'BT /F1 16 Tf 72 720 Td (PaperDesk browser PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}
