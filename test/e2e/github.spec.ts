import { expect, test } from '@playwright/test';
import { API, FAKES, signedIn } from './sign-in';

// GitHub is a stand-in (test/fakes/services.mjs): the real service is never called.
test('connect GitHub, push a project, pull a conflicting change, and disconnect', async ({
  browser,
  request,
}, info) => {
  test.skip(info.project.name !== 'desktop-light' || !!process.env.E2E_BASE_URL, 'Runs once, against the local API.');
  test.setTimeout(180_000);
  await request.post(`${FAKES}/github/test/reset`);
  const repoState = async (repo?: string) =>
    (await (await request.get(`${FAKES}/github/test/repo${repo ? `?repo=${repo}` : ''}`)).json()) as {
      files: Record<string, string>;
      commits: { message: string; author: string; namedAuthor: boolean }[];
      revoked: number;
    };
  const { page, errors, context, token } = await signedIn(browser, 'syncer');
  const auth = { Authorization: `Bearer ${token}` };
  const id = `sync-${Date.now().toString(36)}`;
  const main = '\\documentclass{article}\n\\begin{document}\nFirst draft\n\\end{document}\n';
  await request.put(`${API}/api/projects/${id}`, {
    headers: auth,
    data: {
      name: 'Sync Paper',
      mainFile: 'main.tex',
      files: [
        { name: 'main.tex', content: main },
        { name: 'main.aux', content: '\\relax' },
        { name: 'main.log', content: 'This is pdfTeX' },
      ],
    },
  });
  // Not connected yet: the server refuses to sync, and never reveals a token.
  expect(await (await request.get(`${API}/api/github`, { headers: auth })).json()).toEqual({
    configured: true,
    connected: false,
  });
  expect(
    (await request.post(`${API}/api/projects/${id}/github/push`, { headers: auth, data: { message: 'x' } })).status(),
  ).toBe(409);
  expect((await request.get(`${API}/api/github/repos`)).status()).toBe(401);

  await page.goto(`/#/paper/${id}/`);
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  const openSync = async () => {
    await page.locator('.editor-menus .text-menu').filter({ hasText: 'File' }).click();
    await page.getByRole('menuitem', { name: 'GitHub sync' }).click();
  };
  await openSync();
  const dialog = page.getByRole('dialog', { name: 'GitHub sync' });
  // Connecting goes to GitHub and comes back to the same project with the dialog open.
  await dialog.getByRole('button', { name: 'Connect GitHub' }).click();
  await expect(dialog.getByRole('heading', { name: 'Link to GitHub repo' })).toBeVisible();
  expect(page.url()).toContain(`#/paper/${id}/`);
  expect(page.url()).not.toContain('github=');
  await expect(dialog).toContainText('Connected as @octo-test');
  const status = await (await request.get(`${API}/api/github`, { headers: auth })).text();
  expect(status).toContain('octo-test');
  expect(status).not.toContain('gho_');

  // A new repository, then the preview of what the first push sends.
  await dialog.getByLabel('Repository name').fill('sync-paper');
  await dialog.getByRole('button', { name: 'Link repository' }).click();
  await expect(dialog.getByRole('link', { name: 'octo-test/sync-paper' })).toBeVisible();
  await expect(dialog.getByTestId('last-sync')).toContainText('Not synced yet');
  const pushSection = dialog.getByRole('region', { name: 'Push to GitHub' });
  await expect(pushSection.getByRole('button', { name: /added main\.tex/ })).toBeVisible();
  await expect(pushSection.getByRole('button', { name: /added \.gitignore/ })).toBeVisible();
  await expect(pushSection).not.toContainText('main.aux');
  await expect(pushSection).not.toContainText('main.log');
  await pushSection.getByRole('button', { name: /added main\.tex/ }).click();
  await expect(pushSection.getByLabel('Changes in main.tex')).toContainText('+ First draft');
  const pushButton = pushSection.getByRole('button', { name: 'Push', exact: true });
  await expect(pushButton).toBeDisabled();
  await pushSection.getByLabel('Commit message').fill('First version of the paper');
  await pushButton.click();
  await expect(page.locator('.toast')).toContainText('Pushed');
  await expect(dialog.getByTestId('last-sync')).toContainText('Last synced');
  await expect(pushSection).toContainText('Everything here is already on GitHub.');
  let repo = await repoState('octo-test/sync-paper');
  expect(Object.keys(repo.files).sort()).toEqual(['.gitignore', 'main.tex']);
  expect(repo.files['main.tex']).toBe(main);
  expect(repo.files['.gitignore']).toContain('*.aux');
  // The commit is exactly the typed message, made as the connected account.
  expect(repo.commits.at(-1)).toEqual({
    message: 'First version of the paper',
    author: 'octo-test',
    namedAuthor: false,
  });
  await page.keyboard.press('Escape');

  // Someone changes main.tex and adds a file on GitHub while main.tex is also edited here.
  await request.post(`${FAKES}/github/test/commit`, {
    data: {
      repo: 'octo-test/sync-paper',
      files: { 'main.tex': main.replace('First draft', 'Changed on GitHub'), 'notes.txt': 'From GitHub\n' },
    },
  });
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('% edited here\n');
  await openSync();
  const pullSection = dialog.getByRole('region', { name: 'Pull from GitHub' });
  await expect(pullSection).toContainText('notes.txt');
  const conflict = pullSection.getByTestId('conflict');
  await expect(conflict).toContainText('main.tex');
  await expect(conflict).toContainText('% edited here');
  await expect(conflict).toContainText('Changed on GitHub');
  const pullButton = pullSection.getByRole('button', { name: 'Pull', exact: true });
  await expect(pullButton).toBeDisabled();
  // Pushing over the change on GitHub is refused, in the dialog and by the server.
  await expect(pushSection).toContainText(/Pull/);
  const refused = await request.post(`${API}/api/projects/${id}/github/push`, {
    headers: auth,
    data: { message: 'overwrite' },
  });
  expect(refused.status()).toBe(409);
  expect((await request.post(`${API}/api/projects/${id}/github/pull`, { headers: auth, data: {} })).status()).toBe(409);
  expect((await repoState('octo-test/sync-paper')).files['main.tex']).toContain('Changed on GitHub');

  await conflict.getByLabel('Use the GitHub version').check();
  await pullButton.click();
  await expect(page.locator('.toast')).toContainText('Pulled 2 files');
  await expect(pullSection).toContainText('Nothing new on GitHub.');
  await page.keyboard.press('Escape');
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('Changed on GitHub');
  await expect(page.locator('.monaco-editor .view-lines').first()).not.toContainText('edited here');
  await expect(page.getByRole('button', { name: 'Rename notes.txt' })).toBeAttached();

  // Disconnecting revokes the grant at GitHub.
  await openSync();
  await dialog.getByRole('button', { name: 'Disconnect @octo-test' }).click();
  await expect(dialog.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
  repo = await repoState();
  expect(repo.revoked).toBe(1);
  expect((await request.get(`${API}/api/github/repos`, { headers: auth })).status()).toBe(409);
  expect(errors).toEqual([]);
  await context.close();
  await request.delete(`${API}/api/projects/${id}`, { headers: auth });
});
