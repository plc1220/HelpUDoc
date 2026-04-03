import { expect, test } from '@playwright/test';

test.setTimeout(150_000);

const E2E_USER = {
  id: 'admin-local',
  name: 'Admin',
  email: 'admin@local.com',
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

test('frontend-slides uses a paginated clarification wizard and submits structured answers', async ({ page, baseURL }) => {
  const resolvedBaseUrl = baseURL || 'https://lc-demo.com';
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

  // Open the workspace drawer if it is collapsed.
  const filesPanel = page.getByText('Files', { exact: true });
  if (!(await filesPanel.isVisible().catch(() => false))) {
    await page.getByRole('button').first().click();
  }

  // Create and auto-select a disposable workspace.
  await page.getByRole('button', { name: /^Create$/i }).click();
  await page.getByRole('button').first().click();

  // Upload the source markdown through the workspace file input.
  await page.locator('#file-upload').setInputFiles({
    name: 'operation-epic-fury-report.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(REPORT_CONTENT, 'utf-8'),
  });
  await expect(page.getByText('operation-epic-fury-report.md', { exact: true })).toBeVisible();

  // Trigger the frontend-slides flow using a tagged workspace file.
  const composer = page.locator('textarea[placeholder*="Interact with the agent..."]');
  await expect(composer).toBeVisible();
  await composer.fill('/skill frontend-slides @operation-epic-fury-report.md');
  const startRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/agent\/runs(?:\?|$)/.test(response.url()),
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('/skill frontend-slides @operation-epic-fury-report.md')).toBeVisible();
  const runResponse = await startRunResponse;
  console.log(`[start-run-body] ${await runResponse.text()}`);

  // The desired blocked state is a clarification pause, not a plan approval card.
  await expect
    .poll(
      async () => {
        const purposeQuestionCount = await page.getByText(/What is this presentation for\?/i).count();
        const pitchDeckOptionCount = await page.getByRole('button', { name: /Pitch deck/i }).count();
        const discoveryTitleCount = await page.getByText(/Presentation Discovery|Presentation Context|File Not Found/i).count();
        const questionStepCount = await page.getByText(/Question 1 of 5/i).count();
        return (
          (questionStepCount > 0 && discoveryTitleCount > 0 && pitchDeckOptionCount > 0) ||
          (questionStepCount > 0 && purposeQuestionCount > 0 && pitchDeckOptionCount > 0)
        );
      },
      { timeout: 120_000, message: 'expected clarification UI to appear' },
    )
    .toBe(true);

  await expect(page.getByText(/Review Research Strategy/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  await expect(page.getByText('Generating...')).toHaveCount(0, { timeout: 30_000 });

  await page.getByRole('button', { name: /Pitch deck/i }).click();
  await page.getByRole('button', { name: /Next/i }).click();
  await expect(page.getByText(/Question 2 of 5/i)).toBeVisible();

  await page.getByRole('button', { name: /Medium \(10-20\)/i }).click();
  await page.getByRole('button', { name: /Next/i }).click();
  await expect(page.getByText(/Question 3 of 5/i)).toBeVisible();

  await page.getByRole('button', { name: /Rough notes/i }).click();
  await page.getByRole('button', { name: /Next/i }).click();
  await expect(page.getByText(/Question 4 of 5/i)).toBeVisible();

  await page.getByRole('button', { name: /Use \.\/assets/i }).click();
  await page.getByRole('button', { name: /Next/i }).click();
  await expect(page.getByText(/Question 5 of 5/i)).toBeVisible();

  await page.getByRole('button', { name: /^Yes \(Recommended\)$/i }).click();

  const respondRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      /\/api\/agent\/runs\/[^/]+\/respond(?:\?|$)/.test(request.url()),
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: /Review answers/i }).click();
  await expect(page.getByText(/Review/i)).toBeVisible();
  await page.locator('textarea').last().fill('Keep it bold, fast-paced, and visually modern.');
  await page.getByRole('button', { name: /Continue|Start Designing/i }).click();

  const respondRequest = await respondRequestPromise;
  const respondPayload = respondRequest.postDataJSON() as {
    message?: string;
    answersByQuestionId?: Record<string, string>;
  };

  expect(respondPayload.answersByQuestionId).toMatchObject({
    purpose: 'Pitch deck',
    length: 'Medium (10-20)',
    content: 'I have rough notes',
    images: './assets',
    editing: 'Yes',
  });
  expect(respondPayload.message || '').toContain('Purpose: Pitch deck');
  expect(respondPayload.message || '').toContain('Notes: Keep it bold, fast-paced, and visually modern.');
  await expect(page.getByText(/What is this presentation for\?/i)).toHaveCount(0, { timeout: 15_000 });
});
