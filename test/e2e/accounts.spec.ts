import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Request } from '@playwright/test';
import { importJWK, SignJWT } from 'jose';

// Sign-in against a fake Supabase (requests to its origin are answered here) and the real local API, which trusts
// only the test signing key in test/fixtures/auth. Live sites need a real Supabase project, so these run locally.
const SUPABASE = 'http://127.0.0.1:54399';
const API = 'http://127.0.0.1:3002';
const userId = '6a1f3c2e-8d4b-4c1a-9e2f-3b5d7c9a1e44';
const anonymousId = '0b8f5a2c-4d6e-4f1a-8b3c-5d7e9f1a2b3c';

async function accessToken(claims: Record<string, unknown> = {}) {
  const key = await importJWK(JSON.parse(readFileSync('test/fixtures/auth/test-signing-key.json', 'utf8')), 'ES256');
  return new SignJWT({ role: 'authenticated', email: 'ada@example.com', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'paperdesk-test' })
    .setSubject(userId)
    .setIssuer(`${SUPABASE}/auth/v1`)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

const errorsByPage = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }, info) => {
  test.skip(!!process.env.E2E_BASE_URL, 'Needs the local API that trusts the test signing key.');
  test.skip(info.project.name !== 'desktop-light', 'Sign-in flow runs once; other profiles cover layout.');
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
});
test.afterEach(async ({ page }) => {
  expect(errorsByPage.get(page) ?? []).toEqual([]);
});

test('the API accepts only valid sign-in tokens and keeps accounts apart from anonymous keys', async ({ request }) => {
  const token = await accessToken();
  expect((await request.get(`${API}/api/projects`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(
    200,
  );
  const bad = await request.get(`${API}/api/projects`, { headers: { Authorization: 'Bearer not-a-real-token' } });
  expect(bad.status()).toBe(401);
  expect((await bad.json()).error).toMatch(/sign-in has expired/);
  const forged = await accessToken({ role: 'anon' });
  expect((await request.get(`${API}/api/projects`, { headers: { Authorization: `Bearer ${forged}` } })).status()).toBe(
    401,
  );
  // Claiming needs a signed-in user and a well-formed anonymous key.
  expect((await request.post(`${API}/api/account/claim`, { data: { anonymousId } })).status()).toBe(401);
  expect(
    (
      await request.post(`${API}/api/account/claim`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { anonymousId: 'nope' },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post(`${API}/api/account/claim`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { anonymousId },
      })
    ).status(),
  ).toBe(200);
  expect((await (await request.get(`${API}/api/health`)).json()).auth).toEqual({ configured: true });
});

test('email sign-in moves this browser’s projects to the account and sign-out forgets them', async ({ page }) => {
  const project = {
    id: 'p1',
    name: 'My thesis',
    modified: Date.now(),
    mainFile: 'main.tex',
    files: [{ name: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nThesis\n\\end{document}\n' }],
  };
  await page.addInitScript(
    ([value, owner]) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('paperdesk-projects', JSON.stringify([value]));
      localStorage.setItem('paperdesk-owner-id', owner as string);
      localStorage.setItem('paperdesk-tour-done', '1');
      localStorage.setItem('paperdesk-help-seen', '1');
    },
    [project, anonymousId] as const,
  );

  // Fake Supabase Auth: the magic-link request, the code exchange after the link is opened, and sign-out.
  const otp: Request[] = [];
  const token = await accessToken();
  await page.route(`${SUPABASE}/auth/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/settings')) return route.fulfill({ json: { external: { email: true, google: true } } });
    if (url.pathname.endsWith('/otp')) {
      otp.push(route.request());
      return route.fulfill({ json: {} });
    }
    if (url.pathname.endsWith('/token') && url.searchParams.get('grant_type') === 'pkce') {
      return route.fulfill({
        json: {
          access_token: token,
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'test-refresh',
          user: {
            id: userId,
            aud: 'authenticated',
            role: 'authenticated',
            email: 'ada@example.com',
            app_metadata: { provider: 'email' },
            user_metadata: { full_name: 'Ada Lovelace' },
            created_at: new Date().toISOString(),
          },
        },
      });
    }
    if (url.pathname.endsWith('/logout')) return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 404, json: { error: 'unexpected auth call' } });
  });
  // The local development API keeps one shared project folder, so report a moved id the way Neon would.
  const claims: Request[] = [];
  await page.route('**/api/account/claim', async (route) => {
    claims.push(route.request());
    await route.fulfill({ json: { moved: [{ from: 'p1', to: 'p1-a1b2c3' }] } });
  });
  // …and keep the server's list consistent with that move (the shared local folder still has the old id).
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue(),
  );

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to PaperDesk' });
  await expect(dialog.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await dialog.getByLabel('Email').fill('ada@example.com');
  await dialog.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(dialog).toContainText('Check ada@example.com for a sign-in link');
  expect(otp[0]!.postDataJSON()).toMatchObject({ email: 'ada@example.com', create_user: true });

  // Opening the emailed link returns to the site with a one-time code.
  const listed = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/projects' && r.method() === 'GET');
  await page.goto('/?code=test-code');
  await expect(page.getByRole('button', { name: 'Account: Ada Lovelace' })).toBeVisible();
  expect(new URL(page.url()).searchParams.has('code')).toBe(false);
  expect(claims).toHaveLength(1);
  expect(claims[0]!.postDataJSON()).toEqual({ anonymousId });
  expect(claims[0]!.headers().authorization).toBe(`Bearer ${token}`);
  // Projects are now requested as the account, never with the anonymous key.
  const list = await listed;
  expect(list.headers().authorization).toBe(`Bearer ${token}`);
  expect(list.headers()['x-paperdesk-owner']).toBeUndefined();
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('paperdesk-projects') ?? '[]').map((p: { id: string }) => p.id),
      ),
    )
    .toContain('p1-a1b2c3');
  await expect(page.getByText('My thesis')).toBeVisible();

  await page.getByRole('button', { name: 'Account: Ada Lovelace' }).click();
  await expect(page.getByRole('menu')).toContainText('ada@example.com');
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
  // Signing out reloads the page, so the check may land in the middle of that navigation: ask again.
  await expect
    .poll(() =>
      page
        .evaluate(() => [
          localStorage.getItem('paperdesk-auth'),
          localStorage.getItem('paperdesk-owner-id') === '0b8f5a2c-4d6e-4f1a-8b3c-5d7e9f1a2b3c',
        ])
        .catch(() => 'navigating'),
    )
    .toEqual([null, false]);
  await expect(page.getByText('My thesis')).toHaveCount(0);
});
