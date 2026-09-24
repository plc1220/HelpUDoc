import { expect, request, test } from '@playwright/test';

// Explicitly opt-in: real local backend/agent/model, dedicated disposable test data.
test.skip(process.env.RUN_LOCAL_SLIDE_QC !== '1', 'Set RUN_LOCAL_SLIDE_QC=1 for live local QC.');
test.setTimeout(600_000);

test('live local style preview protects the source, applies, undoes and continues an agent edit', async ({ page, baseURL }, info) => {
  expect(baseURL).toMatch(/^http:\/\/(?:127\.0\.0\.1|localhost):5179$/);
  page.setDefaultTimeout(20_000);
  const apiURL = 'http://127.0.0.1:3008';
  const stamp = Date.now();
  const user = { id: `slide-style-qc-${stamp}`, name: 'Slide Style QC', email: `slide-style-qc-${stamp}@local.test`, provider: 'local' };
  const headers = { 'X-User-Id': user.id, 'X-User-Name': user.name, 'X-User-Email': user.email };
  const api = await request.newContext({ baseURL: apiURL, extraHTTPHeaders: headers });
  const admin = await request.newContext({ baseURL: apiURL, extraHTTPHeaders: { 'X-User-Id': 'admin-local', 'X-User-Name': 'Admin', 'X-User-Email': 'admin@local.com' } });
  const errors: string[] = []; const runs: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400 && response.url().includes('/api/')) console.log('HTTP failure', response.status(), new URL(response.url()).pathname); });
  const auth = await (await api.get('/api/auth/me')).json();
  expect(auth.authMode).toBe('headers'); expect(auth.user.isAdmin).toBe(false);
  const groupResponse = await admin.post('/api/users/groups', { data: { name: `Slide Style QC ${stamp}` } });
  expect(groupResponse.status(), await groupResponse.text()).toBe(201);
  const group = (await groupResponse.json()).group;
  expect((await admin.put(`/api/users/groups/${group.id}/access`, { data: { skillIds: ['frontend-slides'], mcpServerIds: [] } })).ok()).toBe(true);
  expect((await admin.post(`/api/users/groups/${group.id}/members`, { data: { userId: auth.user.userId } })).ok()).toBe(true);
  const workspaceName = `Slide Style QC ${stamp}`;
  const workspace = await (await api.post('/api/workspaces', { data: { name: workspaceName } })).json();
  expect(workspace.id).toBeTruthy(); console.log('QC workspace', workspace.id, workspaceName);
  const source = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Roast Room launch</title><style>*{box-sizing:border-box}body{margin:0;background:#171b20;color:#f1eadc;font-family:Arial,sans-serif}.slide{width:100%;aspect-ratio:16/9;padding:7%;display:flex;flex-direction:column;justify-content:center;border-bottom:1px solid #444}h1{font-size:clamp(24px,6vw,100px);margin:0 0 4%}p{font-size:clamp(14px,2.4vw,40px);max-width:85%;line-height:1.5}.label{font-size:14px;color:#b8d393;letter-spacing:.12em}</style></head><body><section class="slide"><span class="label">THE ROAST ROOM / 01</span><h1>A better daily ritual</h1><p>Great coffee. A welcoming neighborhood space.</p></section><section class="slide"><span class="label">OUR AUDIENCE / 02</span><h1>Made for your everyday</h1><p>Morning regulars, remote workers, and weekend neighbors.</p></section><section class="slide"><span class="label">FIRST 90 DAYS / 03</span><h1>Build a local habit</h1><p>Launch a neighborhood tasting. Introduce weekly rituals. Listen and refine.</p></section></body></html>`;
  const fileResponse = await api.post(`/api/workspaces/${workspace.id}/files/text`, { data: { name: 'launch.html', content: source, mimeType: 'text/html' } });
  expect(fileResponse.status(), await fileResponse.text()).toBe(201);
  const file = await fileResponse.json();
  const conversation = await (await api.post(`/api/workspaces/${workspace.id}/conversations`, { data: { persona: 'fast' } })).json();
  expect(conversation.id).toBeTruthy();
  expect((await api.post(`/api/conversations/${conversation.id}/messages`, { data: { sender: 'agent', text: 'QC fixture: the three-slide HTML deck is available at launch.html.' } })).ok()).toBe(true);
  const read = async () => (await api.get(`/api/workspaces/${workspace.id}/files/${file.id}/content`)).json();
  const baseline = await read();
  const metrics: Record<string, unknown> = { workspaceId: workspace.id, fileId: file.id, groupId: group.id };
  const waitRun = async (runId: string) => {
    let prior = ''; const started = Date.now();
    while (Date.now() - started < 300_000) {
      const meta = await (await api.get(`/api/agent/runs/${runId}`)).json();
      if (meta.status !== prior) { console.log('Run', runId, meta.status); prior = meta.status; }
      if (meta.status === 'completed') return;
      if (['failed', 'cancelled', 'awaiting_approval'].includes(meta.status)) throw new Error(`Run ${meta.status}: ${meta.error || JSON.stringify(meta.pendingInterrupt?.displayPayload || {})}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('Agent run exceeded five minutes.');
  };
  try {
    await page.addInitScript(payload => { if (window === window.top) localStorage.setItem('helpudoc-auth-user', JSON.stringify(payload)); }, user);
    await page.goto(baseURL!);
    console.log('Initial page', page.url());
    await page.screenshot({ path: info.outputPath('live-initial.png') });
    await page.getByRole('button', { name: 'Select workspace' }).click();
    await page.getByPlaceholder('Search workspaces').last().fill(workspaceName);
    await page.getByRole('button', { name: workspaceName, exact: true }).click();
    await page.getByText('launch.html', { exact: true }).first().click();
    await expect(page.getByRole('tab', { name: 'Styles', exact: true })).toBeVisible({ timeout: 30_000 });
    const began = Date.now(); await page.getByRole('tab', { name: 'Styles', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Explore / })).toHaveCount(34);
    metrics.galleryReadyMs = Date.now() - began;
    await page.screenshot({ path: info.outputPath('live-gallery.png') });
    await page.getByRole('searchbox').fill('forest');
    await page.getByRole('button', { name: 'Explore Editorial Forest', exact: true }).click();
    expect((await read()).content).toBe(source);
    const started = Date.now();
    const runResponse = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/agent\/runs$/.test(response.url()));
    await page.getByRole('button', { name: 'Preview on my deck' }).click();
    const response = await runResponse; expect(response.ok(), await response.text()).toBe(true);
    const { runId } = await response.json(); runs.push(runId);
    await waitRun(runId);
    await expect(page.getByRole('button', { name: 'Apply Editorial Forest' })).toBeVisible({ timeout: 30_000 });
    metrics.previewReadyMs = Date.now() - started;
    const unchanged = await read(); expect(unchanged.content).toBe(source); expect(unchanged.version).toBe(baseline.version);
    await page.screenshot({ path: info.outputPath('live-comparison.png') });
    await page.locator('iframe[title="Proposed slide deck"]').scrollIntoViewIfNeeded();
    await expect(page.frameLocator('iframe[title="Proposed slide deck"]').getByText('A better daily ritual', { exact: true })).toBeVisible();
    await page.frameLocator('iframe[title="Proposed slide deck"]').locator('body').evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({ path: info.outputPath('live-proposed.png') });
    await page.getByRole('button', { name: 'Apply Editorial Forest' }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    const applied = await read(); expect(applied.content).not.toBe(source); expect(applied.version).toBeGreaterThan(baseline.version);
    expect(await page.evaluate(html => new DOMParser().parseFromString(html, 'text/html').querySelectorAll('.slide').length, applied.content)).toBe(3);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByText('Previous style restored.', { exact: true })).toBeVisible();
    expect((await read()).content).toBe(source);
    const composer = page.getByRole('textbox', { name: 'Message Lumo' });
    const editStarted = Date.now();
    await composer.fill('Change the title on slide 1 to "Your neighborhood coffee ritual". Keep all other content, slide count and visual style unchanged.');
    const editResponse = page.waitForResponse(res => res.request().method() === 'POST' && /\/api\/agent\/runs$/.test(res.url()));
    await page.getByRole('button', { name: /^Send(?: message)?$/ }).last().click();
    const edit = await (await editResponse).json(); runs.push(edit.runId); await waitRun(edit.runId);
    const edited = await read();
    expect(edited.content).toContain('Your neighborhood coffee ritual');
    const editSummary = await page.evaluate(html => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { titles: [...doc.querySelectorAll('.slide h1')].map(node => node.textContent),
        paragraphs: [...doc.querySelectorAll('.slide p')].map(node => node.textContent),
        slideCount: doc.querySelectorAll('.slide').length };
    }, edited.content);
    expect(editSummary).toEqual({ titles: ['Your neighborhood coffee ritual', 'Made for your everyday', 'Build a local habit'],
      paragraphs: ['Great coffee. A welcoming neighborhood space.', 'Morning regulars, remote workers, and weekend neighbors.', 'Launch a neighborhood tasting. Introduce weekly rituals. Listen and refine.'], slideCount: 3 });
    metrics.editReadyMs = Date.now() - editStarted;
    metrics.editCompleted = true;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'canvas', exact: true }).click();
    await page.getByRole('tab', { name: 'Styles', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Explore / })).toHaveCount(34);
    await page.screenshot({ path: info.outputPath('live-mobile.png') });
    metrics.mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(metrics.mobileOverflow).toBe(false);
    metrics.browserErrors = errors; expect(errors).toEqual([]);
  } finally {
    metrics.runIds = runs; console.log('QC metrics', JSON.stringify(metrics));
    await info.attach('qc-metrics', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
    await api.dispose(); await admin.dispose();
  }
});
