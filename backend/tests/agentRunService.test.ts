import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { AxiosResponse } from 'axios';
import type { IncomingMessage } from 'node:http';
import { redisClient } from '../src/services/redisService';
import {
  buildSyntheticClarificationFollowupPrompt,
  buildSyntheticResumeParams,
  buildFrontendSlidesWorkflowState,
  configureAgentRunServices,
  extractInteractionGateIdFromPendingInterrupt,
  getRunMeta,
  inferFrontendSlidesGateIdFromInteraction,
  isCompletedFrontendSlidesGateInterrupt,
  isRealRunProgressEvent,
  normalizeWorkflowActionEvent,
  resolveStreamCloseDisposition,
  shouldFailRunningRunForStaleActivity,
  shouldFailResumedRunForIdle,
  startAgentRun,
  terminalEventFromStreamPayload,
  validateInterrupt,
  resumeAgentRunWithResponse,
  withFrontendSlidesGateMetadata,
  mergeAssistantTextChunk,
} from '../src/services/agentRunService';
import {
  artifactPathMatchesRequirement,
  requiredArtifactsForSkill,
  requiredGateIdsForSkill,
} from '../src/services/agent-runs/workflowContracts';
import {
  normalizeInterruptPayloadRecord,
  parsePendingInterrupt,
} from '../src/services/agent-runs/interrupts';

const makeStreamResponse = (lines: Array<Record<string, unknown>>): Promise<AxiosResponse<IncomingMessage>> =>
  Promise.resolve({
    data: Readable.from(lines.map((line) => `${JSON.stringify(line)}\n`)) as IncomingMessage,
  } as AxiosResponse<IncomingMessage>);

const waitForRunStatus = async (
  runId: string,
  predicate: (status: string | undefined, meta: Awaited<ReturnType<typeof getRunMeta>>) => boolean,
  timeoutMs = 2_000,
) => {
  const started = Date.now();
  let latest = await getRunMeta(runId);
  while (!predicate(latest?.status, latest) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    latest = await getRunMeta(runId);
  }
  return latest;
};

test('synthetic Interaction interrupts persist the fresh-prompt resume strategy', () => {
  const normalized = normalizeInterruptPayloadRecord({
    type: 'interrupt',
    kind: 'clarification',
    title: 'Choose Deck Mode',
    display_payload: {
      synthetic: true,
      source: 'interaction_contract_synthetic',
      interactionContract: 'helpudoc.interaction',
      gateId: 'presentation_context',
    },
    interactionRequest: {
      contract: 'helpudoc.interaction',
      gateId: 'presentation_context',
      metadata: {
        synthetic: true,
        source: 'interaction_contract_synthetic',
        interactionContract: 'helpudoc.interaction',
      },
    },
  });

  assert.equal(normalized.resumeStrategy, 'fresh_prompt');
  assert.equal((normalized.displayPayload as Record<string, unknown>).gateId, 'presentation_context');

  const pending = parsePendingInterrupt(JSON.stringify(normalized));
  assert.equal(pending?.resumeStrategy, 'fresh_prompt');
  assert.equal(pending?.displayPayload?.gateId, 'presentation_context');
});

test('synthetic resumes discard stale history and content in favor of the continuation prompt', () => {
  const params = buildSyntheticResumeParams(
    {
      workspaceId: 'workspace-1',
      persona: 'fast',
      prompt: '/skill frontend-slides Build a quarterly review deck.',
      history: [
        { role: 'user', content: '/skill frontend-slides Build a quarterly review deck.' },
        { role: 'assistant', content: '' },
      ],
      messageContent: [{ type: 'text', text: 'stale multimodal turn' }],
    },
    {
      message: '',
      answersByQuestionId: {
        density: 'Low density / speaker-led',
      },
    },
    {
      kind: 'clarification',
      resumeStrategy: 'fresh_prompt',
      displayPayload: {
        synthetic: true,
        skill: 'frontend-slides',
        gateId: 'presentation_context',
      },
    },
    { completedGateIds: ['presentation_context'] },
  );

  assert.equal(params.forceReset, true);
  assert.equal(params.history, undefined);
  assert.equal(params.messageContent, undefined);
  assert.match(params.prompt, /Low density \/ speaker-led/);
  assert.match(params.prompt, /Build a quarterly review deck/);
});

test('real LangGraph interrupts do not get marked as fresh-prompt resumes', () => {
  const normalized = normalizeInterruptPayloadRecord({
    type: 'interrupt',
    kind: 'clarification',
    title: 'Need detail',
    interactionRequest: {
      contract: 'helpudoc.interaction',
      gateId: 'detail',
      metadata: {
        source: 'workflow_action',
      },
    },
  });

  assert.equal(normalized.resumeStrategy, undefined);
});

test('mergeAssistantTextChunk collapses cumulative final stream snapshots', () => {
  const partial = 'Based on the data...\n\n### KPI\n\n| Metric | Value |';
  const final = `${partial}\n\n### Insights\n\n- Revenue increased.`;

  assert.equal(mergeAssistantTextChunk(partial, final), final);
  assert.equal(mergeAssistantTextChunk(final, final), final);
  assert.equal(mergeAssistantTextChunk(final, '- trailing delta'), `${final}- trailing delta`);
});

const presentationContextInterrupt = {
  type: 'interrupt',
  kind: 'clarification',
  title: 'Presentation Setup',
  description: 'Configure the basic settings for your presentation.',
  responseSpec: {
    inputMode: 'text',
    questions: [
      {
        id: 'purpose',
        header: 'Purpose',
        question: 'What is this presentation for?',
        options: [{ id: 'purpose-pitch-deck', label: 'Pitch deck', value: 'Pitch deck' }],
      },
    ],
  },
  displayPayload: {
    skill: 'frontend-slides',
    gateId: 'presentation_context',
    interactionContract: 'helpudoc.interaction',
    expectedPresentation: 'questionnaire',
    source: 'implicit_input_guard',
  },
  interruptId: 'interrupt-presentation-context',
  interactionRequest: {
    contract: 'helpudoc.interaction',
    version: '0.9',
    interactionId: 'interaction-presentation_context',
    presentation: 'questionnaire',
    gateId: 'presentation_context',
    skill: 'frontend-slides',
    required: true,
    resumeAction: {
      endpoint: 'respond',
      actionId: 'submit',
    },
    metadata: {
      skill: 'frontend-slides',
      gateId: 'presentation_context',
      interactionContract: 'helpudoc.interaction',
      expectedPresentation: 'questionnaire',
      source: 'implicit_input_guard',
    },
    props: {
      questions: [
        {
          id: 'purpose',
          header: 'Purpose',
          question: 'What is this presentation for?',
          options: [{ id: 'purpose-pitch-deck', label: 'Pitch deck', value: 'Pitch deck' }],
        },
      ],
      title: 'Presentation Setup',
    },
  },
};

const nativeOnlyPresentationContextInterrupt = (() => {
  const { displayPayload, responseSpec, ...nativeOnly } = presentationContextInterrupt;
  return nativeOnly;
})();

const nativeOnlyContractSyntheticPresentationContextInterrupt = {
  ...nativeOnlyPresentationContextInterrupt,
  interactionRequest: {
    ...nativeOnlyPresentationContextInterrupt.interactionRequest,
    metadata: {
      skill: 'frontend-slides',
      gateId: 'presentation_context',
      interactionContract: 'helpudoc.interaction',
      expectedPresentation: 'questionnaire',
      synthetic: true,
      source: 'interaction_contract_synthetic',
    },
  },
};

const outlineConfirmationInterrupt = {
  type: 'interrupt',
  kind: 'clarification',
  title: 'Outline Confirmation',
  description: 'Confirm the proposed slide outline.',
  responseSpec: {
    inputMode: 'text',
    questions: [
      {
        id: 'outline_confirmation',
        header: 'Outline',
        question: 'Does this outline look right?',
        options: [{ id: 'outline-yes', label: 'Yes', value: 'Yes' }],
      },
    ],
  },
  displayPayload: {
    skill: 'frontend-slides',
    gateId: 'outline_confirmation',
    interactionContract: 'helpudoc.interaction',
    expectedPresentation: 'questionnaire',
  },
  interruptId: 'interrupt-outline-confirmation',
  interactionRequest: {
    contract: 'helpudoc.interaction',
    version: '0.9',
    interactionId: 'interaction-outline_confirmation',
    presentation: 'questionnaire',
    gateId: 'outline_confirmation',
    skill: 'frontend-slides',
    required: true,
    resumeAction: {
      endpoint: 'respond',
      actionId: 'submit',
    },
    metadata: {
      skill: 'frontend-slides',
      gateId: 'outline_confirmation',
      interactionContract: 'helpudoc.interaction',
      expectedPresentation: 'questionnaire',
    },
    props: {
      questions: [
        {
          id: 'outline_confirmation',
          header: 'Outline',
          question: 'Does this outline look right?',
          options: [{ id: 'outline-yes', label: 'Yes', value: 'Yes' }],
        },
      ],
      title: 'Outline Confirmation',
    },
  },
};


