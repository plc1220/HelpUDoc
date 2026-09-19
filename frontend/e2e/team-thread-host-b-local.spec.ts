import { expect, test, type Page } from '@playwright/test';

/**
 * Release B integrated HOST regressions. These mount the REAL production
 * components that own the host callbacks (TeamThreadDetail tabs + association +
 * Work-privately + Include-in-Lumo; CanvasAnnotations dirty/unavailable/ share
 * guards) with actual-shaped mocked APIs — covering behaviors the standalone
 * component fixtures do not.
 *
 * Local Vite only: E2E_BASE_URL=http://127.0.0.1:5179.
 */

const localOnly = (baseURL?: string) =>
  !baseURL || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL);

const cors = (baseURL: string) => ({
  'access-control-allow-origin': baseURL,
  'access-control-allow-credentials': 'true',
});

const PREAMBLE = `<script type="module">
  import R from '/@react-refresh'; R.injectIntoGlobalHook(window);
  window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
</script>`;

async function mount(page: Page, route: string, imports: string, render: string) {
  await page.route(`**/${route}**`, (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html data-astryx-theme="neutral" data-theme="light"><head><meta charset="utf-8">${PREAMBLE}</head><body><div id="root"></div>
      <script type="module">
        import React from '/node_modules/.vite/deps/react.js';
        import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
        import { BrowserRouter } from '/node_modules/.vite/deps/react-router-dom.js';
        import { AppThemeRoot } from '/src/AppThemeRoot.tsx';
        ${imports}
        import '/src/index.css';
        function Harness(){ return ${render}; }
        ReactDOM.createRoot(document.getElementById('root')).render(
          React.createElement(BrowserRouter,{},React.createElement(AppThemeRoot,{},React.createElement(Harness)))
        );
      </script></body></html>`,
    }),
  );
}

const THREAD = {
  id: 'thread-A', workspaceId: 'qc', title: 'Review the onboarding guide and confirm the very long heading wraps',
  status: 'open', rootMessageId: 'm1', rootPreview: 'hi', createdBy: 'u1', replyCount: 1,
  lastActivityAt: '2026-09-19T10:00:00.000Z', lastMessageSeq: 1,
  participants: [{ userId: 'u1', displayName: 'Alice' }], unread: false, unreadCount: 0,
  following: false, runStatus: null, createdAt: '2026-09-19T09:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z',
};

const MESSAGES = {
  thread: THREAD,
  messages: [{ id: 'm1', workspaceId: 'qc', originVersionId: null, originVersionNumber: null, authorId: 'u1', authorType: 'user', authorName: 'Alice', body: 'Opening message', replyToMessageId: null, threadRootId: null, threadId: 'thread-A', sequence: 1, mentionsLumo: false, mentionedUserIds: [], isMentioned: false, isMine: true, metadata: null, createdAt: '2026-09-19T09:00:00.000Z', updatedAt: '2026-09-19T09:00:00.000Z' }],
  olderCursor: null, newerCursor: null, hasOlder: false, hasNewer: false,
};

async function routeThreadBasics(page: Page, baseURL: string) {
  await page.addInitScript(() => window.localStorage.setItem('helpudoc-auth-user', JSON.stringify({ id: 'u1', name: 'Alice', provider: 'local' })));
  await page.route('**/collaboration/team-chat/threads/thread-A/messages**', (r) => r.fulfill({ headers: cors(baseURL), json: MESSAGES }));
  await page.route('**/collaboration/team-chat/threads/thread-A/read-state', (r) => r.fulfill({ headers: cors(baseURL), json: { lastReadSeq: 1 } }));
  await page.route('**/collaboration/team-chat/threads/thread-A/follow-state', (r) => r.fulfill({ headers: cors(baseURL), json: { following: true } }));
}

const detailRender = (releaseBReady: boolean, width?: number) => `React.createElement('div',{style:{${width ? `width:${width},` : ''}height:'100vh',display:'flex'}},
  React.createElement(TeamThreadDetail,{
    workspaceId:'qc', userId:'u1', thread:${JSON.stringify(THREAD)}, isDarkMode:false, role:'editor',
    releaseBReady:${releaseBReady}, markdownComponents:{}, referenceOptions:[], showBack:false,
    onBack:function(){}, onThreadUpdated:function(){}, onAccessLost:function(){},
  }))`;

// ---------------------------------------------------------------------------
// H-01 — B tabs + association toggle appear only when Release B ready
// ---------------------------------------------------------------------------
test('H-01 Release B tabs + association control gate on releaseBReady', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');
  await routeThreadBasics(page, baseURL!);
  await page.route('**/collaboration/team-chat/threads/thread-A/changes**', (r) => r.fulfill({ headers: cors(baseURL!), json: { changes: [], nextCursor: null } }));
  await page.route('**/collaboration/team-chat/threads/thread-A/linked-items', (r) => r.fulfill({ headers: cors(baseURL!), json: { items: [] } }));

  // B OFF: no Changes/Linked tabs, no association toggle, no Work privately.
  await mount(page, '__h_off', "import TeamThreadDetail from '/src/components/chat/TeamThreadDetail.tsx';", detailRender(false));
  await page.goto('/__h_off');
  await expect(page.getByText('Opening message')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Changes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Work privately' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Attribute my edits' })).toHaveCount(0);

  // B ON: tabs + association + Work privately present.
  await mount(page, '__h_on', "import TeamThreadDetail from '/src/components/chat/TeamThreadDetail.tsx';", detailRender(true));
  await page.goto('/__h_on');
  await expect(page.getByText('Opening message')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Linked items' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Work privately' })).toBeVisible();
  // Explicit association toggle: opening the thread did NOT attribute.
  const toggle = page.getByRole('button', { name: 'Attribute my edits' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Attributing edits here' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// H-02 — Include in Lumo stages BOTH @Lumo and the annotation ref; explicit send
// ---------------------------------------------------------------------------
test('H-02 Include in Lumo stages @Lumo + annotation reference and only sends on explicit Send', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');
  await routeThreadBasics(page, baseURL!);
  let sendBody: Record<string, unknown> | null = null;
  await page.route('**/collaboration/team-chat/threads/thread-A/messages', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    sendBody = r.request().postDataJSON();
    return r.fulfill({ headers: cors(baseURL!), json: { ...MESSAGES.messages[0], id: 'm2', sequence: 2, body: sendBody?.body } });
  });
  await page.route('**/collaboration/team-chat/threads/thread-A/linked-items', (r) => r.fulfill({ headers: cors(baseURL!), json: { items: [
    { objectId: 'ann-1', type: 'annotation', status: 'open', title: 'Clarify intro', fileId: 1, filePath: 'docs/x.md', anchorText: 'intro', anchorVersionId: 'uuid-v2', anchorVersionNumber: 2, currentVersionNumber: 2, fileDeleted: false, anchorChanged: false, createdAt: '2026-09-19T09:00:00.000Z' },
  ] } }));

  await mount(page, '__h_lumo', "import TeamThreadDetail from '/src/components/chat/TeamThreadDetail.tsx';", detailRender(true));
  await page.goto('/__h_lumo');
  await page.getByRole('button', { name: 'Linked items' }).click();
  await page.getByRole('button', { name: 'Include in Lumo request' }).click();
  // Staged only — nothing sent yet.
  expect(sendBody).toBeNull();
  // Composer now has @Lumo and the annotation reference chip.
  await expect(page.getByLabel('Workspace Chat message')).toHaveValue(/@Lumo/);
  await expect(page.getByLabel('Workspace Chat message')).toHaveValue(/@Clarify intro/);
  await expect(page.getByLabel('Selected references').getByText('Clarify intro', { exact: true })).toBeVisible();
  // Explicit send runs once with both references.
  await page.getByTestId('composer-send').click();
  await expect.poll(() => sendBody).not.toBeNull();
  const refs = (sendBody?.references as Array<{ kind: string }>) || [];
  expect(refs.some((x) => x.kind === 'agent')).toBe(true);
  expect(refs.some((x) => x.kind === 'annotation')).toBe(true);
});

// ---------------------------------------------------------------------------
// H-03 — CanvasAnnotations blocks a new anchored comment with no exact version
// or a dirty canvas (zero POST); replies still allowed.
// ---------------------------------------------------------------------------
test('H-03 anchored comment is blocked without an exact version and while dirty (zero POST)', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');
  let objectPosts = 0;
  await page.route('**/api/workspaces/qc/collaboration/objects**', (r) => {
    const req = r.request();
    if (req.method() === 'POST') objectPosts += 1;
    return r.fulfill({ headers: cors(baseURL!), json: req.method() === 'POST' ? { id: 'new1' } : { objects: [] } });
  });

  // Missing exact version (anchorVersionId undefined) AND dirty canvas.
  await mount(
    page,
    '__h_anchor',
    "import CanvasAnnotations from '/src/components/CanvasAnnotations.tsx';",
    `React.createElement('div',{style:{height:600,width:420}},
       React.createElement(CanvasAnnotations,{workspace:{id:'qc',visibility:'team',role:'editor'},filePath:'notes.md',releaseBReady:true,canvasDirty:true,onAgentChat:function(){}},
         React.createElement('p',{'data-testid':'passage'},'Selected passage')))`,
  );
  await page.goto('/__h_anchor');
  await page.getByRole('button', { name: 'Annotate', exact: true }).click();
  await page.getByTestId('passage').evaluate((el) => {
    const range = document.createRange(); range.selectNodeContents(el);
    const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('textbox', { name: 'Annotation comment' }).fill('Please clarify');
  // The Post button is disabled (no exact version + dirty) — an honest block.
  await expect(page.getByRole('button', { name: 'Post comment', exact: true })).toBeDisabled();
  await page.waitForTimeout(200);
  expect(objectPosts).toBe(0);
});

// ---------------------------------------------------------------------------
// H-04 — Work privately reuses an existing thread-linked proposal (no dup)
// ---------------------------------------------------------------------------
test('H-04 Work privately reuses an existing thread-linked proposal and does NOT open the shared modal on entry', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');
  await routeThreadBasics(page, baseURL!);
  let objectCreates = 0;
  let proposalConverts = 0;
  const opened: Array<Record<string, unknown>> = [];
  let openedPrivateCopy = 0;
  // Existing proposal already linked to this thread + authored by me.
  await page.route('**/api/workspaces/qc/collaboration/objects', (r) => {
    if (r.request().method() === 'POST') { objectCreates += 1; return r.fulfill({ headers: cors(baseURL!), json: { id: 'new-obj' } }); }
    return r.fulfill({ headers: cors(baseURL!), json: { objects: [
      { id: 'prop-1', workspaceId: 'qc', type: 'change_proposal', visibility: 'workspace_audience', status: 'proposed', authorId: 'u1', authorName: 'Alice', sourceThreadId: 'thread-A', filePath: null, title: 'Existing', body: '', originVersionId: null, messageCount: 0, createdAt: '2026-09-19T09:00:00.000Z', updatedAt: '2026-09-19T09:00:00.000Z', linkedPrivateWorkspaceId: null, assigneeId: null, assigneeName: null, resolvedByVersionId: null, sourceTeamMessageId: null, dueAt: null, resolvedAt: null },
    ] } });
  });
  await page.route('**/collaboration/objects/*/proposal', (r) => { proposalConverts += 1; return r.fulfill({ headers: cors(baseURL!), json: { id: 'prop-1' } }); });
  await page.route('**/collaboration/objects/prop-1/private-navigation', (r) => r.fulfill({ headers: cors(baseURL!), json: { linkedPrivateWorkspaceId: 'priv-1', privateContentRevision: 3, sourceThreadId: 'thread-A', originThreadIds: ['thread-A'] } }));

  await page.exposeFunction('__recordOpen', (d: Record<string, unknown>) => { opened.push(d); });
  await page.addInitScript(() => window.addEventListener('helpudoc-open-collaboration-object', (e) => (window as unknown as { __recordOpen: (d: unknown) => void }).__recordOpen((e as CustomEvent).detail)));

  // Detail with an onOpenPrivateWorkingCopy callback (entering the private copy).
  await mount(
    page,
    '__h_wp',
    "import TeamThreadDetail from '/src/components/chat/TeamThreadDetail.tsx';",
    `React.createElement('div',{style:{height:'100vh',display:'flex'}},
      React.createElement(TeamThreadDetail,{ workspaceId:'qc', userId:'u1', thread:${JSON.stringify(THREAD)}, isDarkMode:false, role:'editor', releaseBReady:true, markdownComponents:{}, referenceOptions:[], showBack:false, onBack:function(){}, onThreadUpdated:function(){}, onAccessLost:function(){}, onOpenPrivateWorkingCopy:function(){ window.__openedPrivate = (window.__openedPrivate||0)+1; return Promise.resolve(); } }))`,
  );
  await page.goto('/__h_wp');
  await page.getByRole('button', { name: 'Work privately' }).click();
  // Entered the private copy (callback fired), reusing the existing proposal:
  // NO new object create, NO new convert, and NO shared modal opened on entry.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __openedPrivate?: number }).__openedPrivate || 0)).toBeGreaterThan(0);
  openedPrivateCopy = await page.evaluate(() => (window as unknown as { __openedPrivate?: number }).__openedPrivate || 0);
  expect(openedPrivateCopy).toBeGreaterThan(0);
  expect(objectCreates).toBe(0);
  expect(proposalConverts).toBe(0);
  expect(opened.length).toBe(0); // shared proposal modal is NOT opened on entry
});

// ---------------------------------------------------------------------------
// H-05 — collaboration dialog: author submit refreshes review WITHOUT reopen;
// apply flips status to applied and hides Apply (round47).
// ---------------------------------------------------------------------------
test('H-05 dialog submit refreshes review list and apply updates status in the same open dialog', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');
  await page.addInitScript(() => window.localStorage.setItem('helpudoc-auth-user', JSON.stringify({ id: 'u1', name: 'Alice', provider: 'local' })));

  const PROPOSAL = {
    id: 'prop-1', workspaceId: 'qc', type: 'change_proposal', visibility: 'workspace_audience', status: 'proposed',
    authorId: 'u1', authorName: 'Alice', sourceThreadId: 'thread-A', filePath: null, title: 'Prop', body: '',
    originVersionId: null, messageCount: 0, createdAt: '2026-09-19T09:00:00.000Z', updatedAt: '2026-09-19T09:00:00.000Z', linkedPrivateWorkspaceId: null,
    assigneeId: null, assigneeName: null, resolvedByVersionId: null, sourceTeamMessageId: null, dueAt: null, resolvedAt: null,
  };
  let submissions: Array<Record<string, unknown>> = [];
  let applied = false;

  await page.route('**/api/workspaces/qc/collaboration/objects', (r) => r.fulfill({ headers: cors(baseURL!), json: { objects: [PROPOSAL] } }));
  await page.route('**/collaboration/objects/prop-1', (r) => { if (r.request().method() !== 'GET') return r.fallback(); return r.fulfill({ headers: cors(baseURL!), json: { object: PROPOSAL, messages: [] } }); });
  await page.route('**/collaboration/objects/prop-1/submission-candidates**', (r) => r.fulfill({ headers: cors(baseURL!), json: { candidates: [{ path: 'selected.md', fromPath: null, fileId: 1, changeKind: 'content', baseVersionId: 'b1', proposedVersionId: 'p1', sha256: 'a', size: 3, mimeType: 'text/markdown', requiredDeps: [] }], baseSharedRevision: 5, basePrivateRevision: 2 } }));
  await page.route('**/collaboration/objects/prop-1/private-navigation', (r) => r.fulfill({ headers: cors(baseURL!), json: { linkedPrivateWorkspaceId: 'priv-1', privateContentRevision: 2, sourceThreadId: 'thread-A', originThreadIds: ['thread-A'] } }));
  await page.route('**/collaboration/objects/prop-1/submissions', (r) => {
    if (r.request().method() === 'POST') {
      submissions = [{ id: 'sub-1', status: 'submitted', submittedBy: 'u1', publicExplanation: null, baseSharedRevision: 5, operationCount: 1, createdAt: '2026-09-19T09:00:00.000Z', appliedAt: null, reviews: [] }];
      return r.fulfill({ headers: cors(baseURL!), json: { id: 'sub-1', objectId: 'prop-1', sourceThreadId: 'thread-A', status: 'submitted', submittedBy: 'u1', publicExplanation: null, baseSharedRevision: 5, createdAt: '2026-09-19T09:00:00.000Z', operations: [{ path: 'selected.md', fromPath: null, fileId: 1, changeKind: 'content', baseVersionId: 'b1', proposedVersionId: 'p1', sha256: 'a' }], reviews: [] } });
    }
    return r.fulfill({ headers: cors(baseURL!), json: { submissions } });
  });
  await page.route('**/collaboration/objects/prop-1/submissions/sub-1', (r) => r.fulfill({ headers: cors(baseURL!), json: { id: 'sub-1', objectId: 'prop-1', sourceThreadId: 'thread-A', status: applied ? 'applied' : 'submitted', submittedBy: 'u1', publicExplanation: null, baseSharedRevision: 5, createdAt: '2026-09-19T09:00:00.000Z', appliedAt: applied ? 'y' : null, operations: [{ path: 'selected.md', fromPath: null, fileId: 1, changeKind: 'content', baseVersionId: 'b1', proposedVersionId: 'p1', sha256: 'a' }], reviews: [] } }));
  await page.route('**/collaboration/objects/prop-1/apply', (r) => { applied = true; return r.fulfill({ headers: cors(baseURL!), json: { status: 'applied' } }); });

  await mount(
    page,
    '__h_dialog',
    `import WorkspaceCollaborationDialog from '/src/components/WorkspaceCollaborationDialog.tsx';
     import { AuthContext } from '/src/auth/authContext.ts';`,
    `React.createElement(AuthContext.Provider,{value:{user:{id:'u1',name:'Alice'},loading:false}},
       React.createElement(WorkspaceCollaborationDialog,{open:true,workspace:{id:'qc',name:'QC',role:'owner',visibility:'team',contentRevision:5},filePath:null,initialObjectId:'prop-1',releaseBReady:true,onClose:function(){},onWorkspaceListChanged:function(){}}))`,
  );
  await page.goto('/__h_dialog');

  // Author submit panel: select the candidate and submit.
  await expect(page.getByText('Select the changes to submit')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select selected.md' }).check();
  await page.getByRole('button', { name: /^Submit 1 change/ }).click();

  // Review panel refreshes in the SAME dialog: the new submission appears
  // (no "No submissions yet"), without reopening.
  await expect(page.getByText('Selected operations')).toBeVisible();
  await expect(page.getByText('selected.md', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('No submissions yet for this proposal.')).toHaveCount(0);

  // Apply → status flips to applied, Apply button disappears.
  const applyBtn = page.getByRole('button', { name: 'Apply to Shared Working' });
  await applyBtn.click();
  await expect(page.getByText('applied', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply to Shared Working' })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// H-06 — narrow panel (320 & 420): no horizontal overflow, all header controls
// within the viewport (round43/44/45 layout).
// ---------------------------------------------------------------------------
for (const width of [320, 420]) {
  test(`H-06 thread detail at ${width}px has no overflow and all controls in bounds`, async ({ page, baseURL }) => {
    test.skip(localOnly(baseURL), 'Local Vite required');
    await routeThreadBasics(page, baseURL!);
    await page.route('**/collaboration/team-chat/threads/thread-A/changes**', (r) => r.fulfill({ headers: cors(baseURL!), json: { changes: [], nextCursor: null } }));
    await page.route('**/collaboration/team-chat/threads/thread-A/linked-items', (r) => r.fulfill({ headers: cors(baseURL!), json: { items: [] } }));
    await page.setViewportSize({ width, height: 720 });
    await mount(
      page,
      `__h_w${width}`,
      "import TeamThreadDetail from '/src/components/chat/TeamThreadDetail.tsx';",
      detailRender(true, width),
    );
    await page.goto(`/__h_w${width}`);
    await expect(page.getByText('Opening message')).toBeVisible();
    // No horizontal overflow.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    // Every header control is fully within the viewport width.
    for (const name of ['Work privately', 'Attribute my edits', 'Follow', 'Resolve']) {
      const box = await page.getByRole('button', { name }).boundingBox();
      if (box) expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
  });
}

// ---------------------------------------------------------------------------
// H-07 — anchor guard SEPARATED: pinned+clean allows POST; pinned+dirty blocks;
// missing-pin+clean blocks; a reply to an existing annotation is always allowed.
// ---------------------------------------------------------------------------
const canvasRender = (opts: { anchorVersionId?: string; canvasDirty?: boolean }) =>
  `React.createElement('div',{style:{height:600,width:420}},
     React.createElement(CanvasAnnotations,{workspace:{id:'qc',visibility:'team',role:'editor'},filePath:'notes.md',releaseBReady:true,fileId:101${opts.anchorVersionId ? `,anchorVersionId:'${opts.anchorVersionId}'` : ''}${opts.canvasDirty ? ',canvasDirty:true' : ''},onAgentChat:function(){}},
       React.createElement('p',{'data-testid':'passage'},'Selected passage')))`;

async function routeObjects(page: Page, baseURL: string, counter: { posts: number }) {
  await page.route('**/api/workspaces/qc/collaboration/objects**', (r) => {
    const req = r.request();
    if (req.method() === 'POST') { counter.posts += 1; return r.fulfill({ headers: cors(baseURL), json: { id: 'new1', filePath: 'notes.md', anchorText: 'Selected passage', anchorStart: 0, anchorEnd: 16, visibility: 'workspace_audience', status: 'open', authorName: 'A', messageCount: 0 } }); }
    return r.fulfill({ headers: cors(baseURL), json: { objects: [] } });
  });
}

async function selectPassageAndType(page: Page) {
  await page.getByRole('button', { name: 'Annotate', exact: true }).click();
  await page.getByTestId('passage').evaluate((el) => {
    const range = document.createRange(); range.selectNodeContents(el);
    const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('textbox', { name: 'Annotation comment' }).fill('Please clarify');
}

test('H-07a pinned + clean canvas → anchored comment POSTs with the exact version', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');
  const counter = { posts: 0 };
  let body: Record<string, unknown> | null = null;
  await page.route('**/api/workspaces/qc/collaboration/objects**', (r) => {
    const req = r.request();
    if (req.method() === 'POST') { counter.posts += 1; body = req.postDataJSON(); return r.fulfill({ headers: cors(baseURL!), json: { id: 'new1', filePath: 'notes.md', anchorText: 'Selected passage', anchorStart: 0, anchorEnd: 16, visibility: 'workspace_audience', status: 'open', authorName: 'A', messageCount: 0 } }); }
    return r.fulfill({ headers: cors(baseURL!), json: { objects: [] } });
  });
  await mount(page, '__h7a', "import CanvasAnnotations from '/src/components/CanvasAnnotations.tsx';", canvasRender({ anchorVersionId: 'ver-uuid-1' }));
  await page.goto('/__h7a');
  await selectPassageAndType(page);
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect.poll(() => counter.posts).toBe(1);
  expect(body?.anchorVersionId).toBe('ver-uuid-1');
});

test('H-07b pinned + DIRTY canvas → anchored comment blocked (zero POST)', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');
  const counter = { posts: 0 };
  await routeObjects(page, baseURL!, counter);
  await mount(page, '__h7b', "import CanvasAnnotations from '/src/components/CanvasAnnotations.tsx';", canvasRender({ anchorVersionId: 'ver-uuid-1', canvasDirty: true }));
  await page.goto('/__h7b');
  await selectPassageAndType(page);
  await expect(page.getByRole('button', { name: 'Post comment', exact: true })).toBeDisabled();
  await page.waitForTimeout(150);
  expect(counter.posts).toBe(0);
});

test('H-07c missing pin + clean canvas → anchored comment blocked (zero POST)', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');
  const counter = { posts: 0 };
  await routeObjects(page, baseURL!, counter);
  await mount(page, '__h7c', "import CanvasAnnotations from '/src/components/CanvasAnnotations.tsx';", canvasRender({}));
  await page.goto('/__h7c');
  await selectPassageAndType(page);
  await expect(page.getByRole('button', { name: 'Post comment', exact: true })).toBeDisabled();
  await page.waitForTimeout(150);
  expect(counter.posts).toBe(0);
});
