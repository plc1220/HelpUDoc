import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { redisClient } from '../src/services/redisService';
import { configureAgentRunServices, getRunMeta, startAgentRun } from '../src/services/agentRunService';

test('Calendar output reconciliation follows artifact commit and completed status; an index outage cannot fail the run', {
  skip: process.env.RUN_CALENDAR_LIFECYCLE_TESTS !== '1',
}, async () => {
  if (!redisClient.isOpen) await redisClient.connect();
  let commits = 0, observedRunId = '', runId = '';
  let resolveHook!: () => void;
  const observed = new Promise<void>(resolve => { resolveHook = resolve; });
  const workspaceId = `calendar-output-hook-${Date.now()}`;
  try {
    configureAgentRunServices({ telemetryService: null, userMemoryService: null, skillEvolutionService: null, conversationService: null,
      fileService: {
        reconcileWorkspaceMirror: async () => undefined,
        captureWorkspaceArtifactBaseline: async () => ({}),
        commitWorkspaceArtifacts: async () => { commits++; return [{ fileId: 1, version: 1, name: 'report.md' }]; },
      } as never,
      onRunCompleted: async input => {
        assert.equal(commits, 1); assert.equal(input.userId, 'calendar-output-owner'); assert.equal(input.workspaceId, workspaceId);
        assert.equal((await getRunMeta(input.runId))?.status, 'completed');
        observedRunId = input.runId; resolveHook();
        throw new Error('Simulated context index outage; durable links catch up on read');
      },
      agentStreamClient: { runAgentStream: async () => ({ data: Readable.from([{ type: 'token', content: 'Created report.md.' }, { type: 'done', status: 'completed' }].map(event => `${JSON.stringify(event)}\n`)) }) as never },
    });
    const run = await startAgentRun({ workspaceId, userId: 'calendar-output-owner', persona: 'fast', prompt: 'Create report.md', turnId: `calendar-output-${Date.now()}` }); runId = run.runId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([observed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Output reconciliation hook did not run')), 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
    assert.equal(observedRunId, runId); assert.equal((await getRunMeta(runId))?.status, 'completed');
  } finally {
    configureAgentRunServices({ onRunCompleted: null, fileService: null, agentStreamClient: null });
    if (runId) { await redisClient.del(`agent:run:${runId}`); await redisClient.del(`agent:run:${runId}:meta`); }
    if (redisClient.isOpen) await redisClient.quit();
  }
});
