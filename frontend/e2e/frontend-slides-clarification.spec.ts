import {
  expect,
  request,
  test,
  type APIRequestContext,
} from "@playwright/test";

test.setTimeout(420_000);

type LocalAuthUser = {
  id: string;
  name: string;
  email: string;
  provider: "local";
};

const ADMIN_USER: LocalAuthUser = {
  id: "admin-local",
  name: "Admin",
  email: "admin@local.com",
  provider: "local",
};

const authHeadersFor = (user: LocalAuthUser) => ({
  "X-User-Id": user.id,
  "X-User-Name": user.name,
  "X-User-Email": user.email,
});

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

test("frontend-slides uses a paginated clarification wizard and submits structured answers", async ({
  page,
  baseURL,
}) => {
  const resolvedBaseUrl = baseURL || "https://lc-demo.com";
  const testRunId = Date.now();
  const e2eUser: LocalAuthUser = {
    id: `slides-e2e-${testRunId}`,
    name: "Slides E2E",
    email: `slides-e2e-${testRunId}@local.test`,
    provider: "local",
  };
  const workspaceName = `a2ui-slides-${testRunId}`;
  let adminApi: APIRequestContext | undefined;
  let userApi: APIRequestContext | undefined;
  let groupId: string | undefined;
  page.on("console", (message) => {
    console.log(`[browser:${message.type()}] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    console.log(`[pageerror] ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    console.log(
      `[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`,
    );
  });
  page.on("response", async (response) => {
    if (!response.url().includes("/api/")) {
      return;
    }
    const request = response.request();
    console.log(
      `[response] ${request.method()} ${response.status()} ${response.url()}`,
    );
  });

  try {
    adminApi = await request.newContext({
      baseURL: resolvedBaseUrl,
      extraHTTPHeaders: authHeadersFor(ADMIN_USER),
    });
    userApi = await request.newContext({
      baseURL: resolvedBaseUrl,
      extraHTTPHeaders: authHeadersFor(e2eUser),
    });

    const ensureUser = await userApi.get("/api/auth/me");
    expect(ensureUser.status(), await ensureUser.text()).toBe(200);
    const userSession = (await ensureUser.json()) as {
      user?: { userId?: string; isAdmin?: boolean };
    };
    expect(userSession.user?.userId).toBeTruthy();
    expect(userSession.user?.isAdmin).toBe(false);
    const userId = userSession.user!.userId!;

    const createGroup = await adminApi.post("/api/users/groups", {
      data: { name: `Slides E2E ${testRunId}` },
    });
    expect(createGroup.status(), await createGroup.text()).toBe(201);
    const groupPayload = (await createGroup.json()) as {
      group?: { id?: string };
    };
    expect(groupPayload.group?.id).toBeTruthy();
    groupId = groupPayload.group!.id!;

    const grantSkill = await adminApi.put(
      `/api/users/groups/${groupId}/access`,
      {
        data: { skillIds: ["frontend-slides"], mcpServerIds: [] },
      },
    );
    expect(grantSkill.status(), await grantSkill.text()).toBe(200);

    const addMember = await adminApi.post(
      `/api/users/groups/${groupId}/members`,
      {
        data: { userId },
      },
    );
    expect(addMember.status(), await addMember.text()).toBe(204);

    await page.addInitScript((payload) => {
      window.localStorage.setItem(
        "helpudoc-auth-user",
        JSON.stringify(payload),
      );
    }, e2eUser);

    const createWorkspace = await userApi.post("/api/workspaces", {
      data: { name: workspaceName },
    });
    expect(createWorkspace.status(), await createWorkspace.text()).toBe(201);
    const workspace = (await createWorkspace.json()) as { id?: string };
    expect(workspace.id).toBeTruthy();
    const workspaceId = workspace.id!;

    const createReport = await userApi.post(
      `/api/workspaces/${workspaceId}/files/text`,
      {
        data: {
          name: "operation-epic-fury-report.md",
          content: REPORT_CONTENT,
          mimeType: "text/markdown",
        },
      },
    );
    expect(createReport.status(), await createReport.text()).toBe(201);

    await page.goto(resolvedBaseUrl, { waitUntil: "domcontentloaded" });

    await page.getByRole("button", { name: "Select workspace" }).click();
    await page.getByPlaceholder("Search workspaces").last().fill(workspaceName);
    await page
      .getByRole("button", { name: new RegExp(`^${workspaceName}$`) })
      .click();

    // Trigger the frontend-slides flow using a tagged workspace file.
    const composer = page
      .locator(
        'textarea[placeholder="Ask HelpUDoc anything..."], textarea[placeholder*="Interact with the agent"]',
      )
      .first();
    await expect(composer).toBeVisible();
    await composer.fill(
      "/skill frontend-slides @operation-epic-fury-report.md",
    );
    const startRunResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/agent\/runs(?:\?|$)/.test(response.url()),
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByText("/skill frontend-slides @operation-epic-fury-report.md"),
    ).toBeVisible();
    const runResponse = await startRunResponse;
    const runResponseText = await runResponse.text();
    console.log(`[start-run-body] ${runResponseText}`);
    const startedRun = JSON.parse(runResponseText) as { runId?: string };
    expect(startedRun.runId).toBeTruthy();
    const runId = startedRun.runId!;

    const getRunMeta = async () => {
      const response = await userApi!.get(`/api/agent/runs/${runId}`);
      expect(response.status(), await response.text()).toBe(200);
      return response.json() as Promise<{
        status?: string;
        error?: string;
        a2uiGateState?: { completedGateIds?: string[] };
        pendingInterrupt?: {
          displayPayload?: { gateId?: string };
          a2uiRequest?: {
            gateId?: string;
            component?: string;
            metadata?: Record<string, unknown>;
          };
        };
      }>;
    };

    // The desired blocked state is a clarification pause, not a plan approval card.
    await expect
      .poll(
        async () => {
          const purposeQuestionCount = await page
            .getByText(/What is this presentation for\?/i)
            .count();
          const pitchDeckOptionCount = await page
            .getByRole("button", { name: /Pitch deck/i })
            .count();
          const discoveryTitleCount = await page
            .getByText(
              /Presentation Discovery|Presentation Context|File Not Found/i,
            )
            .count();
          const questionStepCount = await page
            .getByText(/Question 1 of 5/i)
            .count();
          return (
            (questionStepCount > 0 &&
              discoveryTitleCount > 0 &&
              pitchDeckOptionCount > 0) ||
            (questionStepCount > 0 &&
              purposeQuestionCount > 0 &&
              pitchDeckOptionCount > 0)
          );
        },
        { timeout: 120_000, message: "expected clarification UI to appear" },
      )
      .toBe(true);

    await expect(page.getByText(/Review Research Strategy/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reject" })).toHaveCount(0);
    await expect(page.getByText("Generating...")).toHaveCount(0, {
      timeout: 30_000,
    });

    await page.getByText("Pitch deck", { exact: true }).click();
    await page.getByRole("button", { name: /Next/i }).click();
    await expect(page.getByText(/Question 2 of 5/i)).toBeVisible();

    await page.getByText("Medium (10-20)", { exact: true }).click();
    await page.getByRole("button", { name: /Next/i }).click();
    await expect(page.getByText(/Question 3 of 5/i)).toBeVisible();

    await page.getByText("I have rough notes", { exact: true }).click();
    await page.getByRole("button", { name: /Next/i }).click();
    await expect(page.getByText(/Question 4 of 5/i)).toBeVisible();

    await page.getByText("./assets", { exact: true }).click();
    await page.getByRole("button", { name: /Next/i }).click();
    await expect(page.getByText(/Question 5 of 5/i)).toBeVisible();

    await page.getByText("Yes (Recommended)", { exact: true }).click();

    const respondRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        /\/api\/agent\/runs\/[^/]+\/respond(?:\?|$)/.test(request.url()),
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: /Review answers/i }).click();
    await expect(page.getByText(/Review/i)).toBeVisible();
    await page
      .locator("textarea")
      .last()
      .fill("Keep it bold, fast-paced, and visually modern.");
    await page
      .getByRole("button", { name: /Continue|Start Designing/i })
      .click();

    const respondRequest = await respondRequestPromise;
    const respondPayload = respondRequest.postDataJSON() as {
      message?: string;
      answersByQuestionId?: Record<string, string>;
    };

    expect(respondPayload.answersByQuestionId).toMatchObject({
      purpose: "Pitch deck",
      length: "Medium (10-20)",
      content: "I have rough notes",
      images: "./assets",
      editing: "Yes (Recommended)",
    });
    await expect(
      page.getByText(/What is this presentation for\?/i),
    ).toHaveCount(0, { timeout: 15_000 });

    await expect
      .poll(
        async () => {
          const meta = await getRunMeta();
          return Boolean(
            meta.a2uiGateState?.completedGateIds?.includes(
              "presentation_context",
            ),
          );
        },
        {
          timeout: 60_000,
          message:
            "expected presentation_context to be marked complete after submit",
        },
      )
      .toBe(true);

    await expect
      .poll(
        async () => {
          const meta = await getRunMeta();
          const gateId =
            meta.pendingInterrupt?.a2uiRequest?.gateId ||
            meta.pendingInterrupt?.displayPayload?.gateId ||
            "";
          if (meta.status === "failed") {
            return `failed:${meta.error || ""}`;
          }
          return gateId || meta.status || "";
        },
        {
          timeout: 240_000,
          message: "expected the same run to advance to outline_confirmation",
        },
      )
      .toBe("outline_confirmation");

    await expect(
      page.getByText(
        /Does this slide outline and image selection look right\?/i,
      ),
    ).toBeVisible();
    await expect(page.getByText(/Review material/i)).toBeVisible();
    await expect(
      page.getByText(/The slide outline was not included in the agent response/i),
    ).toHaveCount(0);
    await expect(
      page.getByText(/The run failed before it could finish/i),
    ).toHaveCount(0);
    await expect(page.getByText(/I have opened the setup form/i)).toHaveCount(
      0,
    );
  } finally {
    if (adminApi && groupId) {
      await adminApi
        .delete(`/api/users/groups/${groupId}`)
        .catch(() => undefined);
    }
    await userApi?.dispose();
    await adminApi?.dispose();
  }
});
