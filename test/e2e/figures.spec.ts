import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Paste or drag images into the editor: files land in figures/, a figure block is inserted at the cursor,
// oversized or unsupported input is handled, and undo removes the image again.
const tex = '\\documentclass{article}\n\\begin{document}\nIntro text.\n\nAfter.\n\\end{document}\n';
const errorsByPage = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, 'Runs against the local build.');
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('**/api/projects', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue());
  await page.addInitScript(main => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('paperdesk-projects', JSON.stringify([{ id: `fig-${Date.now().toString(36)}`, name: 'Figures', modified: Date.now(), mainFile: 'main.tex', files: [{ name: 'main.tex', content: main }] }]));
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-help-seen', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
  }, tex);
  await page.goto('/');
  await page.getByRole('button', { name: /Figures/ }).first().click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
});
test.afterEach(async ({ page }) => { expect(errorsByPage.get(page) ?? []).toEqual([]); });

type Stored = { name: string; content: string; encoding?: string };
const files = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('paperdesk-projects')!)[0].files as Stored[]);
const mainTex = async (page: Page) => (await files(page)).find(f => f.name === 'main.tex')!.content;
const figureNames = async (page: Page) => (await files(page)).map(f => f.name).filter(n => n.startsWith('figures/') && n !== 'figures/');

/** Makes an image in the page and delivers it as a paste or a drop, the way the browser would. */
async function deliver(page: Page, how: 'paste' | 'drop' | 'tree', image: { name: string; type: string; width: number; height: number } | { name: string; type: string; bytes: number } | { name: string; type: string; base64: string }) {
  await page.evaluate(async ([kind, spec]) => {
    let blob: Blob;
    if ('base64' in spec) blob = new Blob([Uint8Array.from(atob(spec.base64), c => c.charCodeAt(0))], { type: spec.type });
    else if ('bytes' in spec) blob = new Blob([new Uint8Array(spec.bytes)], { type: spec.type });
    else {
      const canvas = document.createElement('canvas');
      canvas.width = spec.width; canvas.height = spec.height;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#2d9d6f'; context.fillRect(0, 0, spec.width, spec.height);
      blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), spec.type));
    }
    const data = new DataTransfer();
    data.items.add(new File([blob], spec.name, { type: spec.type }));
    if (kind === 'paste') document.querySelector('.monaco-editor textarea, .monaco-editor .native-edit-context')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    else {
      const target = document.querySelector(kind === 'drop' ? '.editor-canvas .view-lines' : '.file-tree')!;
      const box = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, clientX: box.left + 80, clientY: box.top + 54 }));
    }
  }, [how, image] as const);
}
const undo = async (page: Page) => {
  if ((page.viewportSize()?.width ?? 1440) <= 860) { await page.getByRole('button', { name: 'Menu' }).click(); await page.getByRole('menuitem', { name: 'Undo' }).click(); }
  else await page.getByRole('button', { name: 'Undo' }).click();
};

test('a pasted image becomes a figure at the cursor, graphicx is offered, and undo removes the image', async ({ page }) => {
  await page.locator('.view-line').filter({ hasText: 'Intro text.' }).click();
  await page.keyboard.press('End');
  await deliver(page, 'paste', { name: 'image.png', type: 'image/png', width: 120, height: 80 });
  await page.getByRole('dialog', { name: 'Add the graphicx package?' }).getByRole('button', { name: 'Add it' }).click();
  await expect.poll(() => figureNames(page)).toHaveLength(1);
  const [name] = await figureNames(page);
  expect(name).toMatch(/^figures\/pasted-\d{8}-\d{6}\.png$/);
  // The cursor is inside the caption.
  await expect.poll(() => mainTex(page)).toContain('\\caption{}');
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.editor-canvas'))).toBe(true);
  await page.keyboard.type('My caption');
  await expect.poll(() => mainTex(page)).toContain(`Intro text.\n\\begin{figure}[ht]\n  \\centering\n  \\includegraphics[width=\\linewidth]{${name}}\n  \\caption{My caption}\n  \\label{fig:${name!.slice(8, -4)}}\n\\end{figure}\n`);
  expect(await mainTex(page)).toContain('\\documentclass{article}\n\\usepackage{graphicx}\n');
  expect((await files(page)).find(f => f.name === name)!.encoding).toBe('base64');

  // Undo until the figure block is gone: the uploaded file goes with it.
  for (let i = 0; i < 12 && (await figureNames(page)).length; i++) { await undo(page); await page.waitForTimeout(150); }
  expect(await figureNames(page)).toEqual([]);
  expect(await mainTex(page)).not.toContain('\\includegraphics');
});

