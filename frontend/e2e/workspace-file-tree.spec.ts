import { expect, test, type APIRequestContext } from '@playwright/test';

test.setTimeout(120_000);

const E2E_USER = {
  id: 'local-e2e',
  name: 'E2E User',
  email: 'e2e@example.com',
  provider: 'local',
};

const E2E_AUTH_HEADERS = {
  'X-User-Id': E2E_USER.id,
  'X-User-Name': E2E_USER.name,
  'X-User-Email': E2E_USER.email,
};

const createNestedTextFile = async (
  request: APIRequestContext,
  workspaceId: string,
  name: string,
  content: string,
  mimeType = 'text/markdown',
) => {
  const response = await request.post(`/api/workspaces/${workspaceId}/files/text`, {
    headers: E2E_AUTH_HEADERS,
    data: { name, content, mimeType },
  });
  expect(response.status(), await response.text()).toBe(201);
};

test('workspace file tree shows hierarchy and moves files between folders', async ({ page, baseURL }) => {
  const resolvedBaseUrl = baseURL || 'https://lc-demo.com';
  const workspaceName = `tree-${Date.now()}`;

  await page.addInitScript((payload) => {
    window.localStorage.setItem('helpudoc-auth-user', JSON.stringify(payload));
  }, E2E_USER);

  const createWs = await page.request.post('/api/workspaces', {
    headers: E2E_AUTH_HEADERS,
    data: { name: workspaceName },
  });
  expect(createWs.status(), await createWs.text()).toBe(201);
  const workspace = await createWs.json();
  const workspaceId: string | undefined = workspace?.id;
  expect(workspaceId).toBeTruthy();

  try {
    await createNestedTextFile(page.request, workspaceId!, 'docs/alpha.md', '# Alpha\n');
    await createNestedTextFile(page.request, workspaceId!, 'docs/reports/beta.md', '# Beta\n');
    await createNestedTextFile(page.request, workspaceId!, 'root-note.md', '# Root\n');

    await page.goto(resolvedBaseUrl, { waitUntil: 'domcontentloaded' });

    await page.getByRole('button').first().click();
    await page.getByPlaceholder('Search workspaces').fill(workspaceName);
    await page.getByRole('button', { name: new RegExp(`${workspaceName} Last used`) }).click();

    await expect(page.getByText('docs', { exact: true })).toBeVisible();
    await expect(page.getByText('reports', { exact: true })).toBeVisible();
    await expect(page.getByText('alpha.md', { exact: true })).toBeVisible();
    await expect(page.getByText('beta.md', { exact: true })).toBeVisible();

    const alphaRow = page.getByTitle('docs/alpha.md');
    await alphaRow.getByText('alpha.md', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'alpha.md' })).toBeVisible();

    await alphaRow.dragTo(page.locator('[title="docs/reports"]').first());

    await expect(page.getByTitle('docs/reports/alpha.md')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'alpha.md' })).toBeVisible();
  } finally {
    try {
      await page.request.delete(`/api/workspaces/${workspaceId}`, {
        headers: E2E_AUTH_HEADERS,
        timeout: 5_000,
      });
    } catch (error) {
      console.warn('Failed to delete e2e workspace (continuing):', error);
    }
  }
});
