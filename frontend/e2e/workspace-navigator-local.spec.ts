import { test, expect } from '@playwright/test';

test('workspace switching, pin persistence and owned trash cleanup', async ({ page }) => {
  await page.goto('/e2e/fixtures/workspace-navigator.html');
  await page.getByRole('button', { name: 'Alpha plan Private', exact: true }).click();
  await expect(page.getByLabel('Current workspace')).toHaveText('Alpha plan');
  await page.getByRole('button', { name: 'More actions for Alpha plan' }).focus();
  await page.getByRole('button', { name: 'More actions for Alpha plan' }).click();
  await page.getByRole('menuitem', { name: 'Pin workspace', exact: true }).click();
  await expect(page.getByText('Pinned', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Pinned', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close workspace menu' }).click();
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Switch workspace', exact: true }).getByRole('textbox', { name: 'Search workspaces', exact: true }).fill('Beta');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Current workspace')).toHaveText('Beta research');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Trash (1)' }).click();
  await expect(page.getByText('Old draft', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Empty trash', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Permanently delete 1 workspace?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Trash (1)' })).toBeVisible();
  await page.route('**/workspaces/old/permanent', async (route) => route.fulfill({ status: 204 }));
  await page.route('**/fixture-workspaces', async (route) => route.fulfill({ json: [] }));
  await page.getByRole('button', { name: 'Empty trash', exact: true }).click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(page.getByText('Trash is empty.')).toBeVisible();
});

test('trash errors retain the workspace and allow a successful restore', async ({ page }) => {
  await page.goto('/e2e/fixtures/workspace-navigator.html');
  await page.getByRole('radio', { name: 'All workspaces', exact: true }).click();
  await page.getByRole('radio', { name: 'Shared', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Beta research/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Alpha plan Private', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Trash (1)' }).click();
  const old = { id: 'old', name: 'Old draft', visibility: 'private', role: 'owner', status: 'trashed' };
  await page.route('**/fixture-workspaces', async (route) => route.fulfill({ json: [old] }));
  await page.route('**/workspaces/old/restore', async (route) => route.fulfill({ status: 403, json: { error: 'Only the owner can restore' } }));
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Only the owner can restore');
  await expect(page.getByText('Old draft', { exact: true })).toBeVisible();
  await page.route('**/workspaces/old/restore', async (route) => route.fulfill({ status: 200, json: { workspace: { ...old, status: 'active' } } }));
  await page.route('**/fixture-workspaces', async (route) => route.fulfill({ json: [{ ...old, status: 'active' }] }));
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText('Trash is empty.')).toBeVisible();
});

test('workspace pane has one search and no duplicate switcher', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('helpudoc-color-mode', 'dark'));
  await page.goto('/e2e/fixtures/workspace-navigator.html');
  const pane = page.getByRole('complementary', { name: 'Workspaces', exact: true });
  await expect(pane.getByRole('button', { name: 'Switch workspace', exact: true })).toHaveCount(0);
  await expect(pane.getByRole('textbox', { name: 'Search workspaces', exact: true })).toHaveCount(1);
  await pane.getByRole('textbox', { name: 'Search workspaces', exact: true }).fill('Beta');
  await expect(pane.getByRole('button', { name: /^Beta research/ })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Alpha plan Private', exact: true })).toHaveCount(0);
  await expect(pane.locator('[class*="Mui"]')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/helpudoc-workspace-pane-dark.png' });
});
