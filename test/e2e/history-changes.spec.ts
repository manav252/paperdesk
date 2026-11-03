import { expect, test, type Page } from '@playwright/test';

const project = () => ({
  id: 'p1', name: 'E2E Change Review', modified: Date.now(), mainFile: 'main.tex',
  files: [{ name: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nOriginal line\n\\end{document}\n' }],
});

const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  // Tests must not depend on the network: answer Google Fonts requests locally (the system font fallback is used).
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

async function openFresh(page: Page) {
  await page.addInitScript(value => { localStorage.setItem('paperdesk-projects', JSON.stringify([value])); localStorage.setItem('paperdesk-tour-done', '1'); }, project());
  await page.goto('/');
  await expect(page.locator('.monaco-editor')).toBeVisible();
}

async function typeAtEnd(page: Page, value: string) {
  const input = page.getByRole('textbox', { name: 'Editor content' });
  await input.click({ force: true });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.type(value);
}

async function openMenuItem(page: Page, menu: string, item: RegExp | string) {
  await page.locator('.editor-menus .text-menu').filter({ hasText: menu }).first().click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('history shows aligned highlighted side-by-side lines and restores a snapshot', async ({ page }) => {
  await openFresh(page);
  await typeAtEnd(page, 'Changed line');
  await openMenuItem(page, 'File', 'Project history');
  const dialog = page.getByRole('dialog', { name: 'Project history' });
  await expect(dialog.getByText('Previous').first()).toBeVisible();
  await expect(dialog.getByText('Current').first()).toBeVisible();
  await expect(dialog.locator('.diff-added, .diff-removed').first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Label current version' }).click();
  await page.getByLabel('Version label').fill('Before change');
  await page.getByRole('button', { name: 'Save version' }).click();
  await page.getByRole('dialog', { name: 'Project history' }).getByRole('button', { name: 'Close' }).last().click();
  await typeAtEnd(page, ' Another edit');
  await openMenuItem(page, 'File', 'Project history');
  const baseline = page.locator('.history-version').filter({ hasText: 'Before change' });
  await baseline.getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('dialog', { name: 'Restore version?' }).getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('.monaco-editor').getByText('Another edit')).toHaveCount(0);
});

test('tracked change can be rejected individually', async ({ page }) => {
  await openFresh(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const trackingRow = page.locator('.field-row').filter({ hasText: 'Track changes' });
  await trackingRow.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await typeAtEnd(page, ' tracked');
  await openMenuItem(page, 'Edit', /Review changes/);
  const review = page.getByRole('dialog', { name: 'Track changes' });
  await expect(review.getByText('tracked', { exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Reject change in main.tex' }).first().click();
  await expect(review.getByText('No pending tracked changes.')).toBeVisible();
  await expect(page.locator('.monaco-editor').getByText('tracked')).toHaveCount(0);
  await review.getByRole('button', { name: 'Close' }).last().click();
  await typeAtEnd(page, ' accepted');
  await openMenuItem(page, 'Edit', /Review changes/);
  await page.getByRole('dialog', { name: 'Track changes' }).getByRole('button', { name: 'Accept change in main.tex' }).first().click();
  await expect(page.locator('.monaco-editor').getByText('accepted')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Track changes' }).getByText('No pending tracked changes.')).toBeVisible();
});

test('tracked changes can be accepted all or rejected all', async ({ page }) => {
  await openFresh(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.locator('.field-row').filter({ hasText: 'Track changes' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await typeAtEnd(page, ' accepted');
  await openMenuItem(page, 'Edit', /Review changes/);
  let review = page.getByRole('dialog', { name: 'Track changes' });
  await review.getByRole('button', { name: 'Accept all' }).click();
  await expect(review.getByText('No pending tracked changes.')).toBeVisible();
  await page.getByRole('dialog', { name: 'Track changes' }).getByRole('button', { name: 'Close' }).last().click();
  await typeAtEnd(page, ' rejected');
  await openMenuItem(page, 'Edit', /Review changes/);
  review = page.getByRole('dialog', { name: 'Track changes' });
  await review.getByRole('button', { name: 'Reject all' }).click();
  await expect(review.getByText('No pending tracked changes.')).toBeVisible();
  await expect(page.locator('.monaco-editor').getByText('rejected')).toHaveCount(0);
});