const stylePreviewSelectionInterrupt = {
  type: 'interrupt',
  kind: 'clarification',
  title: 'Select a Style Template',
  description: 'Choose one of the generated style previews to apply to your presentation.',
  responseSpec: {
    inputMode: 'choice',
    choices: [
      { id: 'style-a', label: 'Style A', value: 'Style A' },
      { id: 'style-b', label: 'Style B', value: 'Style B' },
    ],
  },
  displayPayload: {
    skill: 'frontend-slides',
    gateId: 'style_preview_selection',
    interactionContract: 'helpudoc.interaction',
    expectedPresentation: 'style_preview',
  },
  interruptId: 'interrupt-style-preview-selection',
  interactionRequest: {
    contract: 'helpudoc.interaction',
    version: '0.9',
    interactionId: 'interaction-style_preview_selection',
    presentation: 'style_preview',
    gateId: 'style_preview_selection',
    skill: 'frontend-slides',
    required: true,
    resumeAction: {
      endpoint: 'respond',
      actionId: 'submit',
    },
    metadata: {
      skill: 'frontend-slides',
      gateId: 'style_preview_selection',
      interactionContract: 'helpudoc.interaction',
      expectedPresentation: 'style_preview',
    },
    props: {
      title: 'Select a Style Template',
      choices: [
        { id: 'style-a', label: 'Style A', value: 'Style A' },
        { id: 'style-b', label: 'Style B', value: 'Style B' },
      ],
      previews: [
        {
          id: 'style-a',
          label: 'Style A',
          description: 'Light technical keynote template.',
          html: '<!doctype html><html><body><h1>Style A</h1></body></html>',
        },
        {
          id: 'style-b',
          label: 'Style B',
          description: 'Dark executive template.',
          html: '<!doctype html><html><body><h1>Style B</h1></body></html>',
        },
      ],
    },
  },
};

test('isRealRunProgressEvent ignores transport-only events', () => {
  assert.equal(isRealRunProgressEvent({ type: 'keepalive' }), false);
  assert.equal(isRealRunProgressEvent({ type: 'policy', skill: 'frontend-slides' }), false);
  assert.equal(isRealRunProgressEvent({ type: 'langfuse', traceId: 'trace-1' }), false);
  assert.equal(isRealRunProgressEvent({ type: 'model_start', name: 'gemini' }), true);
  assert.equal(isRealRunProgressEvent({ type: 'tool_end', name: 'request_clarification' }), true);
  assert.equal(isRealRunProgressEvent({ type: 'workflow_action', action: 'generate_artifact' }), true);
  assert.equal(isRealRunProgressEvent({ type: 'token', content: 'hello' }), true);
});

test('normalizeWorkflowActionEvent parses structured workflow tool output', () => {
  const event = normalizeWorkflowActionEvent({
    ok: true,
    workflowAction: {
      action: 'generate_artifact',
      reason: 'Need a reviewable outline before asking for confirmation.',
      gateId: null,
      presentation: null,
      artifactRefs: ['outline_v1'],
      context: {
        skill: 'frontend-slides',
        artifactType: 'slide_outline',
      },
    },
  });

  assert.equal(event?.action, 'generate_artifact');
  assert.equal(event?.reason, 'Need a reviewable outline before asking for confirmation.');
  assert.deepEqual(event?.artifactRefs, ['outline_v1']);
  assert.equal(event?.context?.skill, 'frontend-slides');
  assert.equal(typeof event?.timestamp, 'string');
});

test('normalizeWorkflowActionEvent rejects unknown workflow actions', () => {
  const event = normalizeWorkflowActionEvent({
    workflowAction: {
      action: 'ask_in_prose',
      reason: 'This is intentionally invalid.',
    },
  });

  assert.equal(event, null);
});

test('buildFrontendSlidesWorkflowState derives next required gate from completed gates', () => {
  const state = buildFrontendSlidesWorkflowState({
    completedGateIds: ['presentation_context'],
  });

  assert.equal(state.workflowType, 'presentation_generation');
  assert.equal(state.currentPhase, 'review_style_previews');
  assert.equal(state.nextRequiredGateId, 'style_preview_selection');
  assert.equal(state.nextRequiredAction, 'request_user_interaction');
  assert.equal(state.canComplete, false);
});

test('frontend-slides workflow contract declares required gates and final artifacts', () => {
  assert.deepEqual(requiredGateIdsForSkill('frontend-slides'), [
    'presentation_context',
    'style_preview_selection',
  ]);
  const artifacts = requiredArtifactsForSkill('frontend-slides');
  assert.equal(artifacts.length, 2);
  const finalDeck = artifacts.find((artifact) => artifact.artifactId === 'final_deck');
  const finalPptx = artifacts.find((artifact) => artifact.artifactId === 'final_pptx');
  assert.ok(finalDeck);
  assert.ok(finalPptx);
  assert.equal(artifactPathMatchesRequirement('slides/operation-epic-fury-deck.html', finalDeck), true);
  assert.equal(artifactPathMatchesRequirement('operation-epic-fury-report.md', finalDeck), false);
  assert.equal(artifactPathMatchesRequirement('slides/operation-epic-fury-deck.pptx', finalPptx), true);
  assert.equal(artifactPathMatchesRequirement('slides/operation-epic-fury-deck.html', finalPptx), false);
});

test('completed frontend-slides gate replays are internal no-op interrupts', () => {
  assert.equal(
    isCompletedFrontendSlidesGateInterrupt(presentationContextInterrupt, {
      completedGateIds: ['presentation_context'],
    }),
    true,
  );
  assert.equal(
    isCompletedFrontendSlidesGateInterrupt(outlineConfirmationInterrupt, {
      completedGateIds: ['presentation_context'],
    }),
    false,
  );
});

test('frontend-slides no-gate Interaction forms are inferred from skill form text', () => {
  const noGateContextReplay = {
    type: 'interrupt',
    kind: 'clarification',
    title: '1. Presentation Context & Requirements',
    interactionRequest: {
      contract: 'helpudoc.interaction',
      presentation: 'questionnaire',
      props: {
        title: '1. Presentation Context & Requirements',
        questions: [
          { id: 'purpose', header: 'Purpose', question: 'What is this presentation for?' },
          { id: 'audience', header: 'Audience', question: 'Who is the audience?' },
        ],
      },
      metadata: {},
    },
  };
  const noGateOutline = {
    type: 'interrupt',
    kind: 'clarification',
    title: 'Outline Confirmation',
    interactionRequest: {
      contract: 'helpudoc.interaction',
      presentation: 'questionnaire',
      props: {
        title: 'Outline Confirmation',
        questions: [
          { id: 'outline_approval', header: 'Outline', question: 'Do you approve this outline?' },
        ],
      },
      metadata: {},
    },
  };

  assert.equal(inferFrontendSlidesGateIdFromInteraction(noGateContextReplay), 'presentation_context');
  assert.equal(
    isCompletedFrontendSlidesGateInterrupt(noGateContextReplay, {
      completedGateIds: ['presentation_context'],
    }),
    true,
  );
  assert.equal(inferFrontendSlidesGateIdFromInteraction(noGateOutline), 'outline_confirmation');
  assert.equal(
    isCompletedFrontendSlidesGateInterrupt(noGateOutline, {
      completedGateIds: ['presentation_context'],
    }),
    false,
  );
  assert.equal(
    extractInteractionGateIdFromPendingInterrupt({
      kind: 'clarification',
      title: 'Outline Confirmation',
      interactionRequest: {
        contract: 'helpudoc.interaction',
        version: '0.9',
        interactionId: 'interaction-outline-confirmation',
        presentation: 'questionnaire',
        gateId: 'outline_confirmation',
        props: { questions: [{ id: 'outline_approval', question: 'Do you approve this outline?' }] },
        metadata: {},
      },
    }),
    'outline_confirmation',
  );
});

test('frontend-slides gate metadata repair fills missing clarification questions', () => {
  const malformedOutlineInterrupt = {
    type: 'interrupt',
    kind: 'clarification',
    title: 'Outline Confirmation',
    interactionRequest: {
      contract: 'helpudoc.interaction',
      version: '0.9',
      interactionId: 'interaction-outline-confirmation',
      presentation: 'questionnaire',
      gateId: 'outline_confirmation',
      skill: 'frontend-slides',
      props: {
        title: 'Outline Confirmation',
        outlineMarkdown: '## Slide 1\nStrategic case\n\n## Slide 2\nPartnership strength\n\n## Slide 3\nLong-term value',
        questions: [],
      },
      metadata: {
        skill: 'frontend-slides',
        gateId: 'outline_confirmation',
      },
    },
  };

  const repaired = withFrontendSlidesGateMetadata(malformedOutlineInterrupt, 'outline_confirmation');
  assert.equal(validateInterrupt(repaired, 'frontend-slides'), null);
  assert.equal(
    Array.isArray((repaired.interactionRequest as any)?.props?.questions) ||
      Array.isArray((repaired.interactionRequest as any)?.props?.questions),
    true,
  );
});