test('dropped images are converted, scaled down and size-limited; a tree drop only uploads', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('phone'), 'Dragging files needs a desktop pointer.');
  // WebP wider than 3000 px: becomes a PNG at 3000 px.
  await deliver(page, 'drop', { name: 'Wide Chart.webp', type: 'image/webp', width: 3600, height: 300 });
  await page.getByRole('dialog', { name: 'Add the graphicx package?' }).getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => figureNames(page)).toEqual(['figures/wide-chart.png']);
  const size = await page.evaluate(async () => {
    const stored = (JSON.parse(localStorage.getItem('paperdesk-projects')!)[0].files as { name: string; content: string }[]).find(f => f.name === 'figures/wide-chart.png')!;
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${stored.content}`)).blob());
    return [bitmap.width, bitmap.height];
  });
  expect(size).toEqual([3000, 250]);
  await expect(page.locator('.toast')).toContainText('scaled down to 3000×250 px');
  expect(await mainTex(page)).toContain('\\includegraphics[width=\\linewidth]{figures/wide-chart.png}');

  // Over 10 MB: refused with the reason, nothing added.
  await deliver(page, 'drop', { name: 'huge.png', type: 'image/png', bytes: 10 * 1024 * 1024 + 1024 });
  await expect(page.locator('.toast')).toContainText('Images can be at most 10.0 MB');
  expect(await figureNames(page)).toEqual(['figures/wide-chart.png']);

  // The same name again gets a unique name; dropping on the file tree uploads without inserting a figure.
  const before = await mainTex(page);
  await deliver(page, 'tree', { name: 'wide chart.jpg', type: 'image/jpeg', width: 60, height: 40 });
  await expect.poll(() => figureNames(page)).toEqual(['figures/wide-chart.png', 'figures/wide-chart.jpg']);
  await deliver(page, 'tree', { name: 'wide-chart.jpg', type: 'image/jpeg', width: 60, height: 40 });
  await expect.poll(() => figureNames(page)).toContain('figures/wide-chart-2.jpg');
  expect(await mainTex(page)).toBe(before);
});

test('a HEIC photo is converted to PNG; a broken one is refused with the reason', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('phone'), 'Dragging files needs a desktop pointer.');
  // A real 64×40 HEIC file, one flat colour. Phones often give HEIC files no MIME type, so none is sent here.
  const heic = readFileSync('test/fixtures/images/sample.heic').toString('base64');
  await deliver(page, 'drop', { name: 'IMG_0042.HEIC', type: '', base64: heic });
  await page.getByRole('dialog', { name: 'Add the graphicx package?' }).getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => figureNames(page), { timeout: 30_000 }).toEqual(['figures/img_0042.png']);
  const decoded = await page.evaluate(async () => {
    const stored = (JSON.parse(localStorage.getItem('paperdesk-projects')!)[0].files as { name: string; content: string }[]).find(f => f.name === 'figures/img_0042.png')!;
    const blob = await (await fetch(`data:image/png;base64,${stored.content}`)).blob();
    const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    return { type: blob.type, size: [bitmap.width, bitmap.height], pixel: Array.from(context.getImageData(32, 20, 1, 1).data), png: stored.content.startsWith('iVBORw0KGgo') };
  });
  expect(decoded.png).toBe(true);
  expect(decoded.size).toEqual([64, 40]);
  // The source colour is rgb(45, 157, 111); HEIC is lossy, so allow a little drift.
  for (const [i, want] of [45, 157, 111].entries()) expect(Math.abs(decoded.pixel[i]! - want)).toBeLessThanOrEqual(12);
  expect(decoded.pixel[3]).toBe(255);
  await expect(page.locator('.toast')).toContainText('Converted to PNG');
  expect(await mainTex(page)).toContain('\\includegraphics[width=\\linewidth]{figures/img_0042.png}');

  // Not really a HEIC file: nothing is added and the message says what to do.
  await deliver(page, 'drop', { name: 'broken.heic', type: 'image/heic', base64: btoa('this is not a photo') });
  await expect(page.locator('.toast')).toContainText('couldn’t be read as a HEIC photo');
  expect(await figureNames(page)).toEqual(['figures/img_0042.png']);
});
