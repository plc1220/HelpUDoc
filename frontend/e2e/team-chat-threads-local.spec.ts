import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Release A team-chat threads — browser validation (spec §9: A01, A02, A03,
 * A10, A13) plus the rollout fallback and two regression repros (composer stale
 * clear; list load-more stranding).
 *
 * These tests mount the ACTUAL production `WorkspaceTeamChatPanel` (which gates
 * on readiness and renders the real `TeamThreadList` / `TeamThreadDetail` /
 * `TeamChatComposer`) inside a router, and intercept the real collaboration API
 * with a realistic in-memory fake. No substitute UI is used.
 */

const BASE = 'http://127.0.0.1:5179';
const WS = 'wsA';
const FIXTURE = '/e2e/fixtures/team-chat-threads.html';

const only = (baseURL?: string) => !baseURL || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL);

// apiFetch uses credentials:'include', so the ACAO header must echo the actual
// origin (never '*') and allow credentials, or the browser blocks the response.
const corsHeaders = { 'access-control-allow-origin': BASE, 'access-control-allow-credentials': 'true' };
const cors = (route: Route, json: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', headers: corsHeaders, body: JSON.stringify(json) });

const gotoFixture = (page: Page, query = '') => page.goto(`${BASE}${FIXTURE}${query}`);

type Thread = {
  id: string;
  workspaceId: string;
  title: string;
  status: 'open' | 'resolved';
  rootMessageId: string | null;
  rootPreview: string;
  createdBy: string | null;
  replyCount: number;
  lastActivityAt: string;
  lastMessageSeq: number;
  participants: Array<{ userId: string; displayName: string }>;
  unread: boolean;
  unreadCount: number;
  following: boolean;
  runStatus: string | null;
  createdAt: string;
  updatedAt: string;
};

type Message = {
  id: string;
  workspaceId: string;
  threadId: string;
  sequence: number;
  authorId: string | null;
  authorType: 'user' | 'lumo' | 'system';
  authorName: string;
  body: string;
  replyToMessageId: string | null;
  threadRootId: string | null;
  mentionsLumo: boolean;
  mentionedUserIds: string[];
  isMentioned: boolean;
  isMine: boolean;
  metadata: Record<string, unknown> | null;
  clientMessageId: string | null;
  originVersionId: string | null;
  originVersionNumber: number | null;
  createdAt: string;
  updatedAt: string;
};

// The harness fixture (e2e/fixtures/team-chat-threads.{tsx,html}) mounts the
// ACTUAL WorkspaceTeamChatPanel inside a BrowserRouter with a preloaded local
// auth user. Tests only need to install the intercepted API, then navigate.

test.describe('Release A team-chat threads (real panel)', () => {
  test.beforeEach(async ({ baseURL }) => {
    test.skip(only(baseURL), 'Local Vite required at 127.0.0.1:5179');
  });

  test('A01: three consecutive sends stay in the thread; quote cancel does not exit; reply-to-reply stays same depth', async ({ page }) => {
    const state = new FakeBackend();
    state.seedThread('t1', 'Kickoff', [{ body: 'Opening message', author: 'Ana' }]);
    await installApi(page, state, { enabled: true, ready: true });

    await gotoFixture(page);
    await page.getByTestId('thread-item-t1').click();
    const feed = page.getByTestId('thread-message-scroll');
    await expect(feed.getByText('Opening message')).toBeVisible();

    const box = page.getByRole('textbox', { name: 'Workspace Chat message' });
    for (const text of ['first reply', 'second reply', 'third reply']) {
      await box.fill(text);
      await page.getByTestId('composer-send').click();
      await expect(feed.getByText(text, { exact: true })).toBeVisible();
    }
    // All three belong to t1 without clicking Reply.
    expect(state.messagesFor('t1').filter((m) => m.threadId === 't1' && /reply$/.test(m.body)).length).toBe(3);

    // Quote a message, then cancel — must stay in the thread (composer visible).
    await page.getByTestId(`thread-message-${state.messagesFor('t1')[1].id}`).getByRole('button', { name: 'Reply' }).click();
    await expect(page.getByTestId('thread-quote-target')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel reply' }).click();
    await expect(page.getByTestId('thread-quote-target')).toHaveCount(0);
    await expect(box).toBeVisible();

    // Reply to a reply: quote target, send, then send again without a quote —
    // both stay in t1.
    const secondReply = state.messagesFor('t1').find((m) => m.body === 'second reply')!;
    await page.getByTestId(`thread-message-${secondReply.id}`).getByRole('button', { name: 'Reply' }).click();
    await box.fill('reply to a reply');
    await page.getByTestId('composer-send').click();
    await expect(feed.getByText('reply to a reply', { exact: true })).toBeVisible();
    await box.fill('follow-up without quote');
    await page.getByTestId('composer-send').click();
    await expect(feed.getByText('follow-up without quote', { exact: true })).toBeVisible();
    // The reply-to-reply carries a quote link (same visual depth, compact link).
    const r2r = state.messagesFor('t1').find((m) => m.body === 'reply to a reply')!;
    expect(r2r.replyToMessageId).toBe(secondReply.id);
    expect(state.messagesFor('t1').every((m) => m.threadId === 't1')).toBe(true);
  });

  test('A02: failed send preserves text/references/destination; switching threads cannot misroute the retry', async ({ page }) => {
    const state = new FakeBackend();
    state.seedThread('t1', 'Alpha', [{ body: 'alpha root', author: 'Ana' }]);
    state.seedThread('t2', 'Beta', [{ body: 'beta root', author: 'Bo' }]);
    await installApi(page, state, { enabled: true, ready: true });

    await gotoFixture(page);
    await page.getByTestId('thread-item-t1').click();
    const box = page.getByRole('textbox', { name: 'Workspace Chat message' });
    const feed = page.getByTestId('thread-message-scroll');

    // Compose text WITH an explicit @mention reference so we verify references
    // (not just text) survive a failed send and thread switch (review: A02
    // references). Ana is a collaborator provided by installApi.
    state.failNextPost = true;
    await box.fill('draft that fails @');
    // The reference menu opens on '@'; pick Ana.
    await page.getByRole('option', { name: /Ana/ }).first().click();
    await expect(page.getByLabel('Selected references')).toContainText('Ana');
    await page.getByTestId('composer-send').click();
    await expect(page.getByTestId('thread-failed-draft')).toBeVisible();
    // Draft text AND the reference chip are preserved.
    await expect(box).toHaveValue(/draft that fails/);
    await expect(page.getByLabel('Selected references')).toContainText('Ana');

    // Switch to t2 and back — the failed draft must NOT have been sent to t2.
    await page.getByTestId('thread-item-t2').click();
    await expect(feed.getByText('beta root')).toBeVisible();
    await expect(box).toHaveValue('');
    await page.getByTestId('thread-item-t1').click();
    await expect(box).toHaveValue(/draft that fails/);
    // The reference survived the round trip (exact token structure preserved).
    await expect(page.getByLabel('Selected references')).toContainText('Ana');

    // Now allow the retry to succeed; it must post to t1 only, once, with the mention.
    state.failNextPost = false;
    await page.getByTestId('composer-send').click();
    await expect(feed.getByText(/draft that fails/)).toBeVisible();
    expect(state.messagesFor('t2').some((m) => /draft that fails/.test(m.body))).toBe(false);
    const t1hit = state.messagesFor('t1').filter((m) => /draft that fails/.test(m.body));
    // Idempotent: exactly one message despite the earlier failed attempt.
    expect(t1hit.length).toBe(1);
    expect(t1hit[0].mentionedUserIds).toContain('ana');
  });

  test('A03: >500 messages, old root with recent replies — list, thread, deep link expose the paginated discussion', async ({ page }) => {
    const state = new FakeBackend();
    // An old root thread with 520 messages.
    state.seedLargeThread('big', 'Long running topic', 520);
    await installApi(page, state, { enabled: true, ready: true });

    await gotoFixture(page);
    await page.getByTestId('thread-item-big').click();
    const feed = page.getByTestId('thread-message-scroll');
    // Latest page shows the newest message; older ones require Load earlier.
    await expect(feed.getByText('message 520', { exact: true })).toBeVisible();
    await expect(feed.getByText('message 1', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Load earlier messages' }).click();
    await expect(feed.getByText('message 470', { exact: true })).toBeVisible();

    // Deep link to the OLD root message: around-pagination reveals it + neighbors.
    const rootId = state.messagesFor('big')[0].id;
    await gotoFixture(page, `?workspaceId=${WS}&channel=team&messageId=${rootId}`);
    await expect(page.getByTestId(`thread-message-${rootId}`)).toBeVisible();
    await expect(page.getByTestId('thread-message-scroll').getByText('message 1', { exact: true })).toBeVisible();
  });

  test('A10: background tab does not advance read state; focused displayed messages do; monotonic', async ({ page }) => {
    const state = new FakeBackend();
    state.seedThread('t1', 'Reading', [{ body: 'r1', author: 'Ana' }, { body: 'r2', author: 'Bo' }, { body: 'r3', author: 'Cy' }]);
    await installApi(page, state, { enabled: true, ready: true });
    // Control the clock so we can advance PAST the real 5s poll interval.
    await page.clock.install();

    await gotoFixture(page);
    await page.getByTestId('thread-item-t1').click();
    const feed = page.getByTestId('thread-message-scroll');
    await expect(feed.getByText('r3', { exact: true })).toBeVisible();
    // Focused reading advances read state to the highest displayed seq.
    await expect.poll(() => state.lastReadSeq('t1', 'me')).toBeGreaterThanOrEqual(3);
    const advanced = state.lastReadSeq('t1', 'me');
    expect(advanced).toBe(3);

    // Background tab: a NEW server message arrives and the real poll runs, but
    // read state must NOT advance while hidden (spec F4/A10).
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('blur'));
    });
    const before = state.pollCount;
    state.appendServerMessage('t1', { body: 'r4 while hidden', author: 'Ana' });
    // Advance past the 5s poll so a background fetch actually occurs.
    await page.clock.runFor(6000);
    await expect.poll(() => state.pollCount).toBeGreaterThan(before); // background fetch happened
    expect(state.lastReadSeq('t1', 'me')).toBe(advanced); // but read state did NOT advance

    // Focus regains: the newly-visible message advances read state monotonically.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect(feed.getByText('r4 while hidden', { exact: true })).toBeVisible();
    await expect.poll(() => state.lastReadSeq('t1', 'me')).toBeGreaterThanOrEqual(4);
    expect(state.lastReadSeq('t1', 'me')).toBeGreaterThanOrEqual(advanced); // monotonic
  });

  test('A13: resolve/reopen, human-message reopen, filters, follow, Back, keyboard, narrow layout', async ({ page }) => {
    const state = new FakeBackend();
    state.seedThread('t1', 'Lifecycle', [{ body: 'root', author: 'Ana' }]);
    await installApi(page, state, { enabled: true, ready: true });

    await gotoFixture(page, '?paneWidth=360');
    // Narrow panel: list shows, opening a thread replaces it with a Back button.
    await page.getByTestId('thread-item-t1').click();
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();

    // Resolve, then verify a human message reopens it.
    await page.getByRole('button', { name: 'Resolve' }).click();
    await expect.poll(() => state.thread('t1').status).toBe('resolved');
    const box = page.getByRole('textbox', { name: 'Workspace Chat message' });
    await box.fill('reopening reply');
    await page.getByTestId('composer-send').click();
    await expect.poll(() => state.thread('t1').status).toBe('open');

    // Follow toggles.
    await page.getByRole('button', { name: 'Follow' }).click();
    await expect.poll(() => state.thread('t1').following).toBe(true);

    // Back returns to the list (browser Back also works via history).
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByTestId('team-thread-list')).toBeVisible();
    await page.getByTestId('thread-item-t1').click();
    await expect(page.getByRole('button', { name: 'Back' }).first()).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('team-thread-list')).toBeVisible();

    // Filters: Resolved shows nothing (t1 is open), Open shows t1.
    await page.getByRole('button', { name: 'Resolved', exact: true }).click();
    await expect(page.getByTestId('thread-item-t1')).toHaveCount(0);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByTestId('thread-item-t1')).toBeVisible();
  });

  test('Rollout fallback: when not enabled/ready, the legacy panel renders (no thread UI)', async ({ page }) => {
    const state = new FakeBackend();
    state.seedThread('t1', 'Hidden', [{ body: 'legacy root', author: 'Ana' }]);
    await installApi(page, state, { enabled: false, ready: false });

    await gotoFixture(page);
    // Legacy panel has NO thread list; it shows the flat feed via the legacy
    // messages endpoint.
    await expect(page.getByTestId('team-thread-list')).toHaveCount(0);
    await expect(page.getByText('legacy root')).toBeVisible();
  });

  test('New thread: empty composer creates nothing; first message atomically creates the thread with an optional title', async ({ page }) => {
    const state = new FakeBackend();
    state.seedThread('existing', 'Existing', [{ body: 'hi', author: 'Ana' }]);
    await installApi(page, state, { enabled: true, ready: true });

    await gotoFixture(page);
    const threadCountBefore = state.threads.size;
    await page.getByRole('button', { name: 'New thread' }).click();
    // Empty composer: the Send/Start button is disabled — no DB row is created.
    await expect(page.getByTestId('composer-send')).toBeDisabled();
    expect(state.threads.size).toBe(threadCountBefore);

    // Type a title and the first message; the first send creates the thread.
    await page.getByRole('textbox', { name: 'New thread title' }).fill('Launch plan');
    const box = page.getByRole('textbox', { name: 'Workspace Chat message' });
    await box.fill('Opening message for the new thread');
    await page.getByTestId('composer-send').click();

    // A new thread was created atomically with its opening message and title.
    await expect.poll(() => state.threads.size).toBe(threadCountBefore + 1);
    const created = [...state.threads.values()].find((t) => t.title === 'Launch plan')!;
    expect(created).toBeTruthy();
    expect(state.messagesFor(created.id)[0].body).toBe('Opening message for the new thread');
    // The panel opens the created thread and shows its message.
    await expect(page.getByTestId('thread-message-scroll').getByText('Opening message for the new thread')).toBeVisible();
  });

  test('A02+: a committed send whose response is lost retries with the SAME clientMessageId (no duplicate)', async ({ page }) => {
    const state = new FakeBackend();
    state.seedThread('t1', 'Idempotent', [{ body: 'root', author: 'Ana' }]);
    await installApi(page, state, { enabled: true, ready: true });

    // The first POST commits server-side but the RESPONSE is dropped (network
    // error after commit) — the classic "unknown outcome" case.
    let dropped = false;
    await page.route(`**/api/workspaces/${WS}/collaboration/team-chat/threads/t1/messages`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = route.request().postDataJSON();
      // Commit on the server regardless.
      state.postMessage('t1', body.body, body.replyToMessageId ?? null, body.clientMessageId);
      if (!dropped) {
        dropped = true;
        return route.abort('failed'); // response lost after commit
      }
      // Retry: return the deduped existing message.
      const existing = state.messagesFor('t1').find((m) => m.clientMessageId === body.clientMessageId)!;
      return cors(route, existing, 201);
    });

    await gotoFixture(page);
    await page.getByTestId('thread-item-t1').click();
    const box = page.getByRole('textbox', { name: 'Workspace Chat message' });
    await box.fill('exactly once please');
    await page.getByTestId('composer-send').click();
    // The dropped response surfaces a failed draft; the text is preserved.
    await expect(page.getByTestId('thread-failed-draft')).toBeVisible();
    await expect(box).toHaveValue('exactly once please');
    // Retry: reuses the SAME clientMessageId, so the server dedupes.
    await page.getByTestId('composer-send').click();
    await expect(page.getByTestId('thread-message-scroll').getByText('exactly once please')).toBeVisible();
    expect(state.messagesFor('t1').filter((m) => m.body === 'exactly once please').length).toBe(1);
  });

  test('Access loss: a 403 unmounts the list/detail, shows an inaccessible state, clears drafts, and stops polling', async ({ page }) => {
    const state = new FakeBackend();
    state.seedThread('t1', 'Confidential', [{ body: 'sensitive', author: 'Ana' }]);
    await installApi(page, state, { enabled: true, ready: true });
    await page.clock.install();

    await gotoFixture(page);
    await page.getByTestId('thread-item-t1').click();
    await expect(page.getByTestId('thread-message-scroll').getByText('sensitive')).toBeVisible();

    // Leave an unsent draft, then revoke access (all collaboration calls 403).
    await page.getByRole('textbox', { name: 'Workspace Chat message' }).fill('secret draft');
    let forbidden = 0;
    await page.route(`**/api/workspaces/${WS}/collaboration/**`, (route) => {
      forbidden += 1;
      return cors(route, { error: 'Forbidden' }, 403);
    });
    // Advance past the poll so a 403 arrives.
    await page.clock.runFor(6000);
    // Explicit inaccessible state; list/detail unmounted (no thread items).
    await expect(page.getByTestId('team-chat-access-lost')).toBeVisible();
    await expect(page.getByTestId('thread-item-t1')).toHaveCount(0);
    await expect(page.getByTestId('thread-message-scroll')).toHaveCount(0);
    // The unsent draft was cleared.
    const draftPresent = await page.evaluate(async () => {
      const drafts = await import('/src/components/chat/teamThreadDrafts.ts');
      return Boolean(drafts.getThreadDraft('me', 'wsA', 't1'));
    });
    expect(draftPresent).toBe(false);
    // Polling has stopped: no further collaboration calls after another cycle.
    const calls = forbidden;
    await page.clock.runFor(6000);
    expect(forbidden).toBe(calls);
  });
});