test('frontend-slides gate metadata repair fills empty style previews with fallback choices', () => {
  const emptyStylePreviewInterrupt = {
    type: 'interrupt',
    kind: 'clarification',
    title: 'Choose a Style Preview',
    interactionRequest: {
      contract: 'helpudoc.interaction',
      version: '0.9',
      interactionId: 'interaction-style-preview-selection',
      presentation: 'style_preview',
      gateId: 'style_preview_selection',
      skill: 'frontend-slides',
      props: {
        title: 'Choose a Style Preview',
        choices: [],
        previews: [],
      },
      metadata: {
        skill: 'frontend-slides',
        gateId: 'style_preview_selection',
      },
    },
  };

  const repaired = withFrontendSlidesGateMetadata(emptyStylePreviewInterrupt, 'style_preview_selection');
  assert.equal(validateInterrupt(repaired, 'frontend-slides'), null);
  assert.equal(((repaired.interactionRequest as any)?.props?.choices || []).length > 0, true);
  assert.equal(((repaired.interactionRequest as any)?.props?.previews || []).length > 0, true);
});

test('frontend-slides gate metadata repair adds fallback previews when choices exist without previews', () => {
  const choicesOnlyStylePreviewInterrupt = {
    type: 'interrupt',
    kind: 'clarification',
    title: 'Choose a Style Preview',
    interactionRequest: {
      contract: 'helpudoc.interaction',
      version: '0.9',
      interactionId: 'interaction-style-preview-selection',
      presentation: 'style_preview',
      gateId: 'style_preview_selection',
      skill: 'frontend-slides',
      props: {
        title: 'Choose a Style Preview',
        choices: [
          {
            id: 'style-a',
            label: 'Style A',
            value: 'Style A',
            description: 'Use the first generated preview direction.',
          },
          {
            id: 'style-b',
            label: 'Style B',
            value: 'Style B',
            description: 'Use the second generated preview direction.',
          },
          {
            id: 'style-c',
            label: 'Style C',
            value: 'Style C',
            description: 'Use the third generated preview direction.',
          },
        ],
      },
      metadata: {
        skill: 'frontend-slides',
        gateId: 'style_preview_selection',
      },
    },
  };

  const repaired = withFrontendSlidesGateMetadata(choicesOnlyStylePreviewInterrupt, 'style_preview_selection');
  const previews = ((repaired.interactionRequest as any)?.props?.previews || []) as Array<Record<string, unknown>>;

  assert.equal(validateInterrupt(repaired, 'frontend-slides'), null);
  assert.equal(previews.length, 3);
  assert.equal(previews[0].id, 'style-a');
  assert.match(String(previews[0].html || ''), /<!doctype html>/i);
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

test('shouldFailRunningRunForStaleActivity only fails stale active runs', () => {
  assert.equal(
    shouldFailRunningRunForStaleActivity({
      status: 'running',
      lastActivityAt: 1_000,
      now: 61_000,
      timeoutMs: 60_000,
    }),
    true,
  );

  assert.equal(
    shouldFailRunningRunForStaleActivity({
      status: 'queued',
      lastActivityAt: 1_000,
      now: 60_999,
      timeoutMs: 60_000,
    }),
    false,
  );

  assert.equal(
    shouldFailRunningRunForStaleActivity({
      status: 'completed',
      lastActivityAt: 1_000,
      now: 999_000,
      timeoutMs: 60_000,
    }),
    false,
  );

  assert.equal(
    shouldFailRunningRunForStaleActivity({
      status: 'running',
      now: 999_000,
      timeoutMs: 60_000,
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

test('terminalEventFromStreamPayload ignores recoverable progress tool errors', () => {
  assert.equal(
    terminalEventFromStreamPayload({
      type: 'progress',
      phase: 'using_tool',
      status: 'error',
      label: 'Searching the web hit a timeout',
      detail: 'The agent will continue without retrying this tool.',
      toolName: 'google_search',
    }),
    undefined,
  );
  assert.deepEqual(terminalEventFromStreamPayload({ type: 'done', status: 'failed', error: 'boom' }), {
    status: 'failed',
    error: 'boom',
  });
});

test('buildSyntheticClarificationFollowupPrompt advances deck mode to style previews', () => {
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
      displayPayload: { synthetic: true, skill: 'frontend-slides', gateId: 'presentation_context' },
      responseSpec: {
        questions: [
          { id: 'presentation_goal', header: 'Goal', question: 'What is the goal?' },
          { id: 'audience', header: 'Audience', question: 'Who is it for?' },
        ],
      },
    } as any,
  );

  assert.match(prompt, /user selected the deck mode/);
  assert.match(prompt, /style_preview_selection/);
  assert.match(prompt, /Frontend-slides workflow state/);
  assert.match(prompt, /workflow_action\(action="request_user_interaction", gate_id="style_preview_selection"/);
  assert.match(prompt, /generate 2-3 style previews\/templates/i);
  assert.doesNotMatch(prompt, /outline_confirmation structured Interaction workflow action/);
  assert.match(prompt, /^\/skill frontend-slides\n/);
});

test('buildSyntheticClarificationFollowupPrompt does not nest prior continuation prompts', () => {
  const previousInterrupt = {
    kind: 'clarification',
    title: 'Presentation Context',
    displayPayload: { synthetic: true, skill: 'frontend-slides', gateId: 'presentation_context' },
    responseSpec: {
      questions: [
        { id: 'purpose', header: 'Purpose', question: 'What is this presentation for?' },
      ],
    },
  } as any;
  const wrappedOnce = buildSyntheticClarificationFollowupPrompt(
    '/skill frontend-slides @final-research-report.md',
    { answersByQuestionId: { purpose: 'Pitch deck' } },
    previousInterrupt,
  );
  const wrappedTwice = buildSyntheticClarificationFollowupPrompt(
    wrappedOnce,
    { answersByQuestionId: { purpose: 'Teaching' } },
    previousInterrupt,
  );

  assert.equal((wrappedTwice.match(/\[Clarification response/g) || []).length, 1);
  assert.equal((wrappedTwice.match(/Original request content, with command routing removed:/g) || []).length, 1);
  assert.match(wrappedTwice, /@final-research-report\.md/);
  assert.equal((wrappedTwice.match(/^\/skill frontend-slides$/gm) || []).length, 1);
});

test('buildSyntheticClarificationFollowupPrompt does not let a legacy outline gate bypass deck mode', () => {
  const prompt = buildSyntheticClarificationFollowupPrompt(
    'Create a deck',
    {
      answersByQuestionId: {
        outline_confirmation: 'Approved',
      },
    },
    {
      kind: 'clarification',
      title: 'Outline Confirmation',
      displayPayload: { synthetic: true, skill: 'frontend-slides', gateId: 'outline_confirmation' },
      responseSpec: {
        questions: [
          { id: 'outline_confirmation', header: 'Outline', question: 'Does this outline look right?' },
        ],
      },
    } as any,
  );

  assert.match(prompt, /presentation_context/);
  assert.match(prompt, /choose_deck_mode/);
  assert.match(prompt, /workflow_action\(action="request_user_interaction", gate_id="presentation_context"/);
  assert.doesNotMatch(prompt, /style_preview_selection structured Interaction workflow action/);
  assert.match(prompt, /^\/skill frontend-slides\n/);
});

test('buildSyntheticClarificationFollowupPrompt can recover legacy mood selection to style previews', () => {
  const prompt = buildSyntheticClarificationFollowupPrompt(
    'Create a deck',
    {
      answersByQuestionId: {
        mood: 'Executive modern',
      },
    },
    {
      kind: 'clarification',
      title: 'Vibe & Mood Selection',
      displayPayload: { synthetic: true, skill: 'frontend-slides', gateId: 'mood_or_preset_selection' },
      responseSpec: {
        questions: [
          { id: 'mood', header: 'Mood', question: 'What mood should the templates use?' },
        ],
      },
    } as any,
    {
      completedGateIds: ['presentation_context', 'outline_confirmation'],
    },
  );

  assert.match(prompt, /selected a legacy mood or preset direction/);
  assert.match(prompt, /Generate 2-3 style previews\/templates next/);
  assert.match(prompt, /style_preview_selection/);
  assert.doesNotMatch(prompt, /completed Presentation Context/);
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
      displayPayload: { synthetic: true, skill: 'frontend-slides', gateId: 'style_preview_selection', chooser: 'style-previews' },
      responseSpec: {
        choices: [
          { id: 'style-a', label: 'Style A', value: 'Style A' },
          { id: 'style-b', label: 'Style B', value: 'Style B' },
        ],
      },
    } as any,
  );

  assert.match(prompt, /Both required decisions are complete: deck mode and visual style/);
  assert.match(prompt, /final generation phase/);
  assert.match(prompt, /Do not call workflow_action\(action="request_user_interaction"\)/);
  assert.match(prompt, /Generate the final required artifact now/);
  assert.match(prompt, /filename ends with -deck\.html/);
  assert.match(prompt, /<section class="slide">/);
  assert.match(prompt, /not a report or summary page/);
  assert.doesNotMatch(prompt, /Presentation Context again/);
});

test('buildSyntheticClarificationFollowupPrompt honors persisted completed frontend-slides gate state', () => {
  const prompt = buildSyntheticClarificationFollowupPrompt(
    '/skill frontend-slides @final-research-report.md',
    {
      answersByQuestionId: {
        presentation_goal: 'Explain the solution.',
      },
    },
    {
      kind: 'clarification',
      title: 'Presentation Context',
      displayPayload: { synthetic: true, skill: 'frontend-slides', gateId: 'presentation_context' },
      responseSpec: {
        questions: [
          { id: 'presentation_goal', header: 'Goal', question: 'What is the goal?' },
        ],
      },
    } as any,
    {
      completedGateIds: [
        'presentation_context',
        'outline_confirmation',
        'style_preview_selection',
      ],
    },
  );

  assert.match(prompt, /Both required decisions are complete/i);
  assert.match(prompt, /Generate the final required artifact now/);
  assert.match(prompt, /Do not call workflow_action\(action="request_user_interaction"\)/);
  assert.match(prompt, /filename ends with -deck\.html/);
  assert.doesNotMatch(prompt, /Generate the slide outline next/);
  assert.doesNotMatch(prompt, /outline_confirmation structured Interaction workflow action/);
});

test('getRunMeta reconciles stale completed-gate frontend-slides runs', {
  skip: process.env.RUN_INTERACTION_E2E !== '1' ? 'set RUN_INTERACTION_E2E=1 with Redis available to run lifecycle flow test' : false,
}, async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  const runId = `stale-frontend-slides-${Date.now()}`;
  const streamKey = `agent:run:${runId}`;
  const metaKey = `${streamKey}:meta`;
  const workspaceId = 'workspace-stale-frontend-slides';
  const turnId = `turn-${Date.now()}`;
  const oldMs = Date.now() - 60 * 60 * 1000;
  const oldIso = new Date(oldMs).toISOString();
  const requiredGates = ['presentation_context', 'style_preview_selection'];

  try {
    await redisClient.hSet(metaKey, {
      workspaceId,
      persona: 'fast',
      status: 'running',
      createdAt: oldIso,
      startedAt: oldIso,
      turnId,
      pendingInterrupt: '',
      error: '',
      interactionGateState: JSON.stringify({ completedGateIds: requiredGates }),
      runContext: JSON.stringify({
        workspaceId,
        persona: 'fast',
        prompt: '/skill frontend-slides @final-research-report.md',
        history: [{ role: 'user', content: '/skill frontend-slides @final-research-report.md' }],
        turnId,
        forceReset: true,
      }),
    });
    await redisClient.sendCommand([
      'XADD',
      streamKey,
      `${oldMs}-0`,
      'data',
      JSON.stringify({ type: 'token', content: 'Generating final deck...' }),
    ]);

    const meta = await getRunMeta(runId);
    assert.equal(meta?.status, 'failed');
    assert.match(meta?.error || '', /before producing the final HTML deck/);
  } finally {
    await redisClient.del(streamKey);
    await redisClient.del(metaKey);
  }
});

test('getRunMeta completes frontend-slides runs that wrote the final deck before settling', {
  skip: process.env.RUN_INTERACTION_E2E !== '1' ? 'set RUN_INTERACTION_E2E=1 with Redis available to run lifecycle flow test' : false,
}, async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  const runId = `deck-recovered-frontend-slides-${Date.now()}`;
  const streamKey = `agent:run:${runId}`;
  const metaKey = `${streamKey}:meta`;
  const workspaceId = 'workspace-deck-recovered-frontend-slides';
  const turnId = `turn-${Date.now()}`;
  const nowIso = new Date().toISOString();
  const requiredGates = ['presentation_context', 'style_preview_selection'];

  try {
    await redisClient.hSet(metaKey, {
      workspaceId,
      persona: 'fast',
      status: 'running',
      createdAt: nowIso,
      startedAt: nowIso,
      turnId,
      pendingInterrupt: '',
      error: '',
      interactionGateState: JSON.stringify({ completedGateIds: requiredGates }),
      runContext: JSON.stringify({
        workspaceId,
        persona: 'fast',
        prompt: '/skill frontend-slides @final-research-report.md',
        history: [{ role: 'user', content: '/skill frontend-slides @final-research-report.md' }],
        turnId,
        forceReset: true,
      }),
    });
    await redisClient.xAdd(streamKey, '*', {
      data: JSON.stringify({
        type: 'tool_end',
        name: 'write_file',
        outputFiles: [
          { path: 'slides/final-research-report-deck.html', mimeType: 'text/html', size: 4096 },
          { path: 'slides/final-research-report-deck.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 8192 },
        ],
      }),
    });

    const meta = await getRunMeta(runId);
    assert.equal(meta?.status, 'completed');
    assert.equal(meta?.error || '', '');
    assert.equal(meta?.pendingInterrupt, undefined);
  } finally {
    await redisClient.del(streamKey);
    await redisClient.del(metaKey);
  }
});

test('getRunMeta completes frontend-slides runs with earlier required deck artifacts', {
  skip: process.env.RUN_INTERACTION_E2E !== '1' ? 'set RUN_INTERACTION_E2E=1 with Redis available to run lifecycle flow test' : false,
}, async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  const runId = `presentation-html-recovered-frontend-slides-${Date.now()}`;
  const streamKey = `agent:run:${runId}`;
  const metaKey = `${streamKey}:meta`;
  const workspaceId = 'workspace-presentation-html-recovered-frontend-slides';
  const turnId = `turn-${Date.now()}`;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const earlierMs = nowMs - 30_000;
  const requiredGates = ['presentation_context', 'style_preview_selection'];

  try {
    await redisClient.hSet(metaKey, {
      workspaceId,
      persona: 'fast',
      status: 'running',
      createdAt: new Date(earlierMs).toISOString(),
      startedAt: nowIso,
      turnId,
      pendingInterrupt: '',
      error: '',
      interactionGateState: JSON.stringify({ completedGateIds: requiredGates }),
      runContext: JSON.stringify({
        workspaceId,
        persona: 'fast',
        prompt: '/skill frontend-slides @final-research-report.md',
        history: [{ role: 'user', content: '/skill frontend-slides @final-research-report.md' }],
        turnId,
        forceReset: true,
      }),
    });
    await redisClient.sendCommand([
      'XADD',
      streamKey,
      `${earlierMs}-0`,
      'data',
      JSON.stringify({
        type: 'tool_end',
        name: 'write_file',
        outputFiles: [
          { path: 'K-CIP-deck.html', mimeType: 'text/html', size: 47_468 },
          { path: 'K-CIP-presentation.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 96_000 },
        ],
      }),
    ]);
    await redisClient.xAdd(streamKey, '*', {
      data: JSON.stringify({
        type: 'token',
        content: 'I have initialized the structured configuration form again.',
      }),
    });

    const meta = await getRunMeta(runId);
    assert.equal(meta?.status, 'completed');
    assert.equal(meta?.error || '', '');
  } finally {
    await redisClient.del(streamKey);
    await redisClient.del(metaKey);
  }
});

test('getRunMeta recovers the next declared frontend-slides gate before terminal stream recovery', {
  skip: process.env.RUN_INTERACTION_E2E !== '1' ? 'set RUN_INTERACTION_E2E=1 with Redis available to run lifecycle flow test' : false,
}, async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  const runId = `terminal-missing-gate-frontend-slides-${Date.now()}`;
  const streamKey = `agent:run:${runId}`;
  const metaKey = `${streamKey}:meta`;
  const workspaceId = 'workspace-terminal-missing-gate-frontend-slides';
  const turnId = `turn-${Date.now()}`;
  const nowIso = new Date().toISOString();

  try {
    await redisClient.hSet(metaKey, {
      workspaceId,
      persona: 'fast',
      status: 'running',
      createdAt: nowIso,
      startedAt: nowIso,
      turnId,
      pendingInterrupt: '',
      error: '',
      interactionGateState: JSON.stringify({ completedGateIds: ['presentation_context'] }),
      runContext: JSON.stringify({
        workspaceId,
        persona: 'fast',
        prompt: '/skill frontend-slides @final-research-report.md',
        history: [{ role: 'user', content: '/skill frontend-slides @final-research-report.md' }],
        turnId,
        forceReset: true,
      }),
    });
    await redisClient.xAdd(streamKey, '*', {
      data: JSON.stringify({ type: 'done', status: 'completed' }),
    });

    const meta = await getRunMeta(runId);
    assert.equal(meta?.status, 'awaiting_approval');
    assert.equal(meta?.error || '', '');
    assert.equal(meta?.pendingInterrupt?.displayPayload?.gateId, 'style_preview_selection');
    assert.equal(meta?.pendingInterrupt?.interactionRequest?.presentation, 'style_preview');
    assert.deepEqual(meta?.interactionGateState?.completedGateIds, ['presentation_context']);
  } finally {
    await redisClient.del(streamKey);
    await redisClient.del(metaKey);
  }
});

test('buildSyntheticClarificationFollowupPrompt gives generic skills non-slide continuation guidance', () => {
  const prompt = buildSyntheticClarificationFollowupPrompt(
    '/skill research write a market brief',
    {
      answersByQuestionId: {
        response: 'Executive summary',
      },
    },
    {
      kind: 'clarification',
      title: 'Input Needed',
      displayPayload: { synthetic: true, skill: 'research', source: 'implicit_completion_guard', interactionContract: 'helpudoc.interaction' },
      responseSpec: {
        questions: [
          { id: 'response', header: 'Input', question: 'Which format would you prefer?' },
        ],
      },
    } as any,
  );

  assert.match(prompt, /continue the 'research' skill/);
  assert.match(prompt, /Do not ask for this same input again/);
  assert.match(prompt, /If another human decision or clarification is required/);
  assert.match(prompt, /workflow_action\(action="request_user_interaction"\)/);
  assert.doesNotMatch(prompt, /Presentation Context/);
  assert.doesNotMatch(prompt, /Frontend-slides workflow state/);
  assert.doesNotMatch(prompt, /^\/skill research/m);
});

test('frontend-slides Interaction presentation gate resumes through continuation instead of repeating Gate 1', {
  skip: process.env.RUN_INTERACTION_E2E !== '1' ? 'set RUN_INTERACTION_E2E=1 with Redis available to run lifecycle flow test' : false,
}, async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  const calls: Array<{
    kind: 'run' | 'respond';
    prompt?: string;
    forceReset?: boolean;
    traceCompletedGates?: string[];
    traceThreadId?: string;
  }> = [];
  let runId = '';
  const turnId = `interaction-e2e-${Date.now()}`;
  const workspaceId = 'workspace-interaction-e2e';
  try {
    configureAgentRunServices({
      telemetryService: null,
      userMemoryService: null,
      skillEvolutionService: null,
      conversationService: null,
      agentStreamClient: {
        runAgentStream: async (_persona, _workspaceId, prompt, _history, options) => {
          calls.push({
            kind: 'run',
            prompt,
            forceReset: options?.forceReset,
            traceCompletedGates: options?.traceContext?.interactionGateState?.completedGateIds,
          });
          if (calls.length === 1) {
            return makeStreamResponse([
              { type: 'policy', skill: 'frontend-slides' },
              nativeOnlyPresentationContextInterrupt,
            ]);
          }
          return makeStreamResponse([
            { type: 'policy', skill: 'frontend-slides' },
            stylePreviewSelectionInterrupt,
          ]);
        },
        resumeAgentResponseStream: async () => {
          calls.push({ kind: 'respond' });
          return makeStreamResponse([
            { type: 'policy', skill: 'frontend-slides' },
            presentationContextInterrupt,
          ]);
        },
      },
    });

    const started = await startAgentRun({
      workspaceId,
      persona: 'fast',
      prompt: '/skill frontend-slides @final-research-report.md',
      history: [{ role: 'user', content: '/skill frontend-slides @final-research-report.md' }],
      turnId,
      forceReset: true,
    });
    runId = started.runId;

    const awaiting = await waitForRunStatus(runId, (status) => status === 'awaiting_approval');
    assert.equal(awaiting?.status, 'awaiting_approval');
    assert.equal(awaiting?.pendingInterrupt?.displayPayload?.source, 'implicit_input_guard');
    assert.equal(awaiting?.pendingInterrupt?.interactionRequest?.presentation, 'questionnaire');
    assert.equal(awaiting?.pendingInterrupt?.interactionRequest?.contract, 'helpudoc.interaction');
    assert.equal(awaiting?.pendingInterrupt?.interactionRequest?.presentation, 'questionnaire');
    assert.equal(awaiting?.pendingInterrupt?.interactionRequest?.gateId, 'presentation_context');

    await resumeAgentRunWithResponse(runId, {
      answersByQuestionId: {
        purpose: 'Pitch deck',
      },
    }, {
      previousInterrupt: awaiting?.pendingInterrupt,
    });

    const settled = await waitForRunStatus(runId, (status, meta) => {
      if (status === 'failed') {
        return true;
      }
      if (status !== 'awaiting_approval') {
        return false;
      }
      return meta?.pendingInterrupt?.displayPayload?.gateId === 'style_preview_selection';
    });
    assert.equal(settled?.status, 'awaiting_approval');
    assert.equal(settled?.pendingInterrupt?.displayPayload?.gateId, 'style_preview_selection');
    assert.deepEqual(settled?.interactionGateState?.completedGateIds, ['presentation_context']);
    assert.equal(calls.some((call) => call.kind === 'respond'), false);
    assert.equal(calls[1]?.kind, 'run');
    assert.equal(calls[1]?.forceReset, true);
    assert.match(calls[1]?.prompt || '', /generate 2-3 style previews\/templates/i);
    assert.match(calls[1]?.prompt || '', /style_preview_selection/);
    assert.deepEqual(calls[1]?.traceCompletedGates, ['presentation_context']);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (runId) {
      await redisClient.del(`agent:run:${runId}`);
      await redisClient.del(`agent:run:${runId}:meta`);
    }
    await redisClient.del(`agent:run:key:${workspaceId}:fast:${turnId}`);
    configureAgentRunServices({ agentStreamClient: null });
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  }
});

test('frontend-slides Interaction contract synthetic native gate continues through followup prompt', {
  skip: process.env.RUN_INTERACTION_E2E !== '1' ? 'set RUN_INTERACTION_E2E=1 with Redis available to run lifecycle flow test' : false,
}, async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  const calls: Array<{
    kind: 'run' | 'respond';
    prompt?: string;
    forceReset?: boolean;
    traceCompletedGates?: string[];
  }> = [];
  let runId = '';
  const turnId = `interaction-contract-synthetic-${Date.now()}`;
  const workspaceId = 'workspace-interaction-contract-synthetic';
  try {
    configureAgentRunServices({
      telemetryService: null,
      userMemoryService: null,
      skillEvolutionService: null,
      conversationService: null,
      agentStreamClient: {
        runAgentStream: async (_persona, _workspaceId, prompt, _history, options) => {
          calls.push({
            kind: 'run',
            prompt,
            forceReset: options?.forceReset,
            traceCompletedGates: options?.traceContext?.interactionGateState?.completedGateIds,
          });
          if (calls.length === 1) {
            return makeStreamResponse([
              { type: 'policy', skill: 'frontend-slides' },
              nativeOnlyContractSyntheticPresentationContextInterrupt,
            ]);
          }
          return makeStreamResponse([
            { type: 'policy', skill: 'frontend-slides' },
            stylePreviewSelectionInterrupt,
          ]);
        },
        resumeAgentResponseStream: async (_persona, _workspaceId, _response, options) => {
          calls.push({
            kind: 'respond',
            traceCompletedGates: options?.traceContext?.interactionGateState?.completedGateIds,
          });
          return makeStreamResponse([
            { type: 'policy', skill: 'frontend-slides' },
            outlineConfirmationInterrupt,
          ]);
        },
      },
    });

    const started = await startAgentRun({
      workspaceId,
      persona: 'fast',
      prompt: '/skill frontend-slides @final-research-report.md',
      history: [{ role: 'user', content: '/skill frontend-slides @final-research-report.md' }],
      turnId,
      forceReset: true,
    });
    runId = started.runId;

    const awaiting = await waitForRunStatus(runId, (status) => status === 'awaiting_approval');
    assert.equal(awaiting?.status, 'awaiting_approval');
    assert.equal(awaiting?.pendingInterrupt?.displayPayload?.synthetic, true);
    assert.equal(awaiting?.pendingInterrupt?.displayPayload?.source, 'interaction_contract_synthetic');
    assert.equal(awaiting?.pendingInterrupt?.interactionRequest?.contract, 'helpudoc.interaction');
    assert.equal(awaiting?.pendingInterrupt?.interactionRequest?.gateId, 'presentation_context');

    await resumeAgentRunWithResponse(runId, {
      answersByQuestionId: {
        purpose: 'Pitch deck',
      },
    }, {
      previousInterrupt: awaiting?.pendingInterrupt,
    });

    const settled = await waitForRunStatus(runId, (status, meta) => {
      if (status === 'failed') {
        return true;
      }
      return status === 'awaiting_approval' && meta?.pendingInterrupt?.displayPayload?.gateId === 'style_preview_selection';
    });
    assert.equal(settled?.status, 'awaiting_approval');
    assert.equal(settled?.pendingInterrupt?.displayPayload?.gateId, 'style_preview_selection');
    assert.deepEqual(settled?.interactionGateState?.completedGateIds, ['presentation_context']);
    assert.equal(calls.some((call) => call.kind === 'respond'), false);
    assert.equal(calls[1]?.kind, 'run');
    assert.equal(calls[1]?.forceReset, true);
    assert.match(calls[1]?.prompt || '', /generate 2-3 style previews\/templates/i);
    assert.match(calls[1]?.prompt || '', /style_preview_selection/);
    assert.deepEqual(calls[1]?.traceCompletedGates, ['presentation_context']);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (runId) {
      await redisClient.del(`agent:run:${runId}`);
      await redisClient.del(`agent:run:${runId}:meta`);
    }
    await redisClient.del(`agent:run:key:${workspaceId}:fast:${turnId}`);
    configureAgentRunServices({ agentStreamClient: null });
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  }
});

test('frontend-slides Interaction flow reaches final slide generation after all required gates', {
  skip: process.env.RUN_INTERACTION_E2E !== '1' ? 'set RUN_INTERACTION_E2E=1 with Redis available to run lifecycle flow test' : false,
}, async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  const requiredGates = ['presentation_context', 'style_preview_selection'];
  const calls: Array<{
    kind: 'run' | 'respond';
    prompt?: string;
    forceReset?: boolean;
    traceCompletedGates?: string[];
  }> = [];
  const seenPendingGates: string[] = [];
  let runId = '';
  const turnId = `interaction-full-flow-${Date.now()}`;
  const workspaceId = 'workspace-interaction-full-flow';

  const completedDeckResponse: Array<Record<string, unknown>> = [
    { type: 'policy', skill: 'frontend-slides' },
    {
      type: 'progress',
      stage: 'writing_artifact',
      status: 'completed',
      label: 'Generated final HTML and PowerPoint slide decks',
      artifactPath: 'slides/final-research-report-deck.html',
    },
    {
      type: 'tool_end',
      name: 'write_file',
      outputFiles: [
        {
          path: 'slides/final-research-report-deck.html',
          mimeType: 'text/html',
          size: 4096,
        },
        {
          path: 'slides/final-research-report-deck.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          size: 8192,
        },
      ],
    },
    {
      type: 'token',
      content: 'Generated the final slide deck and PowerPoint export.',
    },
    { type: 'done', status: 'completed' },
  ];

  const awaitGate = async (gateId: string) => {
    const meta = await waitForRunStatus(runId, (status, latest) => {
      if (status === 'failed') {
        return true;
      }
      return status === 'awaiting_approval' && latest?.pendingInterrupt?.displayPayload?.gateId === gateId;
    });
    assert.equal(meta?.status, 'awaiting_approval');
    assert.equal(meta?.pendingInterrupt?.displayPayload?.gateId, gateId);
    seenPendingGates.push(gateId);
    return meta;
  };

  try {
    configureAgentRunServices({
      telemetryService: null,
      userMemoryService: null,
      skillEvolutionService: null,
      conversationService: null,
      agentStreamClient: {
        runAgentStream: async (_persona, _workspaceId, prompt, _history, options) => {
          const completedGates = options?.traceContext?.interactionGateState?.completedGateIds || [];
          calls.push({
            kind: 'run',
            prompt,
            forceReset: options?.forceReset,
            traceCompletedGates: completedGates,
            traceThreadId: options?.traceContext?.threadId,
          });
          if (completedGates.includes('presentation_context')) {
            return makeStreamResponse([
              { type: 'policy', skill: 'frontend-slides' },
              stylePreviewSelectionInterrupt,
            ]);
          }
          return makeStreamResponse([
            { type: 'policy', skill: 'frontend-slides' },
            presentationContextInterrupt,
          ]);
        },
        resumeAgentResponseStream: async (_persona, _workspaceId, _response, options) => {
          const completedGates = options?.traceContext?.interactionGateState?.completedGateIds || [];
          calls.push({
            kind: 'respond',
            traceCompletedGates: completedGates,
            traceThreadId: options?.traceContext?.threadId,
          });
          return makeStreamResponse(completedDeckResponse);
        },
      },
    });

    const started = await startAgentRun({
      workspaceId,
      persona: 'fast',
      prompt: '/skill frontend-slides @final-research-report.md',
      history: [{ role: 'user', content: '/skill frontend-slides @final-research-report.md' }],
      turnId,
      forceReset: true,
    });
    runId = started.runId;

    const presentation = await awaitGate('presentation_context');
    assert.equal(presentation?.pendingInterrupt?.interactionRequest?.presentation, 'questionnaire');
    await resumeAgentRunWithResponse(runId, {
      answersByQuestionId: {
        purpose: 'Pitch deck',
      },
    }, { previousInterrupt: presentation?.pendingInterrupt });

    const stylePreview = await awaitGate('style_preview_selection');
    assert.equal(calls[1]?.kind, 'run');
    assert.equal(calls[1]?.forceReset, true);
    assert.match(calls[1]?.traceThreadId || '', new RegExp(`^${runId}:reset:`));
    assert.match(calls[1]?.prompt || '', /generate 2-3 style previews\/templates/i);
    assert.equal(stylePreview?.pendingInterrupt?.interactionRequest?.presentation, 'style_preview');
    await resumeAgentRunWithResponse(runId, {
      selectedChoiceIds: ['style-b'],
      selectedValues: ['Style B'],
      message: 'Use Style B for the final deck.',
    }, { previousInterrupt: stylePreview?.pendingInterrupt });

    const completed = await waitForRunStatus(runId, (status) => status === 'completed' || status === 'failed');
    assert.equal(completed?.status, 'completed');
    assert.deepEqual(completed?.interactionGateState?.completedGateIds, requiredGates);
    assert.deepEqual(seenPendingGates, requiredGates);
    assert.deepEqual(
      calls
        .filter((call) => call.kind === 'respond')
        .map((call) => call.traceCompletedGates),
      [requiredGates],
    );
    assert.equal(calls.find((call) => call.kind === 'respond')?.traceThreadId, runId);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (runId) {
      await redisClient.del(`agent:run:${runId}`);
      await redisClient.del(`agent:run:${runId}:meta`);
    }
    await redisClient.del(`agent:run:key:${workspaceId}:fast:${turnId}`);
    configureAgentRunServices({ agentStreamClient: null });
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  }
});

test('frontend-slides completion after presentation recovers to native style preview selection', {
  skip: process.env.RUN_INTERACTION_E2E !== '1' ? 'set RUN_INTERACTION_E2E=1 with Redis available to run lifecycle flow test' : false,
}, async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  let runId = '';
  const turnId = `interaction-missing-style-recovery-${Date.now()}`;
  const workspaceId = 'workspace-interaction-missing-style-recovery';
  let callCount = 0;
  try {
    configureAgentRunServices({
      telemetryService: null,
      userMemoryService: null,
      skillEvolutionService: null,
      conversationService: null,
      agentStreamClient: {
        runAgentStream: async () => {
          callCount += 1;
          if (callCount === 1) {
            return makeStreamResponse([
              { type: 'policy', skill: 'frontend-slides' },
              presentationContextInterrupt,
            ]);
          }
          return makeStreamResponse([
            { type: 'policy', skill: 'frontend-slides' },
            {
              type: 'token',
              content: 'I have prepared three visual directions and am ready for style selection.',
            },
            { type: 'done', status: 'completed' },
          ]);
        },
      },
    });

    const started = await startAgentRun({
      workspaceId,
      persona: 'fast',
      prompt: '/skill frontend-slides @final-research-report.md',
      history: [{ role: 'user', content: '/skill frontend-slides @final-research-report.md' }],
      turnId,
      forceReset: true,
    });
    runId = started.runId;

    const setup = await waitForRunStatus(runId, (status) => status === 'awaiting_approval');
    assert.equal(setup?.pendingInterrupt?.displayPayload?.gateId, 'presentation_context');

    await resumeAgentRunWithResponse(runId, {
      answersByQuestionId: {
        purpose: 'Teaching/Tutorial',
        length: 'Medium (10-20)',
      },
    }, {
      previousInterrupt: setup?.pendingInterrupt,
    });

    const recovered = await waitForRunStatus(runId, (status, meta) => (
      status === 'failed' ||
      (status === 'awaiting_approval' && meta?.pendingInterrupt?.displayPayload?.gateId === 'style_preview_selection')
    ));

    assert.equal(recovered?.status, 'awaiting_approval');
    assert.equal(recovered?.pendingInterrupt?.displayPayload?.gateId, 'style_preview_selection');
    assert.equal(recovered?.pendingInterrupt?.interactionRequest?.presentation, 'style_preview');
    assert.equal(recovered?.pendingInterrupt?.interactionRequest?.gateId, 'style_preview_selection');
    assert.equal(recovered?.pendingInterrupt?.displayPayload?.source, 'implicit_completion_guard');
    assert.deepEqual(recovered?.interactionGateState?.completedGateIds, ['presentation_context']);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (runId) {
      await redisClient.del(`agent:run:${runId}`);
      await redisClient.del(`agent:run:${runId}:meta`);
    }
    await redisClient.del(`agent:run:key:${workspaceId}:fast:${turnId}`);
    configureAgentRunServices({ agentStreamClient: null });
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  }
});

