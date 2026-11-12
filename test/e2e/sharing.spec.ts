import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';
import { importJWK, SignJWT } from 'jose';

// Roles, invites and history need Postgres and object storage: run with E2E_CLOUD_STORAGE=1 and DATABASE_URL/R2_*
// pointing at local test containers. Tokens are signed with the test-only key in test/fixtures/auth.
const SUPABASE = 'http://127.0.0.1:54399', API = 'http://127.0.0.1:3002';
const people = {
  owner: { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com' },
  editor: { id: '22222222-2222-4222-8222-222222222222', email: 'editor@example.com' },
  viewer: { id: '33333333-3333-4333-8333-333333333333', email: 'viewer@example.com' },
  stranger: { id: '44444444-4444-4444-8444-444444444444', email: 'stranger@example.com' },
};
type Person = keyof typeof people;
const source = (text: string) => `\\documentclass{article}\n\\begin{document}\n${text}\n\\end{document}\n`;

async function tokenFor(person: Person) {
  const key = await importJWK(JSON.parse(readFileSync('test/fixtures/auth/test-signing-key.json', 'utf8')), 'ES256');
  return new SignJWT({ role: 'authenticated', email: people[person].email }).setProtectedHeader({ alg: 'ES256', kid: 'paperdesk-test' }).setSubject(people[person].id)
    .setIssuer(`${SUPABASE}/auth/v1`).setAudience('authenticated').setIssuedAt().setExpirationTime('1h').sign(key);
}
function client(request: APIRequestContext, token: string | null) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  return {
    get: (path: string) => request.get(`${API}/api/projects${path}`, { headers }),
    put: (path: string, data: object) => request.put(`${API}/api/projects${path}`, { headers, data }),
    post: (path: string, data: object = {}) => request.post(`${API}/api/projects${path}`, { headers, data }),
    del: (path: string) => request.delete(`${API}/api/projects${path}`, { headers }),
    accept: (invite: string) => request.post(`${API}/api/invites/${invite}/accept`, { headers }),
  };
}
const newId = () => `share-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
test.beforeEach(({ page }, info) => { void page; test.skip(!process.env.E2E_CLOUD_STORAGE || info.project.name !== 'desktop-light', 'Needs local Postgres and object storage.'); });

test('the server enforces every role, invite and link rule', async ({ request }) => {
  const [owner, editor, viewer, stranger] = await Promise.all((['owner', 'editor', 'viewer', 'stranger'] as Person[]).map(async p => client(request, await tokenFor(p))));
  const id = newId(), body = { name: 'Shared', files: [{ name: 'main.tex', content: source('First') }], mainFile: 'main.tex' };
  expect((await owner!.put(`/${id}`, body)).status()).toBe(200);
  // Only the owner can see or manage access.
  expect((await stranger!.get(`/${id}/members`)).status()).toBe(404);
  const editLink = (await (await owner!.post(`/${id}/invites`, { role: 'editor' })).json()).token;
  const viewLink = (await (await owner!.post(`/${id}/invites`, { role: 'viewer' })).json()).token;
  expect((await owner!.post(`/${id}/invites`, { role: 'owner' })).status()).toBe(400);
  const alias = (await (await editor!.accept(editLink)).json()).id as string;
  expect(alias).toMatch(/^s-/);
  expect((await (await viewer!.accept(viewLink)).json()).role).toBe('viewer');

  // Strangers and anonymous browsers get nothing.
  expect((await stranger!.get(`/${alias}`)).status()).toBe(404);
  expect((await client(request, null).get(`/${alias}`)).status()).toBe(401);

  // Viewer: can read and compile, cannot change anything, and compile ignores files it sends.
  const listed = await (await viewer!.get('')).json();
  expect(listed.find((p: { id: string }) => p.id === alias)).toMatchObject({ role: 'viewer', name: 'Shared' });
  expect((await viewer!.get(`/${alias}`)).status()).toBe(200);
  expect((await viewer!.put(`/${alias}`, { name: 'Hacked' })).status()).toBe(403);
  for (const path of ['/files', '/share']) expect((await viewer!.post(`/${alias}${path}`)).status()).toBe(403);
  expect((await viewer!.get(`/${alias}/members`)).status()).toBe(403);
  const compile = await viewer!.post(`/${alias}/compile`, { mainFile: 'main.tex', files: [{ name: 'main.tex', content: '\\broken{' }] });
  expect((await compile.json()).success).toBe(true);

  // Editor: can save, cannot delete the project or manage people; a stale save is refused.
  const saved = await (await editor!.put(`/${alias}`, { files: [{ name: 'main.tex', content: source('Second') }] })).json();
  expect(saved.id).toBe(alias);
  expect((await editor!.put(`/${alias}`, { files: [{ name: 'main.tex', content: source('Stale') }], baseModified: saved.modified - 1000 })).status()).toBe(409);
  expect((await editor!.get(`/${alias}/members`)).status()).toBe(403);
  expect((await editor!.post(`/${alias}/invites`, { role: 'editor' })).status()).toBe(403);

  // Email invites work once, only for that address; turning a link off stops new joins.
  const emailInvite = (await (await owner!.post(`/${id}/invites`, { role: 'viewer', email: 'Stranger@Example.com' })).json()).token;
  expect((await editor!.accept(emailInvite)).status()).toBe(403);
  expect((await stranger!.accept(emailInvite)).status()).toBe(200);
  expect((await stranger!.accept(emailInvite)).status()).toBe(404);
  expect((await owner!.del(`/${id}/invites/${editLink}`)).status()).toBe(204);
  expect((await stranger!.accept(editLink)).status()).toBe(404);

  // Lowering and removing access apply on the next request; a member “deleting” only leaves.
  expect((await owner!.put(`/${id}/members/${people.editor.id}`, { role: 'viewer' })).status()).toBe(204);
  expect((await editor!.put(`/${alias}`, { name: 'Nope' })).status()).toBe(403);
  expect((await owner!.del(`/${id}/members/${people.stranger.id}`)).status()).toBe(204);
  expect((await stranger!.get(`/${alias}`)).status()).toBe(404);
  expect((await viewer!.del(`/${alias}`)).status()).toBe(204);
  expect((await viewer!.get(`/${alias}`)).status()).toBe(404);
  expect((await owner!.get(`/${id}`)).status()).toBe(200);

  // Deleting the project ends everyone's access.
  expect((await owner!.del(`/${id}`)).status()).toBe(204);
  expect((await editor!.get(`/${alias}`)).status()).toBe(404);
});

test('history records per file with authors, and restoring writes a new version', async ({ request }) => {
  const owner = client(request, await tokenFor('owner')), id = newId();
  const write = (text: string, notes = 'a') => owner.put(`/${id}`, { name: 'History', files: [{ name: 'main.tex', content: source(text) }, { name: 'notes.tex', content: notes }] });
  await write('One');
  let list = (await (await owner.get(`/${id}/history`)).json()).versions;
  expect(list).toHaveLength(2);
  const one = list.find((v: { file: string }) => v.file === 'main.tex');
  expect(one.author).toBe(people.owner.email);
  // A name protects a version from being merged with later edits; unchanged files add nothing.
  expect((await owner.put(`/${id}/history/${one.id}`, { name: 'First draft' })).status()).toBe(204);
  await write('Two');
  list = (await (await owner.get(`/${id}/history`)).json()).versions;
  expect(list).toHaveLength(3);
  expect(list.filter((v: { file: string }) => v.file === 'notes.tex')).toHaveLength(1);
  const restored = await owner.post(`/${id}/history/${one.id}/restore`);
  expect(await restored.json()).toMatchObject({ file: 'main.tex', content: source('One') });
  const after = await (await owner.get(`/${id}`)).json();
  expect(after.files.find((f: { name: string }) => f.name === 'main.tex').content).toBe(source('One'));
  expect(after.files.find((f: { name: string }) => f.name === 'notes.tex').content).toBe('a');
  list = (await (await owner.get(`/${id}/history`)).json()).versions;
  expect(list).toHaveLength(4);
  expect(list[0].name).toMatch(/^Restored from/);
  expect((await client(request, await tokenFor('stranger')).get(`/${id}/history/${one.id}`)).status()).toBe(404);
  await owner.del(`/${id}`);
});

async function signedIn(browser: Browser, person: Person) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const access_token = await tokenFor(person), page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.addInitScript(([session]) => {
    localStorage.setItem('paperdesk-auth', session as string);
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-help-seen', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
  }, [JSON.stringify({ access_token, refresh_token: 'test', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: people[person].id, aud: 'authenticated', role: 'authenticated', email: people[person].email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } })]);
  return { page, errors, context };
}

test('owner shares through the dialog; the viewer gets a read-only project and a working diff', async ({ browser, request }) => {
  test.setTimeout(90_000);
  const api = client(request, await tokenFor('owner')), id = newId();
  await api.put(`/${id}`, { name: 'Dialog project', mainFile: 'main.tex', files: [{ name: 'main.tex', content: source('Version one') }] });
  await api.post(`/${id}/invites`, { role: 'viewer' }).then(r => r.json()); // A named first version to compare with:
  const first = (await (await api.get(`/${id}/history`)).json()).versions[0].id;
  await api.put(`/${id}/history/${first}`, { name: 'Draft' });
  await api.put(`/${id}`, { files: [{ name: 'main.tex', content: source('Version two') }] });

  const owner = await signedIn(browser, 'owner');
  await owner.page.goto(`/#/paper/${id}/`);
  await expect(owner.page.locator('.monaco-editor')).toBeVisible();
  await owner.page.getByRole('button', { name: 'Share', exact: true }).first().click();
  const dialog = owner.page.getByRole('dialog', { name: 'Share project' });
  await dialog.getByRole('textbox', { name: 'Email to invite' }).fill('viewer@example.com');
  await dialog.getByRole('combobox', { name: 'Invite role' }).selectOption('viewer');
  await dialog.getByRole('button', { name: 'Create invite' }).click();
  await expect(dialog).toContainText('viewer@example.com');
  const invite = (await (await api.get(`/${id}/members`)).json()).invites.find((i: { email: string | null }) => i.email)?.token as string;

  const viewer = await signedIn(browser, 'viewer');
  await viewer.page.goto(`/?join=${invite}`);
  await expect(viewer.page.getByText('View only')).toBeVisible();
  await expect(viewer.page.locator('.view-line').filter({ hasText: 'Version two' })).toBeVisible();
  await viewer.page.locator('.view-line').filter({ hasText: 'Version two' }).click();
  await viewer.page.keyboard.type('tampered');
  await expect(viewer.page.locator('.view-line').filter({ hasText: 'tampered' })).toHaveCount(0);

  await viewer.page.locator('.editor-menus .text-menu').filter({ hasText: 'File' }).click();
  await viewer.page.getByRole('menuitem', { name: 'Project history' }).click();
  const history = viewer.page.getByRole('dialog', { name: 'Project history' });
  await history.getByRole('combobox', { name: 'Older version' }).selectOption({ label: await history.getByRole('option', { name: /Draft/ }).first().innerText() });
  await expect(history.getByTestId('history-diff')).toContainText('Version one');
  await expect(history.getByTestId('history-diff')).toContainText('Version two');
  await expect(history.getByRole('button', { name: /Restore/ })).toHaveCount(0);
  expect((await (await api.get(`/${id}`)).json()).files[0].content).toBe(source('Version two'));
  expect([...owner.errors, ...viewer.errors]).toEqual([]);
  await api.del(`/${id}`);
  await owner.context.close(); await viewer.context.close();
});