// ---------------------------------------------------------------------------
// A realistic in-memory fake of the collaboration backend.
// ---------------------------------------------------------------------------

class FakeBackend {
  threads = new Map<string, Thread>();
  messages = new Map<string, Message[]>();
  readState = new Map<string, number>(); // `${threadId}:${userId}` -> lastReadSeq
  failNextPost = false;
  pollCount = 0;
  private seq = 0;

  private now() {
    this.seq += 1;
    return new Date(Date.UTC(2026, 8, 20, 0, 0, this.seq)).toISOString();
  }

  seedThread(id: string, title: string, msgs: Array<{ body: string; author: string }>) {
    const list: Message[] = [];
    msgs.forEach((m, index) => {
      list.push(this.makeMessage(id, index + 1, m.body, m.author, index === 0));
    });
    this.messages.set(id, list);
    this.threads.set(id, {
      id,
      workspaceId: WS,
      title,
      status: 'open',
      rootMessageId: list[0]?.id ?? null,
      rootPreview: msgs[0]?.body ?? '',
      createdBy: 'ana',
      replyCount: Math.max(list.length - 1, 0),
      lastActivityAt: list[list.length - 1]?.createdAt ?? this.now(),
      lastMessageSeq: list.length,
      participants: [...new Set(msgs.map((m) => m.author))].map((name) => ({ userId: name.toLowerCase(), displayName: name })),
      unread: false,
      unreadCount: 0,
      following: false,
      runStatus: null,
      createdAt: list[0]?.createdAt ?? this.now(),
      updatedAt: this.now(),
    });
  }

