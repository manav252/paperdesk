import type { APIRequestContext, Page } from '@playwright/test';

export async function cleanExternalProjects(page: Page, request: APIRequestContext) {
  const apiBase = process.env.E2E_API_URL;
  if (!process.env.E2E_BASE_URL || !apiBase) return;
  const state = await page.evaluate(() => ({
    owner: localStorage.getItem('paperdesk-owner-id'),
    ids: (JSON.parse(localStorage.getItem('paperdesk-projects') ?? '[]') as { id: string }[]).map(project => project.id).filter(id => id !== 'p1'),
  })).catch(() => null);
  if (!state?.owner) return;
  // Best effort: a dropped connection while tidying up must not fail a test that already passed. Retry once.
  await Promise.all(state.ids.map(async id => {
    const url = new URL(`/api/projects/${encodeURIComponent(id)}`, apiBase).toString();
    for (let attempt = 0; attempt < 2; attempt++) {
      const ok = await request.delete(url, { headers: { 'X-PaperDesk-Owner': state.owner! }, timeout: 20_000 }).then(r => r.ok() || r.status() === 404, () => false);
      if (ok) return;
    }
    console.warn(`Could not delete test project ${id} on ${apiBase}`);
  }));
}