test('frontend-slides duplicate setup gate recovers to style preview selection with fallback previews', {
  skip: process.env.RUN_INTERACTION_E2E !== '1' ? 'set RUN_INTERACTION_E2E=1 with Redis available to run lifecycle flow test' : false,
}, async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  let runId = '';
  const turnId = `interaction-duplicate-setup-style-recovery-${Date.now()}`;
  const workspaceId = 'workspace-interaction-duplicate-setup-style-recovery';
  let callCount = 0;
  const syntheticPresentationContextInterrupt = {
    ...presentationContextInterrupt,
    displayPayload: {
      ...presentationContextInterrupt.displayPayload,
      synthetic: true,
    },
    interactionRequest: {
      ...presentationContextInterrupt.interactionRequest,
      metadata: {
        ...presentationContextInterrupt.interactionRequest.metadata,
        synthetic: true,
      },
    },
  };
  try {
    configureAgentRunServices({
      telemetryService: null,
      userMemoryService: null,
      skillEvolutionService: null,
      conversationService: null,
      agentStreamClient: {
        runAgentStream: async () => {
          callCount += 1;
          if (callCount === 1) {
            return makeStreamResponse([
              { type: 'policy', skill: 'frontend-slides' },
              syntheticPresentationContextInterrupt,
            ]);
          }
          return makeStreamResponse([
            { type: 'policy', skill: 'frontend-slides' },
            { type: 'tool_start', name: 'read_file', content: '{"file_path":"/operation-epic-fury-report.md"}' },
            {
              type: 'tool_end',
              name: 'read_file',
              content: [
                '1\t# Operation Epic Fury',
                '2\t',
                '3\t## TL;DR',
                '4\t- Major regional conflict scenario',
                '5\t- Strategic, economic, and geopolitical impacts',
              ].join('\n'),
            },
            syntheticPresentationContextInterrupt,
          ]);
        },
      },
    });

    const started = await startAgentRun({
      workspaceId,
      persona: 'fast',
      prompt: '/skill frontend-slides @operation-epic-fury-report.md',
      history: [{ role: 'user', content: '/skill frontend-slides @operation-epic-fury-report.md' }],
      turnId,
      forceReset: true,
    });
    runId = started.runId;

    const setup = await waitForRunStatus(runId, (status) => status === 'awaiting_approval');
    assert.equal(setup?.pendingInterrupt?.displayPayload?.gateId, 'presentation_context');

    await resumeAgentRunWithResponse(runId, {
      answersByQuestionId: {
        purpose: 'Pitch deck',
        length: 'Medium (10-20)',
      },
    }, {
      previousInterrupt: setup?.pendingInterrupt,
    });

    const recovered = await waitForRunStatus(runId, (status, meta) => (
      status === 'failed' ||
      (status === 'awaiting_approval' && meta?.pendingInterrupt?.displayPayload?.gateId === 'style_preview_selection')
    ));

    assert.equal(recovered?.status, 'awaiting_approval');
    assert.equal(recovered?.pendingInterrupt?.displayPayload?.gateId, 'style_preview_selection');
    const props = recovered?.pendingInterrupt?.interactionRequest?.props || {};
    assert.ok(Array.isArray(props.choices) && props.choices.length >= 3);
    assert.ok(Array.isArray(props.previews) && props.previews.length >= 3);
    assert.deepEqual(recovered?.interactionGateState?.completedGateIds, ['presentation_context']);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (runId) {
      await redisClient.del(`agent:run:${runId}`);
      await redisClient.del(`agent:run:${runId}:meta`);
    }
    await redisClient.del(`agent:run:key:${workspaceId}:fast:${turnId}`);
    configureAgentRunServices({ agentStreamClient: null });
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  }
});

