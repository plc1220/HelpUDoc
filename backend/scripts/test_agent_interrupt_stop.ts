import assert from 'node:assert/strict';

import { persistInterruptAndStopRun } from '../src/services/agentRunService';

async function main() {
  const persisted: Array<{ runId: string; interruptPayload: string }> = [];
  let destroyCalls = 0;

  const upstream = {
    destroyed: false,
    destroy() {
      destroyCalls += 1;
      this.destroyed = true;
    },
  };

  const state = {
    sawInterruptPayload: null as Record<string, unknown> | null,
    buffer: 'pending-stream-buffer',
    upstream,
  };

  const interruptPayload = {
    type: 'interrupt',
    kind: 'clarification',
    title: 'Presentation Discovery',
  };

  const stopped = await persistInterruptAndStopRun(
    'run-123',
    interruptPayload,
    state,
    async (runId, serializedPayload) => {
      persisted.push({ runId, interruptPayload: serializedPayload });
    },
  );

  assert.equal(stopped, true);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.runId, 'run-123');
  const persistedInterrupt = JSON.parse(persisted[0]?.interruptPayload ?? '{}');
  assert.equal(persistedInterrupt.type, interruptPayload.type);
  assert.equal(persistedInterrupt.kind, interruptPayload.kind);
  assert.equal(persistedInterrupt.title, interruptPayload.title);
  assert.equal(typeof persistedInterrupt.interruptId, 'string');
  assert.equal(state.buffer, 'pending-stream-buffer');
  assert.deepEqual(state.sawInterruptPayload, persistedInterrupt);
  assert.equal(destroyCalls, 0);
  assert.equal(upstream.destroyed, false);

  const stoppedAgain = await persistInterruptAndStopRun(
    'run-123',
    { type: 'interrupt', kind: 'approval', title: 'Should not replace first interrupt' },
    state,
    async (runId, serializedPayload) => {
      persisted.push({ runId, interruptPayload: serializedPayload });
    },
  );

  assert.equal(stoppedAgain, false);
  assert.equal(persisted.length, 1);
  assert.deepEqual(state.sawInterruptPayload, persistedInterrupt);
  assert.equal(destroyCalls, 0);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
