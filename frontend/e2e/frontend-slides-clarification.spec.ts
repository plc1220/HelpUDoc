import { expect, test } from '@playwright/test';

test.setTimeout(150_000);

const E2E_USER = {
  id: 'local-e2e',
  name: 'E2E User',
  email: 'e2e@example.com',
  provider: 'local',
};

const REPORT_CONTENT = `# Operation Epic Fury

## TL;DR
- Major regional conflict scenario
- Strategic, economic, and geopolitical impacts

## Sections
1. Background
2. Military narrative
3. Economic implications
4. Regional shifts
`;

test('frontend-slides pauses on clarification instead of approval', async ({ page, baseURL }) => {
  const resolvedBaseUrl = baseURL || 'https://lc-demo.com';
  const workspaceName = `e2e-slides-${Date.now()}`;

  page.on('console', (message) => {
    console.log(`[browser:${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    console.log(`[pageerror] ${error.message}`);
  });
  page.on('requestfailed', (request) => {
    console.log(`[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`);
  });
  page.on('response', async (response) => {
    if (!response.url().includes('/api/')) {
      return;
    }
    const request = response.request();
    console.log(`[response] ${request.method()} ${response.status()} ${response.url()}`);
  });

  await page.addInitScript((payload) => {
    window.localStorage.setItem('helpudoc-auth-user', JSON.stringify(payload));
  }, E2E_USER);

  await page.goto(resolvedBaseUrl, { waitUntil: 'domcontentloaded' });

  // Open the workspace drawer.
  await page.getByRole('button').first().click();

  // Create and select a disposable workspace.
  await page.getByPlaceholder('New workspace').fill(workspaceName);
  await page.getByRole('button', { name: /^Create$/ }).click();
  await page.getByRole('button', { name: new RegExp(workspaceName) }).click();
  await page.getByRole('button').first().click();

  // Upload the source markdown through the workspace file input.
  await page.locator('#file-upload').setInputFiles({
    name: 'operation-epic-fury-report.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(REPORT_CONTENT, 'utf-8'),
  });
  await expect(page.getByText('operation-epic-fury-report.md', { exact: true })).toBeVisible();

  // Trigger the frontend-slides flow using a tagged workspace file.
  const composer = page.getByPlaceholder('Interact with the agent... (Type / for commands)');
  await composer.fill('use frontend-slide skill, build the presentation slide for @operation-epic-fury-report.md');
  const startRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/agent\/runs(?:\?|$)/.test(response.url()),
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('use frontend-slide skill, build the presentation slide for @operation-epic-fury-report.md')).toBeVisible();
  const runResponse = await startRunResponse;
  console.log(`[start-run-body] ${await runResponse.text()}`);

  // The desired blocked state is a clarification pause, not a plan approval card.
  await expect
    .poll(
      async () => {
        const purposeQuestionCount = await page.getByText(/Purpose: What is this presentation for\?/i).count();
        const discoveryTitleCount = await page.getByText(/Presentation Discovery|File Not Found/i).count();
        const continueCount = await page.getByRole('button', { name: 'Continue' }).count();
        return (
          (continueCount > 0 && discoveryTitleCount > 0) ||
          (continueCount > 0 && purposeQuestionCount > 0)
        );
      },
      { timeout: 120_000, message: 'expected clarification UI to appear' },
    )
    .toBe(true);

  await expect(page.getByText(/Review Research Strategy/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  await expect(page.getByText('Generating...')).toHaveCount(0, { timeout: 30_000 });
});