test('frontend-slides completion with missing style preview gate recovers with fallback previews', {
  skip: process.env.RUN_INTERACTION_E2E !== '1' ? 'set RUN_INTERACTION_E2E=1 with Redis available to run lifecycle flow test' : false,
}, async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  let runId = '';
  const turnId = `interaction-missing-style-preview-recovery-${Date.now()}`;
  const workspaceId = 'workspace-interaction-missing-style-preview-recovery';
  try {
    configureAgentRunServices({
      telemetryService: null,
      userMemoryService: null,
      skillEvolutionService: null,
      conversationService: null,
      agentStreamClient: {
        runAgentStream: async (_persona, _workspaceId, _prompt, _history, options) => {
          const completedGates = options?.traceContext?.interactionGateState?.completedGateIds || [];
          if (completedGates.includes('presentation_context')) {
            return makeStreamResponse([
              { type: 'policy', skill: 'frontend-slides' },
              { type: 'done', status: 'completed' },
            ]);
          }
          return makeStreamResponse([
            { type: 'policy', skill: 'frontend-slides' },
            presentationContextInterrupt,
          ]);
        },
      },
    });

    const started = await startAgentRun({
      workspaceId,
      persona: 'fast',
      prompt: '/skill frontend-slides @final-research-report.md',
      history: [{ role: 'user', content: '/skill frontend-slides @final-research-report.md' }],
      turnId,
      forceReset: true,
    });
    runId = started.runId;

    const presentation = await waitForRunStatus(runId, (status, latest) => (
      status === 'failed' ||
      (status === 'awaiting_approval' && latest?.pendingInterrupt?.displayPayload?.gateId === 'presentation_context')
    ));
    assert.equal(presentation?.status, 'awaiting_approval');
    await resumeAgentRunWithResponse(runId, {
      answersByQuestionId: { purpose: 'Pitch deck' },
    }, {
      previousInterrupt: presentation?.pendingInterrupt,
    });

    const recovered = await waitForRunStatus(runId, (status, latest) => (
      status === 'failed' ||
      (status === 'awaiting_approval' && latest?.pendingInterrupt?.displayPayload?.gateId === 'style_preview_selection')
    ));
    assert.equal(recovered?.status, 'awaiting_approval');
    const props = recovered?.pendingInterrupt?.interactionRequest?.props || {};
    assert.equal(recovered?.pendingInterrupt?.interactionRequest?.presentation, 'style_preview');
    assert.ok(Array.isArray(props.choices) && props.choices.length >= 3);
    assert.ok(Array.isArray(props.previews) && props.previews.length >= 3);
    assert.deepEqual(recovered?.interactionGateState?.completedGateIds, ['presentation_context']);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (runId) {
      await redisClient.del(`agent:run:${runId}`);
      await redisClient.del(`agent:run:${runId}:meta`);
    }
    await redisClient.del(`agent:run:key:${workspaceId}:fast:${turnId}`);
    configureAgentRunServices({ agentStreamClient: null });
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  }
});

