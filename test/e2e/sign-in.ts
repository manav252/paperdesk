import { readFileSync } from 'node:fs';
import type { Browser } from '@playwright/test';
import { importJWK, SignJWT } from 'jose';

// Test accounts and sessions, signed with the test-only key in test/fixtures/auth (see its README).
const SUPABASE = 'http://127.0.0.1:54399';
export const API = 'http://127.0.0.1:3002';
export const FAKES = 'http://127.0.0.1:3997';
export const people = {
  owner: { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com' },
  editor: { id: '22222222-2222-4222-8222-222222222222', email: 'editor@example.com' },
  chatter: { id: '55555555-5555-4555-8555-555555555555', email: 'chatter@example.com' },
  syncer: { id: '66666666-6666-4666-8666-666666666666', email: 'syncer@example.com' },
};
export type Person = keyof typeof people;

export async function tokenFor(person: Person) {
  const key = await importJWK(JSON.parse(readFileSync('test/fixtures/auth/test-signing-key.json', 'utf8')), 'ES256');
  return new SignJWT({ role: 'authenticated', email: people[person].email })
    .setProtectedHeader({ alg: 'ES256', kid: 'paperdesk-test' })
    .setSubject(people[person].id)
    .setIssuer(`${SUPABASE}/auth/v1`)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

/** A browser window that is already signed in as this person. */
export async function signedIn(browser: Browser, person: Person) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const access_token = await tokenFor(person),
    page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.addInitScript(
    ([session]) => {
      localStorage.setItem('paperdesk-auth', session as string);
      localStorage.setItem('paperdesk-tour-done', '1');
      localStorage.setItem('paperdesk-help-seen', '1');
      localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
    },
    [
      JSON.stringify({
        access_token,
        refresh_token: 'test',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: {
          id: people[person].id,
          aud: 'authenticated',
          role: 'authenticated',
          email: people[person].email,
          app_metadata: {},
          user_metadata: {},
          created_at: new Date().toISOString(),
        },
      }),
    ],
  );
  return { page, errors, context, token: access_token };
}
