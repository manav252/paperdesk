import type { APIRequestContext, Page } from '@playwright/test';

/** Keep each browser test's p1 isolated locally and prevent writes to user projects on an external site. */
export async function isolateProjects(page: Page, request: APIRequestContext) {
  if (process.env.E2E_BASE_URL) {
    await page.route('**/api/projects', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue());
    await page.route('**/api/projects/p1', route => {
      if (route.request().method() === 'DELETE') return route.fulfill({ status: 204 });
      if (route.request().method() === 'PUT') return route.fulfill({ json: { id: 'p1' } });
      return route.continue();
    });
    return;
  }
  const response = await request.get('/api/projects').catch(() => null);
  if (!response?.ok()) return;
  const projects = await response.json() as { id: string }[];
  await Promise.all(projects.map(project => request.delete(`/api/projects/${project.id}`)));
}
