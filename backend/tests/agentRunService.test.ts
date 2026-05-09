import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRealRunProgressEvent,
  shouldFailResumedRunForIdle,
} from '../src/services/agentRunService';

test('isRealRunProgressEvent ignores transport-only events', () => {
  assert.equal(isRealRunProgressEvent({ type: 'keepalive' }), false);
  assert.equal(isRealRunProgressEvent({ type: 'policy', skill: 'frontend-slides' }), false);
  assert.equal(isRealRunProgressEvent({ type: 'langfuse', traceId: 'trace-1' }), false);
  assert.equal(isRealRunProgressEvent({ type: 'model_start', name: 'gemini' }), true);
  assert.equal(isRealRunProgressEvent({ type: 'tool_end', name: 'request_clarification' }), true);
  assert.equal(isRealRunProgressEvent({ type: 'token', content: 'hello' }), true);
});

test('shouldFailResumedRunForIdle only fails resumed idle runs with no active tool', () => {
  const resumePayload = { response: { message: 'ok' } } as any;

  assert.equal(
    shouldFailResumedRunForIdle({
      resumePayload,
      activeToolCalls: 0,
      lastRealActivityAt: 1_000,
      now: 4_001,
      timeoutMs: 3_000,
    }),
    true,
  );

  assert.equal(
    shouldFailResumedRunForIdle({
      resumePayload,
      activeToolCalls: 1,
      lastRealActivityAt: 1_000,
      now: 10_000,
      timeoutMs: 3_000,
    }),
    false,
  );

  assert.equal(
    shouldFailResumedRunForIdle({
      activeToolCalls: 0,
      lastRealActivityAt: 1_000,
      now: 10_000,
      timeoutMs: 3_000,
    }),
    false,
  );
});
