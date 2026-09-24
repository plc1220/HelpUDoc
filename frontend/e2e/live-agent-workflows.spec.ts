import { createHash } from 'node:crypto';

import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';

test.skip(
  process.env.RUN_LIVE_AGENT_E2E !== '1',
  'Set RUN_LIVE_AGENT_E2E=1 to run model-backed local workflow tests.',
);
test.setTimeout(1_800_000);

type LocalAuthUser = {
  id: string;
  name: string;
  email: string;
  provider: 'local';
};

type WorkspaceFile = {
  id: number;
  name: string;
  mimeType?: string;
  version?: number;
  sha256?: string;
};

type RunMeta = {
  status?: string;
  error?: string;
  pendingInterrupt?: {
    kind?: string;
    title?: string;
    interruptId?: string;
    interactionRequest?: {
      presentation?: string;
      gateId?: string;
    };
    displayPayload?: {
      gateId?: string;
    };
  };
};

const ADMIN_USER: LocalAuthUser = {
  id: 'admin-local',
  name: 'Admin',
  email: 'admin@local.com',
  provider: 'local',
};

const authHeadersFor = (user: LocalAuthUser) => ({
  'X-User-Id': user.id,
  'X-User-Name': user.name,
  'X-User-Email': user.email,
});

const delay = (milliseconds: number) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const composerFor = (page: Page): Locator => page
  .locator(
    'textarea[placeholder*="Ask Lumo"], textarea[placeholder*="Ask anything"], textarea[placeholder="Ask HelpUDoc anything..."], textarea[placeholder*="Interact with the agent"]',
  )
  .first();

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
  options: { rejectPlanReview?: boolean } = {},
): Promise<RunMeta> => {
  const deadline = Date.now() + timeoutMs;
  let latest: RunMeta = {};
  let lastSignature = '';
  while (Date.now() < deadline) {
    latest = await fetchRun(api, runId);
    const signature = [
      latest.status || 'unknown',
      latest.pendingInterrupt?.kind || '',
      latest.pendingInterrupt?.interactionRequest?.presentation || '',
      latest.pendingInterrupt?.interactionRequest?.gateId
        || latest.pendingInterrupt?.displayPayload?.gateId
        || '',
    ].join(':');
    if (signature !== lastSignature) {
      console.log(`[live-e2e] ${description}: ${signature}`);
      lastSignature = signature;
    }
    if (latest.status === 'failed' || latest.status === 'cancelled') {
      throw new Error(
        `${description}: run ${runId} ${latest.status}: ${latest.error || JSON.stringify(latest.pendingInterrupt || {})}`,
      );
    }
    if (
      options.rejectPlanReview
      && latest.status === 'awaiting_approval'
      && latest.pendingInterrupt?.interactionRequest?.presentation === 'plan_review'
    ) {
      throw new Error(`${description}: unexpectedly requested an extra plan approval`);
    }
    if (predicate(latest)) {
      return latest;
    }
    await delay(1_500);
  }
  throw new Error(
    `${description}: timed out with run ${runId} in ${latest.status || 'unknown'}: ${JSON.stringify(latest.pendingInterrupt || {})}`,
  );
};

const startSkillRun = async (
  page: Page,
  skillId: string,
  requestText: string,
): Promise<string> => {
  const composer = composerFor(page);
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(composer).toBeEditable({ timeout: 30_000 });
  await composer.fill(`/skill ${skillId} ${requestText}`);
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST'
      && /\/api\/agent\/runs(?:\?|$)/.test(response.url()),
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: /^Send(?: message)?$/ }).last().click();
  const response = await responsePromise;
  const responseText = await response.text();
  expect(response.status(), responseText).toBe(200);
  const payload = JSON.parse(responseText) as { runId?: string };
  expect(payload.runId).toBeTruthy();
  return payload.runId!;
};

const listFiles = async (
  api: APIRequestContext,
  workspaceId: string,
): Promise<WorkspaceFile[]> => {
  const response = await api.get(`/api/workspaces/${workspaceId}/files`);
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<WorkspaceFile[]>;
};

