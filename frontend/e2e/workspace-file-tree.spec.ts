import { expect, test, type APIRequestContext } from '@playwright/test';

test.setTimeout(120_000);

const E2E_USER = {
  id: 'local-e2e',
  name: 'E2E User',
  email: 'e2e@example.com',
  provider: 'local',
};

const uploadNestedFile = async (
  request: APIRequestContext,
  workspaceId: string,
  name: string,
  content: string,
  mimeType = 'text/markdown',
) => {
  const response = await request.post(`/api/workspaces/${workspaceId}/files`, {
    multipart: {
      file: {
        name,
        mimeType,
        buffer: Buffer.from(content, 'utf-8'),
      },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
};

test('workspace file tree shows hierarchy and moves files between folders', async ({ page, baseURL }) => {
  const resolvedBaseUrl = baseURL || 'https://lc-demo.com';
  const workspaceName = `tree-${Date.now()}`;

  await page.addInitScript((payload) => {
    window.localStorage.setItem('helpudoc-auth-user', JSON.stringify(payload));
  }, E2E_USER);

  const createWs = await page.request.post('/api/workspaces', { data: { name: workspaceName } });
  expect(createWs.status(), await createWs.text()).toBe(201);
  const workspace = await createWs.json();
  const workspaceId: string | undefined = workspace?.id;
  expect(workspaceId).toBeTruthy();

  try {
    await uploadNestedFile(page.request, workspaceId!, 'docs/alpha.md', '# Alpha\n');
    await uploadNestedFile(page.request, workspaceId!, 'docs/reports/beta.md', '# Beta\n');
    await uploadNestedFile(page.request, workspaceId!, 'root-note.md', '# Root\n');

    await page.goto(resolvedBaseUrl, { waitUntil: 'domcontentloaded' });

    await page.getByRole('button').first().click();
    await page.getByPlaceholder('Search workspaces').fill(workspaceName);
    await page.getByRole('button', { name: new RegExp(workspaceName) }).click();

    await expect(page.getByText('docs', { exact: true })).toBeVisible();
    await expect(page.getByText('reports', { exact: true })).toBeVisible();
    await expect(page.getByText('alpha.md', { exact: true })).toBeVisible();
    await expect(page.getByText('beta.md', { exact: true })).toBeVisible();

    const alphaRow = page.getByTitle('docs/alpha.md');
    await alphaRow.getByText('alpha.md', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'docs/alpha.md' })).toBeVisible();

    await alphaRow.hover();
    await page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('prompt');
      await dialog.accept('archive');
    });
    await alphaRow.getByRole('button', { name: 'Move' }).click();

    await expect(page.getByText('archive', { exact: true })).toBeVisible();
    await expect(page.getByTitle('archive/alpha.md')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'archive/alpha.md' })).toBeVisible();
  } finally {
    try {
      await page.request.delete(`/api/workspaces/${workspaceId}`, { timeout: 5_000 });
    } catch (error) {
      console.warn('Failed to delete e2e workspace (continuing):', error);
    }
  }
});
