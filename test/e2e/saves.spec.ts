import { expect, test } from '@playwright/test';

// Saves that arrive at the same moment must not overwrite each other: each one reads the stored files,
// merges its own change and writes the result, so the server has to do that one save at a time.
const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:3002';

test('saves sent at the same moment each keep their own new file', async ({ request }, info) => {
  test.skip(info.project.name !== 'desktop-light', 'An API test: one profile is enough.');
  const headers = { 'X-PaperDesk-Owner': crypto.randomUUID() },
    id = `saves-${Date.now().toString(36)}`,
    url = `${API}/api/projects/${id}`;
  expect(
    (
      await request.put(url, {
        headers,
        data: { name: 'Saves', mainFile: 'main.tex', files: [{ name: 'main.tex', content: 'Hello' }] },
      })
    ).ok(),
  ).toBe(true);
  const names = Array.from({ length: 6 }, (_, i) => `figures/image-${i}.png`);
  const answers = await Promise.all([
    ...names.map((name) =>
      request.put(url, {
        headers,
        data: { patch: { files: [{ name, content: 'aGVsbG8=', encoding: 'base64', base: null }], deleted: [] } },
      }),
    ),
    // Settings-only saves in between, like the ones a collaborator's browser sends.
    ...names.map(() => request.put(url, { headers, data: { name: 'Saves', patch: { files: [], deleted: [] } } })),
  ]);
  expect(answers.map((r) => r.status())).toEqual(answers.map(() => 200));
  const stored = ((await (await request.get(url, { headers })).json()).files as { name: string }[])
    .map((f) => f.name)
    .filter((name) => !name.endsWith('/'))
    .sort();
  expect(stored).toEqual([...names, 'main.tex'].sort());
  await request.delete(url, { headers });
});
