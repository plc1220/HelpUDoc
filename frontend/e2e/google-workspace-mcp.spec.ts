import { expect, test, type APIRequestContext } from '@playwright/test';

test.skip(
  process.env.RUN_GOOGLE_WORKSPACE_MCP_E2E !== '1',
  'Set RUN_GOOGLE_WORKSPACE_MCP_E2E=1 and E2E_SESSION_COOKIE to run the real OIDC smoke test.',
);
test.setTimeout(300_000);

type RunMeta = {
  status?: string;
  error?: string;
};

type StreamEvent = {
  type?: string;
  name?: string;
  content?: string;
};

const delay = (milliseconds: number) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const waitForRun = async (api: APIRequestContext, runId: string): Promise<RunMeta> => {
  const deadline = Date.now() + 240_000;
  let latest: RunMeta = {};
  while (Date.now() < deadline) {
    const response = await api.get(`/api/agent/runs/${runId}`);
    expect(response.status(), await response.text()).toBe(200);
    latest = await response.json() as RunMeta;
    if (latest.status === 'completed') return latest;
    if (latest.status === 'failed' || latest.status === 'cancelled') {
      throw new Error(`Google Workspace run ${latest.status}: ${latest.error || 'unknown error'}`);
    }
    await delay(1_500);
  }
  throw new Error(`Google Workspace run timed out in ${latest.status || 'unknown'} state`);
};

test('OIDC user can discover and call the default Google Workspace MCP server', async ({
  context,
  page,
  baseURL,
}) => {
  const sessionCookie = process.env.E2E_SESSION_COOKIE;
  expect(sessionCookie, 'E2E_SESSION_COOKIE must contain a signed HelpUDoc session cookie').toBeTruthy();

  const resolvedBaseUrl = baseURL || 'http://localhost:5173';
  const origin = new URL(resolvedBaseUrl);
  await context.addCookies([{
    name: 'helpudoc.sid',
    value: sessionCookie!,
    domain: origin.hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: origin.protocol === 'https:',
  }]);

  await page.goto(resolvedBaseUrl, { waitUntil: 'domcontentloaded' });
  const api = page.request;
  const authResponse = await api.get('/api/auth/me');
  expect(authResponse.status(), await authResponse.text()).toBe(200);
  const auth = await authResponse.json() as {
    authenticated?: boolean;
    authMode?: string;
    user?: { email?: string };
  };
  expect(auth.authenticated).toBe(true);
  expect(auth.authMode).toBe('oidc');
  expect(auth.user?.email).toBe('licheng.phan@mile.cloud');

  const workspaceName = `gws-mcp-e2e-${Date.now()}`;
  let workspaceId: string | undefined;
  try {
    const createWorkspace = await api.post('/api/workspaces', {
      data: { name: workspaceName },
    });
    expect(createWorkspace.status(), await createWorkspace.text()).toBe(201);
    workspaceId = ((await createWorkspace.json()) as { id?: string }).id;
    expect(workspaceId).toBeTruthy();

    const slashResponse = await api.get(`/api/agent/slash-metadata?workspaceId=${workspaceId}`);
    expect(slashResponse.status(), await slashResponse.text()).toBe(200);
    const slash = await slashResponse.json() as { mcpServers?: Array<{ name?: string }> };
    expect(slash.mcpServers?.map((server) => server.name)).toContain('google-workspace');

    const marker = `__helpudoc_mcp_smoke_${Date.now()}__`;
    const startResponse = await api.post('/api/agent/runs', {
      data: {
        persona: 'fast',
        workspaceId,
        prompt: [
          '/mcp google-workspace',
          `Search Google Drive for the exact filename ${marker}.`,
          'Return only the number of matching files. Do not open, create, edit, share, or delete anything.',
        ].join(' '),
      },
    });
    expect(startResponse.status(), await startResponse.text()).toBe(200);
    const runId = ((await startResponse.json()) as { runId?: string }).runId;
    expect(runId).toBeTruthy();

    await waitForRun(api, runId!);

    const streamResponse = await api.get(`/api/agent/runs/${runId}/stream?after=0-0`);
    expect(streamResponse.status(), await streamResponse.text()).toBe(200);
    const events = (await streamResponse.text())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StreamEvent);
    const toolStarts = events.filter((event) => event.type === 'tool_start');
    expect(toolStarts, 'the forced MCP run must invoke a Google Workspace tool').not.toHaveLength(0);
    expect(events.filter((event) => event.type === 'tool_error')).toHaveLength(0);
  } finally {
    if (workspaceId) {
      await api.delete(`/api/workspaces/${workspaceId}`).catch(() => undefined);
    }
  }
});
