import { expect, test } from '@playwright/test';
import { API, FAKES, signedIn, tokenFor } from './sign-in';

let errors: string[] = [];
test.afterEach(({ page }, info) => {
  void page;
  if (info.status !== info.expectedStatus && errors.length) console.log('Browser errors:', errors);
});
const source = '\\documentclass{article}\n\\begin{document}\nOne\n\nTwo\n\nThree\n\\end{document}\n';

test('chat keeps messages, links to a line, and shows markup as plain text', async ({ page, request }, info) => {
  test.skip(
    !['desktop-light', 'phone-light'].includes(info.project.name) || !!process.env.E2E_CLOUD_STORAGE,
    'Runs once per layout, with local file storage.',
  );
  const phone = info.project.name.startsWith('phone');
  const id = `chat-${Date.now().toString(36)}`;
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.addInitScript(
    ([projectId, content]) => {
      localStorage.setItem('paperdesk-tour-done', '1');
      localStorage.setItem('paperdesk-help-seen', '1');
      localStorage.setItem('paperdesk-compile-prefs', JSON.stringify({ autoCompile: false }));
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(
        'paperdesk-projects',
        JSON.stringify([
          {
            id: projectId,
            name: 'Chatty',
            modified: Date.now(),
            mainFile: 'main.tex',
            files: [{ name: 'main.tex', content }],
          },
        ]),
      );
    },
    [id, source],
  );
  const open = async () => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Chatty/ })
      .first()
      .click();
    await expect(page.locator('.monaco-editor').first()).toBeVisible();
    // The project is saved to the server shortly after it opens; chat needs it there.
    await expect.poll(async () => (await request.get(`${API}/api/projects/${id}`)).status()).toBe(200);
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
  };
  await open();
  const chat = page.getByRole('complementary', { name: 'Chat' });
  await expect(chat).toContainText('No messages yet');

  await chat
    .getByLabel('Message', { exact: true })
    .fill('Look at main.tex:5 <img src=x onerror="window.hacked=1"> <b>bold</b>');
  await chat.getByLabel('Message', { exact: true }).press('Enter');
  const message = chat.getByTestId('chat-message').first();
  await expect(message).toContainText('<img src=x onerror="window.hacked=1"> <b>bold</b>');
  await expect(message.locator('img, b')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { hacked?: number }).hacked)).toBeUndefined();
  await expect(message.locator('time')).toHaveText(/\d{1,2}[:.]\d{2}/);
  await expect(message).toContainText('You');
  await expect(chat.getByLabel('Message', { exact: true })).toHaveValue('');

  // Editing and deleting.
  await message.hover();
  await message.getByRole('button', { name: 'Edit message' }).click();
  await expect(chat).toContainText('Editing your message');
  await chat.getByLabel('Message', { exact: true }).fill('Second thoughts about main.tex:5');
  await chat.getByRole('button', { name: 'Send message' }).click();
  await expect(message).toContainText('Second thoughts about main.tex:5');
  await expect(message).toContainText('(edited)');
  await expect(chat.getByTestId('chat-message')).toHaveCount(1);

  // The file reference jumps to that line.
  await message.getByRole('button', { name: 'main.tex:5' }).click();
  if (phone) await expect(chat).toBeHidden();
  else await expect(page.locator('.status-bar')).toContainText('Ln 5, Col 1');

  // Messages are stored on the server: a second one, deleted, is still there after a reload.
  if (phone) await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await chat.getByLabel('Message', { exact: true }).fill('Throwaway');
  await chat.getByLabel('Message', { exact: true }).press('Enter');
  const second = chat.getByTestId('chat-message').nth(1);
  await second.hover();
  await second.getByRole('button', { name: 'Delete message' }).click();
  await expect(second).toContainText('This message was deleted.');
  await page.reload();
  await open();
  await expect(chat.getByTestId('chat-message')).toHaveCount(2);
  await expect(chat.getByTestId('chat-message').first()).toContainText('Second thoughts');
  await expect(chat.getByTestId('chat-message').nth(1)).toContainText('This message was deleted.');
  // Nothing new arrived while the panel was open, so there is no unread badge after closing it.
  await chat.getByRole('button', { name: 'Close chat' }).click();
  await expect(page.getByTestId('chat-unread')).toHaveCount(0);
  expect(errors).toEqual([]);
  await request.delete(`${API}/api/projects/${id}`);
});

test('the server limits how fast one person can post, and only authors change their messages', async ({
  request,
}, info) => {
  test.skip(info.project.name !== 'desktop-light', 'Server behaviour: runs once.');
  const id = `chat-limit-${Date.now().toString(36)}`;
  const chatter = { Authorization: `Bearer ${await tokenFor('chatter')}` },
    other = { Authorization: `Bearer ${await tokenFor('syncer')}` };
  const base = `${API}/api/projects/${id}`;
  expect((await request.post(`${base}/chat`, { headers: chatter, data: { text: 'early' } })).status()).toBe(404);
  await request.put(base, {
    headers: chatter,
    data: { name: 'Limits', mainFile: 'main.tex', files: [{ name: 'main.tex', content: source }] },
  });
  expect((await request.post(`${base}/chat`, { headers: chatter, data: { text: '   ' } })).status()).toBe(400);
  const first = await request.post(`${base}/chat`, {
    headers: chatter,
    data: { text: 'mine\u0000 <script>x</script>' },
  });
  expect(first.status()).toBe(201);
  const message = (await first.json()) as { id: string; text: string };
  expect(message.text).toBe('mine <script>x</script>');
  // Someone else cannot edit it (with accounts stored in a database they cannot even see the project).
  expect([403, 404]).toContain(
    (await request.put(`${base}/chat/${message.id}`, { headers: other, data: { text: 'theirs' } })).status(),
  );
  expect((await request.get(`${API}/api/notifications`)).status()).toBe(401);

  const statuses: number[] = [];
  for (let i = 0; i < 31; i++)
    statuses.push((await request.post(`${base}/chat`, { headers: chatter, data: { text: `message ${i}` } })).status());
  expect(statuses.slice(0, 28).every((s) => s === 201)).toBe(true);
  expect(statuses.at(-1)).toBe(429);
  await request.delete(base, { headers: chatter });
});

