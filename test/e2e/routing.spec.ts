import { expect, test } from '@playwright/test';

const ids = ['route-project-one', 'route-project-two'];
test.afterEach(async ({ request }) => {
  if (!process.env.E2E_BASE_URL)
    await Promise.all(ids.map((id) => request.delete(`/api/projects/${id}`).catch(() => undefined)));
});

test('project URLs survive direct load and refresh; browser back and forward follow project navigation', async ({
  page,
}) => {
  test.skip(!!process.env.E2E_BASE_URL, 'Routing test uses isolated local project storage.');
  test.skip(test.info().project.name !== 'desktop-light', 'Run route history coverage once.');
  const projects = [
    {
      id: 'route-project-one',
      name: 'Route Project One',
      modified: Date.now(),
      files: [{ name: 'main.tex', content: '\\documentclass{article}\n\\begin{document}One\\end{document}' }],
    },
    {
      id: 'route-project-two',
      name: 'Route Project Two',
      modified: Date.now() - 1,
      files: [{ name: 'main.tex', content: '\\documentclass{article}\n\\begin{document}Two\\end{document}' }],
    },
  ];
  await page.addInitScript((items) => {
    localStorage.setItem('paperdesk-projects', JSON.stringify(items));
    localStorage.setItem('paperdesk-tour-done', '1');
    localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
  }, projects);
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/#/paper/route-project-one/');
  await expect(page.getByTitle('Rename project')).toContainText('Route Project One');
  await expect(page).toHaveURL(/#\/paper\/route-project-one\/$/);
  await page.reload();
  await expect(page.getByTitle('Rename project')).toContainText('Route Project One');
  await expect(page).toHaveURL(/#\/paper\/route-project-one\/$/);

  await page.getByRole('button', { name: 'Back to projects' }).click();
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.locator('.project-open').filter({ hasText: 'Route Project Two' }).click();
  await expect(page.getByTitle('Rename project')).toContainText('Route Project Two');
  await expect(page).toHaveURL(/#\/paper\/route-project-two\/$/);

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await page.goForward();
  await expect(page.getByTitle('Rename project')).toContainText('Route Project Two');
  expect(errors).toEqual([]);
});

test('a long project name never runs under the header buttons', async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, 'Uses isolated local project storage.');
  test.skip(test.info().project.name !== 'desktop-light', 'Widths are set by the test.');
  await page.addInitScript(
    (items) => {
      localStorage.setItem('paperdesk-projects', JSON.stringify(items));
      localStorage.setItem('paperdesk-tour-done', '1');
      localStorage.setItem('paperdesk-help-seen', '1');
    },
    [
      {
        id: 'route-project-one',
        name: 'Smart Wardrobe Management System with a Much Longer Working Title',
        modified: Date.now(),
        files: [{ name: 'main.tex', content: '\\documentclass{article}\n\\begin{document}One\\end{document}' }],
      },
    ],
  );
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.goto('/#/paper/route-project-one/');
  const title = page.getByTitle('Rename project');
  await expect(title).toBeVisible();
  for (const width of [1600, 1280, 1100, 1000, 900, 780]) {
    await page.setViewportSize({ width, height: 800 });
    // The layout settles a moment after a resize, when the app switches between its wide and narrow forms.
    await expect(async () => {
      const [name, menus, buttons] = await Promise.all(
        [title, page.locator('.editor-menus'), page.locator('.header-right')].map((l) => l.boundingBox()),
      );
      expect(name!.x, `title clears the menus at ${width}px`).toBeGreaterThanOrEqual(menus!.x + menus!.width - 1);
      expect(name!.x + name!.width, `title clears the buttons at ${width}px`).toBeLessThanOrEqual(buttons!.x + 1);
      expect(buttons!.x + buttons!.width, `buttons stay on screen at ${width}px`).toBeLessThanOrEqual(width);
    }).toPass({ timeout: 5000 });
    if (process.env.HEADER_SHOTS)
      await page.locator('.editor-header').screenshot({ path: `${process.env.HEADER_SHOTS}/header-${width}.png` });
  }
});
