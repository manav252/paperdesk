import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { cleanExternalProjects } from './external-api';

// Builds the figures/tables/equations fixture through the editor UI (folders, uploads, drag and drop, SVG) and
// compiles it with the real TeX engine: locally through Docker, or against E2E_BASE_URL/E2E_API_URL when set.
const FIXTURE = path.resolve('test/fixtures/compile/rich');
const read = (name: string) => readFileSync(path.join(FIXTURE, name));
const errorsByPage = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-light', 'One real compile is enough; other profiles cover layout.');
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('paperdesk-projects', '[]');
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-help-seen', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
  });
  if (process.env.E2E_BASE_URL)
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
});

test.afterEach(async ({ page, request }) => {
  if (process.env.E2E_BASE_URL) {
    await page.waitForTimeout(800);
    await cleanExternalProjects(page, request);
  }
  expect(errorsByPage.get(page) ?? []).toEqual([]);
});

async function newFolder(page: Page, name: string) {
  await page.getByRole('button', { name: 'New folder' }).first().click();
  await page.getByLabel('Folder name').fill(name);
  await page.getByRole('button', { name: 'Create folder' }).click();
}

async function uploadInto(
  page: Page,
  folderLabel: string,
  files: { name: string; mimeType: string; buffer: Buffer }[],
) {
  const uploadButton = page.getByRole('button', { name: `Upload into ${folderLabel}`, exact: true });
  await expect(uploadButton).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await uploadButton.click();
  await (await chooser).setFiles(files);
}

test('figures, tables and equations compile to a clean PDF', async ({ page }) => {
  test.setTimeout(300_000);
  const synced = page.waitForResponse(
    (r) => /\/api\/projects$/.test(new URL(r.url()).pathname) && r.request().method() === 'GET',
  );
  await page.goto('/');
  // The app reopens a project once the project list has loaded; start from the dashboard.
  await synced;
  await page.waitForTimeout(300);
  if (await page.getByRole('button', { name: 'Back to projects' }).isVisible())
    await page.getByRole('button', { name: 'Back to projects' }).click();
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByLabel('Project name').fill('Rendering check');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.monaco-editor')).toBeVisible();

  // Replace the starter with the fixture source.
  await page.evaluate((source) => {
    const projects = JSON.parse(localStorage.getItem('paperdesk-projects')!);
    projects[0].files = projects[0].files.map((f: { name: string }) =>
      f.name === 'main.tex' ? { ...f, content: source } : f,
    );
    localStorage.setItem('paperdesk-projects', JSON.stringify(projects));
  }, read('main.tex').toString('utf8'));
  await page.reload();
  await expect(page.locator('.monaco-editor')).toContainText('Rendering Check');

  await newFolder(page, 'figures');
  await uploadInto(page, 'figures', [
    { name: 'plot.png', mimeType: 'image/png', buffer: read('figures/plot.png') },
    { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: read('figures/photo.jpg') },
    { name: 'shape.eps', mimeType: 'application/postscript', buffer: read('figures/shape.eps') },
  ]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('paperdesk-projects') ?? '[]')[0]?.files?.map(
          (file: { name: string }) => file.name,
        ),
      ),
    )
    .toEqual(expect.arrayContaining(['figures/plot.png', 'figures/photo.jpg', 'figures/shape.eps']));
  await expect(page.locator('.file-label').getByText('photo.jpg', { exact: true })).toBeVisible();

  // The PDF figure arrives by drag and drop onto the folder.
  const drop = await page.evaluateHandle(
    (bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'diagram.pdf', { type: 'application/pdf' }));
      return dt;
    },
    [...read('figures/diagram.pdf')],
  );
  const figuresRow = page
    .getByRole('treeitem', { name: /^figures\b/ })
    .first()
    .locator('.file-row')
    .first();
  await figuresRow.dispatchEvent('dragover', { dataTransfer: drop });
  await figuresRow.dispatchEvent('drop', { dataTransfer: drop });
  await expect(page.locator('.file-label').getByText('diagram.pdf', { exact: true })).toBeVisible();

  await newFolder(page, 'figures/sub');
  await uploadInto(page, 'sub', [
    { name: 'gradient.png', mimeType: 'image/png', buffer: read('figures/sub/gradient.png') },
  ]);
  await expect(page.locator('.file-label').getByText('gradient.png', { exact: true })).toBeVisible();

  // SVG can't be included by LaTeX; uploading one adds a PNG copy.
  await uploadInto(page, 'figures', [
    {
      name: 'logo.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#1f6f55"/></svg>',
      ),
    },
  ]);
  await expect(page.locator('.file-label').getByText('logo.png', { exact: true })).toBeVisible();

  const imageChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert image' }).click();
  await (
    await imageChooser
  ).setFiles({
    name: 'User attachment.png',
    mimeType: 'image/png',
    buffer: readFileSync(path.resolve('test/fixtures/compile/image-space-upload/user-attachment.png')),
  });
  await expect(page.locator('.file-label').getByText('user-attachment.png', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('paperdesk-projects') ?? '[]')[0]?.files?.find(
            (file: { name: string }) => file.name === 'main.tex',
          )?.content,
      ),
    )
    .toContain('\\includegraphics[width=\\linewidth]{figures/user-attachment.png}');

  const compiledResponse = page.waitForResponse((response) =>
    /\/api\/projects\/[^/]+\/compile$/.test(new URL(response.url()).pathname),
  );
  await page
    .getByRole('button', { name: /^Recompile/ })
    .first()
    .click();
  const compiled = await (await compiledResponse).json();
  await expect(page.getByRole('region', { name: 'PDF preview' }).getByRole('status')).toContainText('Compiled in', {
    timeout: 240_000,
  });
  await expect.poll(() => page.locator('.pdf-page').count()).toBeGreaterThanOrEqual(5);
  await expect(page.locator('.pdf-page canvas').first()).not.toHaveClass(/is-loading/);
  expect(compiled.success).toBe(true);
  expect(compiled.pdf).toBeTruthy();
  const compiledPdf = await getDocument({ data: new Uint8Array(Buffer.from(compiled.pdf, 'base64')), verbosity: 0 })
    .promise;
  try {
    const operators = await Promise.all(
      Array.from({ length: compiledPdf.numPages }, (_, i) =>
        compiledPdf.getPage(i + 1).then((page) => page.getOperatorList()),
      ),
    );
    expect(
      operators.some((list) =>
        list.fnArray.some((fn) =>
          [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(fn),
        ),
      ),
    ).toBe(true);
  } finally {
    await compiledPdf.destroy();
  }
  await page.getByRole('button', { name: 'Logs' }).click();
  const log = page.getByRole('dialog', { name: 'Compile log' });
  await expect(log).toContainText('Compiled successfully · 0 errors');
  await expect(log.locator('.compile-timings')).toContainText(/browser PDF page render \d+ ms/);
  await expect(log.locator('.log-entry.warning', { hasText: /undefined|not found|Unknown graphics/i })).toHaveCount(0);
});
