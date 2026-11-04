import { expect, test } from '@playwright/test';

const ids = ['route-project-one', 'route-project-two'];
test.afterEach(async ({ request }) => {
  if (!process.env.E2E_BASE_URL) await Promise.all(ids.map(id => request.delete(`/api/projects/${id}`).catch(() => undefined)));
});

test('project URLs survive direct load and refresh; browser back and forward follow project navigation', async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, 'Routing test uses isolated local project storage.');
  test.skip(test.info().project.name !== 'desktop-light', 'Run route history coverage once.');
  const projects = [
    { id: 'route-project-one', name: 'Route Project One', modified: Date.now(), files: [{ name: 'main.tex', content: '\\documentclass{article}\n\\begin{document}One\\end{document}' }] },
    { id: 'route-project-two', name: 'Route Project Two', modified: Date.now() - 1, files: [{ name: 'main.tex', content: '\\documentclass{article}\n\\begin{document}Two\\end{document}' }] },
  ];
  await page.addInitScript(items => {
    localStorage.setItem('paperdesk-projects', JSON.stringify(items));
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
  }, projects);
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));

  await page.goto('/paper/route-project-one/');
  await expect(page.getByTitle('Rename project')).toContainText('Route Project One');
  await expect(page).toHaveURL(/\/paper\/route-project-one\/$/);
  await page.reload();
  await expect(page.getByTitle('Rename project')).toContainText('Route Project One');
  await expect(page).toHaveURL(/\/paper\/route-project-one\/$/);

  await page.getByRole('button', { name: 'Back to projects' }).click();
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.locator('.project-open').filter({ hasText: 'Route Project Two' }).click();
  await expect(page.getByTitle('Rename project')).toContainText('Route Project Two');
  await expect(page).toHaveURL(/\/paper\/route-project-two\/$/);

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await page.goForward();
  await expect(page.getByTitle('Rename project')).toContainText('Route Project Two');
  expect(errors).toEqual([]);

});
