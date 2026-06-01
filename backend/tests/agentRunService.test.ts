import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSyntheticClarificationFollowupPrompt,
  isRealRunProgressEvent,
  resolveStreamCloseDisposition,
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

test('resolveStreamCloseDisposition preserves an emitted interrupt ahead of stream errors', () => {
  const interruptPayload = {
    type: 'interrupt',
    kind: 'clarification',
    title: 'Style Selection Method',
  };

  assert.deepEqual(
    resolveStreamCloseDisposition({
      sawInterruptPayload: interruptPayload,
      loopErrorMessage: 'Clarification response was not consumed. The same clarification was emitted again.',
      contractErrorMessage: 'Artifact contract validation failed.',
    }),
    { status: 'awaiting_approval', preserveInterrupt: true },
  );

  assert.deepEqual(
    resolveStreamCloseDisposition({
      contractErrorMessage: 'Artifact contract validation failed.',
    }),
    { status: 'failed', error: 'Artifact contract validation failed.', preserveInterrupt: false },
  );
});

test('buildSyntheticClarificationFollowupPrompt advances frontend-slides context to style previews', () => {
  const prompt = buildSyntheticClarificationFollowupPrompt(
    '/skill frontend-slides Create a deck\nOriginal request:\n/skill frontend-slides Create a deck',
    {
      message: 'Use a concise technical deck.',
      answersByQuestionId: {
        presentation_goal: 'Explain the solution.',
        audience: 'Technical team.',
      },
    },
    {
      kind: 'clarification',
      title: 'Presentation Context',
      displayPayload: { synthetic: true, skill: 'frontend-slides' },
      responseSpec: {
        questions: [
          { id: 'presentation_goal', header: 'Goal', question: 'What is the goal?' },
          { id: 'audience', header: 'Audience', question: 'Who is it for?' },
        ],
      },
    } as any,
  );

  assert.match(prompt, /Generate 2-3 style previews\/templates next/);
  assert.doesNotMatch(prompt, /^\/skill frontend-slides/m);
});

test('buildSyntheticClarificationFollowupPrompt advances frontend-slides style choice to deck building', () => {
  const prompt = buildSyntheticClarificationFollowupPrompt(
    'Create a deck',
    {
      selectedChoiceIds: ['style-b'],
      selectedValues: ['Style B'],
      message: 'Use Style B.',
    },
    {
      kind: 'clarification',
      title: 'Choose Your Presentation Style',
      displayPayload: { synthetic: true, skill: 'frontend-slides', chooser: 'style-previews' },
      responseSpec: {
        choices: [
          { id: 'style-a', label: 'Style A', value: 'Style A' },
          { id: 'style-b', label: 'Style B', value: 'Style B' },
        ],
      },
    } as any,
  );

  assert.match(prompt, /selected a visual style/);
  assert.match(prompt, /Continue directly into building the deck/);
  assert.match(prompt, /Do not ask for Presentation Context again/);
});
