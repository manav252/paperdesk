import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';
import { importJWK, SignJWT } from 'jose';

// Real-time co-editing between signed-in people. Needs Postgres and object storage like sharing.spec.ts:
// run with E2E_CLOUD_STORAGE=1 and DATABASE_URL/R2_* pointing at local test services.
const SUPABASE = 'http://127.0.0.1:54399', API = 'http://127.0.0.1:3002';
const people = {
  owner: { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com' },
  editor: { id: '22222222-2222-4222-8222-222222222222', email: 'editor@example.com' },
  viewer: { id: '33333333-3333-4333-8333-333333333333', email: 'viewer@example.com' },
};
type Person = keyof typeof people;
const source = '\\documentclass{article}\n\\begin{document}\nHello\n\nSecond line\n\\end{document}\n';

async function tokenFor(person: Person) {
  const key = await importJWK(JSON.parse(readFileSync('test/fixtures/auth/test-signing-key.json', 'utf8')), 'ES256');
  return new SignJWT({ role: 'authenticated', email: people[person].email }).setProtectedHeader({ alg: 'ES256', kid: 'paperdesk-test' }).setSubject(people[person].id)
    .setIssuer(`${SUPABASE}/auth/v1`).setAudience('authenticated').setIssuedAt().setExpirationTime('1h').sign(key);
}
const api = (request: APIRequestContext, token: string) => {
  const headers = { Authorization: `Bearer ${token}` };
  return {
    get: (path: string) => request.get(`${API}/api/projects${path}`, { headers }),
    put: (path: string, data: object) => request.put(`${API}/api/projects${path}`, { headers, data }),
    post: (path: string, data: object = {}) => request.post(`${API}/api/projects${path}`, { headers, data }),
    del: (path: string) => request.delete(`${API}/api/projects${path}`, { headers }),
    accept: (invite: string) => request.post(`${API}/api/invites/${invite}/accept`, { headers }),
  };
};
async function open(browser: Browser, person: Person, projectId: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const access_token = await tokenFor(person), page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.addInitScript(([session]) => {
    localStorage.setItem('paperdesk-auth', session as string);
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-help-seen', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
    localStorage.setItem('paperdesk-layout', JSON.stringify({ spellcheck: false }));
  }, [JSON.stringify({ access_token, refresh_token: 'test', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: people[person].id, aud: 'authenticated', role: 'authenticated', email: people[person].email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } })]);
  await page.goto(`/#/paper/${projectId}/`);
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect(page.getByTestId('live-badge')).toBeVisible();
  return { page, errors, context };
}
const line = (page: import('@playwright/test').Page, text: string | RegExp) => page.locator('.view-line').filter({ hasText: text });

test('two people edit the same file live; a viewer watches; everything is saved', async ({ browser, request }, info) => {
  test.skip(!process.env.E2E_CLOUD_STORAGE || info.project.name !== 'desktop-light', 'Needs local Postgres and object storage.');
  test.setTimeout(120_000);
  const owner = api(request, await tokenFor('owner')), id = `collab-${Date.now().toString(36)}`;
  await owner.put(`/${id}`, { name: 'Live project', mainFile: 'main.tex', files: [{ name: 'main.tex', content: source }] });
  const editLink = (await (await owner.post(`/${id}/invites`, { role: 'editor' })).json()).token;
  const viewLink = (await (await owner.post(`/${id}/invites`, { role: 'viewer' })).json()).token;
  const alias = (await (await api(request, await tokenFor('editor')).accept(editLink)).json()).id as string;
  await api(request, await tokenFor('viewer')).accept(viewLink);

  const a = await open(browser, 'owner', id), b = await open(browser, 'editor', alias), v = await open(browser, 'viewer', alias);
  await expect(a.page.getByTestId('live-badge')).toContainText('3');

  // Each person types on a different line; everyone sees both edits.
  await line(a.page, 'Hello').click();
  await a.page.keyboard.press('End');
  await a.page.keyboard.type(' from the owner');
  await expect(line(b.page, 'Hello from the owner')).toBeVisible();
  await line(b.page, 'Second line').click();
  await b.page.keyboard.press('End');
  await b.page.keyboard.type(' by the editor');
  for (const page of [a.page, v.page]) {
    await expect(line(page, 'Second line by the editor')).toBeVisible();
    await expect(line(page, 'Hello from the owner')).toBeVisible();
  }
  // The other person's cursor is shown with their name.
  await expect(a.page.locator('.yRemoteSelectionHead').first()).toBeAttached();

  // Typing at the same time in the same line keeps both people's text.
  await line(a.page, 'Hello from the owner').click();
  await a.page.keyboard.press('Home');
  await line(b.page, 'Hello from the owner').click();
  await b.page.keyboard.press('End');
  await Promise.all([a.page.keyboard.type('AAA ', { delay: 30 }), b.page.keyboard.type(' BBB', { delay: 30 })]);
  for (const page of [a.page, b.page, v.page]) await expect(line(page, 'AAA Hello from the owner BBB')).toBeVisible();

  // A viewer can't change the document, in the editor or behind it.
  await line(v.page, 'Second line').click();
  await v.page.keyboard.type('tampered');
  await a.page.waitForTimeout(500);
  await expect(line(a.page, 'tampered')).toHaveCount(0);

  // A file added through the API appears for everyone, with live text.
  await owner.put(`/${id}`, { patch: { files: [{ name: 'extra.tex', content: 'Extra file', base: null }], deleted: [] } });
  await expect(b.page.getByText('extra.tex').first()).toBeVisible();

  // The server saves the live text a few seconds after typing stops, with history by author.
  await expect.poll(async () => (await (await owner.get(`/${id}`)).json()).files.find((f: { name: string }) => f.name === 'main.tex').content, { timeout: 30_000 })
    .toBe(source.replace('Hello', 'AAA Hello from the owner BBB').replace('Second line', 'Second line by the editor'));
  const authors = (await (await owner.get(`/${id}/history`)).json()).versions.map((x: { author: string }) => x.author);
  expect(authors.some((x: string) => x.includes('editor@example.com'))).toBe(true);

  expect([...a.errors, ...b.errors, ...v.errors]).toEqual([]);
  await Promise.all([a.context.close(), b.context.close(), v.context.close()]);
  await owner.del(`/${id}`);
});

