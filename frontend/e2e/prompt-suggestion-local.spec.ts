import { test, expect } from '@playwright/test';

test('grey follow-up hints start after a reply, stay out of drafts, and work on desktop and mobile', async ({ page, baseURL }, info) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await page.setViewportSize({ width: 1440, height: 950 });
  const workspace = { id: '11111111-1111-4111-8111-111111111111', name: 'Prompt suggestions', role: 'owner', visibility: 'private', workspaceType: 'private', status: 'active', createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z', contentRevision: 1 };
  const conversation = { id: '22222222-2222-4222-8222-222222222222', workspaceId: workspace.id, persona: 'fast', title: 'Simplify the document toolbar', createdAt: workspace.createdAt, updatedAt: workspace.updatedAt };
  const messages = [
    { id: 1, conversationId: conversation.id, sender: 'user', text: 'How can we simplify this document toolbar?', createdAt: workspace.createdAt },
    { id: 2, conversationId: conversation.id, sender: 'agent', text: 'Put Annotate and Comments beside Copy and Print as icon buttons. Keep tooltips and a small comment badge.', createdAt: workspace.createdAt, metadata: { status: 'completed' } },
  ];
  const suggestion = 'Show me the simplified toolbar with Annotate and Comments beside Copy and Print.';
  const requests: unknown[] = []; let runs = 0;
  await page.addInitScript(() => localStorage.setItem('helpudoc-color-mode', 'dark'));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    let json: unknown = {};
    if (path === '/api/auth/me') json = { authenticated: true, authMode: 'hybrid', googleConfigured: true, user: { userId: workspace.id, externalId: 'fixture', displayName: 'Tester', isAdmin: false } };
    else if (path === '/api/workspaces') json = [workspace];
    else if (path === `/api/workspaces/${workspace.id}`) json = workspace;
    else if (path.endsWith('/conversations')) json = [conversation];
    else if (path === `/api/conversations/${conversation.id}`) json = { conversation, messages };
    else if (path === '/api/agent/prompt-suggestion') { requests.push(request.postDataJSON()); json = { suggestion }; }
    else if (path === '/api/agent/runs') { runs++; return route.fulfill({ status: 500, headers, json: { error: 'Must not run from a hint' } }); }
    else if (path.endsWith('/slash-metadata')) json = { skills: [], mcpServers: [], plugins: [] };
    else if (path.endsWith('/notifications')) json = { notifications: [], unreadCount: 0 };
    else if (path.endsWith('/files') || path.endsWith('/recent') || path.endsWith('/knowledge')) json = [];
    else if (path.endsWith('/folders')) json = { folders: [] };
    else if (path.endsWith('/schedules')) json = { schedules: [] };
    return route.fulfill({ headers, json });
  });
  await page.goto('/');
  await expect(page.getByPlaceholder('Ask Lumo anything…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use suggested prompt' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Suggested follow-up', exact: true })).toHaveCount(0);
  const starters = page.getByRole('group', { name: 'Starter prompts', exact: true });
  await expect(starters.getByRole('button')).toHaveCount(4);
  await page.screenshot({ path: info.outputPath('starter-chips-main-page.png'), fullPage: true });
  await starters.getByRole('button', { name: 'Draft a proposal', exact: true }).click();
  await expect(page.getByPlaceholder('Ask Lumo anything…')).toHaveValue(/Help me draft a proposal/);
  await expect(starters).toHaveCount(0);
  expect(runs).toBe(0);
  await page.getByPlaceholder('Ask Lumo anything…').fill('');
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Select workspace', exact: true }).click();
  await page.getByRole('button', { name: workspace.name, exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message Lumo', exact: true });
  await expect(input).toHaveAttribute('placeholder', suggestion);
  await expect(input).toHaveValue('');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ messages: [{ role: 'user' }, { role: 'assistant' }] });
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await input.focus();
  await page.screenshot({ path: info.outputPath('follow-up-hint-desktop.png'), fullPage: true });
  await input.press('Tab');
  await expect(input).toHaveValue(suggestion);
  expect(runs).toBe(0);
  await input.fill('My own follow-up');
  await expect(page.getByRole('button', { name: 'Use suggested prompt' })).toHaveCount(0);
  await input.fill('');
  await expect(input).toHaveAttribute('placeholder', suggestion);
  await page.getByRole('button', { name: 'Go to landing page', exact: true }).click();
  const mainInput = page.getByPlaceholder('Ask Lumo anything…');
  const chip = starters.getByRole('button', { name: 'Analyze data', exact: true });
  await expect(starters.getByRole('button')).toHaveCount(4);
  await expect(mainInput).toHaveValue('');
  await chip.click();
  await expect(mainInput).toHaveValue(/Help me analyze a dataset/);
  await expect(chip).toHaveCount(0);
  expect(runs).toBe(0);
  expect(requests).toHaveLength(1);
  await mainInput.fill('');
  await page.getByRole('button', { name: 'Select workspace', exact: true }).click();
  await page.getByRole('button', { name: workspace.name, exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(input).toHaveAttribute('placeholder', suggestion);
  await page.screenshot({ path: info.outputPath('follow-up-hint-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Use suggested prompt', exact: true }).click();
  await expect(input).toHaveValue(suggestion);
  expect(runs).toBe(0);
});

test('workspace starter chips follow selection, ignore late responses, and fall back when Lite is unavailable', async ({ page, baseURL }, info) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await page.setViewportSize({ width: 1440, height: 950 });
  const workspaces = ['Client proposal', 'Sales analysis', 'Research planning'].map((name, i) => ({
    id: `${i + 1}${'1'.repeat(7)}-1111-4111-8111-111111111111`, name, role: 'owner', canEdit: true,
    visibility: 'private', workspaceType: 'private', status: 'active', contentRevision: 1,
    createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z',
  }));
  const prompts = [
    [{ label: 'Review client scope', prompt: 'Review the proposal scope and identify unclear deliverables.' }, { label: 'Draft client summary', prompt: 'Draft a client proposal summary for review.' }],
    [{ label: 'Explore sales trends', prompt: 'Analyze the sales dataset and summarize the main trends.' }, { label: 'Check sales data quality', prompt: 'Check the sales dataset for missing and inconsistent values.' }],
  ];
  const requests: string[] = []; let runs = 0, firstDelivered = false;
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.addInitScript(() => localStorage.setItem('helpudoc-color-mode', 'dark'));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    let json: unknown = {};
    if (path === '/api/auth/me') json = { authenticated: true, authMode: 'hybrid', googleConfigured: true, user: { userId: workspaces[0].id, externalId: 'fixture', displayName: 'Tester', isAdmin: false } };
    else if (path === '/api/workspaces') json = workspaces;
    else if (path === '/api/agent/workspace-starter-prompts') {
      const body = request.postDataJSON();
      expect(Object.keys(body)).toEqual(['workspaceId']);
      requests.push(body.workspaceId);
      const index = workspaces.findIndex(item => item.id === body.workspaceId);
      if (index === 2) return route.fulfill({ status: 503, headers, json: { error: 'Lite unavailable' } });
      if (index === 0) {
        await firstGate;
        await route.fulfill({ headers, json: { prompts: prompts[0] } }).catch(() => undefined);
        firstDelivered = true;
        return;
      }
      json = { prompts: prompts[index] };
    } else if (path === '/api/agent/runs') { runs++; json = {}; }
    else if (path.endsWith('/slash-metadata')) json = { skills: [], mcpServers: [], plugins: [] };
    else if (path.endsWith('/notifications')) json = { notifications: [], unreadCount: 0 };
    else if (path.endsWith('/conversations') || path.endsWith('/files') || path.endsWith('/recent') || path.endsWith('/knowledge')) json = [];
    else if (path.endsWith('/folders')) json = { folders: [] };
    else if (path.endsWith('/schedules')) json = { schedules: [] };
    else json = workspaces.find(item => path.endsWith(item.id)) || {};
    return route.fulfill({ headers, json });
  });
  await page.goto('/');
  const starters = page.getByRole('group', { name: 'Starter prompts', exact: true });
  await expect(starters.getByRole('button', { name: 'Draft a proposal', exact: true })).toBeVisible();
  expect(requests).toHaveLength(0);
  const select = async (index: number) => {
    await page.getByRole('button', { name: 'Select workspace', exact: true }).click();
    await page.getByRole('button', { name: workspaces[index].name, exact: true }).click();
  };
  await select(0);
  await expect.poll(() => requests.includes(workspaces[0].id)).toBe(true);
  await select(1);
  const salesChip = starters.getByRole('button', { name: 'Explore sales trends', exact: true });
  await expect(salesChip).toBeVisible();
  releaseFirst();
  await expect.poll(() => firstDelivered).toBe(true);
  await expect(salesChip).toBeVisible();
  await expect(starters.getByRole('button', { name: 'Review client scope', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('workspace-specific-starter-chips.png'), fullPage: true });
  await salesChip.click();
  await expect(page.getByPlaceholder('Ask Lumo anything…')).toHaveValue(prompts[1][0].prompt);
  expect(runs).toBe(0);
  await page.getByPlaceholder('Ask Lumo anything…').fill('');
  await select(2);
  await expect.poll(() => requests.includes(workspaces[2].id)).toBe(true);
  await expect(starters.getByRole('button', { name: 'Draft a proposal', exact: true })).toBeVisible();
  await expect(salesChip).toHaveCount(0);
});