test('frontend-slides export approval before style gate recovers to style preview selection', {
  skip: process.env.RUN_INTERACTION_E2E !== '1' ? 'set RUN_INTERACTION_E2E=1 with Redis available to run lifecycle flow test' : false,
}, async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  let runId = '';
  const turnId = `interaction-export-approval-before-style-${Date.now()}`;
  const workspaceId = 'workspace-interaction-export-approval-before-style';
  const exportApprovalInterrupt = {
    type: 'interrupt',
    kind: 'approval',
    title: 'Run PPTX Export Script',
    description: 'Export the generated deck to PowerPoint.',
    displayPayload: {
      skill: 'frontend-slides',
      html_path: '/demo-deck.html',
      pptx_path: '/demo-deck.pptx',
    },
    interruptId: 'interrupt-run-pptx-export',
  };

  try {
    configureAgentRunServices({
      telemetryService: null,
      userMemoryService: null,
      skillEvolutionService: null,
      conversationService: null,
      agentStreamClient: {
        runAgentStream: async (_persona, _workspaceId, _prompt, _history, options) => {
          const completedGates = options?.traceContext?.interactionGateState?.completedGateIds || [];
          if (completedGates.includes('presentation_context')) {
            return makeStreamResponse([
              { type: 'policy', skill: 'frontend-slides' },
              exportApprovalInterrupt,
            ]);
          }
          return makeStreamResponse([
            { type: 'policy', skill: 'frontend-slides' },
            presentationContextInterrupt,
          ]);
        },
      },
    });

    const started = await startAgentRun({
      workspaceId,
      persona: 'fast',
      prompt: '/skill frontend-slides create a pitch deck and export pptx',
      history: [{ role: 'user', content: '/skill frontend-slides create a pitch deck and export pptx' }],
      turnId,
      forceReset: true,
    });
    runId = started.runId;

    const presentation = await waitForRunStatus(runId, (status, latest) => (
      status === 'failed' ||
      (status === 'awaiting_approval' && latest?.pendingInterrupt?.displayPayload?.gateId === 'presentation_context')
    ));
    assert.equal(presentation?.status, 'awaiting_approval');
    await resumeAgentRunWithResponse(runId, {
      answersByQuestionId: { purpose: 'Pitch deck' },
    }, {
      previousInterrupt: presentation?.pendingInterrupt,
    });

    const recovered = await waitForRunStatus(runId, (status, latest) => (
      status === 'failed' ||
      (status === 'awaiting_approval' && latest?.pendingInterrupt?.displayPayload?.gateId === 'style_preview_selection')
    ));
    assert.equal(recovered?.status, 'awaiting_approval');
    assert.equal(recovered?.pendingInterrupt?.kind, 'clarification');
    assert.equal(recovered?.pendingInterrupt?.interactionRequest?.presentation, 'style_preview');
    assert.deepEqual(recovered?.interactionGateState?.completedGateIds, ['presentation_context']);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (runId) {
      await redisClient.del(`agent:run:${runId}`);
      await redisClient.del(`agent:run:${runId}:meta`);
    }
    await redisClient.del(`agent:run:key:${workspaceId}:fast:${turnId}`);
    configureAgentRunServices({ agentStreamClient: null });
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  }
});

