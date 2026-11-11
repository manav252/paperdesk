import { expect, test, type Page } from '@playwright/test';

// Add citation by DOI / arXiv ID. The local API talks to test/fakes/services.mjs instead of Crossref and arXiv.
const tex = '\\documentclass{article}\n\\begin{document}\nSee \n\\bibliography{refs}\n\\end{document}\n';
const bib = '@article{knuth1984literate,\n  author = {Knuth, Donald E.},\n  title = {Literate programming},\n  year = {1984}\n}\n';
const errorsByPage = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, 'Uses the local API with stand-in Crossref and arXiv services.');
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('**/api/projects', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue());
  await page.addInitScript(([main, refs]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('paperdesk-projects', JSON.stringify([{ id: `cite-${Date.now().toString(36)}`, name: 'Citations', modified: Date.now(), mainFile: 'main.tex', files: [{ name: 'main.tex', content: main }, { name: 'refs.bib', content: refs }] }]));
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-help-seen', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
  }, [tex, bib] as const);
  await page.goto('/');
  await page.getByRole('button', { name: /Citations/ }).first().click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
});
test.afterEach(async ({ page }) => { expect(errorsByPage.get(page) ?? []).toEqual([]); });

const files = (page: Page) => page.evaluate(() => Object.fromEntries((JSON.parse(localStorage.getItem('paperdesk-projects')!)[0].files as { name: string; content: string }[]).map(f => [f.name, f.content])));
async function openDialog(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) <= 860) { await page.getByRole('button', { name: 'Menu' }).click(); await page.getByRole('menuitem', { name: /Citation from DOI/ }).click(); }
  else await page.getByRole('button', { name: 'Add citation' }).click();
  return page.getByRole('dialog', { name: 'Add citation' });
}

test('bulk lookup previews entries, warns about a duplicate, and inserts into the .bib file and at the cursor', async ({ page }) => {
  await page.locator('.view-line').filter({ hasText: 'See' }).click();
  await page.keyboard.press('End');
  const dialog = await openDialog(page);
  await dialog.getByLabel(/DOIs, doi.org links or arXiv IDs/).fill('https://doi.org/10.1038/s41586-020-2649-2\narXiv:1706.03762\n10.1000/existing\n10.1000/missing\nnot a doi');
  await dialog.getByRole('button', { name: 'Look up' }).click();
  await expect(dialog.getByLabel('BibTeX entry for https://doi.org/10.1038/s41586-020-2649-2')).toHaveValue(/@article\{harris2020array,[\s\S]*title = \{Array programming with \{NumPy\}\}/);
  await expect(dialog.getByLabel('BibTeX entry for arXiv:1706.03762')).toHaveValue(/@misc\{vaswani2017attention,[\s\S]*eprint = \{1706\.03762\}/);
  await expect(dialog).toContainText('The key knuth1984literate is already in refs.bib');
  await expect(dialog).toContainText('No record was found for DOI 10.1000/missing');
  await expect(dialog).toContainText('not a doi: This isn’t a DOI, a doi.org link or an arXiv ID.');
  // The preview can be edited before inserting.
  const preview = dialog.getByLabel('BibTeX entry for arXiv:1706.03762');
  await preview.fill((await preview.inputValue()).replace('vaswani2017attention', 'attention2017'));
  await dialog.getByRole('button', { name: 'Add 2 citations' }).click();
  await expect.poll(async () => (await files(page))['refs.bib']).toContain('@misc{attention2017,');
  const after = await files(page);
  expect(after['refs.bib']).toContain('@article{harris2020array,');
  expect(after['refs.bib']!.match(/knuth1984literate/g)).toHaveLength(1);
  expect(after['main.tex']).toContain('See \\cite{harris2020array,attention2017,knuth1984literate}');
});

test('the command palette opens the dialog; it reports an unreachable service and creates a .bib file', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('phone'), 'The command palette needs a keyboard.');
  await page.locator('.view-line').first().click();
  await page.keyboard.press('F1');
  await page.keyboard.type('Add citation by DOI');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add citation' });
  await dialog.getByRole('button', { name: 'Look up' }).click();
  await expect(dialog).toContainText('Paste a DOI, a doi.org link or an arXiv ID.');
  await page.route('**/api/citations/lookup', route => route.abort('internetdisconnected'), { times: 1 });
  await dialog.getByLabel(/DOIs, doi.org links or arXiv IDs/).fill('10.1038/s41586-020-2649-2');
  await dialog.getByRole('button', { name: 'Look up' }).click();
  await expect(dialog).toContainText('couldn’t be reached');
  errorsByPage.get(page)!.length = 0; // the aborted request logs a network error by design
  await dialog.getByRole('button', { name: 'Look up' }).click();
  await dialog.getByRole('combobox', { name: 'Bibliography file' }).selectOption('references.bib');
  await dialog.getByRole('button', { name: 'Add 1 citation' }).click();
  await expect.poll(async () => (await files(page))['references.bib']).toContain('@article{harris2020array,');
  // Crossref was called with the polite User-Agent, once (the second lookup came from the 7-day cache).
  const calls = await (await page.request.get('http://127.0.0.1:3997/requests')).json() as { path: string; agent: string }[];
  const crossref = calls.filter(c => c.path.includes('s41586-020-2649-2'));
  expect(crossref.length).toBeGreaterThan(0);
  expect(crossref[0]!.agent).toContain('mailto:tests@example.com');
});
