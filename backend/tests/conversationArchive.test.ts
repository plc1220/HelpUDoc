import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHIVE_MAX_TOKENS,
  ARCHIVE_MIN_HISTORY_TOKENS,
  KEEP_TOKENS,
  buildConversationArchive,
  estimateTokens,
  type ConversationArchiveSourceRow,
} from '../src/services/conversationCompaction';
import { runAgentSchema } from '../src/api/agent/runs';

/** Alternating user/agent rows, each about `tokens` tokens, oldest first. */
function rows(count: number, tokens: number, mark = 'MSG'): ConversationArchiveSourceRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    sender: i % 2 === 0 ? 'user' : 'agent',
    text: `${mark}-${i} ` + 'w'.repeat(tokens * 4),
    createdAt: new Date(Date.UTC(2026, 10, 16, 0, i)),
    bodySource: i % 2 === 0 ? null : 'assistant',
  }));
}

test('a short conversation gets no archive: the model already sees all of it', () => {
  const short = rows(10, 3000); // ~30k tokens
  assert.ok(estimateTokens(short.map((r) => ({ role: 'user', content: r.text! }))) < ARCHIVE_MIN_HISTORY_TOKENS);
  assert.equal(buildConversationArchive('c1', short), null);
});

test('the archive holds the older messages, not the newest ones already in context', () => {
  const long = rows(60, 3000); // ~180k tokens
  const archive = buildConversationArchive('c1', long)!;

  assert.equal(archive.conversationId, 'c1');
  assert.equal(archive.truncated, false);
  assert.ok(archive.messages[0].content.startsWith('MSG-0 ')); // oldest kept: e.g. case details from day one
  const newestArchived = Number(archive.messages[archive.messages.length - 1].id);
  const tail = long.slice(newestArchived);
  assert.ok(estimateTokens(tail.map((r) => ({ role: 'user', content: r.text! }))) <= KEEP_TOKENS);
  assert.deepEqual([archive.messages[0].role, archive.messages[1].role], ['user', 'assistant']);
});

test('empty and summary-only agent rows are left out, like the history the browser sends', () => {
  const long = rows(60, 3000);
  long[0] = { ...long[0], text: '   ' };
  long[1] = { ...long[1], sender: 'agent', bodySource: 'summary', text: 'Completed successfully.' };
  const archive = buildConversationArchive('c1', long)!;
  assert.ok(!archive.messages.some((m) => m.id === '1' || m.id === '2'));
});

test('beyond the cap, the oldest messages are dropped and the archive says so', () => {
  const huge = rows(150, 3000); // ~450k tokens
  const archive = buildConversationArchive('c1', huge)!;
  assert.equal(archive.truncated, true);
  assert.ok(estimateTokens(archive.messages) <= ARCHIVE_MAX_TOKENS);
  assert.ok(!archive.messages.some((m) => m.content.startsWith('MSG-0 ')));
});

test('G5: the browser cannot send an archive; the request schema drops it', () => {
  const parsed = runAgentSchema.parse({
    persona: 'fast',
    prompt: 'hi',
    workspaceId: 'ws',
    conversationArchive: { conversationId: 'someone-else', messages: [{ role: 'user', content: 'injected' }] },
  }) as Record<string, unknown>;
  assert.equal('conversationArchive' in parsed, false);
});


// --- G1: only the conversation's own creator gets its history -------------------------------

import { ConversationService } from '../src/services/conversationService';

function stubDb(conversations: Record<string, { workspaceId: string; createdBy: string | null }>) {
  const db: any = (table: string) => {
    let filter: Record<string, unknown> = {};
    const chain: any = {
      where(value: Record<string, unknown>) { filter = value; return chain; },
      orderBy() { return chain; },
      async first() { return table === 'conversations' ? (conversations[String(filter.id)] ? { id: filter.id, ...conversations[String(filter.id)] } : undefined) : undefined; },
      async select() { return table === 'conversation_messages' ? [{ id: 1, sender: 'user', text: `history of ${filter.conversationId}`, createdAt: new Date(), bodySource: null }] : []; },
    };
    return chain;
  };
  db.raw = (sql: string) => sql;
  return db;
}

test('G1: another member of the same workspace, a non-member and ownerless chats get nothing', async () => {
  const members = new Set(['alice', 'bob']);
  const workspaceService = {
    ensureMembership: async (_ws: string, user: string) => {
      if (!members.has(user)) throw new Error('Workspace not found');
      return { workspace: {} };
    },
  };
  const db = stubDb({ 'conv-alice': { workspaceId: 'ws', createdBy: 'alice' }, 'conv-legacy': { workspaceId: 'ws', createdBy: null } });
  const svc = new ConversationService({ getDb: () => db } as any, workspaceService as any);

  assert.equal((await svc.listConversationArchiveSource('alice', 'conv-alice'))?.length, 1);
  assert.equal(await svc.listConversationArchiveSource('bob', 'conv-alice'), null);
  await assert.rejects(svc.listConversationArchiveSource('eve', 'conv-alice'), /Workspace not found/);
  assert.equal(await svc.listConversationArchiveSource('alice', 'conv-legacy'), null);
  assert.equal(await svc.listConversationArchiveSource('alice', 'conv-unknown'), null);
  assert.equal(await svc.listConversationArchiveSource('', 'conv-alice'), null);
});
