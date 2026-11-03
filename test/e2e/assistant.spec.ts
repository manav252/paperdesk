import { expect, test, type Page } from '@playwright/test';

// The broken line is 3: the closing brace of \textbf is missing.
const source = '\\documentclass{article}\n\\begin{document}\n\\textbf{Hello\n\\end{document}\n';
const project = () => ({ id: 'p1', name: 'E2E Assistant', modified: Date.now(), mainFile: 'main.tex', files: [{ name: 'main.tex', content: source }] });

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  // Tests must not depend on the network: answer Google Fonts requests locally (the system font fallback is used).
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
});
test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

async function open(page: Page, { tourDone = true } = {}) {
  await page.addInitScript(([value, done]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('paperdesk-projects', JSON.stringify([value]));
    if (done) localStorage.setItem('paperdesk-tour-done', '1');
  }, [project(), tourDone] as const);
  await page.goto('/');
  await expect(page.locator('.monaco-editor')).toBeVisible();
}

/** Fakes a configured assistant, a failed compile and a streamed answer, so no Docker or API key is needed. */
async function fakeBackend(page: Page, answer: string) {
  const requests: any[] = [];
  await page.route('**/api/health', route => route.fulfill({ json: { ok: true, docker: true, image: true, compilerImage: 'test', assistant: { configured: true, model: 'test-model' } } }));
  await page.route('**/api/projects/*/compile', route => route.fulfill({ json: {
    success: false, durationMs: 400, log: './main.tex:3: Runaway argument?', warnings: [],
    errors: [{ file: 'main.tex', line: 3, message: 'Runaway argument? — \\textbf{Hello' }],
  } }));
  await page.route('**/api/assistant', async route => {
    requests.push(route.request().postDataJSON());
    const half = Math.floor(answer.length / 2);
    const body = [{ type: 'text', text: answer.slice(0, half) }, { type: 'text', text: answer.slice(half) }, { type: 'done', stopReason: 'end_turn' }].map(e => JSON.stringify(e)).join('\n') + '\n';
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body });
  });
  return requests;
}

const editorText = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('paperdesk-projects')!)[0].files[0].content as string);

test('first-run tour can be skipped and reopened from Help', async ({ page }) => {
  await open(page, { tourDone: false });
  const tour = page.getByRole('dialog', { name: 'Getting started tour' });
  await expect(tour).toBeVisible();
  await expect(tour.getByText('Your project files')).toBeVisible();
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour.getByText('Write LaTeX here')).toBeVisible();
  await tour.getByRole('button', { name: 'Skip tour', exact: true }).click();
  await expect(tour).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect(tour).toHaveCount(0);

  await page.locator('.editor-menus .text-menu').filter({ hasText: 'Help' }).click();
  await page.getByRole('menuitem', { name: 'Take the tour' }).click();
  for (const title of ['Your project files', 'Write LaTeX here', 'Recompile to see your PDF', 'Your PDF', 'Logs explain problems']) {
    await expect(tour.getByText(title)).toBeVisible();
    await tour.getByRole('button', { name: 'Next' }).click();
  }
  await expect(tour.getByText('Ask the assistant')).toBeVisible();
  await tour.getByRole('button', { name: 'Finish' }).click();
  await expect(tour).toHaveCount(0);
});

test('panel says when the assistant is not configured', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Help and assistant' }).click();
  await page.getByRole('menuitem', { name: 'Ask the assistant' }).click();
  const panel = page.getByRole('complementary', { name: 'Assistant' });
  await expect(panel.getByText('Assistant not configured')).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Ask the assistant' })).toBeDisabled();
});

test('explain an error, review the diff, and apply the fix only on click', async ({ page }) => {
  const answer = 'The `\\textbf` command on line 3 never closes its brace.\n\n```latex replace-lines 3-3\n\\textbf{Hello}\n```';
  const requests = await fakeBackend(page, answer);
  await open(page);
  await page.getByRole('button', { name: /Recompile/ }).first().click();
  await page.getByRole('button', { name: 'View log' }).click();
  await page.getByRole('dialog', { name: 'Compile log' }).getByRole('button', { name: 'Explain this error' }).click();

  const panel = page.getByRole('complementary', { name: 'Assistant' });
  await expect(panel.getByText('never closes its brace')).toBeVisible();
  expect(requests[0].mode).toBe('explain');
  expect(requests[0].context.error).toMatchObject({ file: 'main.tex', line: 3 });
  expect(requests[0].context.content).toContain('3| \\textbf{Hello');
  // Nothing has changed yet.
  expect(await editorText(page)).toBe(source);

  await panel.getByRole('button', { name: 'Apply fix…' }).click();
  const review = page.getByRole('dialog', { name: 'Review suggested fix' });
  await expect(review.locator('.diff-removed')).toContainText('\\textbf{Hello');
  await expect(review.locator('.diff-added')).toContainText('\\textbf{Hello}');
  await review.getByRole('button', { name: 'Cancel' }).click();
  expect(await editorText(page)).toBe(source);

  await panel.getByRole('button', { name: 'Apply fix…' }).click();
  await review.getByRole('button', { name: 'Apply fix' }).click();
  await expect(panel.getByText('Fix applied')).toBeVisible();
  await expect.poll(() => editorText(page)).toBe(source.replace('\\textbf{Hello', '\\textbf{Hello}'));
});

test('quick prompts send visible context and code blocks insert at the cursor', async ({ page }) => {
  const requests = await fakeBackend(page, 'Here is a table:\n```latex\n\\begin{tabular}{cc}\nA & B\n\\end{tabular}\n```');
  await open(page);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Assistant' });
  await expect(panel.getByText(/Sends: main\.tex · Ln 1, Col 1/)).toBeVisible();
  await panel.getByRole('button', { name: 'Insert table' }).click();
  await expect(panel.getByText('Here is a table:')).toBeVisible();
  expect(requests[0].context).toMatchObject({ file: 'main.tex', cursor: { line: 1, col: 1 } });

  // With sharing off, only the question is sent.
  await panel.getByText('Share editor context').click();
  await expect(panel.getByText('Only your question is sent.')).toBeVisible();
  await panel.getByRole('textbox', { name: 'Ask the assistant' }).fill('What is a preamble?');
  await panel.getByRole('textbox', { name: 'Ask the assistant' }).press('Enter');
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].context).toBeUndefined();
  expect(requests[1].messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);

  expect(await editorText(page)).toBe(source);
  await panel.getByRole('button', { name: 'Insert at cursor' }).first().click();
  await expect.poll(() => editorText(page)).toContain('\\begin{tabular}{cc}');
});
