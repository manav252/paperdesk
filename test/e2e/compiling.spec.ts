import { expect, test, type Page } from '@playwright/test';
import { isolateProjects } from './isolate-projects';

// Compiling behaves the same for LaTeX and Typst: only Recompile starts a compile. The first test fakes the compile
// service so it can hold a compile open and count requests; the last one compiles for real.
const PDF = (label: string) =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
      `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj\n` +
      `4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 100 Td (${label.padEnd(8).slice(0, 8)}) Tj ET\nendstream endobj\n` +
      `trailer<</Root 1 0 R>>\n%%EOF`,
  );
const projects = {
  latex: {
    name: 'Auto LaTeX',
    main: 'main.tex',
    content: '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
  },
  typst: { name: 'Auto Typst', main: 'main.typ', content: '= Hello\n\nSome text.\n' },
};

async function open(page: Page, language: 'latex' | 'typst') {
  // Both projects are seeded, so one page can open either.
  await page.addInitScript(
    (seed) => {
      localStorage.setItem('paperdesk-tour-done', '1');
      localStorage.setItem('paperdesk-help-seen', '1');
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('paperdesk-projects', JSON.stringify(seed));
    },
    (['latex', 'typst'] as const).map((l) => ({
      id: `auto-${l}`,
      name: projects[l].name,
      modified: Date.now(),
      language: l,
      mainFile: projects[l].main,
      files: [{ name: projects[l].main, content: projects[l].content }],
    })),
  );
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.goto(`/#/paper/auto-${language}/`);
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
}
/** Types at the end of the document's text: after "Hello" in LaTeX (text after \end{document} is ignored). */
const type = async (page: Page, text: string) => {
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+G');
  await page.keyboard.type('3');
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.type(text);
};
/** Counts compile requests the page has open at once; a request it cancelled stops counting at that moment. */
const countOpenCompiles = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { openCompiles: number; mostOpenCompiles: number };
    w.openCompiles = 0;
    w.mostOpenCompiles = 0;
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (!String(input instanceof Request ? input.url : input).endsWith('/compile')) return original(input, init);
      w.mostOpenCompiles = Math.max(w.mostOpenCompiles, ++w.openCompiles);
      let open = true;
      const close = () => {
        if (open) w.openCompiles--;
        open = false;
      };
      init?.signal?.addEventListener('abort', close);
      return original(input, init).finally(close);
    };
  });

for (const language of ['latex', 'typst'] as const) {
  test(`${language}: typing never compiles, Recompile runs one compile at a time, errors keep the last good PDF`, async ({
    page,
    request,
  }, info) => {
    test.skip(info.project.name !== 'desktop-light', 'Runs once per language.');
    test.setTimeout(90_000);
    await isolateProjects(page, request);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const sent: { language?: string }[] = [];
    let hold = 0,
      fail = false;
    await countOpenCompiles(page);
    await page.route('**/api/projects/*/compile', async (route) => {
      sent.push(route.request().postDataJSON());
      const n = sent.length;
      if (hold) await new Promise((done) => setTimeout(done, hold));
      await route
        .fulfill({
          json: fail
            ? {
                success: false,
                log: 'error',
                errors: [{ file: projects[language].main, line: 2, message: 'broken on purpose' }],
                warnings: [],
                durationMs: 20,
              }
            : {
                success: true,
                log: '',
                errors: [],
                warnings: [],
                durationMs: 20,
                session: 's',
                pdf: PDF(`v${n}`).toString('base64'),
              },
        })
        .catch(() => undefined);
    });
    await open(page, language);
    const status = page.getByRole('region', { name: 'PDF preview' }).getByRole('status');
    const recompile = page.getByRole('button', { name: /^Recompile/ });

    // Typing does not compile, however long you wait.
    await type(page, ' one');
    await page.waitForTimeout(3500);
    expect(sent).toHaveLength(0);
    await page.getByRole('button', { name: 'Compiler options' }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: /Auto compile/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Recompile compiles once, with this project's language.
    await recompile.click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ language });
    await expect(status).toContainText('Compiled in');
    const canvas = page.locator('canvas[aria-label="PDF page 1"]');
    await expect(canvas).toBeVisible();

    // A second Recompile while one is running replaces it; the two never run side by side.
    hold = 2000;
    await type(page, ' two');
    await recompile.click();
    await expect.poll(() => sent.length).toBe(2);
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect.poll(() => sent.length).toBe(3);
    hold = 0;
    await expect(status).toContainText('Compiled in', { timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { mostOpenCompiles: number }).mostOpenCompiles)).toBe(1);

    // Typing while a compile runs still shows its PDF when it arrives, marked as out of date.
    hold = 1500;
    await recompile.click();
    await expect.poll(() => sent.length).toBe(4);
    await type(page, ' during');
    hold = 0;
    await expect(status).toContainText('PDF is out of date', { timeout: 10_000 });
    await expect(canvas).toBeVisible();

    // An error shows in the preview with a jump to its line, and the last good PDF stays visible.
    fail = true;
    await recompile.click();
    await expect(page.getByRole('button', { name: 'Go to error' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('region', { name: 'PDF preview' })).toContainText('broken on purpose');
    await expect(canvas).toBeVisible();
    await page.getByRole('button', { name: 'Go to error' }).click();
    await expect(page.locator('.status-bar')).toContainText('Ln 2, Col 1');
    expect(errors).toEqual([]);
  });
}

test('both languages: Recompile refreshes the PDF with the real compilers, and LaTeX-only options are hidden for Typst', async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== 'desktop-light' || !!process.env.E2E_BASE_URL, 'Runs once, against the local API.');
  test.setTimeout(180_000);
  await isolateProjects(page, request);
  for (const language of ['latex', 'typst'] as const) {
    await open(page, language);
    const status = page.getByRole('region', { name: 'PDF preview' }).getByRole('status');
    const compiled = () =>
      page.waitForResponse((r) => /\/compile$/.test(r.url()) && r.status() === 200, { timeout: 90_000 });
    let done = compiled();
    await type(page, ' first');
    await page.getByRole('button', { name: /^Recompile/ }).click();
    await done;
    await expect(status).toContainText('Compiled in', { timeout: 60_000 });
    const canvas = page.locator('canvas[aria-label="PDF page 1"]');
    const picture = () => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
    const first = await picture();
    done = compiled();
    await type(page, ' second');
    await page.getByRole('button', { name: /^Recompile/ }).click();
    await done;
    await expect.poll(picture, { timeout: 30_000 }).not.toBe(first);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByText('Draft mode')).toHaveCount(language === 'typst' ? 0 : 1);
    await expect(dialog.getByText('Stop on first error')).toHaveCount(language === 'typst' ? 0 : 1);
    await page.keyboard.press('Escape');
  }
});