test('a signed-out visitor is told which project a link is for, and lands in it after signing in', async ({ browser, request }) => {
  test.setTimeout(90_000);
  const api = client(request, await tokenFor('owner')), id = newId();
  // A project with a large image: creating a link must not depend on loading the project's files.
  const image = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
  await api.put(`/${id}`, { name: 'Smart Wardrobe Management System', mainFile: 'main.tex', files: [{ name: 'main.tex', content: source('Wardrobe paper') }, { name: 'figures/big.png', content: image, encoding: 'base64' }] });
  const started = Date.now();
  const link = (await (await api.post(`/${id}/invites`, { role: 'editor' })).json()).token as string;
  expect((await (await api.get(`/${id}/members`)).json()).invites.map((i: { token: string }) => i.token)).toEqual([link]);
  expect(Date.now() - started).toBeLessThan(2000);

  // Anyone holding the link can see what it is for; an unknown link says so.
  expect(await (await request.get(`${API}/api/invites/${link}`)).json()).toEqual({ project: 'Smart Wardrobe Management System', role: 'editor', forEmail: false });
  expect((await request.get(`${API}/api/invites/not-a-real-link`)).status()).toBe(404);

  // A visitor who is not signed in, on a browser that has never opened the app.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const token = await tokenFor('editor');
  await page.route(`${SUPABASE}/auth/v1/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/settings')) return route.fulfill({ json: { external: { email: true, google: false } } });
    if (url.pathname.endsWith('/otp')) return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/token')) return route.fulfill({ json: {
      access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'test-refresh',
      user: { id: people.editor.id, aud: 'authenticated', role: 'authenticated', email: people.editor.email, app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() },
    } });
    return route.fulfill({ status: 404, json: { error: 'unexpected auth call' } });
  });
  await page.addInitScript(() => { localStorage.setItem('paperdesk-tour-done', '1'); localStorage.setItem('paperdesk-help-seen', '1'); });

  await page.goto(`/?join=${link}`);
  const dialog = page.getByRole('dialog', { name: 'Sign in to PaperDesk' });
  await expect(dialog).toContainText('You were invited to edit “Smart Wardrobe Management System”. Sign in to open it.');
  // The sample project is not opened behind the dialog: that looked like the link had opened the wrong project.
  await expect(page.locator('.monaco-editor')).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('');
  await dialog.getByLabel('Email').fill(people.editor.email);
  await dialog.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(dialog).toContainText(`Check ${people.editor.email} for a sign-in link`);

  // Opening the emailed link comes back with a one-time code; the invited project opens.
  await page.goto('/?code=test-code');
  await expect(page.locator('.view-line').filter({ hasText: 'Wardrobe paper' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.project-title, .editor-title, header').filter({ hasText: 'Smart Wardrobe Management System' }).first()).toBeVisible();
  expect(new URL(page.url()).hash).toMatch(/^#\/paper\/s-/);
  expect(errors).toEqual([]);
  await context.close();

  // A link that was turned off says so instead of asking the visitor to sign in.
  await api.del(`/${id}/invites/${link}`);
  const late = await browser.newContext(), latePage = await late.newPage();
  await latePage.addInitScript(() => { localStorage.setItem('paperdesk-tour-done', '1'); localStorage.setItem('paperdesk-help-seen', '1'); });
  await latePage.goto(`/?join=${link}`);
  await expect(latePage.locator('.toast')).toContainText('This invitation link is no longer valid');
  await expect(latePage.getByRole('dialog', { name: 'Sign in to PaperDesk' })).toHaveCount(0);
  await late.close();
  await api.del(`/${id}`);
});