const readTextFile = async (
  api: APIRequestContext,
  workspaceId: string,
  file: WorkspaceFile,
): Promise<string> => {
  const response = await api.get(
    `/api/workspaces/${workspaceId}/files/${file.id}/content`,
  );
  expect(response.status(), await response.text()).toBe(200);
  const payload = (await response.json()) as { content?: string };
  return String(payload.content || '');
};

const readRawFile = async (
  api: APIRequestContext,
  workspaceId: string,
  file: WorkspaceFile,
): Promise<Buffer> => {
  const response = await api.get(
    `/api/workspaces/${workspaceId}/files/preview/raw?path=${encodeURIComponent(file.name)}`,
  );
  expect(response.status(), await response.text()).toBe(200);
  return response.body();
};

const validateImageInBrowser = async (page: Page, body: Buffer) => page.evaluate(
  (base64) => new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('Browser could not decode generated image'));
    image.src = `data:image/png;base64,${base64}`;
  }),
  body.toString('base64'),
);

test('research, create/edit slides, and create/edit images complete locally', async ({
  page,
  baseURL,
}, testInfo: TestInfo) => {
  const resolvedBaseUrl = baseURL || 'http://localhost:5173';
  const testRunId = Date.now();
  const e2eUser: LocalAuthUser = {
    id: `live-workflows-${testRunId}`,
    name: 'Live Workflow E2E',
    email: `live-workflows-${testRunId}@local.test`,
    provider: 'local',
  };
  const workspaceName = `live-workflows-${testRunId}`;
  const evidence: Record<string, unknown> = {
    workspaceName,
    runs: {},
    artifacts: {},
  };
  let adminApi: APIRequestContext | undefined;
  let userApi: APIRequestContext | undefined;
  let workspaceId: string | undefined;
  let groupId: string | undefined;

  try {
    adminApi = await request.newContext({
      baseURL: resolvedBaseUrl,
      extraHTTPHeaders: authHeadersFor(ADMIN_USER),
    });
    userApi = await request.newContext({
      baseURL: resolvedBaseUrl,
      extraHTTPHeaders: authHeadersFor(e2eUser),
    });

    const ensureUser = await userApi.get('/api/auth/me');
    expect(ensureUser.status(), await ensureUser.text()).toBe(200);
    const userSession = (await ensureUser.json()) as { user?: { userId?: string } };
    const userId = userSession.user?.userId;
    expect(userId).toBeTruthy();

    const createGroup = await adminApi.post('/api/users/groups', {
      data: { name: `Live Workflow E2E ${testRunId}` },
    });
    expect(createGroup.status(), await createGroup.text()).toBe(201);
    groupId = ((await createGroup.json()) as { group?: { id?: string } }).group?.id;
    expect(groupId).toBeTruthy();

    const grantSkills = await adminApi.put(`/api/users/groups/${groupId}/access`, {
      data: {
        skillIds: ['research', 'frontend-slides', 'image'],
        mcpServerIds: [],
      },
    });
    expect(grantSkills.status(), await grantSkills.text()).toBe(200);
    const addMember = await adminApi.post(`/api/users/groups/${groupId}/members`, {
      data: { userId },
    });
    expect(addMember.status(), await addMember.text()).toBe(204);

    const createWorkspace = await userApi.post('/api/workspaces', {
      data: { name: workspaceName },
    });
    expect(createWorkspace.status(), await createWorkspace.text()).toBe(201);
    workspaceId = ((await createWorkspace.json()) as { id?: string }).id;
    expect(workspaceId).toBeTruthy();

    const createBrief = await userApi.post(
      `/api/workspaces/${workspaceId}/files/text`,
      {
        data: {
          name: 'e2e-brief.md',
          mimeType: 'text/markdown',
          content: [
            '# Reliable Agent Workflows',
            '',
            'Explain a lightweight agent harness built around skills, a writable private sandbox snapshot,',
            'validated workspace publication, and explicit human gates only where judgment is required.',
            '',
            'Use five concise slides for an engineering audience.',
          ].join('\n'),
        },
      },
    );
    expect(createBrief.status(), await createBrief.text()).toBe(201);

    await page.addInitScript((payload) => {
      window.localStorage.setItem('helpudoc-auth-user', JSON.stringify(payload));
    }, e2eUser);
    await page.goto(resolvedBaseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Select workspace' }).click();
    await page.getByPlaceholder('Search workspaces').last().fill(workspaceName);
    await page.getByRole('button', { name: new RegExp(`^${workspaceName}`) }).click();

    const composer = composerFor(page);
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Commands' }).click();
    await expect(page.getByRole('button', { name: /Research.*\/skill research/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Frontend Slides.*\/skill frontend-slides/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Image.*\/skill image/i })).toBeVisible();
    await page.keyboard.press('Escape');

    const internetToggle = page.getByRole('button', { name: /Internet search off/i });
    if (await internetToggle.count()) {
      await internetToggle.click();
      await expect(page.getByRole('button', { name: /Internet search on/i })).toBeVisible();
    }

    // 1. Research: exercise the plan gate, live search, declared skill script,
    // and full workspace artifact publication.
    const researchRunId = await startSkillRun(
      page,
      'research',
      'Do quick research on the published support lifecycle of Python 3.13. Use primary Python.org sources, produce the required sourced workspace report, and keep the scope narrow.',
    );
    (evidence.runs as Record<string, unknown>).research = researchRunId;
    await waitForRun(
      userApi,
      researchRunId,
      (meta) => meta.status === 'awaiting_approval'
        && meta.pendingInterrupt?.interactionRequest?.presentation === 'plan_review',
      240_000,
      'research plan approval',
    );
    const approveButton = page.getByRole('button', { name: 'Approve', exact: true }).last();
    await expect(approveButton).toBeVisible({ timeout: 30_000 });
    await expect(approveButton).toBeEnabled();
    await testInfo.attach('research-plan-approval.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    // Submit through Playwright's authenticated request context after proving
    // the real approval card and enabled control rendered. This avoids UI
    // animation/overlay flakiness while exercising the same public endpoint.
    const approvalResponse = await userApi.post(
      `/api/agent/runs/${researchRunId}/decision`,
      { data: { decision: 'approve' } },
    );
    expect(approvalResponse.status(), await approvalResponse.text()).toBe(200);
    await waitForRun(
      userApi,
      researchRunId,
      (meta) => meta.status === 'completed',
      600_000,
      'research completion',
    );
    const researchFiles = await listFiles(userApi, workspaceId);
    const reportFile = researchFiles.find((file) => file.name === 'final-research-report.md');
    expect(reportFile, researchFiles.map((file) => file.name).join(', ')).toBeTruthy();
    const reportText = await readTextFile(userApi, workspaceId, reportFile!);
    expect(reportText).toMatch(/## Sources|# Sources/i);
    expect(reportText).toMatch(/## Word Count/i);
    expect(reportText.split(/\s+/).filter(Boolean).length).toBeGreaterThan(700);
    (evidence.artifacts as Record<string, unknown>).research = {
      name: reportFile!.name,
      version: reportFile!.version,
      bytes: Buffer.byteLength(reportText),
    };

    // 2. Create slides: exercise both structured decision gates and verify the
    // resulting browser-native deck rather than stopping at preview creation.
    const slideRunId = await startSkillRun(
      page,
      'frontend-slides',
      'Create a concise browser-native HTML presentation from @e2e-brief.md.',
    );
    (evidence.runs as Record<string, unknown>).createSlide = slideRunId;
    await waitForRun(
      userApi,
      slideRunId,
      (meta) => meta.status === 'awaiting_approval'
        && (meta.pendingInterrupt?.interactionRequest?.gateId
          || meta.pendingInterrupt?.displayPayload?.gateId) === 'presentation_context',
      180_000,
      'slide deck-mode gate',
    );
    await page.getByRole('button', { name: /speaker-led/i }).last().click();
    await page.getByRole('button', { name: 'Continue', exact: true }).last().click();
    await waitForRun(
      userApi,
      slideRunId,
      (meta) => meta.status === 'awaiting_approval'
        && (meta.pendingInterrupt?.interactionRequest?.gateId
          || meta.pendingInterrupt?.displayPayload?.gateId) === 'style_preview_selection',
      300_000,
      'slide style-preview gate',
    );
    const useSelectedStyleButton = page
      .getByRole('button', { name: 'Use selected style', exact: true })
      .last();
    await expect(useSelectedStyleButton).toBeVisible({ timeout: 30_000 });
    const styleCard = useSelectedStyleButton.locator('xpath=ancestor::article[1]');
    await expect(styleCard).toBeVisible();
    const previewFrames = styleCard.locator('iframe');
    await expect(previewFrames.first()).toBeVisible({ timeout: 30_000 });
    await expect(previewFrames.first()).toHaveAttribute('srcdoc', /<!doctype html|<html/i);
    expect(await previewFrames.count()).toBeGreaterThanOrEqual(3);
    await testInfo.attach('slide-style-selection.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    const styleChoiceButtons = styleCard.locator('li button');
    expect(await styleChoiceButtons.count()).toBeGreaterThanOrEqual(3);
    await styleChoiceButtons.first().click();
    await expect(useSelectedStyleButton).toBeEnabled();
    await useSelectedStyleButton.click();
    await waitForRun(
      userApi,
      slideRunId,
      (meta) => meta.status === 'completed',
      480_000,
      'slide creation',
      { rejectPlanReview: true },
    );
    const filesAfterSlide = await listFiles(userApi, workspaceId);
    const deckFile = filesAfterSlide.find((file) => (
      /\.html?$/i.test(file.name)
      && !file.name.startsWith('.frontend-slides/')
      && !/^(?:style|preview)[-_]?[a-z0-9-]*\.html?$/i.test(file.name.split('/').pop() || '')
    ));
    expect(deckFile, filesAfterSlide.map((file) => file.name).join(', ')).toBeTruthy();
    const deckTextBeforeEdit = await readTextFile(userApi, workspaceId, deckFile!);
    expect(deckTextBeforeEdit).toMatch(/1920/);
    expect(deckTextBeforeEdit).toMatch(/class=["'][^"']*slide/i);
    const deckHashBeforeEdit = createHash('sha256').update(deckTextBeforeEdit).digest('hex');
    (evidence.artifacts as Record<string, unknown>).createdSlide = {
      name: deckFile!.name,
      version: deckFile!.version,
      sha256: deckHashBeforeEdit,
    };

    // 3. Create an image and prove the browser can decode the actual bytes.
    const filesBeforeImage = await listFiles(userApi, workspaceId);
    const imageRunId = await startSkillRun(
      page,
      'image',
      'Generate a square editorial illustration of a lightweight agent workflow: skill cards flowing through a teal sandbox into a validated workspace. Use a dark navy background, no words, and save it with output name prefix e2e-created.',
    );
    (evidence.runs as Record<string, unknown>).createImage = imageRunId;
    await waitForRun(
      userApi,
      imageRunId,
      (meta) => meta.status === 'completed',
      300_000,
      'image creation',
      { rejectPlanReview: true },
    );
    const filesAfterImage = await listFiles(userApi, workspaceId);
    const previousImageNames = new Set(
      filesBeforeImage.filter((file) => /\.(?:png|jpe?g|webp)$/i.test(file.name)).map((file) => file.name),
    );
    const createdImage = filesAfterImage.find((file) => (
      /\.(?:png|jpe?g|webp)$/i.test(file.name) && !previousImageNames.has(file.name)
    ));
    expect(createdImage, filesAfterImage.map((file) => file.name).join(', ')).toBeTruthy();
    const createdImageBody = await readRawFile(userApi, workspaceId, createdImage!);
    const createdDimensions = await validateImageInBrowser(page, createdImageBody);
    expect(createdDimensions.width).toBeGreaterThan(0);
    expect(createdDimensions.height).toBeGreaterThan(0);
    const createdImageHash = createHash('sha256').update(createdImageBody).digest('hex');
    await testInfo.attach('created-image.png', {
      body: createdImageBody,
      contentType: createdImage!.mimeType || 'image/png',
    });
    (evidence.artifacts as Record<string, unknown>).createdImage = {
      name: createdImage!.name,
      dimensions: createdDimensions,
      sha256: createdImageHash,
    };

    // 4. Edit the HTML deck in place and require both a version increment and
    // a semantic marker in the revised artifact.
    const editSlideRunId = await startSkillRun(
      page,
      'frontend-slides',
      `Enhance @${deckFile!.name} in place. Add a final slide whose visible title is "E2E Validation Complete" and use teal as its accent. Do not create a copy.`,
    );
    (evidence.runs as Record<string, unknown>).editSlide = editSlideRunId;
    await waitForRun(
      userApi,
      editSlideRunId,
      (meta) => meta.status === 'completed',
      360_000,
      'slide edit',
      { rejectPlanReview: true },
    );
    const filesAfterSlideEdit = await listFiles(userApi, workspaceId);
    const editedDeck = filesAfterSlideEdit.find((file) => file.name === deckFile!.name);
    expect(editedDeck).toBeTruthy();
    expect(Number(editedDeck!.version || 0)).toBeGreaterThan(Number(deckFile!.version || 0));
    const editedDeckText = await readTextFile(userApi, workspaceId, editedDeck!);
    expect(editedDeckText).toContain('E2E Validation Complete');
    const editedDeckHash = createHash('sha256').update(editedDeckText).digest('hex');
    expect(editedDeckHash).not.toBe(deckHashBeforeEdit);
    (evidence.artifacts as Record<string, unknown>).editedSlide = {
      name: editedDeck!.name,
      version: editedDeck!.version,
      sha256: editedDeckHash,
    };

    // 5. Edit the generated image using a tagged workspace source and require
    // a distinct, browser-decodable output artifact.
    const imageNamesBeforeEdit = new Set(
      filesAfterSlideEdit.filter((file) => /\.(?:png|jpe?g|webp)$/i.test(file.name)).map((file) => file.name),
    );
    const editImageRunId = await startSkillRun(
      page,
      'image',
      `Edit @${createdImage!.name}: add a small coral-orange circular beacon in the upper-right corner while preserving the composition. Save the result with output name prefix e2e-edited.`,
    );
    (evidence.runs as Record<string, unknown>).editImage = editImageRunId;
    await waitForRun(
      userApi,
      editImageRunId,
      (meta) => meta.status === 'completed',
      300_000,
      'image edit',
      { rejectPlanReview: true },
    );
    const finalFiles = await listFiles(userApi, workspaceId);
    const editedImage = finalFiles.find((file) => (
      /\.(?:png|jpe?g|webp)$/i.test(file.name) && !imageNamesBeforeEdit.has(file.name)
    ));
    expect(editedImage, finalFiles.map((file) => file.name).join(', ')).toBeTruthy();
    const editedImageBody = await readRawFile(userApi, workspaceId, editedImage!);
    const editedDimensions = await validateImageInBrowser(page, editedImageBody);
    expect(editedDimensions.width).toBeGreaterThan(0);
    expect(editedDimensions.height).toBeGreaterThan(0);
    const editedImageHash = createHash('sha256').update(editedImageBody).digest('hex');
    expect(editedImageHash).not.toBe(createdImageHash);
    await testInfo.attach('edited-image.png', {
      body: editedImageBody,
      contentType: editedImage!.mimeType || 'image/png',
    });
    (evidence.artifacts as Record<string, unknown>).editedImage = {
      name: editedImage!.name,
      dimensions: editedDimensions,
      sha256: editedImageHash,
    };

    await testInfo.attach('workflow-evidence.json', {
      body: Buffer.from(JSON.stringify(evidence, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    if (adminApi && groupId) {
      await adminApi.delete(`/api/users/groups/${groupId}`).catch(() => undefined);
    }
    if (userApi && workspaceId) {
      await userApi.delete(`/api/workspaces/${workspaceId}`).catch(() => undefined);
    }
    await userApi?.dispose();
    await adminApi?.dispose();
  }
});