  seedLargeThread(id: string, title: string, count: number) {
    const list: Message[] = [];
    for (let i = 1; i <= count; i += 1) list.push(this.makeMessage(id, i, `message ${i}`, 'Ana', i === 1));
    this.messages.set(id, list);
    this.threads.set(id, {
      id, workspaceId: WS, title, status: 'open',
      rootMessageId: list[0].id, rootPreview: 'message 1', createdBy: 'ana',
      replyCount: count - 1, lastActivityAt: list[count - 1].createdAt, lastMessageSeq: count,
      participants: [{ userId: 'ana', displayName: 'Ana' }],
      unread: false, unreadCount: 0, following: false, runStatus: null,
      createdAt: list[0].createdAt, updatedAt: this.now(),
    });
  }

  private makeMessage(threadId: string, sequence: number, body: string, author: string, isRoot: boolean): Message {
    const ts = this.now();
    return {
      id: `${threadId}-m${sequence}`,
      workspaceId: WS,
      threadId,
      sequence,
      authorId: author.toLowerCase(),
      authorType: 'user',
      authorName: author,
      body,
      replyToMessageId: null,
      threadRootId: isRoot ? null : `${threadId}-m1`,
      mentionsLumo: false,
      mentionedUserIds: [],
      isMentioned: false,
      isMine: author === 'Me',
      metadata: {},
      clientMessageId: null,
      originVersionId: null,
      originVersionNumber: null,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  thread(id: string) { return this.threads.get(id)!; }
  messagesFor(id: string) { return this.messages.get(id) ?? []; }
  lastReadSeq(threadId: string, userId: string) { return this.readState.get(`${threadId}:${userId}`) ?? 0; }

  appendServerMessage(threadId: string, m: { body: string; author: string }) {
    const list = this.messages.get(threadId)!;
    const msg = this.makeMessage(threadId, list.length + 1, m.body, m.author, false);
    list.push(msg);
    const t = this.thread(threadId);
    t.lastMessageSeq = msg.sequence;
    t.lastActivityAt = msg.createdAt;
    t.replyCount = list.length - 1;
    return msg;
  }

  postMessage(threadId: string, body: string, replyToMessageId: string | null, clientMessageId: string, mentionedUserIds: string[] = []) {
    const list = this.messages.get(threadId)!;
    const existing = list.find((m) => m.clientMessageId === clientMessageId);
    if (existing) return existing; // idempotent
    const msg = this.makeMessage(threadId, list.length + 1, body, 'Me', false);
    msg.replyToMessageId = replyToMessageId;
    msg.clientMessageId = clientMessageId;
    msg.mentionedUserIds = mentionedUserIds;
    list.push(msg);
    const t = this.thread(threadId);
    t.lastMessageSeq = msg.sequence;
    t.lastActivityAt = msg.createdAt;
    t.replyCount = list.length - 1;
    if (t.status === 'resolved') t.status = 'open'; // human message reopens
    return msg;
  }
}

async function installApi(page: Page, state: FakeBackend, readiness: { enabled: boolean; ready: boolean; unmappedMessageCount: number }) {
  const api = `**/api/workspaces/${WS}/collaboration`;

  await page.route(`${api}/team-chat/readiness`, (route) => cors(route, readiness));

  // Legacy flat feed (used only when readiness is off).
  await page.route(`${api}/team-chat/messages*`, (route) => {
    const all = [...state.messages.values()].flat();
    return cors(route, { messages: all });
  });

  await page.route(`${api}/team-chat/threads**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const path = url.pathname;

    // /threads (list or create)
    if (path.endsWith('/team-chat/threads')) {
      if (method === 'POST') {
        const body = req.postDataJSON();
        // Create a new thread with its root.
        const id = `new-${Date.now()}`;
        state.seedThread(id, body.title || body.body.split('\n')[0].slice(0, 80), [{ body: body.body, author: 'Me' }]);
        const t = state.thread(id);
        const m = state.messagesFor(id)[0];
        m.clientMessageId = body.clientMessageId;
        return cors(route, { thread: t, message: m }, 201);
      }
      const status = url.searchParams.get('status') || 'all';
      const cursor = url.searchParams.get('cursor');
      let all = [...state.threads.values()].filter((t) => (status === 'all' ? true : t.status === status));
      all = all.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
      // 30/page cursor by index.
      const start = cursor ? Number(cursor) : 0;
      const pageRows = all.slice(start, start + 30);
      const nextCursor = start + 30 < all.length ? String(start + 30) : null;
      return cors(route, { threads: pageRows, nextCursor });
    }

    // /threads/:id/messages
    const msgMatch = path.match(/\/team-chat\/threads\/([^/]+)\/messages$/);
    if (msgMatch) {
      const threadId = msgMatch[1];
      const list = state.messagesFor(threadId);
      const t = state.thread(threadId);
      if (method === 'POST') {
        if (state.failNextPost) {
          state.failNextPost = false;
          return cors(route, { error: 'Simulated send failure' }, 500);
        }
        const body = req.postDataJSON();
        const msg = state.postMessage(threadId, body.body, body.replyToMessageId ?? null, body.clientMessageId, body.mentionedUserIds ?? []);
        return cors(route, msg, 201);
      }
      const limit = Number(url.searchParams.get('limit') || 50);
      const beforeSeq = url.searchParams.get('beforeSeq');
      const afterSeq = url.searchParams.get('afterSeq');
      const aroundMessageId = url.searchParams.get('aroundMessageId');
      state.pollCount += 1;
      let rows: Message[];
      if (aroundMessageId) {
        const target = list.find((m) => m.id === aroundMessageId)!;
        const half = Math.floor(limit / 2);
        const older = list.filter((m) => m.sequence < target.sequence).slice(-half);
        const newer = list.filter((m) => m.sequence >= target.sequence).slice(0, limit - half);
        rows = [...older, ...newer];
      } else if (afterSeq != null) {
        rows = list.filter((m) => m.sequence > Number(afterSeq)).slice(0, limit);
      } else if (beforeSeq != null) {
        rows = list.filter((m) => m.sequence < Number(beforeSeq)).slice(-limit);
      } else {
        rows = list.slice(-limit);
      }
      const seqs = rows.map((m) => m.sequence);
      const minSeq = seqs.length ? Math.min(...seqs) : 0;
      const maxSeq = seqs.length ? Math.max(...seqs) : 0;
      return cors(route, {
        thread: t,
        messages: rows,
        olderCursor: minSeq > 1 ? String(minSeq) : null,
        newerCursor: maxSeq < t.lastMessageSeq ? String(maxSeq) : null,
        hasOlder: minSeq > 1,
        hasNewer: maxSeq < t.lastMessageSeq,
      });
    }

    // /threads/:id/read-state
    const readMatch = path.match(/\/team-chat\/threads\/([^/]+)\/read-state$/);
    if (readMatch && method === 'PUT') {
      const threadId = readMatch[1];
      const body = req.postDataJSON();
      const key = `${threadId}:me`;
      const clamped = Math.max(state.readState.get(key) ?? 0, Math.min(body.lastReadSeq, state.thread(threadId).lastMessageSeq));
      state.readState.set(key, clamped);
      return cors(route, { lastReadSeq: clamped });
    }

    // /threads/:id/follow-state
    const followMatch = path.match(/\/team-chat\/threads\/([^/]+)\/follow-state$/);
    if (followMatch && method === 'PUT') {
      const threadId = followMatch[1];
      const body = req.postDataJSON();
      state.thread(threadId).following = body.following;
      return cors(route, { following: body.following });
    }

    // PATCH /threads/:id (rename/status)
    const patchMatch = path.match(/\/team-chat\/threads\/([^/]+)$/);
    if (patchMatch && method === 'PATCH') {
      const threadId = patchMatch[1];
      const body = req.postDataJSON();
      const t = state.thread(threadId);
      if (body.title !== undefined) t.title = body.title;
      if (body.status !== undefined) t.status = body.status;
      return cors(route, { thread: t });
    }

    // GET /threads/:id (metadata)
    if (patchMatch && method === 'GET') {
      return cors(route, { thread: state.thread(patchMatch[1]) });
    }

    return cors(route, { error: 'not found' }, 404);
  });

  // Deep-link resolver GET /team-chat/messages/:id -> {message, threadId, sequence}
  await page.route(`${api}/team-chat/messages/*`, (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/').pop()!;
    const msg = [...state.messages.values()].flat().find((m) => m.id === id);
    if (!msg) return cors(route, { error: 'not found' }, 404);
    return cors(route, { message: msg, threadId: msg.threadId, sequence: msg.sequence });
  });

  // Collaborators + files + slash metadata (reference options).
  await page.route(`**/api/workspaces/${WS}/collaborators`, (route) => cors(route, { collaborators: [{ userId: 'ana', displayName: 'Ana', role: 'editor' }] }));
  await page.route(`**/api/workspaces/${WS}/files`, (route) => cors(route, []));
  await page.route('**/api/agent/**', (route) => cors(route, { skills: [] }));
}