test('completed non-slide skill with prose-only input request recovers to generic Interaction clarification', {
  skip: process.env.RUN_INTERACTION_E2E !== '1' ? 'set RUN_INTERACTION_E2E=1 with Redis available to run lifecycle flow test' : false,
}, async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  let runId = '';
  const turnId = `generic-interaction-recovery-${Date.now()}`;
  const workspaceId = 'workspace-generic-interaction-recovery';
  try {
    configureAgentRunServices({
      telemetryService: null,
      userMemoryService: null,
      skillEvolutionService: null,
      conversationService: null,
      agentStreamClient: {
        runAgentStream: async () => makeStreamResponse([
          { type: 'policy', skill: 'research' },
          {
            type: 'token',
            content: [
              'I can prepare this research brief in a few formats.',
              'Which format would you prefer?',
              '1. Executive summary',
              '2. Full report',
            ].join('\n'),
          },
          { type: 'done', status: 'completed' },
        ]),
      },
    });

    const started = await startAgentRun({
      workspaceId,
      persona: 'fast',
      prompt: '/skill research write a market brief',
      history: [{ role: 'user', content: '/skill research write a market brief' }],
      turnId,
      forceReset: true,
    });
    runId = started.runId;

    const recovered = await waitForRunStatus(runId, (status, meta) => (
      status === 'failed' ||
      (status === 'awaiting_approval' && meta?.pendingInterrupt?.displayPayload?.skill === 'research')
    ));

    assert.equal(recovered?.status, 'awaiting_approval');
    assert.equal(recovered?.pendingInterrupt?.kind, 'clarification');
    assert.equal(recovered?.pendingInterrupt?.displayPayload?.source, 'implicit_completion_guard');
    assert.equal(recovered?.pendingInterrupt?.displayPayload?.skill, 'research');
    assert.equal(recovered?.pendingInterrupt?.interactionRequest?.presentation, 'questionnaire');
    assert.equal(recovered?.pendingInterrupt?.interactionRequest?.contract, 'helpudoc.interaction');
    assert.equal(recovered?.pendingInterrupt?.interactionRequest?.presentation, 'questionnaire');
    assert.equal(recovered?.pendingInterrupt?.interactionRequest?.skill, 'research');
    assert.equal(recovered?.pendingInterrupt?.interactionRequest?.props?.title, 'Input Needed');
    assert.ok(Array.isArray(recovered?.pendingInterrupt?.interactionRequest?.props?.questions));
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (runId) {
      await redisClient.del(`agent:run:${runId}`);
      await redisClient.del(`agent:run:${runId}:meta`);
    }
    await redisClient.del(`agent:run:key:${workspaceId}:fast:${turnId}`);
    configureAgentRunServices({ agentStreamClient: null });
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  }
});