/** Pastes a small generated PNG into the focused editor, the way the browser would. */
const pasteImage = (page: import('@playwright/test').Page, colour: string) => page.evaluate(async fill => {
  const canvas = document.createElement('canvas');
  canvas.width = 90; canvas.height = 60;
  const context = canvas.getContext('2d')!;
  context.fillStyle = fill; context.fillRect(0, 0, 90, 60);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/png'));
  const data = new DataTransfer();
  data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
  document.querySelector('.monaco-editor textarea, .monaco-editor .native-edit-context')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, colour);

test('an image pasted by one person appears for the other, as text and as a file', async ({ browser, request }, info) => {
  test.skip(!process.env.E2E_CLOUD_STORAGE || info.project.name !== 'desktop-light', 'Needs local Postgres and object storage.');
  test.setTimeout(120_000);
  const owner = api(request, await tokenFor('owner')), id = `figs-${Date.now().toString(36)}`;
  const withGraphics = source.replace('\\begin{document}', '\\usepackage{graphicx}\n\\begin{document}');
  await owner.put(`/${id}`, { name: 'Live figures', mainFile: 'main.tex', files: [{ name: 'main.tex', content: withGraphics }] });
  const alias = (await (await api(request, await tokenFor('editor')).accept((await (await owner.post(`/${id}/invites`, { role: 'editor' })).json()).token)).json()).id as string;
  const a = await open(browser, 'owner', id), b = await open(browser, 'editor', alias);
  await expect(a.page.getByTestId('live-badge')).toContainText('2');
  type Stored = { name: string; content: string; encoding?: string };
  const stored = async () => (await (await owner.get(`/${id}`)).json()).files as Stored[];
  const figures = async () => (await stored()).filter(f => /^figures\/.+\.png$/.test(f.name));

  const treeImages = async (page: import('@playwright/test').Page) => ((await page.locator('.file-tree').innerText()).match(/pasted-\d{8}-\d{6}(-\d)?\.png/g) ?? []).length;
  // The owner pastes an image after "Hello": the editor sees the block, the caption being typed, and the file.
  await line(a.page, 'Hello').click();
  await a.page.keyboard.press('End');
  await pasteImage(a.page, '#2d9d6f');
  await expect(line(a.page, '\\caption{}')).toBeVisible();
  await a.page.keyboard.type('From the owner');
  await expect(line(b.page, '\\caption{From the owner}')).toBeVisible();
  await expect(line(b.page, '\\includegraphics[width=\\linewidth]{figures/')).toBeVisible();
  await expect.poll(() => treeImages(b.page), { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await figures()).length, { timeout: 30_000 }).toBe(1);

  // The editor pastes a second one under "Second line": the owner gets it too, and neither image is lost.
  await line(b.page, 'Second line').click();
  await b.page.keyboard.press('End');
  await pasteImage(b.page, '#b0413e');
  await expect(line(b.page, '\\caption{}')).toBeVisible();
  await b.page.keyboard.type('From the editor');
  await expect(line(a.page, '\\caption{From the editor}')).toBeVisible();
  await expect.poll(() => treeImages(a.page)).toBe(2);
  await expect.poll(() => treeImages(b.page)).toBe(2);
  await expect.poll(async () => (await figures()).length, { timeout: 30_000 }).toBe(2);
  // The server saves the live text a few seconds after typing stops.
  const savedMain = async () => (await stored()).find(f => f.name === 'main.tex')!.content;
  await expect.poll(savedMain, { timeout: 30_000 }).toContain('\\caption{From the editor}');
  const main = await savedMain();
  for (const figure of await figures()) {
    expect(figure.encoding).toBe('base64');
    expect(figure.content.length).toBeGreaterThan(100);
    expect(main).toContain(`{${figure.name}}`);
  }
  expect(main.match(/\\begin\{figure\}/g)).toHaveLength(2);
  // Both people still show the same text.
  const text = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { monaco?: { editor: { getModels(): { getValue(): string }[] } } }).monaco?.editor.getModels()[0]?.getValue() ?? null);
  expect(await text(a.page)).toBe(await text(b.page));

  expect([...a.errors, ...b.errors]).toEqual([]);
  await Promise.all([a.context.close(), b.context.close()]);
  await owner.del(`/${id}`);
});
