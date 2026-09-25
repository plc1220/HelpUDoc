import { expect, test, type Page } from '@playwright/test';

/**
 * Release B (F6–F8) browser tests. Each test mounts the REAL production
 * component (imported from /src/...) inside a minimal Vite-served HTML shell and
 * routes the Release B endpoints with ACTUAL-SHAPED responses from
 * release-b-backend-contract.md — including the failure cases the independent
 * review demanded (missing snapshot bytes, list-summary vs full submission,
 * stale apply, deleted-file diff, run-failed-partial, anchor_changed).
 *
 * Local Vite only: run with E2E_BASE_URL=http://127.0.0.1:5179. The default
 * Playwright baseURL is remote and these tests skip unless a local origin is
 * configured.
 */

const localOnly = (baseURL?: string) =>
  !baseURL || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL);

const REACT_PREAMBLE = `<script type="module">
  import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
</script>`;

/** Serve an HTML shell that mounts the given production component. `importPath`
 *  is the /src path; `render` is a JS expression string producing the element. */
async function mountFixture(
  page: Page,
  route: string,
  imports: string,
  render: string,
) {
  await page.route(`**/${route}**`, (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html data-astryx-theme="neutral" data-theme="light"><head><meta charset="utf-8">${REACT_PREAMBLE}</head><body><div id="root"></div>
      <script type="module">
        import React from '/node_modules/.vite/deps/react.js';
        import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
        import { AppThemeRoot } from '/src/AppThemeRoot.tsx';
        ${imports}
        import '/src/index.css';
        function Harness(){ return ${render}; }
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AppThemeRoot,{},React.createElement(Harness)));
      </script></body></html>`,
    }),
  );
}

const cors = (baseURL: string) => ({
  'access-control-allow-origin': baseURL,
  'access-control-allow-credentials': 'true',
});

// ---------------------------------------------------------------------------
// B-01 — attributed Changes: exact before/after, superseded, no inferred diff
// ---------------------------------------------------------------------------
test('B-01 Changes view attributes exact before/after versions and shows a real text diff', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required (E2E_BASE_URL=http://127.0.0.1:5179)');

  await page.route('**/collaboration/team-chat/threads/thread-A/changes**', (r) =>
    r.fulfill({
      headers: cors(baseURL!),
      json: {
        changes: [
          {
            versionId: 'v3', fileId: 1, filePath: 'docs/report.md', changeKind: 'content',
            actorId: 'u1', actorName: 'Alice', createdAt: '2026-09-19T10:00:00.000Z',
            sourceRunId: null, sourceMessageId: null, baseVersionId: 'v2', baseVersion: 2,
            version: 3, currentVersion: 4, superseded: true, runStatus: null, fileDeleted: false,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  // Immutable bytes: before=v2 content, after=v3 content (a real, differing diff).
  await page.route('**/changes/v3/content?side=before', (r) =>
    r.fulfill({ headers: { ...cors(baseURL!), 'Content-Type': 'text/markdown' }, body: 'line one\nline two\n' }),
  );
  await page.route('**/changes/v3/content?side=after', (r) =>
    r.fulfill({ headers: { ...cors(baseURL!), 'Content-Type': 'text/markdown' }, body: 'line one\nline two changed\nline three\n' }),
  );

  await mountFixture(
    page,
    '__b_changes',
    "import TeamThreadWorkHistory from '/src/components/chat/TeamThreadWorkHistory.tsx';",
    "React.createElement('div',{style:{width:360,padding:16}},React.createElement(TeamThreadWorkHistory,{workspaceId:'qc',threadId:'thread-A'}))",
  );
  await page.goto('/__b_changes');

  await expect(page.getByText('docs/report.md')).toBeVisible();
  // Superseded badge proves it never claims a later version as its own op.
  await expect(page.getByText('Superseded', { exact: true })).toBeVisible();
  await expect(page.getByText('v2 → v3', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'View changes' }).click();
  // Real line diff from the exact immutable bytes.
  await expect(page.getByText('line two changed', { exact: true })).toBeVisible();
  await expect(page.getByText('line three', { exact: true })).toBeVisible();
  await expect(page.getByText('+2', { exact: false })).toBeVisible();
});

// ---------------------------------------------------------------------------
// B-02 — deletion + run-failed-partial appear; deleted-file bytes still load
// ---------------------------------------------------------------------------
test('B-02 deletion and failed-run committed work are discoverable with honest state', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');

  await page.route('**/collaboration/team-chat/threads/thread-A/changes**', (r) =>
    r.fulfill({
      headers: cors(baseURL!),
      json: {
        changes: [
          {
            versionId: 'vdel', fileId: 2, filePath: 'notes/old.md', changeKind: 'delete',
            actorId: 'u1', actorName: 'Alice', createdAt: '2026-09-19T11:00:00.000Z',
            sourceRunId: null, sourceMessageId: null, baseVersionId: 'v9', baseVersion: 9,
            version: 10, currentVersion: 10, superseded: false, runStatus: null, fileDeleted: true,
          },
          {
            versionId: 'vfail', fileId: 3, filePath: 'data/partial.txt', changeKind: 'content',
            actorId: null, actorName: 'Lumo', createdAt: '2026-09-19T11:05:00.000Z',
            sourceRunId: 'run-xyz', sourceMessageId: 'msg-1', baseVersionId: 'v1', baseVersion: 1,
            version: 2, currentVersion: 2, superseded: false, runStatus: 'failed', fileDeleted: false,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  // Deleted file: before=pre-delete bytes still retrievable from immutable row.
  await page.route('**/changes/vdel/content?side=before', (r) =>
    r.fulfill({ headers: { ...cors(baseURL!), 'Content-Type': 'text/markdown' }, body: 'content that existed before deletion\n' }),
  );

  await mountFixture(
    page,
    '__b_deletion',
    "import TeamThreadWorkHistory from '/src/components/chat/TeamThreadWorkHistory.tsx';",
    "React.createElement('div',{style:{width:360,padding:16}},React.createElement(TeamThreadWorkHistory,{workspaceId:'qc',threadId:'thread-A'}))",
  );
  await page.goto('/__b_deletion');

  await expect(page.getByText('File deleted', { exact: true })).toBeVisible();
  await expect(page.getByText('Run failed', { exact: true })).toBeVisible();
  // Failed run is not proof that nothing changed.
  await expect(page.getByText('was committed before it stopped', { exact: false })).toBeVisible();

  // Deleted-file bytes still load (immutable snapshot), showing the pre-delete content.
  await page.getByRole('button', { name: 'View changes' }).first().click();
  await expect(page.getByText('content that existed before deletion', { exact: true })).toBeVisible();
});

// ---------------------------------------------------------------------------
// B-03 — submit selected A only; list is summaries, full fetched by id
// ---------------------------------------------------------------------------
test('B-03 review lists summaries then loads full submission ops (no crash) and shows selected operations only', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');

  // LIST returns SUMMARIES (operationCount, NO operations) — mapping ops off
  // this would crash a naive client.
  await page.route('**/collaboration/objects/obj-1/submissions', (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    return r.fulfill({
      headers: cors(baseURL!),
      json: {
        submissions: [
          {
            id: 'sub-2', status: 'submitted', submittedBy: 'u1', publicExplanation: 'Only the A change',
            baseSharedRevision: 5, operationCount: 1, createdAt: '2026-09-19T12:10:00.000Z',
            appliedAt: null, reviews: [],
          },
        ],
      },
    });
  });
  // Full submission by exact id carries operations + reviews.
  await page.route('**/collaboration/objects/obj-1/submissions/sub-2', (r) =>
    r.fulfill({
      headers: cors(baseURL!),
      json: {
        id: 'sub-2', objectId: 'obj-1', sourceThreadId: 'thread-A', status: 'submitted',
        submittedBy: 'u1', publicExplanation: 'Only the A change', baseSharedRevision: 5,
        createdAt: '2026-09-19T12:10:00.000Z', appliedAt: null,
        operations: [
          { path: 'docs/a.md', fileId: 1, changeKind: 'content', baseVersionId: 'b1', proposedVersionId: 'p1', sha256: 'abc' },
        ],
        reviews: [
          { id: 'rev-1', reviewerId: 'u2', reviewerName: 'Bob', verdict: 'changes_requested', comment: 'Please tweak', createdAt: '2026-09-19T12:20:00.000Z' },
        ],
      },
    }),
  );

  await mountFixture(
    page,
    '__b_review',
    "import TeamThreadProposalReview from '/src/components/chat/TeamThreadProposalReview.tsx';",
    "React.createElement('div',{style:{width:380,padding:16}},React.createElement(TeamThreadProposalReview,{workspaceId:'qc',objectId:'obj-1',mode:'review',canReview:true,canApply:true}))",
  );
  await page.goto('/__b_review');

  // Selected operation from the FULL submission (proves list→detail fetch works).
  await expect(page.getByText('docs/a.md', { exact: true })).toBeVisible();
  await expect(page.getByText('Only the A change', { exact: true })).toBeVisible();
  // Review history from the full submission.
  await expect(page.getByText('Changes requested', { exact: true })).toBeVisible();
  await expect(page.getByText('Please tweak', { exact: true })).toBeVisible();
  // Unrelated B operations are never shown (only selected A op present).
  await expect(page.getByText('docs/b.md', { exact: true })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// B-04 — stale apply surfaces typed conflict; older submission cannot apply
// ---------------------------------------------------------------------------
test('B-04 concurrent shared edit → typed PROPOSAL_STALE conflict, no silent apply', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');

  await page.route('**/collaboration/objects/obj-2/submissions', (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    return r.fulfill({
      headers: cors(baseURL!),
      json: {
        submissions: [
          { id: 'sub-9', status: 'submitted', submittedBy: 'u1', publicExplanation: null, baseSharedRevision: 5, operationCount: 1, createdAt: '2026-09-19T13:00:00.000Z', appliedAt: null, reviews: [] },
        ],
      },
    });
  });
  await page.route('**/collaboration/objects/obj-2/submissions/sub-9', (r) =>
    r.fulfill({
      headers: cors(baseURL!),
      json: {
        id: 'sub-9', objectId: 'obj-2', sourceThreadId: 'thread-A', status: 'submitted', submittedBy: 'u1',
        publicExplanation: null, baseSharedRevision: 5, createdAt: '2026-09-19T13:00:00.000Z', appliedAt: null,
        operations: [{ path: 'docs/a.md', fileId: 1, changeKind: 'content', baseVersionId: 'b1', proposedVersionId: 'p1', sha256: 'abc' }],
        reviews: [],
      },
    }),
  );
  // Apply → typed 409 PROPOSAL_STALE.
  await page.route('**/collaboration/objects/obj-2/apply', (r) =>
    r.fulfill({ status: 409, headers: cors(baseURL!), json: { error: 'Shared Working moved', code: 'PROPOSAL_STALE' } }),
  );

  await mountFixture(
    page,
    '__b_stale',
    "import TeamThreadProposalReview from '/src/components/chat/TeamThreadProposalReview.tsx';",
    "React.createElement('div',{style:{width:380,padding:16}},React.createElement(TeamThreadProposalReview,{workspaceId:'qc',objectId:'obj-2',mode:'review',canApply:true}))",
  );
  await page.goto('/__b_stale');

  await page.getByRole('button', { name: 'Apply to Shared Working' }).click();
  await expect(page.getByText('Shared Working has changed', { exact: false })).toBeVisible();
  await expect(page.getByText('resubmit before applying', { exact: false })).toBeVisible();
});

// ---------------------------------------------------------------------------
// B-04b — missing/unauthorized snapshot 404 is an honest error, not empty diff
// ---------------------------------------------------------------------------
test('B-04b unexpected 404 on version bytes shows a failed preview, never a fake empty diff', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');

  await page.route('**/collaboration/team-chat/threads/thread-A/changes**', (r) =>
    r.fulfill({
      headers: cors(baseURL!),
      json: {
        changes: [
          {
            versionId: 'vX', fileId: 1, filePath: 'docs/x.md', changeKind: 'content',
            actorId: 'u1', actorName: 'Alice', createdAt: '2026-09-19T10:00:00.000Z',
            sourceRunId: null, sourceMessageId: null, baseVersionId: 'vW', baseVersion: 1,
            version: 2, currentVersion: 2, superseded: false, runStatus: null, fileDeleted: false,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  // A CONTENT change expects both sides present; a 404 here is a real failure
  // (missing/corrupt/unauthorized snapshot), not a legitimate absent side.
  await page.route('**/changes/vX/content?side=before', (r) =>
    r.fulfill({ status: 404, headers: cors(baseURL!), json: { error: 'snapshot missing' } }),
  );
  await page.route('**/changes/vX/content?side=after', (r) =>
    r.fulfill({ headers: { ...cors(baseURL!), 'Content-Type': 'text/markdown' }, body: 'new\n' }),
  );

  await mountFixture(
    page,
    '__b_missing',
    "import TeamThreadWorkHistory from '/src/components/chat/TeamThreadWorkHistory.tsx';",
    "React.createElement('div',{style:{width:360,padding:16}},React.createElement(TeamThreadWorkHistory,{workspaceId:'qc',threadId:'thread-A'}))",
  );
  await page.goto('/__b_missing');
  await page.getByRole('button', { name: 'View changes' }).click();
  await expect(page.getByText('Could not load version bytes', { exact: false })).toBeVisible();
  // It must NOT claim "No changes" / an empty successful diff.
  await expect(page.getByText('No changes', { exact: true })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// B-05 — linked items: anchor_changed keeps original excerpt; reattach uses a
// real version UUID; private annotation link is refused by the backend
// ---------------------------------------------------------------------------
test('B-05 linked item shows anchor_changed; reattach requires an explicit new excerpt on the chosen version', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');

  let reattachBody: Record<string, unknown> | null = null;

  await page.route('**/collaboration/team-chat/threads/thread-A/linked-items', (r) =>
    r.fulfill({
      headers: cors(baseURL!),
      json: {
        items: [
          {
            objectId: 'ann-1', type: 'annotation', status: 'open', title: null,
            fileId: 1, filePath: 'docs/report.md', anchorText: 'the original passage',
            anchorVersionId: 'uuid-v2', anchorVersionNumber: 2, currentVersionNumber: 4,
            fileDeleted: false, anchorChanged: true, createdAt: '2026-09-19T09:00:00.000Z',
          },
        ],
      },
    }),
  );
  // Version list returns REAL immutable ids (uuid), keyed by numeric fileId.
  await page.route('**/files/1/versions', (r) =>
    r.fulfill({ headers: cors(baseURL!), json: { versions: [
      { id: 'uuid-v4', version: 4, fileId: 1 },
      { id: 'uuid-v3', version: 3, fileId: 1 },
    ] } }),
  );
  // Raw source of the chosen version (download endpoint), for explicit selection.
  await page.route('**/files/1/download**', (r) =>
    r.fulfill({ headers: { ...cors(baseURL!), 'Content-Type': 'text/markdown' }, body: 'brand new passage here\nsecond line\n' }),
  );
  await page.route('**/collaboration/objects/ann-1/reattach-anchor', (r) => {
    reattachBody = r.request().postDataJSON();
    return r.fulfill({ headers: cors(baseURL!), json: {} });
  });

  await mountFixture(
    page,
    '__b_linked',
    "import TeamThreadLinkedItems from '/src/components/chat/TeamThreadLinkedItems.tsx';",
    "React.createElement('div',{style:{width:360,padding:16}},React.createElement(TeamThreadLinkedItems,{workspaceId:'qc',threadId:'thread-A',canManage:true,onOpenObject:function(){}}))",
  );
  await page.goto('/__b_linked');

  await expect(page.getByText('Anchor changed', { exact: true })).toBeVisible();
  await expect(page.getByText('the original passage', { exact: false })).toBeVisible();
  await expect(page.getByText('latest is version 4', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Reattach anchor' }).click();
  // Step 1: choose the version → its raw source loads for selection.
  await page.getByRole('button', { name: 'v4', exact: true }).click();
  const source = page.getByTestId('reattach-source');
  await expect(source).toBeVisible();
  // Step 2: make an EXPLICIT new selection of the first line ("brand new passage here" = 22 chars)
  // using cross-platform keyboard motion (macOS Home/End may scroll): select-all,
  // collapse to start, then extend right 22 times.
  await source.focus();
  // Collapse the caret to the start deterministically, then extend the
  // selection 22 chars with REAL keyboard motion (fires the component's
  // selection handlers). setSelectionRange only positions the caret.
  await source.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(0, 0); });
  for (let i = 0; i < 22; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await expect
    .poll(() => source.evaluate((el: HTMLTextAreaElement) => `${el.selectionStart}:${el.selectionEnd}`))
    .toBe('0:22');
  await expect(page.getByTestId('reattach-selection')).toContainText('brand new passage here');
  // Step 3: confirm — submits exact offsets + the NEW excerpt, not the old one.
  await page.getByRole('button', { name: 'Reattach to this selection' }).click();
  await expect.poll(() => reattachBody?.anchorVersionId).toBe('uuid-v4');
  expect(reattachBody?.anchorStart).toBe(0);
  expect(reattachBody?.anchorEnd).toBe(22);
  expect(reattachBody?.anchorText).toBe('brand new passage here');
});

// ---------------------------------------------------------------------------
// B-06 — explicit future-editor association: stamps sourceThreadId on save,
// opening a thread never reattributes, and sign-out clears the association
// ---------------------------------------------------------------------------
test('B-06 future association is explicit, stamps saves, and clears on sign-out', async ({ page, baseURL }) => {
  test.skip(localOnly(baseURL), 'Local Vite required');

  const bodies: Array<Record<string, unknown>> = [];
  await page.route('**/workspaces/qc/files/1/content', (r) => {
    bodies.push(r.request().postDataJSON());
    return r.fulfill({ headers: cors(baseURL!), json: { version: 2 } });
  });

  // Seed an authenticated local user so the association helper has an identity.
  await page.addInitScript(() => {
    window.localStorage.setItem('helpudoc-auth-user', JSON.stringify({ id: 'u1', name: 'Alice', provider: 'local' }));
  });

  await mountFixture(
    page,
    '__b_assoc',
    `import { updateFileContent } from '/src/services/fileApi.ts';
     import { setThreadAssociation, clearThreadAssociation, getAssociatedThreadId } from '/src/services/teamThreadAssociation.ts';`,
    `React.createElement('div',{style:{padding:16}},
       React.createElement('button',{'data-testid':'save',onClick:function(){updateFileContent('qc',1,'hello');}},'Save'),
       React.createElement('button',{'data-testid':'associate',onClick:function(){setThreadAssociation('qc','thread-A','A');}},'Associate'),
       React.createElement('button',{'data-testid':'open-other',onClick:function(){/* opening another thread must NOT change attribution */}},'OpenOther'),
       React.createElement('button',{'data-testid':'signout',onClick:function(){clearThreadAssociation();}},'SignOut'))`,
  );
  await page.goto('/__b_assoc');

  // 1) No association → save is unattributed (no sourceThreadId).
  await page.getByTestId('save').click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].sourceThreadId).toBeUndefined();

  // 2) Explicit associate → subsequent save carries the thread id.
  await page.getByTestId('associate').click();
  await page.getByTestId('open-other').click(); // opening another thread does nothing
  await page.getByTestId('save').click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1].sourceThreadId).toBe('thread-A');

  // 3) Sign-out clears association → save is unattributed again.
  await page.getByTestId('signout').click();
  await page.getByTestId('save').click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2].sourceThreadId).toBeUndefined();
});

