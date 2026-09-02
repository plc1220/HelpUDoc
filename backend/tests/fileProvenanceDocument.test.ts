import assert from 'node:assert/strict';
import test from 'node:test';

import { computeEventHash } from '../src/services/fileAuditService';
import {
  PROVENANCE_SCHEMA_VERSION,
  buildProvenanceDocument,
  verifyEventChain,
} from '../src/services/fileProvenance';

const FILE = { id: 412, workspaceId: 'ws-1', name: 'reports/q3.md', version: 4 };

/** Builds a correctly-linked chain, mirroring what the emitter writes. */
function chain(specs: Array<{
  eventType: string;
  actorUserId?: string | null;
  payload?: Record<string, unknown>;
  fileId?: number;
  workspaceId?: string;
}>) {
  let prev: string | null = null;
  return specs.map((spec, index) => {
    const seq = index + 1;
    const fileId = spec.fileId ?? FILE.id;
    const occurredAt = new Date(Date.UTC(2026, 7, 14, 9, index)).toISOString();
    const payload = spec.payload ?? {};
    const actorUserId = spec.actorUserId ?? 'u-alice';
    const eventHash = computeEventHash({
      prevEventHash: prev, fileId, seq, eventType: spec.eventType, actorUserId, occurredAt, payload,
    });
    const row = {
      id: `ev-${seq}`,
      fileId,
      workspaceId: spec.workspaceId ?? FILE.workspaceId,
      filePath: FILE.name,
      seq,
      eventType: spec.eventType,
      actorUserId,
      actorType: 'human',
      payload,
      prevEventHash: prev,
      eventHash,
      occurredAt,
    } as any;
    prev = eventHash;
    return row;
  });
}

test('events are ordered by seq regardless of input order', () => {
  const events = chain([
    { eventType: 'file.created' },
    { eventType: 'file.content_updated' },
    { eventType: 'file.agent_generated' },
  ]);
  const doc = buildProvenanceDocument({ file: FILE, events: [events[2], events[0], events[1]] });

  assert.deepEqual(doc.events.map((event) => event.seq), [1, 2, 3]);
  assert.equal(doc.schemaVersion, PROVENANCE_SCHEMA_VERSION);
  assert.equal(doc.integrity.eventCount, 3);
  assert.equal(doc.integrity.chainHead, events[2].eventHash);
});

test('an empty trail produces a well-formed document rather than throwing', () => {
  const doc = buildProvenanceDocument({ file: FILE, events: [] });

  assert.deepEqual(doc.events, []);
  assert.equal(doc.origin.kind, 'unknown');
  assert.equal(doc.origin.occurredAt, null);
  assert.equal(doc.integrity.chainHead, null);
  assert.equal(doc.integrity.eventCount, 0);
  // An empty chain is vacuously intact, not "broken".
  assert.equal(doc.integrity.verified, true);
});

test('origin reflects how the file first came into existence', () => {
  const uploaded = buildProvenanceDocument({ file: FILE, events: chain([{ eventType: 'file.created' }]) });
  assert.equal(uploaded.origin.kind, 'uploaded');

  const generated = buildProvenanceDocument({
    file: FILE,
    events: chain([{ eventType: 'file.agent_generated' }]),
  });
  assert.equal(generated.origin.kind, 'agent_generated');
});

test('a published file inherits its prior-workspace history through the bridge', () => {
  const priorEvents = chain([
    { eventType: 'file.created' },
    { eventType: 'file.agent_generated' },
  ]).map((event) => ({ ...event, fileId: 412, workspaceId: 'ws-priv-alice' }));

  const currentEvents = chain([{ eventType: 'file.synced_from_publication' }])
    .map((event) => ({
      ...event,
      fileId: 907,
      workspaceId: 'ws-team-fin',
      sourceFileVersionId: 'fv-aaa4',
    }));

  const doc = buildProvenanceDocument({
    file: { id: 907, workspaceId: 'ws-team-fin', name: 'reports/q3.md', version: 1 },
    events: currentEvents,
    priorEvents,
  });

  // Prior history reads first, so the document tells the story in order.
  assert.deepEqual(doc.events.map((event) => event.chain), ['prior', 'prior', 'current']);
  assert.equal(doc.origin.priorWorkspace?.workspaceId, 'ws-priv-alice');
  assert.equal(doc.origin.priorWorkspace?.bridgeVersionId, 'fv-aaa4');
  assert.equal(doc.origin.priorWorkspace?.eventCount, 2);
  // Origin is where it truly began, not where this row began.
  assert.equal(doc.origin.kind, 'uploaded');
});

test('actor display names resolve for readability', () => {
  const doc = buildProvenanceDocument({
    file: FILE,
    events: chain([{ eventType: 'file.created', actorUserId: 'u-alice' }]),
    actorNames: { 'u-alice': 'Alice Tan' },
  });
  assert.equal(doc.events[0].actor?.displayName, 'Alice Tan');
});

