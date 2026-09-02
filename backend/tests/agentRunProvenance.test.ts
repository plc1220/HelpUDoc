import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentRunProvenanceService,
  MAX_TEXT_BYTES,
  collectKnowledgeChunks,
  truncateText,
  type RunKnowledgeChunk,
} from '../src/services/agentRunProvenanceService';

// --- knowledge chunk parsing -------------------------------------------------

test('knowledge chunks are pulled out of a knowledge_search result', () => {
  const into: RunKnowledgeChunk[] = [];
  collectKnowledgeChunks(JSON.stringify({
    results: [
      { path: 'knowledge://88/10k.md', title: 'FY24 10-K', snapshotId: 'snap-3a', score: 0.87 },
      { path: 'knowledge://88/mdna.md', title: 'MD&A', snapshotId: 'snap-3a', score: 0.71 },
    ],
  }), into);

  assert.equal(into.length, 2);
  assert.equal(into[0].path, 'knowledge://88/10k.md');
  assert.equal(into[0].snapshotId, 'snap-3a');
  assert.equal(into[0].score, 0.87);
});

test('knowledge_read page ranges are kept', () => {
  const into: RunKnowledgeChunk[] = [];
  collectKnowledgeChunks(JSON.stringify({
    path: 'knowledge://88/10k.md',
    snapshotId: 'snap-3a',
    sourceLocations: [{ page: 14 }, { page: 15 }],
  }), into);

  assert.deepEqual(into[0].sourceLocations, [{ page: 14 }, { page: 15 }]);
});

test('the same passage is not recorded twice', () => {
  const into: RunKnowledgeChunk[] = [];
  const payload = JSON.stringify({ results: [{ path: 'knowledge://88/10k.md', snapshotId: 'snap-3a' }] });
  // A search followed by a read of the same passage is normal.
  collectKnowledgeChunks(payload, into);
  collectKnowledgeChunks(payload, into);
  assert.equal(into.length, 1);

  // A different snapshot of the same path is a genuinely different source.
  collectKnowledgeChunks(JSON.stringify({ results: [{ path: 'knowledge://88/10k.md', snapshotId: 'snap-9z' }] }), into);
  assert.equal(into.length, 2);
});

test('malformed tool output is ignored rather than thrown', () => {
  // Provenance is best effort; losing a detail is fine, failing a user's run is not.
  const into: RunKnowledgeChunk[] = [];
  for (const bad of ['not json at all', '{"results":', '', 'null', '{"results":[{"noPath":1}]}']) {
    assert.doesNotThrow(() => collectKnowledgeChunks(bad, into));
  }
  assert.equal(into.length, 0);
});

test('a bare array of results is accepted', () => {
  const into: RunKnowledgeChunk[] = [];
  collectKnowledgeChunks(JSON.stringify([{ path: 'knowledge://1/a.md' }]), into);
  assert.equal(into.length, 1);
});

// --- text capping ------------------------------------------------------------

test('long prompts are capped and flagged', () => {
  const short = truncateText('hello');
  assert.equal(short.text, 'hello');
  assert.equal(short.truncated, false);

  const long = truncateText('x'.repeat(MAX_TEXT_BYTES + 5_000));
  assert.equal(long.truncated, true);
  assert.ok(Buffer.byteLength(long.text!, 'utf8') <= MAX_TEXT_BYTES);

  assert.deepEqual(truncateText(null), { text: null, truncated: false });
});

test('capping does not leave a broken character behind', () => {
  // Multi-byte characters must not be sliced in half.
  const value = '🙂'.repeat(MAX_TEXT_BYTES);
  const result = truncateText(value);
  assert.equal(result.truncated, true);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify({ text: result.text })));
});

// --- persistence -------------------------------------------------------------

function fakeDb(state: { rows: any[]; messages?: any[] }) {
  const db: any = (table: string) => {
    let rows = table === 'conversation_messages' ? (state.messages ?? []) : state.rows;
    const api: any = {
      where(clause: any) {
        rows = rows.filter((r: any) => Object.entries(clause).every(([k, v]) => r[k] === v));
        return api;
      },
      whereIn(col: string, vals: unknown[]) {
        rows = rows.filter((r: any) => vals.includes(r[col]));
        return api;
      },
      select() { return api; },
      async first() { return rows[0]; },
      insert(row: any) {
        return {
          onConflict: () => ({
            ignore: async () => {
              if (!state.rows.some((r) => r.runId === row.runId)) state.rows.push({ ...row });
            },
          }),
        };
      },
      async update(patch: any) {
        for (const row of rows) Object.assign(row, patch);
        return rows.length;
      },
      then(resolve: any, reject: any) { return Promise.resolve(rows).then(resolve, reject); },
    };
    return api;
  };
  db.fn = { now: () => 'NOW' };
  db.raw = (sql: string, bindings: unknown[] = []) => ({ __raw: sql, bindings });
  return db;
}

