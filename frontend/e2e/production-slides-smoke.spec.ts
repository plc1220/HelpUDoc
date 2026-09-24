import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';

test.skip(
  process.env.RUN_PRODUCTION_SLIDES_E2E !== '1',
  'Set RUN_PRODUCTION_SLIDES_E2E=1 and provide E2E_STORAGE_STATE or E2E_SESSION_COOKIE.',
);
test.setTimeout(900_000);

type RunMeta = {
  status?: string;
  error?: string;
  pendingInterrupt?: {
    interactionRequest?: { gateId?: string };
    displayPayload?: { gateId?: string };
  };
};

type WorkspaceFile = {
  id: number;
  name: string;
  mimeType?: string;
};

type StreamEvent = {
  type?: string;
  name?: string;
};

const delay = (milliseconds: number) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const gateIdFor = (meta: RunMeta) => (
  meta.pendingInterrupt?.interactionRequest?.gateId
  || meta.pendingInterrupt?.displayPayload?.gateId
  || ''
);

const fetchRun = async (api: APIRequestContext, runId: string): Promise<RunMeta> => {
  const response = await api.get(`/api/agent/runs/${runId}`);
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<RunMeta>;
};

const waitForRun = async (
  api: APIRequestContext,
  runId: string,
  predicate: (meta: RunMeta) => boolean,
  timeoutMs: number,
  description: string,
) => {
  const deadline = Date.now() + timeoutMs;
  let latest: RunMeta = {};
  let lastSignature = '';
  while (Date.now() < deadline) {
    latest = await fetchRun(api, runId);
    const signature = `${latest.status || 'unknown'}:${gateIdFor(latest)}`;
    if (signature !== lastSignature) {
      console.log(`[production-slides] ${description}: ${signature}`);
      lastSignature = signature;
    }
    if (latest.status === 'failed' || latest.status === 'cancelled') {
      throw new Error(`${description}: run ${runId} ${latest.status}: ${latest.error || 'unknown error'}`);
    }
    if (predicate(latest)) return latest;
    await delay(2_000);
  }
  throw new Error(`${description}: timed out with run ${runId} in ${latest.status || 'unknown'}`);
};

const composerFor = (page: Page) => page.locator(
  'textarea[placeholder*="Ask Lumo"], textarea[placeholder*="Ask anything"], textarea[placeholder="Ask HelpUDoc anything..."], textarea[placeholder*="Interact with the agent"]',
).first();