// Two people in one project need sharing, which needs Postgres and object storage (E2E_CLOUD_STORAGE=1).
test('a mention reaches the other person: unread badge, bell, and an email', async ({ browser, request }, info) => {
  test.skip(!process.env.E2E_CLOUD_STORAGE || info.project.name !== 'desktop-light', 'Needs local Postgres.');
  test.setTimeout(120_000);
  const id = `chat-${Date.now().toString(36)}`;
  const owner = await signedIn(browser, 'owner'),
    editor = await signedIn(browser, 'editor');
  const ownerAuth = { Authorization: `Bearer ${owner.token}` },
    editorAuth = { Authorization: `Bearer ${editor.token}` };
  await request.put(`${API}/api/projects/${id}`, {
    headers: ownerAuth,
    data: { name: 'Mentions', mainFile: 'main.tex', files: [{ name: 'main.tex', content: source }] },
  });
  const invite = await (
    await request.post(`${API}/api/projects/${id}/invites`, { headers: ownerAuth, data: { role: 'editor' } })
  ).json();
  const alias = (
    await (await request.post(`${API}/api/invites/${invite.token}/accept`, { headers: editorAuth })).json()
  ).id as string;

  await owner.page.goto(`/#/paper/${id}/`);
  await editor.page.goto(`/#/paper/${alias}/`);
  await expect(owner.page.getByTestId('live-badge')).toBeVisible();
  await expect(editor.page.getByTestId('live-badge')).toBeVisible();

  // The owner picks the editor from the list that opens after "@".
  await owner.page.getByRole('button', { name: 'Chat', exact: true }).click();
  const ownerChat = owner.page.getByRole('complementary', { name: 'Chat' });
  const box = ownerChat.getByLabel('Message', { exact: true });
  await box.pressSequentially('@ed');
  await expect(ownerChat.getByRole('option', { name: /@editor/ })).toBeVisible();
  await box.press('Enter');
  await expect(box).toHaveValue('@editor ');
  await box.pressSequentially('please check main.tex:3');
  await box.press('Enter');
  await expect(ownerChat.locator('.mention')).toHaveText('@editor');

  // The editor, with chat closed, sees an unread message and a notification without reloading.
  await expect(editor.page.getByTestId('chat-unread')).toHaveText('1');
  await expect(editor.page.getByRole('button', { name: 'Notifications, 1 new' })).toBeVisible();
  await editor.page.getByRole('button', { name: /^Notifications/ }).click();
  const item = editor.page.getByRole('menuitem').filter({ hasText: 'owner@example.com' });
  await expect(item).toContainText('mentioned you in');
  await expect(item).toContainText('Mentions');
  await item.click();
  const editorChat = editor.page.getByRole('complementary', { name: 'Chat' });
  await expect(editorChat.getByTestId('chat-message')).toContainText('please check main.tex:3');
  await expect(editorChat.getByTestId('chat-message')).toContainText('owner@example.com');
  await expect(editor.page.getByTestId('chat-unread')).toHaveCount(0);
  await editor.page.reload();
  await expect(editor.page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();

  // The reply shows up for the owner straight away; the owner cannot edit it but may delete it.
  await editor.page.getByRole('button', { name: 'Chat', exact: true }).click();
  await editorChat.getByLabel('Message', { exact: true }).fill('On it');
  await editorChat.getByLabel('Message', { exact: true }).press('Enter');
  const reply = ownerChat.getByTestId('chat-message').nth(1);
  await expect(reply).toContainText('On it');
  await expect(reply.getByRole('button', { name: 'Edit message' })).toHaveCount(0);

  // A mention in a comment notifies as well.
  await owner.page.getByRole('button', { name: 'Comments' }).click();
  const comments = owner.page.getByRole('dialog', { name: 'Comments' });
  await comments.getByLabel('New comment').fill('@editor is this right?');
  await comments.getByRole('button', { name: 'Add comment at cursor' }).click();
  await expect(comments.locator('.mention')).toHaveText('@editor');
  await expect(editor.page.getByRole('button', { name: 'Notifications, 1 new' })).toBeVisible();

  const sent = (await (await request.get(`${FAKES}/mail/sent`)).json()) as {
    to: { email: string }[];
    subject: string;
  }[];
  expect(
    sent.filter((m) => m.to[0]!.email === 'editor@example.com' && /mentioned you in “Mentions”/.test(m.subject)).length,
  ).toBeGreaterThanOrEqual(2);
  expect(owner.errors).toEqual([]);
  expect(editor.errors).toEqual([]);
  await owner.context.close();
  await editor.context.close();
});
