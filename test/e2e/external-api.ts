import type { APIRequestContext, Page } from '@playwright/test';

export async function cleanExternalProjects(page: Page, request: APIRequestContext) {
  const apiBase = process.env.E2E_API_URL;
  if (!process.env.E2E_BASE_URL || !apiBase) return;
  const state = await page.evaluate(() => ({
    owner: localStorage.getItem('paperdesk-owner-id'),
    ids: (JSON.parse(localStorage.getItem('paperdesk-projects') ?? '[]') as { id: string }[]).map(project => project.id).filter(id => id !== 'p1'),
  })).catch(() => null);
  if (!state?.owner) return;
  await Promise.all(state.ids.map(id => request.delete(new URL(`/api/projects/${encodeURIComponent(id)}`, apiBase).toString(), {
    headers: { 'X-PaperDesk-Owner': state.owner! },
  })));
}