test('authenticated production user can choose a style and generate an HTML deck', async ({
  context,
  page,
  baseURL,
}, testInfo: TestInfo) => {
  const resolvedBaseUrl = baseURL || 'https://lc-demo.com';
  const sessionCookie = process.env.E2E_SESSION_COOKIE;
  const storageState = process.env.E2E_STORAGE_STATE;
  test.skip(!sessionCookie && !storageState, 'Provide E2E_STORAGE_STATE or E2E_SESSION_COOKIE.');

  if (sessionCookie) {
    const origin = new URL(resolvedBaseUrl);
    await context.addCookies([{
      name: 'helpudoc.sid',
      value: sessionCookie,
      domain: origin.hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: origin.protocol === 'https:',
    }]);
  }

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(resolvedBaseUrl, { waitUntil: 'domcontentloaded' });
  const api = page.request;
  const authResponse = await api.get('/api/auth/me');
  expect(authResponse.status(), await authResponse.text()).toBe(200);
  const auth = await authResponse.json() as {
    authenticated?: boolean;
    authMode?: string;
    user?: { email?: string };
  };
  expect(auth.authenticated, 'The saved QA session has expired.').toBe(true);
  expect(['oidc', 'hybrid']).toContain(auth.authMode);

  const marker = Date.now();
  const workspaceName = `production-slides-qc-${marker}`;
  let workspaceId: string | undefined;
  let runId: string | undefined;
  const evidence: Record<string, unknown> = {
    baseURL: resolvedBaseUrl,
    workspaceName,
    authenticatedAs: auth.user?.email || 'unknown',
    startedAt: new Date().toISOString(),
  };

  try {
    const createWorkspace = await api.post('/api/workspaces', {
      data: { name: workspaceName },
    });
    expect(createWorkspace.status(), await createWorkspace.text()).toBe(201);
    workspaceId = ((await createWorkspace.json()) as { id?: string }).id;
    expect(workspaceId).toBeTruthy();

    const createBrief = await api.post(`/api/workspaces/${workspaceId}/files/text`, {
      data: {
        name: 'production-qc-brief.md',
        mimeType: 'text/markdown',
        content: [
          '# Production Slide QC',
          '',
          'Create a concise three-slide presentation for an engineering review.',
          '',
          '## Required slides',
          '1. Objective: reliable slide generation',
          '2. Validation: interaction gates, readable previews, and clean progress',
          '3. Outcome: a browser-native HTML deck',
        ].join('\n'),
      },
    });
    expect(createBrief.status(), await createBrief.text()).toBe(201);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Select workspace' }).click();
    await page.getByPlaceholder('Search workspaces').last().fill(workspaceName);
    await page.getByRole('button', { name: new RegExp(`^${workspaceName}$`) }).click();

    const composer = composerFor(page);
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.fill(
      '/skill frontend-slides Create a concise browser-native HTML presentation from @production-qc-brief.md. Do not export PowerPoint.',
    );
    const runResponsePromise = page.waitForResponse(
      (response) => response.request().method() === 'POST'
        && /\/api\/agent\/runs(?:\?|$)/.test(response.url()),
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: /^Send(?: message)?$/ }).last().click();
    const runResponse = await runResponsePromise;
    expect(runResponse.status(), await runResponse.text()).toBe(200);
    runId = ((await runResponse.json()) as { runId?: string }).runId;
    expect(runId).toBeTruthy();
    evidence.runId = runId;

    await waitForRun(
      api,
      runId!,
      (meta) => meta.status === 'awaiting_approval' && gateIdFor(meta) === 'presentation_context',
      180_000,
      'deck-mode gate',
    );
    await expect(page.getByText(/presented live or read on its own|speaker-led or reading-first/i)).toBeVisible();
    await page.getByRole('button', { name: /speaker-led/i }).last().click();
    await page.getByRole('button', { name: 'Continue', exact: true }).last().click();

    await waitForRun(
      api,
      runId!,
      (meta) => meta.status === 'awaiting_approval' && gateIdFor(meta) === 'style_preview_selection',
      300_000,
      'style-preview gate',
    );

    const styleCard = page.getByRole('button', { name: 'Use selected style', exact: true })
      .last()
      .locator('xpath=ancestor::article[1]');
    await expect(styleCard).toBeVisible({ timeout: 30_000 });
    const previewFrames = styleCard.locator('iframe[title$="preview"]');
    expect(await previewFrames.count()).toBeGreaterThanOrEqual(3);
    for (const frame of await previewFrames.all()) {
      await expect(frame).toBeVisible();
      await expect(frame).toHaveAttribute('srcdoc', /<!doctype html|<html/i);
      await expect(frame).not.toHaveAttribute('src', /\/files\/preview\/raw/);
      await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);
    }
    const styleChoices = styleCard.locator('li button');
    expect(await styleChoices.count()).toBeGreaterThanOrEqual(3);
    const styleChoiceText = await styleChoices.allTextContents();
    evidence.styleChoices = styleChoiceText;
    await testInfo.attach('style-chooser.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    await styleChoices.first().click();
    const useSelectedStyle = page.getByRole('button', { name: 'Use selected style', exact: true }).last();
    await expect(useSelectedStyle).toBeEnabled();
    await useSelectedStyle.click();

    await waitForRun(
      api,
      runId!,
      (meta) => meta.status === 'completed',
      480_000,
      'HTML deck completion',
    );

    const filesResponse = await api.get(`/api/workspaces/${workspaceId}/files`);
    expect(filesResponse.status(), await filesResponse.text()).toBe(200);
    const files = await filesResponse.json() as WorkspaceFile[];
    const deck = files.find((file) => (
      /\.html?$/i.test(file.name)
      && !file.name.startsWith('.frontend-slides/')
      && !/^(?:style|preview)[-_]?[a-z0-9-]*\.html?$/i.test(file.name.split('/').pop() || '')
    ));
    expect(deck, files.map((file) => file.name).join(', ')).toBeTruthy();
    const contentResponse = await api.get(
      `/api/workspaces/${workspaceId}/files/${deck!.id}/content`,
    );
    expect(contentResponse.status(), await contentResponse.text()).toBe(200);
    const deckContent = String(((await contentResponse.json()) as { content?: string }).content || '');
    expect(deckContent).toMatch(/<!doctype html|<html/i);
    expect(deckContent).toMatch(/class=["'][^"']*slide/i);
    const slideCount = (deckContent.match(/class=["'][^"']*\bslide\b/gi) || []).length;
    expect(slideCount).toBeGreaterThanOrEqual(3);
    evidence.deck = { name: deck!.name, bytes: Buffer.byteLength(deckContent), slideCount };

    const streamResponse = await api.get(`/api/agent/runs/${runId}/stream?after=0-0`);
    expect(streamResponse.status(), await streamResponse.text()).toBe(200);
    const events = (await streamResponse.text())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StreamEvent);
    const toolStarts = events.filter((event) => event.type === 'tool_start');
    expect(events.filter((event) => event.type === 'tool_error')).toHaveLength(0);
    expect(toolStarts.filter((event) => /export-pptx/i.test(event.name || ''))).toHaveLength(0);
    evidence.toolStarts = toolStarts.map((event) => event.name).filter(Boolean);
    evidence.consoleErrors = consoleErrors;
    evidence.pageErrors = pageErrors;
    expect(pageErrors).toEqual([]);

    await testInfo.attach('production-slides-evidence.json', {
      body: Buffer.from(JSON.stringify(evidence, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    if (workspaceId) {
      await api.delete(`/api/workspaces/${workspaceId}`).catch(() => undefined);
    }
  }
});
