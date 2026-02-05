import { expect, test } from '@playwright/test';

test('does not generate localhost:9000 public URLs (no mixed content)', async ({ page, baseURL }) => {
  const resolvedBaseUrl = baseURL || 'https://lc-demo.com';

  const badRequestUrls: string[] = [];
  const badConsoleMessages: string[] = [];

  page.on('request', (req) => {
    if (req.url().startsWith('http://localhost:9000')) {
      badRequestUrls.push(req.url());
    }
  });

  page.on('requestfailed', (req) => {
    if (req.url().startsWith('http://localhost:9000')) {
      badRequestUrls.push(`${req.url()} (FAILED: ${req.failure()?.errorText || 'unknown'})`);
    }
  });

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('localhost:9000') || text.includes('Mixed Content')) {
      badConsoleMessages.push(`${msg.type()}: ${text}`);
    }
  });

  page.on('pageerror', (err) => {
    const text = String(err);
    if (text.includes('localhost:9000') || text.includes('Mixed Content')) {
      badConsoleMessages.push(`pageerror: ${text}`);
    }
  });

  await page.addInitScript((payload) => {
    window.localStorage.setItem('helpudoc-auth-user', JSON.stringify(payload));
  }, {
    id: 'local-e2e',
    name: 'E2E User',
    email: 'e2e@example.com',
    provider: 'local',
  });

  // Create a disposable workspace so we can validate the backend-generated publicUrl.
  const workspaceName = `e2e-${Date.now()}`;
  const createWs = await page.request.post('/api/workspaces', { data: { name: workspaceName } });
  expect(createWs.status(), await createWs.text()).toBe(201);
  const workspace = await createWs.json();
  const workspaceId: string | undefined = workspace?.id;
  expect(workspaceId).toBeTruthy();

  try {
    const fileName = 'presentations/e2e-slide.jpg';
    const jpgBytes = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wCEAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
      'base64',
    );
    const upload = await page.request.post(`/api/workspaces/${workspaceId}/files`, {
      multipart: {
        file: {
          name: fileName,
          mimeType: 'image/jpeg',
          buffer: jpgBytes,
        },
      },
    });

    expect(upload.status(), await upload.text()).toBe(201);
    const createdFile = await upload.json();
    const publicUrl: string | undefined = createdFile?.publicUrl || createdFile?.public_url;
    expect(publicUrl, `Missing publicUrl in response: ${JSON.stringify(createdFile)}`).toBeTruthy();

    expect(publicUrl).not.toContain('localhost:9000');
    expect(publicUrl).not.toMatch(/^http:\/\//);

    await page.goto(resolvedBaseUrl, { waitUntil: 'domcontentloaded' });

    // Open workspace list and select our workspace (create via UI to ensure list refreshes).
    await page.getByRole('button').first().click();
    await page.getByPlaceholder('New workspace').fill(workspaceName);
    await page.getByRole('button', { name: /^Create$/ }).click();
    await page.getByRole('button', { name: new RegExp(workspaceName) }).click();

    // Click the media file in the file pane (displayed by basename).
    await page.getByText('e2e-slide.jpg', { exact: true }).click();

    const img = page.locator('img[alt="e2e-slide.jpg"]');
    await expect(img).toBeVisible();
    const imgSrc = await img.getAttribute('src');
    expect(imgSrc, 'Image src is missing after selecting media file').toBeTruthy();
    expect(imgSrc || '').not.toContain('localhost:9000');

    expect(badRequestUrls, `Unexpected requests to localhost:9000\\n${badRequestUrls.join('\\n')}`).toEqual([]);
    expect(badConsoleMessages, `Unexpected console/page errors mentioning localhost:9000 or Mixed Content\\n${badConsoleMessages.join('\\n')}`).toEqual([]);
  } finally {
    try {
      await page.request.delete(`/api/workspaces/${workspaceId}`, { timeout: 5000 });
    } catch (error) {
      console.warn('Failed to delete e2e workspace (continuing):', error);
    }
  }
});
