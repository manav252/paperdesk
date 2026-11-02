import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: 'npm run server',
      url: 'http://127.0.0.1:3002/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ...process.env, PAPERDESK_DATA: '/tmp/paperdesk-playwright-data', PORT: '3002' },
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ...process.env, PAPERDESK_API_PROXY: 'http://127.0.0.1:3002' },
    },
  ],
});