test('non-slide skill can resume through multiple generic Interaction input gates', {
  skip: process.env.RUN_INTERACTION_E2E !== '1' ? 'set RUN_INTERACTION_E2E=1 with Redis available to run lifecycle flow test' : false,
}, async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  let runId = '';
  let runCallCount = 0;
  const prompts: string[] = [];
  const turnId = `generic-interaction-multigate-${Date.now()}`;
  const workspaceId = 'workspace-generic-interaction-multigate';
  try {
    configureAgentRunServices({
      telemetryService: null,
      userMemoryService: null,
      skillEvolutionService: null,
      conversationService: null,
      agentStreamClient: {
        runAgentStream: async (_persona, _workspaceId, prompt) => {
          runCallCount += 1;
          prompts.push(prompt);
          if (runCallCount === 1) {
            return makeStreamResponse([
              { type: 'policy', skill: 'research' },
              {
                type: 'token',
                content: [
                  'I can prepare this research brief in a few formats.',
                  'Which format would you prefer?',
                  '1. Executive summary',
                  '2. Full report',
                ].join('\n'),
              },
              { type: 'done', status: 'completed' },
            ]);
          }
          if (runCallCount === 2) {
            return makeStreamResponse([
              { type: 'policy', skill: 'research' },
              {
                type: 'token',
                content: [
                  'I will use the executive summary format.',
                  'Which audience should I optimize for?',
                  '1. Leadership team',
                  '2. Technical reviewers',
                ].join('\n'),
              },
              { type: 'done', status: 'completed' },
            ]);
          }
          return makeStreamResponse([
            { type: 'policy', skill: 'research' },
            {
              type: 'token',
              content: 'Completed the executive summary brief for the leadership team.',
            },
            { type: 'done', status: 'completed' },
          ]);
        },
      },
    });

    const started = await startAgentRun({
      workspaceId,
      persona: 'fast',
      prompt: '/skill research write a market brief',
      history: [{ role: 'user', content: '/skill research write a market brief' }],
      turnId,
      forceReset: true,
    });
    runId = started.runId;

    const firstAwaiting = await waitForRunStatus(runId, (status, meta) => (
      status === 'failed' ||
      (status === 'awaiting_approval' && meta?.pendingInterrupt?.displayPayload?.skill === 'research')
    ));

    assert.equal(firstAwaiting?.status, 'awaiting_approval');
    assert.equal(firstAwaiting?.pendingInterrupt?.interactionRequest?.presentation, 'questionnaire');
    assert.equal(firstAwaiting?.pendingInterrupt?.interactionRequest?.presentation, 'questionnaire');
    assert.equal(firstAwaiting?.pendingInterrupt?.displayPayload?.source, 'implicit_completion_guard');
    const firstInterrupt = firstAwaiting?.pendingInterrupt;
    assert.ok(firstInterrupt);

    await resumeAgentRunWithResponse(
      runId,
      { answersByQuestionId: { response: 'Executive summary' } },
      { previousInterrupt: firstInterrupt },
    );

    const secondAwaiting = await waitForRunStatus(runId, (status, meta) => (
      status === 'failed' ||
      (
        status === 'awaiting_approval' &&
        meta?.pendingInterrupt?.displayPayload?.skill === 'research' &&
        meta.pendingInterrupt.description?.includes('audience')
      )
    ));

    assert.equal(secondAwaiting?.status, 'awaiting_approval');
    assert.equal(secondAwaiting?.pendingInterrupt?.interactionRequest?.presentation, 'questionnaire');
    assert.equal(secondAwaiting?.pendingInterrupt?.interactionRequest?.presentation, 'questionnaire');
    assert.match(prompts[1], /Do not ask for this same input again/);
    assert.match(prompts[1], /workflow_action\(action="request_user_interaction"\)/);
    assert.doesNotMatch(prompts[1], /Presentation Context/);
    const secondInterrupt = secondAwaiting?.pendingInterrupt;
    assert.ok(secondInterrupt);

    await resumeAgentRunWithResponse(
      runId,
      { answersByQuestionId: { response: 'Leadership team' } },
      { previousInterrupt: secondInterrupt },
    );

    const completed = await waitForRunStatus(runId, (status) => status === 'completed' || status === 'failed');
    assert.equal(completed?.status, 'completed');
    assert.equal(runCallCount, 3);
    assert.match(prompts[2], /Do not ask for this same input again/);
    assert.doesNotMatch(prompts[2], /Presentation Context/);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (runId) {
      await redisClient.del(`agent:run:${runId}`);
      await redisClient.del(`agent:run:${runId}:meta`);
    }
    await redisClient.del(`agent:run:key:${workspaceId}:fast:${turnId}`);
    configureAgentRunServices({ agentStreamClient: null });
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  }
});
