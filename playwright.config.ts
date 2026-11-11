import { readFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Sign-in in local runs: a fake Supabase origin (tests answer its requests) and a test-only signing key that only
// this local API trusts. See test/fixtures/auth/README.md.
export const FAKE_SUPABASE_URL = 'http://127.0.0.1:54399';
const FAKES_URL = 'http://127.0.0.1:3997';
const testJwks = readFileSync('test/fixtures/auth/test-jwks.json', 'utf8');

const externalBaseUrl = process.env.E2E_BASE_URL;
if (externalBaseUrl && !process.env.E2E_API_URL) throw new Error('Set E2E_API_URL when testing an external frontend.');
const matrix = [
  { name: 'desktop-light', viewport: { width: 1440, height: 900 }, colorScheme: 'light' as const },
  { name: 'desktop-dark', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' as const },
  { name: 'phone-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' as const },
  { name: 'phone-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' as const },
];

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  // Generous limits: on a busy machine (e.g. iCloud syncing the project folder) single clicks can take seconds.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: { baseURL: externalBaseUrl ?? 'http://127.0.0.1:4173', trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  projects: matrix.map(profile => ({ name: profile.name, use: { ...devices['Desktop Chrome'], viewport: profile.viewport, colorScheme: profile.colorScheme } })),
  ...(externalBaseUrl ? {} : { webServer: [
    // Crossref and arXiv stand-ins (test/fakes/services.mjs): tests never call the real services.
    { command: 'node test/fakes/services.mjs', url: `${FAKES_URL}/health`, reuseExistingServer: false, timeout: 30_000 },
    {
      command: 'node --import tsx server.ts',
      url: 'http://127.0.0.1:3002/api/health',
      reuseExistingServer: false,
      timeout: 180_000,
      // An empty key overrides any .env value, so the tests never call the external assistant service.
      env: { ...process.env, TMPDIR: '/private/tmp', PAPERDESK_DATA: '/tmp/paperdesk-playwright-data', PORT: '3002', ANTHROPIC_API_KEY: '', SUPABASE_URL: FAKE_SUPABASE_URL, SUPABASE_JWKS: testJwks, SUPABASE_JWT_SECRET: '', CROSSREF_API_URL: `${FAKES_URL}/crossref`, ARXIV_API_URL: `${FAKES_URL}/arxiv`, CROSSREF_MAILTO: 'tests@example.com' },
    },
    {
      // Test the production build: a few bundled files load reliably, unlike the hundreds of modules the dev server serves.
      // Output and cache live in /tmp, outside the iCloud-synced project folder.
      command: 'npx vite build --outDir /tmp/paperdesk-e2e-dist --emptyOutDir && npx vite preview --outDir /tmp/paperdesk-e2e-dist --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 180_000,
      env: { ...process.env, PAPERDESK_API_PROXY: 'http://127.0.0.1:3002', PAPERDESK_VITE_CACHE: '/tmp/paperdesk-vite-e2e', VITE_SUPABASE_URL: FAKE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY: 'test-publishable-key' },
    },
  ] }),
});
