import { expect, test, type Page } from '@playwright/test';

// Issue #106: read-only XLSX preview with sheet tabs and real cell coordinates.
// Run with: npx playwright test -c playwright.xlsx.config.ts

const MISSING_VALUE = 'Formula, no saved value';

test.beforeEach(({ baseURL }) => {
  const isLocal = Boolean(baseURL && /^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL));
  // CI sets XLSX_E2E_REQUIRED so this gate can never pass by skipping.
  if (process.env.XLSX_E2E_REQUIRED === '1') expect(isLocal, `XLSX preview tests need local Vite, got ${baseURL}`).toBe(true);
  else test.skip(!isLocal, 'Local Vite required');
});

/** Open a fixture workbook and record every request that could write data. */
async function openFixture(page: Page, fixture: string, theme: 'light' | 'dark' = 'light') {
  const writes: string[] = [];
  page.on('request', request => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
  });
  await page.goto(`/e2e/fixtures/xlsx-preview.html?fixture=${fixture}&theme=${theme}`);
  // A cold Vite server may re-bundle dependencies and reload once; this wait absorbs that.
  await expect(page.getByRole('navigation', { name: 'Worksheets' })).toBeVisible({ timeout: 45_000 });
  return writes;
}

const cell = (page: Page, sheet: string, address: string) => page.locator(`[data-sheet="${sheet}"][data-cell="${address}"]`);
const summary = (page: Page) => page.locator('.spreadsheet-preview-summary');
const sheetTab = (page: Page, label: string) => page.getByRole('navigation', { name: 'Worksheets' }).getByRole('button', { name: label, exact: true });

test('switches sheets by name and keeps every cell at its real address', async ({ page }) => {
  const writes = await openFixture(page, 'multi');

  for (const label of ['Alpha', 'Beta', 'Secret (hidden)', 'Big']) await expect(sheetTab(page, label)).toBeVisible();
  await expect(sheetTab(page, 'Alpha')).toHaveAttribute('aria-current', 'page');
  await expect(summary(page)).toHaveText('Alpha · 7 rows · 3 columns');
  await expect(page.getByRole('columnheader')).toHaveText(['A', 'B', 'C']);
  await expect(page.getByRole('rowheader')).toHaveText(['1', '2', '3', '4', '5', '6', '7']);

  // Row 1 is data, not headers; the blank row 3 and blank column B stay in place.
  await expect(cell(page, 'Alpha', 'A1')).toHaveText('Name');
  await expect(cell(page, 'Alpha', 'C1')).toHaveText('Score');
  await expect(cell(page, 'Alpha', 'A2')).toHaveText('Ann');
  await expect(cell(page, 'Alpha', 'A4')).toHaveText('Bob');
  await expect(cell(page, 'Alpha', 'C4')).toHaveText('20');
  for (const address of ['A3', 'B3', 'C3', 'B1', 'B2', 'B4']) await expect(cell(page, 'Alpha', address), address).toHaveText('');

  // A saved formula result is shown; formulas without one are marked, not calculated.
  await expect(cell(page, 'Alpha', 'C5')).toHaveText('30');
  await expect(cell(page, 'Alpha', 'C5')).toHaveAttribute('title', '=C2+C4');
  await expect(cell(page, 'Alpha', 'C5').getByRole('img', { name: MISSING_VALUE })).toHaveCount(0);
  for (const address of ['C6', 'C7']) {
    await expect(cell(page, 'Alpha', address).getByRole('img', { name: MISSING_VALUE }), address).toBeVisible();
    await expect(cell(page, 'Alpha', address), address).not.toContainText('0');
  }
  await page.screenshot({ path: test.info().outputPath('xlsx-multi-alpha.png') });

  await sheetTab(page, 'Beta').click();
  await expect(sheetTab(page, 'Beta')).toHaveAttribute('aria-current', 'page');
  await expect(cell(page, 'Beta', 'B3')).toHaveText('hello from Beta');
  for (const address of ['A1', 'B1', 'A2', 'B2', 'A3']) await expect(cell(page, 'Beta', address), address).toHaveText('');
  await expect(page.locator('[data-sheet="Alpha"]')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('xlsx-multi-beta.png') });

  await sheetTab(page, 'Secret (hidden)').click();
  await expect(cell(page, 'Secret', 'A1')).toHaveText('hidden');

  // Large sheets state the preview limits and stop at T100.
  await sheetTab(page, 'Big').click();
  await expect(summary(page)).toHaveText('Big · 150 rows · 25 columns · Showing rows 1–100 of 150 · columns A–T of Y');
  await expect(cell(page, 'Big', 'A1')).toHaveText('A1');
  await expect(cell(page, 'Big', 'T100')).toHaveText('T100');
  await expect(cell(page, 'Big', 'U1')).toHaveCount(0);
  await expect(cell(page, 'Big', 'A101')).toHaveCount(0);

  expect(writes, 'previewing must not write anything').toEqual([]);
});

test('data that starts away from A1 is shown at its address', async ({ page }) => {
  const writes = await openFixture(page, 'offset');
  await expect(summary(page)).toHaveText('Sheet1 · 3 rows · 3 columns');
  await expect(cell(page, 'Sheet1', 'C3')).toHaveText('C3 here');
  for (const address of ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3']) await expect(cell(page, 'Sheet1', address), address).toHaveText('');
  await page.screenshot({ path: test.info().outputPath('xlsx-offset.png') });
  expect(writes).toEqual([]);
});

test('an empty first sheet says so and later sheets stay reachable', async ({ page }) => {
  const writes = await openFixture(page, 'emptyFirst');
  await expect(sheetTab(page, 'Blank')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Sheet “Blank” has no cell data.')).toBeVisible();
  await expect(page.getByText('Empty or unsupported spreadsheet file.')).toHaveCount(0);
  await expect(page.locator('[data-cell]')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('xlsx-empty-first-blank.png') });

  await sheetTab(page, 'Data').click();
  await expect(cell(page, 'Data', 'A1')).toHaveText('x');
  await page.screenshot({ path: test.info().outputPath('xlsx-empty-first-data.png') });
  expect(writes).toEqual([]);
});

test('uses theme colours in dark mode instead of a white table', async ({ page }) => {
  await openFixture(page, 'multi', 'dark');
  const background = await page.locator('.spreadsheet-preview').evaluate(element => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe('rgb(255, 255, 255)');
  await page.screenshot({ path: test.info().outputPath('xlsx-multi-dark.png') });
});