test('a malformed payload degrades to empty instead of hiding the event', () => {
  const [event] = chain([{ eventType: 'file.created' }]);
  const doc = buildProvenanceDocument({
    file: FILE,
    events: [{ ...event, payload: 'not-json{' as unknown as Record<string, unknown> }],
  });
  assert.equal(doc.events.length, 1);
  assert.deepEqual(doc.events[0].payload, {});
});

test('chain verification detects a tampered event and names the seq', () => {
  const events = chain([
    { eventType: 'file.created' },
    { eventType: 'file.content_updated', payload: { sizeBytes: 10 } },
    { eventType: 'file.content_updated', payload: { sizeBytes: 20 } },
  ]);
  assert.deepEqual(verifyEventChain(events), { verified: true, brokenAtSeq: null });

  const tampered = events.map((event) => (
    event.seq === 2 ? { ...event, payload: { sizeBytes: 999 } } : event
  ));
  assert.deepEqual(verifyEventChain(tampered), { verified: false, brokenAtSeq: 2 });

  // Deleting an event breaks the predecessor link of the one that follows.
  const withHole = [events[0], events[2]];
  assert.equal(verifyEventChain(withHole).verified, false);
});

test('a long trail assembles without blowing up', () => {
  const specs = Array.from({ length: 10_000 }, (_unused, index) => ({
    eventType: index === 0 ? 'file.created' : 'file.content_updated',
    payload: { sizeBytes: index },
  }));
  const events = chain(specs);

  const started = Date.now();
  const doc = buildProvenanceDocument({ file: FILE, events });
  const elapsed = Date.now() - started;

  assert.equal(doc.events.length, 10_000);
  assert.equal(doc.integrity.eventCount, 10_000);
  assert.equal(doc.integrity.verified, true);
  assert.equal(doc.events[0].seq, 1);
  assert.equal(doc.events[9_999].seq, 10_000);
  assert.ok(elapsed < 5_000, `assembling 10k events took ${elapsed}ms`);
});

test('an agent-written file shows the prompt that produced it', () => {
  const events = chain([
    { eventType: 'file.created' },
    { eventType: 'file.agent_generated' },
  ]).map((event, index) => (index === 1 ? { ...event, runId: 'run-88f2' } : event));

  const doc = buildProvenanceDocument({
    file: FILE,
    events,
    runProvenance: {
      'run-88f2': {
        runId: 'run-88f2',
        userPrompt: 'Draft the Q3 board summary using @fy24-filings',
        enrichedPrompt: 'Draft the Q3 board summary…\n\nTagged Knowledge bundles: …',
        responseText: "I've drafted the summary in four sections.",
        skillsInvoked: [{ skillId: 'research' }, { skillId: 'data' }],
        knowledgeRefsDeclared: [{ id: 88, title: 'FY24 Filings' }],
        knowledgeChunksRetrieved: [{ path: 'knowledge://88/10k.md', snapshotId: 'snap-3a' }],
        taggedFileRefs: [{ fileId: 311, version: 2, name: 'notes.md' }],
        langfuseTraceId: 'tr-e7fa20c8',
        conversationMessageId: 90412,
      },
    },
  });

  const agentEvent = doc.events.find((event) => event.eventType === 'file.agent_generated');
  assert.ok(agentEvent?.provenance, 'agent events must carry the run detail');
  assert.equal(agentEvent.provenance.userPrompt, 'Draft the Q3 board summary using @fy24-filings');
  assert.equal(agentEvent.provenance.responseText, "I've drafted the summary in four sections.");
  assert.deepEqual(agentEvent.provenance.skillsInvoked.map((s: any) => s.skillId), ['research', 'data']);
  assert.equal(agentEvent.provenance.knowledgeChunksRetrieved[0].snapshotId, 'snap-3a');
  assert.equal(agentEvent.provenance.langfuseTraceId, 'tr-e7fa20c8');

  // A human edit in the same trail must not borrow the agent's prompt.
  const humanEvent = doc.events.find((event) => event.eventType === 'file.created');
  assert.equal(humanEvent?.provenance, null);
});

test('an agent event without a stored run degrades quietly', () => {
  // Runs from before this feature existed have no provenance row.
  const events = chain([{ eventType: 'file.agent_generated' }])
    .map((event) => ({ ...event, runId: 'run-legacy' }));
  const doc = buildProvenanceDocument({ file: FILE, events, runProvenance: {} });

  assert.equal(doc.events.length, 1);
  assert.equal(doc.events[0].provenance, null);
});

test('jsonb arrays arriving as strings are still readable', () => {
  const events = chain([{ eventType: 'file.agent_generated' }])
    .map((event) => ({ ...event, runId: 'run-1' }));
  const doc = buildProvenanceDocument({
    file: FILE,
    events,
    runProvenance: {
      'run-1': { runId: 'run-1', skillsInvoked: '[{"skillId":"research"}]', knowledgeChunksRetrieved: 'not-json' },
    },
  });

  assert.deepEqual(doc.events[0].provenance?.skillsInvoked, [{ skillId: 'research' }]);
  assert.deepEqual(doc.events[0].provenance?.knowledgeChunksRetrieved, []);
});