const decode = (value: any) => (value?.__raw ? JSON.parse(value.bindings[0]) : value);

test('the prompt is stored when the run starts, not when it finishes', async () => {
  const state = { rows: [] as any[] };
  const service = new AgentRunProvenanceService(fakeDb(state));

  await service.recordRunStart({
    runId: 'run-1',
    workspaceId: 'ws-1',
    userId: 'u-alice',
    conversationId: 'c-1',
    turnId: 't-1',
    persona: 'fast',
    userPrompt: 'Draft the Q3 summary',
    enrichedPrompt: 'Draft the Q3 summary\n\nTagged Knowledge bundles: …',
    knowledgeRefsDeclared: [{ id: 88, title: 'FY24 Filings' }],
    taggedFileRefs: [{ fileId: 311, version: 2, name: 'notes.md' }],
  });

  assert.equal(state.rows.length, 1);
  const row = state.rows[0];
  assert.equal(row.status, 'queued');
  assert.equal(row.userPrompt, 'Draft the Q3 summary');
  assert.match(row.enrichedPrompt, /Tagged Knowledge bundles/);
  // Arrays must carry the ::jsonb cast or Postgres rejects them.
  assert.match(row.knowledgeRefsDeclared.__raw, /::jsonb/);
  assert.deepEqual(decode(row.knowledgeRefsDeclared), [{ id: 88, title: 'FY24 Filings' }]);
  assert.deepEqual(decode(row.taggedFileRefs), [{ fileId: 311, version: 2, name: 'notes.md' }]);
});

test('a crashed run keeps the prompt it was started with', async () => {
  const state = { rows: [] as any[] };
  const service = new AgentRunProvenanceService(fakeDb(state));
  await service.recordRunStart({ runId: 'run-2', workspaceId: 'ws-1', userPrompt: 'do a thing' });

  // finalize never runs; the skeleton must still be there.
  assert.equal(state.rows[0].userPrompt, 'do a thing');
  assert.equal(state.rows[0].responseText, undefined);
});

test('a resumed run does not overwrite the original prompt', async () => {
  const state = { rows: [] as any[] };
  const service = new AgentRunProvenanceService(fakeDb(state));
  await service.recordRunStart({ runId: 'run-3', workspaceId: 'ws-1', userPrompt: 'first' });
  await service.recordRunStart({ runId: 'run-3', workspaceId: 'ws-1', userPrompt: 'second' });

  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].userPrompt, 'first');
});

test('finish records the response, skills and retrieved knowledge', async () => {
  const state = { rows: [{ runId: 'run-4', truncated: {} }] };
  const service = new AgentRunProvenanceService(fakeDb(state));

  await service.recordRunFinish({
    runId: 'run-4',
    status: 'completed',
    responseText: 'I drafted the summary.',
    skillsInvoked: [
      { skillId: 'research', loadedAt: '2026-08-14T09:31:29Z' },
      { skillId: 'data', loadedAt: '2026-08-14T09:32:51Z' },
    ],
    knowledgeChunksRetrieved: [{ path: 'knowledge://88/10k.md', snapshotId: 'snap-3a' }],
    langfuseTraceId: 'tr-e7fa20c8',
  });

  const row = state.rows[0];
  assert.equal(row.status, 'completed');
  assert.equal(row.responseText, 'I drafted the summary.');
  assert.equal(row.langfuseTraceId, 'tr-e7fa20c8');
  // Multiple skills per turn, not just the last one.
  assert.deepEqual(decode(row.skillsInvoked).map((s: any) => s.skillId), ['research', 'data']);
  assert.equal(decode(row.knowledgeChunksRetrieved).length, 1);
});

test('finish resolves the agent message id from the turn', async () => {
  const state = {
    rows: [{ runId: 'run-5', truncated: {} }],
    messages: [
      { id: 42, conversationId: 'c-1', turnId: 't-1', sender: 'user' },
      { id: 43, conversationId: 'c-1', turnId: 't-1', sender: 'agent' },
    ],
  };
  const service = new AgentRunProvenanceService(fakeDb(state));

  await service.recordRunFinish({
    runId: 'run-5', status: 'completed', conversationId: 'c-1', turnId: 't-1',
  });

  assert.equal(state.rows[0].conversationMessageId, 43, 'must pick the agent message, not the user one');
});

test('finish on an unknown run is a no-op', async () => {
  const state = { rows: [] as any[] };
  const service = new AgentRunProvenanceService(fakeDb(state));
  await assert.doesNotReject(() => service.recordRunFinish({ runId: 'missing', status: 'completed' }));
  assert.equal(state.rows.length, 0);
});
