import { createHash, randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import { redisClient } from '../redisService';
import { RunTelemetryService } from '../runTelemetryService';
import { UserMemoryService } from '../userMemoryService';
import type { SkillEvolutionService } from '../skillEvolutionService';
import type { ConversationService } from '../conversationService';
import type { FileService, WorkspaceArtifactBaseline } from '../fileService';
import {
  runAgentStream,
  resumeAgentStream,
  resumeAgentActionStream,
  resumeAgentResponseStream,
  type AgentDecision,
  type AgentMessageContentBlock,
  type AgentTraceContext,
  type AgentInterruptActionResponse,
  type AgentInterruptResponse,
  type AgentHistoryEntry,
  type AgentKnowledgeRef,
} from '../agentService';
import type {
  ConversationMessageMetadata,
  ToolEvent,
  ToolOutputFile,
  InteractionPresentation,
  InteractionRequest,
  WorkflowActionEvent,
} from '@helpudoc/contracts/types';
import {
  artifactPathMatchesRequirement,
  requiredArtifactsForSkill,
  requiredGateIdsForSkill,
} from './workflowContracts';
import { safeErrorForLog, safeTelemetryForPersistence } from '../../lib/safeError';
import { WorkspaceRunLeaseManager } from './workspaceRunLease';

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

type StartRunParams = {
  workspaceId: string;
  conversationId?: string;
  persona: string;
  prompt: string;
  userId?: string;
  history?: AgentHistoryEntry[];
  forceReset?: boolean;
  turnId?: string;
  authToken?: string;
  messageContent?: AgentMessageContentBlock[];
  internetSearchEnabled?: boolean;
  knowledgeRefs?: AgentKnowledgeRef[];
};

type RunPendingInterrupt = {
  kind?: 'approval' | 'clarification';
  resumeStrategy?: 'fresh_prompt' | 'checkpoint';
  interruptId?: string;
  title?: string;
  description?: string;
  stepIndex?: number;
  stepCount?: number;
  actions?: Array<{
    id: string;
    label: string;
    style?: 'primary' | 'secondary' | 'danger';
    inputMode?: 'none' | 'text';
    placeholder?: string;
    submitLabel?: string;
    confirm?: boolean;
    value?: string;
    payload?: Record<string, unknown>;
  }>;
  actionRequests?: Array<{ name?: string; args?: Record<string, unknown> }>;
  reviewConfigs?: Array<{ action_name?: string; allowed_decisions?: string[] }>;
  responseSpec?: {
    inputMode?: 'none' | 'text' | 'choice' | 'text_or_choice';
    multiple?: boolean;
    submitLabel?: string;
    placeholder?: string;
    allowDismiss?: boolean;
    dismissLabel?: string;
    choices?: Array<{ id?: string; label?: string; description?: string; value?: string }>;
    questions?: Array<{
      id?: string;
      header?: string;
      question?: string;
      options?: Array<{ id?: string; label?: string; description?: string; value?: string }>;
    }>;
  };
  displayPayload?: Record<string, unknown>;
  interactionRequest?: InteractionRequest;
};

type RunMeta = {
  workspaceId: string;
  userId?: string;
  persona: string;
  status: AgentRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  turnId?: string;
  pendingInterrupt?: RunPendingInterrupt;
  interactionGateState?: InteractionGateState;
  interactionResponseInterruptId?: string;
  interactionResponseAcceptedAt?: string;
  interactionResponseConsumedAt?: string;
};

export type InteractionGateState = {
  completedGateIds: string[];
};

type RunContext = {
  params: StartRunParams;
};

type PersistedRunContext = {
  workspaceId: string;
  conversationId?: string;
  persona: string;
  prompt: string;
  userId?: string;
  history?: AgentHistoryEntry[];
  forceReset?: boolean;
  turnId?: string;
  messageContent?: AgentMessageContentBlock[];
  internetSearchEnabled?: boolean;
  knowledgeRefs?: AgentKnowledgeRef[];
};

type ResumePayload =
  | { decisions: AgentDecision[]; interruptId?: string; response?: never }
  | { response: AgentInterruptResponse; interruptId?: string; decisions?: never }
  | { action: AgentInterruptActionResponse; decisions?: never; response?: never };

type PersistedRunMeta = Omit<RunMeta, 'pendingInterrupt' | 'interactionGateState'> & {
  pendingInterrupt?: string;
  interactionGateState?: string;
  runContext?: string;
  interactionResponse?: string;
  interactionResponseHash?: string;
};

const STREAM_TTL_SECONDS = 60 * 60 * 24; // 24h
const DEFAULT_RESUMED_RUN_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const RESUMED_RUN_IDLE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AGENT_RESUME_IDLE_TIMEOUT_MS || '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RESUMED_RUN_IDLE_TIMEOUT_MS;
})();
const DEFAULT_RUNNING_RUN_STALE_TIMEOUT_MS = 15 * 60 * 1000;
const RUNNING_RUN_STALE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AGENT_RUN_STALE_TIMEOUT_MS || '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RUNNING_RUN_STALE_TIMEOUT_MS;
})();
const DEBUG_AGENT_RUN_STREAM =
  process.env.DEBUG_AGENT_RUN_STREAM === '1' || process.env.DEBUG_AGENT_RUN_STREAM === 'true';

const runAbortControllers = new Map<string, AbortController>();
const runContexts = new Map<string, RunContext>();
const workspaceRunLease = new WorkspaceRunLeaseManager(redisClient);
let runTelemetryService: RunTelemetryService | null = null;
let userMemoryService: UserMemoryService | null = null;
let skillEvolutionService: SkillEvolutionService | null = null;
let conversationService: ConversationService | null = null;
let fileService: FileService | null = null;
let agentStreamClient = {
  runAgentStream,
  resumeAgentStream,
  resumeAgentActionStream,
  resumeAgentResponseStream,
};

export function configureAgentRunServices(services: {
  telemetryService?: RunTelemetryService | null;
  userMemoryService?: UserMemoryService | null;
  skillEvolutionService?: SkillEvolutionService | null;
  conversationService?: ConversationService | null;
  fileService?: FileService | null;
  agentStreamClient?: Partial<typeof agentStreamClient> | null;
}) {
  if ('telemetryService' in services) {
    runTelemetryService = services.telemetryService || null;
  }
  if ('userMemoryService' in services) {
    userMemoryService = services.userMemoryService || null;
  }
  if ('skillEvolutionService' in services) {
    skillEvolutionService = services.skillEvolutionService || null;
  }
  if ('conversationService' in services) {
    conversationService = services.conversationService || null;
  }
  if ('fileService' in services) {
    fileService = services.fileService || null;
  }
  if ('agentStreamClient' in services) {
    agentStreamClient = {
      runAgentStream,
      resumeAgentStream,
      resumeAgentActionStream,
      resumeAgentResponseStream,
      ...(services.agentStreamClient || {}),
    };
  }
}

const buildStreamKey = (runId: string) => `agent:run:${runId}`;
const buildMetaKey = (runId: string) => `agent:run:${runId}:meta`;
const buildRunDedupeKey = (
  workspaceId: string,
  persona: string,
  turnId: string,
  userId?: string,
) => `agent:run:key:${workspaceId}:${userId || 'anonymous'}:${persona}:${turnId}`;

const stableNormalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableNormalize);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = stableNormalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
};

export const mergeAssistantTextChunk = (existing: string, incoming: string): string => {
  if (!incoming) {
    return existing;
  }
  if (!existing) {
    return incoming;
  }
  // Some agent stream versions emit deltas and then repeat the complete
  // assistant message during finalization. Treat that exact snapshot as a
  // duplicate and a longer cumulative snapshot as a replacement.
  if (incoming === existing) {
    return existing;
  }
  if (incoming.startsWith(existing)) {
    return incoming;
  }
  return `${existing}${incoming}`;
};

const isLineNumberedToolOutput = (value: string): boolean => (
  value
    .trim()
    .split(/\r?\n/)
    .filter((line) => /^\s*\d+\t/.test(line))
    .length >= 3
);

const buildInterruptId = (payload: Record<string, unknown>): string => {
  const canonical = stableNormalize(
    Object.entries(payload).reduce<Record<string, unknown>>((acc, [key, value]) => {
      if (key !== 'interruptId' && key !== 'id') {
        acc[key] = value;
      }
      return acc;
    }, {}),
  );
  return `interrupt-${createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 20)}`;
};

const getPayloadRecord = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

const normalizeInterruptPayloadRecord = (payload: Record<string, unknown>): Record<string, unknown> => {
  if (payload.type !== 'interrupt') {
    return payload;
  }
  const interruptId =
    typeof payload.interruptId === 'string' && payload.interruptId.trim()
      ? payload.interruptId.trim()
      : buildInterruptId(payload);
  const interactionRequest = getPayloadRecord(payload.interactionRequest);
  const metadata = getPayloadRecord(interactionRequest?.metadata);
  const displayPayload =
    getPayloadRecord(payload.displayPayload) ||
    getPayloadRecord(payload.display_payload) ||
    metadata;
  const synthetic = Boolean(
    displayPayload?.synthetic === true ||
    metadata?.synthetic === true ||
    (displayPayload?.source === 'implicit_input_guard' &&
      displayPayload?.interactionContract === 'helpudoc.interaction') ||
    (metadata?.source === 'implicit_input_guard' &&
      metadata?.interactionContract === 'helpudoc.interaction'),
  );
  const resumeStrategy =
    payload.resumeStrategy === 'fresh_prompt' || payload.resumeStrategy === 'checkpoint'
      ? payload.resumeStrategy
      : synthetic
        ? 'fresh_prompt'
        : undefined;
  const needsDisplayPayloadProjection = !getPayloadRecord(payload.displayPayload) && Boolean(displayPayload);
  const needsResumeStrategyProjection = payload.resumeStrategy !== resumeStrategy && Boolean(resumeStrategy);
  if (
    payload.interruptId === interruptId &&
    !needsDisplayPayloadProjection &&
    !needsResumeStrategyProjection
  ) {
    return payload;
  }
  return {
    ...payload,
    interruptId,
    ...(needsDisplayPayloadProjection ? { displayPayload } : {}),
    ...(resumeStrategy ? { resumeStrategy } : {}),
  };
};

const hasStructuredAnswers = (value: unknown): value is Record<string, string | string[]> =>
  Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length,
  );

const hasClarificationResumeInput = (payload?: AgentInterruptResponse): boolean =>
  Boolean(
    payload?.message?.trim() ||
    payload?.selectedChoiceIds?.length ||
    payload?.selectedValues?.length ||
    hasStructuredAnswers(payload?.answersByQuestionId),
  );

const isSyntheticClarificationInterrupt = (interrupt?: RunPendingInterrupt): boolean => {
  if (interrupt?.kind !== 'clarification') {
    return false;
  }
  if (interrupt.resumeStrategy === 'fresh_prompt') {
    return true;
  }
  const displayPayload = interrupt.displayPayload || {};
  const nativeMetadata = interrupt.interactionRequest?.metadata || {};
  return Boolean(
    displayPayload.synthetic === true ||
    nativeMetadata.synthetic === true ||
    (displayPayload.source === 'implicit_input_guard' && displayPayload.interactionContract === 'helpudoc.interaction') ||
    (nativeMetadata.source === 'implicit_input_guard' && nativeMetadata.interactionContract === 'helpudoc.interaction')
  );
};

const nonEmptyRecordString = (
  record: Record<string, unknown> | undefined,
  keys: string[],
): string => {
  if (!record) return '';
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

const interactionChoiceRecords = (interrupt?: RunPendingInterrupt): Array<Record<string, unknown>> => {
  const props = getPayloadRecord(interrupt?.interactionRequest?.props);
  const sources = [
    props?.choices,
    props?.options,
    interrupt?.responseSpec?.choices,
  ];
  return sources.flatMap((source) => (
    Array.isArray(source)
      ? source.map(getPayloadRecord).filter((item): item is Record<string, unknown> => Boolean(item))
      : []
  ));
};

const interactionPreviewRecords = (interrupt?: RunPendingInterrupt): Array<Record<string, unknown>> => {
  const props = getPayloadRecord(interrupt?.interactionRequest?.props);
  const sources = [props?.previews, props?.options];
  return sources.flatMap((source) => (
    Array.isArray(source)
      ? source.map(getPayloadRecord).filter((item): item is Record<string, unknown> => Boolean(item))
      : []
  ));
};

const resolveSelectedChoiceDescriptions = (
  selectedChoiceIds: string[] | undefined,
  previousInterrupt?: RunPendingInterrupt,
): string[] => {
  if (!selectedChoiceIds?.length) return [];
  const choices = interactionChoiceRecords(previousInterrupt);
  const previews = interactionPreviewRecords(previousInterrupt);
  return selectedChoiceIds.map((rawChoiceId) => {
    const choiceId = String(rawChoiceId || '').trim();
    const matchesId = (record: Record<string, unknown>) => {
      const recordId = nonEmptyRecordString(record, ['id', 'choiceId', 'value']);
      return recordId === choiceId;
    };
    const choice = choices.find(matchesId);
    const preview = previews.find(matchesId);
    const label = nonEmptyRecordString(choice || preview, ['label', 'name', 'title']) || choiceId;
    const previewPath = nonEmptyRecordString(preview || choice, [
      'path',
      'preview_path',
      'previewPath',
      'filePath',
      'file',
    ]);
    const identity = label === choiceId ? choiceId : `${label} (id: ${choiceId})`;
    return previewPath ? `${identity}; preview: ${previewPath}` : identity;
  }).filter(Boolean);
};

const enrichClarificationResponseWithChoiceIdentity = (
  response: AgentInterruptResponse,
  previousInterrupt?: RunPendingInterrupt,
): AgentInterruptResponse => {
  if (response.selectedValues?.length || !response.selectedChoiceIds?.length) {
    return response;
  }
  const selectedValues = resolveSelectedChoiceDescriptions(response.selectedChoiceIds, previousInterrupt);
  return selectedValues.length ? { ...response, selectedValues } : response;
};

export const extractInteractionGateIdFromPendingInterrupt = (
  interrupt?: RunPendingInterrupt,
): string | undefined => {
  if (!interrupt) {
    return undefined;
  }
  const payload = {
    type: 'interrupt',
    kind: interrupt.kind,
    title: interrupt.title,
    description: interrupt.description,
    responseSpec: interrupt.responseSpec,
    displayPayload: interrupt.displayPayload,
    display_payload: interrupt.displayPayload,
    interactionRequest: interrupt.interactionRequest,
  };
  return extractInteractionGateId(payload) || inferFrontendSlidesGateIdFromInteraction(payload);
};

const formatClarificationResponseForPrompt = (
  response: AgentInterruptResponse,
  previousInterrupt?: RunPendingInterrupt,
): string => {
  const lines: string[] = [];
  const questions = Array.isArray(previousInterrupt?.responseSpec?.questions)
    ? previousInterrupt.responseSpec.questions
    : [];
  const questionLabelById = new Map(
    questions
      .map((question) => {
        const id = typeof question.id === 'string' ? question.id : '';
        const label = typeof question.header === 'string' && question.header.trim()
          ? question.header.trim()
          : typeof question.question === 'string'
            ? question.question.trim()
            : id;
        return id ? [id, label] as const : null;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry)),
  );

  if (hasStructuredAnswers(response.answersByQuestionId)) {
    Object.entries(response.answersByQuestionId || {}).forEach(([id, value]) => {
      const answer = Array.isArray(value) ? value.join(', ') : String(value || '').trim();
      if (answer) {
        lines.push(`${questionLabelById.get(id) || id}: ${answer}`);
      }
    });
  }
  if (response.selectedValues?.length) {
    lines.push(`Selected values: ${response.selectedValues.join(', ')}`);
  } else if (response.selectedChoiceIds?.length) {
    const labels = resolveSelectedChoiceDescriptions(response.selectedChoiceIds, previousInterrupt);
    if (labels.length) {
      lines.push(`Selected values: ${labels.join(', ')}`);
    }
  }
  if (response.message?.trim()) {
    lines.push(`Notes: ${response.message.trim()}`);
  }
  return lines.join('\n').trim() || 'Continue.';
};

const ORIGINAL_REQUEST_CONTINUATION_MARKER = 'Original request content, with command routing removed:';

const formatOriginalPromptForContinuation = (prompt: string): string => {
  const raw = String(prompt || '').trim();
  const markerIndex = raw.lastIndexOf(ORIGINAL_REQUEST_CONTINUATION_MARKER);
  const trimmed = markerIndex >= 0
    ? raw.slice(markerIndex + ORIGINAL_REQUEST_CONTINUATION_MARKER.length).trim()
    : raw;
  const withoutSkillRouting = trimmed
    .split('\n')
    .map((line) => line.replace(/^(\s*)\/skill\s+\S+\s*/i, '$1'))
    .join('\n')
    .trim();
  return withoutSkillRouting || trimmed || raw;
};

export const buildSyntheticClarificationFollowupPrompt = (
  originalPrompt: string,
  response: AgentInterruptResponse,
  previousInterrupt?: RunPendingInterrupt,
  completedGateStateOverride?: InteractionGateState,
): string => {
  const skill = typeof previousInterrupt?.displayPayload?.skill === 'string'
    ? previousInterrupt.displayPayload.skill
    : 'current';
  const answers = formatClarificationResponseForPrompt(response, previousInterrupt);
  const originalRequest = formatOriginalPromptForContinuation(originalPrompt);
  const gateId = typeof previousInterrupt?.displayPayload?.gateId === 'string'
    ? previousInterrupt.displayPayload.gateId
    : undefined;
  const completedGateState = completedGateStateOverride || frontendSlidesGateStateThrough(gateId);
  const workflowState = previousInterrupt?.displayPayload?.skill === 'frontend-slides'
    ? buildFrontendSlidesWorkflowState(completedGateState)
    : undefined;
  const frontendSlidesArtifactInstruction = previousInterrupt?.displayPayload?.skill === 'frontend-slides'
    ? requiredArtifactDescriptionForSkill('frontend-slides')
    : '';
  const workflowProtocol = workflowState
    ? [
        'Frontend-slides workflow state:',
        JSON.stringify(workflowState),
        workflowState.nextRequiredGateId
          ? (
              workflowState.nextRequiredGateId === 'outline_confirmation'
                ? 'Next structured workflow actions: first call workflow_action(action="generate_artifact", reason="Draft slide outline for review", artifact_refs_json="[\"slide_outline_v1\"]"), then present the concrete outline and call workflow_action(action="request_user_interaction", gate_id="outline_confirmation", presentation="questionnaire", props_json=..., context_json=...) to pause for review.'
                : `Next structured workflow action: call workflow_action(action="request_user_interaction", gate_id="${workflowState.nextRequiredGateId}", presentation="${EXPECTED_GATES[workflowState.nextRequiredGateId] === 'style_preview' ? 'style_preview' : 'questionnaire'}", props_json=..., context_json=...) and then stop.`
            )
          : `All required Interaction gates are complete. Generate the final required artifact now: ${frontendSlidesArtifactInstruction}. The output must be a slide deck, not a report or summary page. Use write_file so the file appears in the workspace. The next structured workflow action may be workflow_action(action="complete") only after that final artifact is generated.`,
      ].join('\n')
    : '';
  const nextFrontendSlidesGate = workflowState?.nextRequiredGateId;
  const frontendSlidesGate = previousInterrupt?.displayPayload?.skill === 'frontend-slides'
    ? workflowState?.canComplete
      ? 'For frontend-slides: both required decisions are complete and the user has selected a visual style. Continue directly into building the final HTML presentation deck now. Do not ask for deck setup, outline approval, or any earlier frontend-slides gate again.'
      : nextFrontendSlidesGate === 'outline_confirmation'
      ? 'For frontend-slides: the user has completed Presentation Context. Generate the slide outline next, then pause with an outline_confirmation structured Interaction workflow action. Do not ask for Presentation Context again and do not generate style previews yet.'
      : nextFrontendSlidesGate === 'style_path_selection'
      ? 'For frontend-slides: the user has confirmed the outline. Continue to style path selection, then pause with a style_path_selection structured Interaction workflow action. Do not ask for Presentation Context or Outline Confirmation again.'
      : nextFrontendSlidesGate === 'mood_or_preset_selection'
      ? 'For frontend-slides: the user selected the style selection method. Continue to the next style gate. If the user chose generated previews, collect the mood or preset direction next; do not ask for Presentation Context or Outline Confirmation again.'
      : nextFrontendSlidesGate === 'style_preview_selection'
      ? gateId === 'outline_confirmation'
        ? 'For frontend-slides: the user confirmed the outline. Generate 2-3 style previews/templates next, then pause with a style_preview_selection structured Interaction workflow action. Do not ask for Presentation Context or Outline Confirmation again.'
        : gateId === 'mood_or_preset_selection'
          ? 'For frontend-slides: the user selected a legacy mood or preset direction. Generate 2-3 style previews/templates next, then pause with a style_preview_selection structured Interaction workflow action. Do not repeat earlier gates.'
          : 'For frontend-slides: the user selected the deck mode. Infer the remaining context and outline from the request and source material, generate 2-3 style previews/templates, then pause with a style_preview_selection structured Interaction workflow action. Do not ask for purpose, audience, length, assets, or outline approval.'
      : 'For frontend-slides: continue to the next incomplete Interaction gate. Do not ask for already answered frontend-slides gates again.'
    : '';
  const repeatedGateInstruction = previousInterrupt?.displayPayload?.skill === 'frontend-slides'
    ? 'The user has already answered the structured UI gate below. Do not ask for this same deck-mode choice again.'
    : 'The user has already answered the structured UI gate below. Do not ask for this same input again.';
  const nextPhaseInstruction = previousInterrupt?.displayPayload?.skill === 'frontend-slides'
    ? 'Treat these answers as final for the current gate and move to the next required phase of the skill.'
    : [
        'Treat these answers as final for the current gate and continue the skill from the point where it paused.',
        'If another human decision or clarification is required before completion, call workflow_action(action="request_user_interaction") or another structured Interaction interrupt and then stop; otherwise complete the requested work.',
      ].join(' ');
  const skillDirective = previousInterrupt?.displayPayload?.skill === 'frontend-slides'
    ? '/skill frontend-slides'
    : '';
  if (previousInterrupt?.displayPayload?.skill === 'frontend-slides' && workflowState?.canComplete) {
    return [
      skillDirective,
      '[Frontend-slides final generation phase]',
      'Both required decisions are complete: deck mode and visual style.',
      'Do not call workflow_action(action="request_user_interaction"), request_clarification, request_interaction, or request_human_action for any frontend-slides gate.',
      `Generate the final required artifact now: ${frontendSlidesArtifactInstruction}. The output must be a slide deck, not a report or summary page. Use write_file so the file appears in the workspace.`,
      'Only after the deck file exists may you call workflow_action(action="complete") or finish the run.',
      answers,
      '',
      ORIGINAL_REQUEST_CONTINUATION_MARKER,
      originalRequest,
    ].filter((line) => line !== '').join('\n');
  }
  return [
    skillDirective,
    `[Clarification response — continue the '${skill}' skill from where you left off; do not restart from the beginning.]`,
    repeatedGateInstruction,
    nextPhaseInstruction,
    frontendSlidesGate,
    workflowProtocol,
    answers,
    '',
    ORIGINAL_REQUEST_CONTINUATION_MARKER,
    originalRequest,
  ].filter((line) => line !== '').join('\n');
};

export const buildSyntheticResumeParams = (
  baseParams: StartRunParams,
  response: AgentInterruptResponse,
  previousInterrupt: RunPendingInterrupt | undefined,
  nextGateState: InteractionGateState,
): StartRunParams => ({
  ...baseParams,
  prompt: buildSyntheticClarificationFollowupPrompt(
    baseParams.prompt,
    response,
    previousInterrupt,
    nextGateState,
  ),
  // Synthetic gates do not have LangGraph checkpoints. The continuation
  // prompt must be the sole conversational input for the fresh stream.
  history: undefined,
  messageContent: undefined,
  forceReset: true,
});

const clarificationSignature = (value: Record<string, unknown> | RunPendingInterrupt | undefined): string => {
  if (!value) {
    return '';
  }
  const source = value as Record<string, unknown>;
  return JSON.stringify(
    stableNormalize({
      kind: source.kind,
      title: source.title,
      description: source.description,
      responseSpec: source.responseSpec,
      displayPayload: source.displayPayload,
      actions: source.actions,
      actionRequests: source.actionRequests,
      reviewConfigs: source.reviewConfigs,
    }),
  );
};

const isRepeatedClarificationInterrupt = (
  payload: Record<string, unknown>,
  previousInterrupt?: RunPendingInterrupt,
  resumePayload?: ResumePayload,
): boolean => {
  if (!('response' in (resumePayload || {})) || !hasClarificationResumeInput(resumePayload?.response)) {
    return false;
  }
  if (previousInterrupt?.kind !== 'clarification' || payload.kind !== 'clarification') {
    return false;
  }
  const normalized = normalizeInterruptPayloadRecord(payload);
  if (previousInterrupt.interruptId && normalized.interruptId === previousInterrupt.interruptId) {
    return true;
  }
  return clarificationSignature(normalized) === clarificationSignature(previousInterrupt);
};

export const isRealRunProgressEvent = (parsed: Record<string, unknown> | null): boolean => {
  const type = typeof parsed?.type === 'string' ? parsed.type : '';
  return Boolean(type && type !== 'keepalive' && type !== 'policy' && type !== 'langfuse');
};

export const shouldFailResumedRunForIdle = (input: {
  resumePayload?: ResumePayload;
  sawInterruptPayload?: Record<string, unknown> | null;
  activeToolCalls: number;
  lastRealActivityAt: number;
  now: number;
  timeoutMs?: number;
}): boolean => {
  if (!input.resumePayload || input.sawInterruptPayload || input.activeToolCalls > 0) {
    return false;
  }
  const timeoutMs = input.timeoutMs ?? RESUMED_RUN_IDLE_TIMEOUT_MS;
  return timeoutMs > 0 && input.now - input.lastRealActivityAt >= timeoutMs;
};

export const resolveStreamCloseDisposition = (input: {
  sawInterruptPayload?: Record<string, unknown> | null;
  loopErrorMessage?: string;
  stallErrorMessage?: string;
  streamErrorMessage?: string;
  aborted?: boolean;
  contractErrorMessage?: string;
}): { status: AgentRunStatus; error?: string; preserveInterrupt: boolean } => {
  if (input.sawInterruptPayload) {
    return { status: 'awaiting_approval', preserveInterrupt: true };
  }
  if (input.loopErrorMessage) {
    return { status: 'failed', error: input.loopErrorMessage, preserveInterrupt: false };
  }
  if (input.stallErrorMessage) {
    return { status: 'failed', error: input.stallErrorMessage, preserveInterrupt: false };
  }
  // An upstream error reported by the agent process is the real cause. It must
  // win over the transport-level abort that usually follows it, otherwise run
  // history records 'aborted' instead of the original failure.
  if (input.streamErrorMessage) {
    return { status: 'failed', error: input.streamErrorMessage, preserveInterrupt: false };
  }
  if (input.aborted) {
    return { status: 'cancelled', preserveInterrupt: false };
  }
  if (input.contractErrorMessage) {
    return { status: 'failed', error: input.contractErrorMessage, preserveInterrupt: false };
  }
  return { status: 'completed', preserveInterrupt: false };
};

const persistMeta = async (runId: string, meta: Partial<PersistedRunMeta>) => {
  const metaKey = buildMetaKey(runId);
  const stringified: Record<string, string> = {};
  Object.entries(meta).forEach(([key, value]) => {
    if (value !== undefined) {
      stringified[key] = String(value);
    }
  });
  if (Object.keys(stringified).length) {
    await redisClient.hSet(metaKey, stringified);
    await redisClient.expire(metaKey, STREAM_TTL_SECONDS);
  }
};

const appendStreamEvent = async (runId: string, line: string) => {
  if (!line.trim()) return undefined;
  const streamKey = buildStreamKey(runId);
  try {
    const entryId = await redisClient.xAdd(streamKey, '*', { data: line });
    await redisClient.expire(streamKey, STREAM_TTL_SECONDS);
    if (DEBUG_AGENT_RUN_STREAM) {
      console.info('[agent-run-stream] appended', {
        runId,
        streamKey,
        entryId,
        bytes: line.length,
        sample: line.slice(0, 160),
      });
    }
    return entryId;
  } catch (error) {
    console.error('[agent-run-stream] failed to append', {
      runId,
      streamKey,
      error: safeErrorForLog(error),
    });
    throw error;
  }
};

type ConversationRunPolicy = NonNullable<ConversationMessageMetadata['runPolicy']>;

type RunProgressEvent = {
  phase: string;
  label: string;
  detail?: string;
  status?: 'pending' | 'running' | 'completed' | 'error';
  stepIndex?: number;
  stepCount?: number;
  toolName?: string;
  artifactPath?: string;
  timestamp?: string;
};

type ConversationRunSnapshot = {
  assistantText?: string;
  thinkingText?: string;
  toolEvents?: ToolEvent[];
  runPolicy?: ConversationRunPolicy;
  pendingInterrupt?: RunPendingInterrupt;
  error?: string;
  implicitInput?: { awaiting: boolean; prompt?: string };
  progressEvents?: RunProgressEvent[];
  workflowActions?: WorkflowActionEvent[];
};

const FRONTEND_SLIDES_DISCOVERY_QUESTIONS = [
  {
    id: 'density',
    header: 'Deck mode',
    question: 'Will this deck be presented live or read on its own?',
    options: [
      { id: 'density-low', label: 'Speaker-led', description: 'Big ideas, fewer words, and more visual breathing room.', value: 'Low density / speaker-led' },
      { id: 'density-high', label: 'Reading-first', description: 'More self-contained detail for async reading.', value: 'High density / reading-first' },
    ],
  },
];

const FRONTEND_SLIDES_OUTLINE_QUESTIONS = [
  {
    id: 'outline',
    header: 'Outline',
    question: 'Does this slide outline and image selection look right?',
    options: [
      {
        id: 'confirm',
        label: 'Looks good, proceed',
        value: 'Looks good, proceed',
        description: 'Move on to style selection.',
      },
      {
        id: 'adjust-images',
        label: 'Adjust images',
        value: 'Adjust images',
        description: 'Change which images go where.',
      },
      {
        id: 'adjust-outline',
        label: 'Adjust outline',
        value: 'Adjust outline',
        description: 'Change the slide structure.',
      },
    ],
  },
];

const FRONTEND_SLIDES_STYLE_PATH_QUESTIONS = [
  {
    id: 'style_path',
    header: 'Style Selection Method',
    question: 'How would you like to choose your presentation style?',
    options: [
      {
        id: 'guided',
        label: 'Show me options',
        value: 'Show me options',
        description: 'Generate 3 previews based on my needs.',
      },
      {
        id: 'direct',
        label: 'I know what I want',
        value: 'I know what I want',
        description: 'Pick from the preset list directly.',
      },
    ],
  },
];

const FRONTEND_SLIDES_MOOD_QUESTIONS = [
  {
    id: 'mood',
    header: 'Vibe',
    question: 'What feeling should the audience have when viewing your slides?',
    options: [
      { id: 'impressed', label: 'Impressed/Confident', value: 'Impressed/Confident' },
      { id: 'excited', label: 'Excited/Energized', value: 'Excited/Energized' },
      { id: 'calm', label: 'Calm/Focused', value: 'Calm/Focused' },
      { id: 'inspired', label: 'Inspired/Moved', value: 'Inspired/Moved' },
    ],
  },
];

const getFrontendSlidesClarificationQuestions = (
  gateId: FrontendSlidesGateId,
): Array<Record<string, unknown>> | undefined => {
  if (gateId === 'presentation_context') {
    return FRONTEND_SLIDES_DISCOVERY_QUESTIONS;
  }
  if (gateId === 'outline_confirmation') {
    return FRONTEND_SLIDES_OUTLINE_QUESTIONS;
  }
  if (gateId === 'style_path_selection') {
    return FRONTEND_SLIDES_STYLE_PATH_QUESTIONS;
  }
  if (gateId === 'mood_or_preset_selection') {
    return FRONTEND_SLIDES_MOOD_QUESTIONS;
  }
  return undefined;
};

const DEFAULT_FRONTEND_SLIDES_STYLE_CHOICES = [
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
  {
    id: 'mix-elements',
    label: 'Mix elements',
    value: 'Mix elements',
    description: 'Combine aspects from the generated previews.',
  },
];

export const isFrontendSlidesSkill = (skillId: string | null | undefined): boolean => {
  const normalized = String(skillId || '').trim().toLowerCase();
  return normalized === 'frontend-slides' || normalized.endsWith('/frontend-slides');
};

const FRONTEND_SLIDES_KNOWN_GATES = [
  'presentation_context',
  'outline_confirmation',
  'style_path_selection',
  'mood_or_preset_selection',
  'style_preview_selection',
] as const;

const FRONTEND_SLIDES_FALLBACK_REQUIRED_GATES = [
  'presentation_context',
  'style_preview_selection',
] as const;

type FrontendSlidesGateId = typeof FRONTEND_SLIDES_KNOWN_GATES[number];

const EXPECTED_GATES: Record<FrontendSlidesGateId, InteractionPresentation> = {
  presentation_context: 'questionnaire',
  outline_confirmation: 'questionnaire',
  style_path_selection: 'questionnaire',
  mood_or_preset_selection: 'questionnaire',
  style_preview_selection: 'style_preview',
};

const isFrontendSlidesGateId = (value: unknown): value is FrontendSlidesGateId => (
  typeof value === 'string' && FRONTEND_SLIDES_KNOWN_GATES.includes(value as FrontendSlidesGateId)
);

const getFrontendSlidesRequiredGates = (): FrontendSlidesGateId[] => {
  const declared = requiredGateIdsForSkill('frontend-slides').filter(isFrontendSlidesGateId);
  return declared.length > 0 ? declared : [...FRONTEND_SLIDES_FALLBACK_REQUIRED_GATES];
};

const getRecord = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

const extractDisplayPayload = (payload: Record<string, unknown>): Record<string, unknown> | undefined => {
  const interactionRequest = getRecord(payload.interactionRequest);
  return (
    getRecord(payload.displayPayload) ||
    getRecord(payload.display_payload) ||
    getRecord(interactionRequest?.metadata)
  );
};

const extractInteractionGateId = (payload: Record<string, unknown>): string | undefined => {
  const displayPayload = extractDisplayPayload(payload);
  const nestedPayload = getRecord(displayPayload?.displayPayload) || getRecord(displayPayload?.display_payload);
  const interactionRequest = getRecord(payload.interactionRequest);
  const rawGateId = interactionRequest?.gateId || displayPayload?.gateId || nestedPayload?.gateId;
  return typeof rawGateId === 'string' && rawGateId.trim() ? rawGateId.trim() : undefined;
};

const MISSING_OUTLINE_DIAGNOSTIC = 'the slide outline was not included in the agent response';

const hasOutlineReviewValue = (value: unknown): boolean => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return Boolean(trimmed && !trimmed.toLowerCase().includes(MISSING_OUTLINE_DIAGNOSTIC));
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return false;
};

const hasFrontendSlidesOutlineReviewMaterial = (
  ...records: Array<Record<string, unknown> | undefined>
): boolean => {
  const outlineKeys = [
    'outlineMarkdown',
    'slideOutline',
    'outline',
    'markdown',
    'slides',
    'outlineItems',
    'items',
    'sections',
  ];
  return records.some((record) => (
    Boolean(record && outlineKeys.some((key) => hasOutlineReviewValue(record[key])))
  ));
};

const normalizeInteractionPresentationName = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const collectFrontendSlidesGateInferenceText = (payload: Record<string, unknown>): string => {
  const fragments: string[] = [];
  const pushValue = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      fragments.push(value.trim());
    }
  };
  const pushQuestions = (value: unknown) => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const question of value) {
      const record = getRecord(question);
      pushValue(record?.id);
      pushValue(record?.header);
      pushValue(record?.question);
      pushValue(record?.label);
    }
  };
  const interactionRequest = getRecord(payload.interactionRequest);
  const interactionProps = getRecord(interactionRequest?.props);
  const responseSpec = getRecord(payload.responseSpec);

  pushValue(payload.title);
  pushValue(payload.description);
  pushValue(interactionRequest?.presentation);
  pushValue(interactionProps?.title);
  pushValue(interactionProps?.description);
  pushQuestions(interactionProps?.questions);
  pushQuestions(responseSpec?.questions);

  return fragments.join('\n').toLowerCase();
};

export const inferFrontendSlidesGateIdFromInteraction = (
  payload: Record<string, unknown>,
): FrontendSlidesGateId | undefined => {
  if (payload.type !== 'interrupt' || payload.kind !== 'clarification' || extractInteractionGateId(payload)) {
    return undefined;
  }
  const interactionRequest = getRecord(payload.interactionRequest);
  const presentation = normalizeInteractionPresentationName(interactionRequest?.presentation);
  const isClarificationInteraction = ['questionnaire', 'style_preview']
    .includes(presentation);
  if (!isClarificationInteraction) {
    return undefined;
  }
  if (presentation === 'style_preview') {
    return 'style_preview_selection';
  }

  const text = collectFrontendSlidesGateInferenceText(payload);
  if (/\boutline[_\s-]*(?:approval|confirmation)\b/.test(text) || /\bconfirm\b.{0,80}\boutline\b/.test(text)) {
    return 'outline_confirmation';
  }
  if (/\bstyle[_\s-]*path\b/.test(text) || /\bstyle selection method\b/.test(text) || /\bchoose style selection\b/.test(text)) {
    return 'style_path_selection';
  }
  if (/\b(?:vibe|mood|preset)\b/.test(text) || /\bvisual direction\b/.test(text)) {
    return 'mood_or_preset_selection';
  }
  if (/\bpresentation context\b/.test(text) || /\bpresentation\b.{0,80}\brequirements\b/.test(text)) {
    return 'presentation_context';
  }
  return undefined;
};

export const withFrontendSlidesGateMetadata = (
  payload: Record<string, unknown>,
  gateId: FrontendSlidesGateId,
  options?: { stylePreviewPaths?: Record<string, string> },
): Record<string, unknown> => {
  const normalized = normalizeInterruptPayloadRecord(payload);
  const existingDisplayPayload = extractDisplayPayload(normalized);
  const displayPayload = {
    ...existingDisplayPayload,
    skill: 'frontend-slides',
    gateId,
    interactionContract: 'helpudoc.interaction',
    expectedPresentation: EXPECTED_GATES[gateId],
    source:
      typeof existingDisplayPayload?.source === 'string' && existingDisplayPayload.source.trim()
        ? existingDisplayPayload.source.trim()
        : 'frontend_slides_gate_inference',
  };
  const interactionRequest = getRecord(normalized.interactionRequest);
  const presentation = normalizeInteractionPresentationName(interactionRequest?.presentation);
  const defaultQuestions = presentation === 'questionnaire'
    ? getFrontendSlidesClarificationQuestions(gateId)
    : undefined;
  const defaultStyleChoices = gateId === 'style_preview_selection'
    ? DEFAULT_FRONTEND_SLIDES_STYLE_CHOICES.slice(0, 3)
    : undefined;
  const defaultStylePreviews = defaultStyleChoices?.map((choice) => {
    const generatedPath = options?.stylePreviewPaths?.[choice.id];
    return {
      id: choice.id,
      label: choice.label,
      description: choice.description,
      ...(generatedPath
        ? { path: generatedPath }
        : { html: buildFallbackStylePreviewHtml(choice) }),
    };
  });
  const buildStylePreviewsForChoices = (choices: unknown): Array<Record<string, unknown>> | undefined => {
    if (!Array.isArray(choices) || choices.length === 0) {
      return defaultStylePreviews;
    }
    const previews = choices
      .map((choice, index) => {
        const record = getRecord(choice);
        if (!record) {
          return null;
        }
        const id = typeof record.id === 'string' && record.id.trim()
          ? record.id.trim()
          : typeof record.choiceId === 'string' && record.choiceId.trim()
            ? record.choiceId.trim()
            : `style-${String.fromCharCode(97 + index)}`;
        const label = typeof record.label === 'string' && record.label.trim()
          ? record.label.trim()
          : typeof record.name === 'string' && record.name.trim()
            ? record.name.trim()
            : typeof record.title === 'string' && record.title.trim()
              ? record.title.trim()
              : `Style ${String.fromCharCode(65 + index)}`;
        const description = typeof record.description === 'string' && record.description.trim()
          ? record.description.trim()
          : typeof record.summary === 'string' && record.summary.trim()
            ? record.summary.trim()
            : undefined;
        const sourcePath = nonEmptyRecordString(record, [
          'path',
          'preview_path',
          'previewPath',
          'filePath',
          'file',
        ]) || options?.stylePreviewPaths?.[id];
        const existingHtml = nonEmptyRecordString(record, ['html', 'srcDoc', 'srcdoc', 'content']);
        return {
          id,
          label,
          ...(description ? { description } : {}),
          ...(sourcePath ? { path: sourcePath } : {}),
          ...(existingHtml
            ? { html: existingHtml }
            : sourcePath
              ? {}
              : { html: buildFallbackStylePreviewHtml({ id, label, description }) }),
        };
      })
      .filter((preview): preview is NonNullable<typeof preview> => preview !== null);
    return previews.length > 0 ? previews : defaultStylePreviews;
  };
  const enrichStylePreviews = (previews: unknown): Array<Record<string, unknown>> | undefined => {
    if (!Array.isArray(previews) || previews.length === 0) {
      return undefined;
    }
    const enriched = previews
      .map((preview, index) => {
        const record = getRecord(preview);
        if (!record) {
          return null;
        }
        const id = typeof record.id === 'string' && record.id.trim()
          ? record.id.trim()
          : typeof record.choiceId === 'string' && record.choiceId.trim()
            ? record.choiceId.trim()
            : `style-${String.fromCharCode(97 + index)}`;
        const label = typeof record.label === 'string' && record.label.trim()
          ? record.label.trim()
          : typeof record.name === 'string' && record.name.trim()
            ? record.name.trim()
            : typeof record.title === 'string' && record.title.trim()
              ? record.title.trim()
              : `Style ${String.fromCharCode(65 + index)}`;
        const description = typeof record.description === 'string' && record.description.trim()
          ? record.description.trim()
          : typeof record.summary === 'string' && record.summary.trim()
            ? record.summary.trim()
            : undefined;
        const existingHtml =
          typeof record.html === 'string' && record.html.trim()
            ? record.html
            : typeof record.srcDoc === 'string' && record.srcDoc.trim()
              ? record.srcDoc
              : typeof record.srcdoc === 'string' && record.srcdoc.trim()
                ? record.srcdoc
                : typeof record.content === 'string' && record.content.trim()
                  ? record.content
                  : undefined;
        const sourcePath = nonEmptyRecordString(record, [
          'path',
          'preview_path',
          'previewPath',
          'filePath',
          'file',
        ]) || options?.stylePreviewPaths?.[id];
        return {
          ...record,
          id,
          label,
          ...(description ? { description } : {}),
          ...(sourcePath ? { path: sourcePath } : {}),
          ...(existingHtml
            ? { html: existingHtml }
            : sourcePath
              ? { html: undefined }
              : { html: buildFallbackStylePreviewHtml({ id, label, description }) }),
        };
      })
      .filter((preview): preview is NonNullable<typeof preview> => preview !== null);
    return enriched.length > 0 ? enriched : undefined;
  };
  const withQuestionDefaults = (props: unknown): Record<string, unknown> | undefined => {
    const record = getRecord(props);
    if (!record) {
      return defaultQuestions ? { questions: defaultQuestions } : undefined;
    }
    if (!defaultQuestions || (Array.isArray(record.questions) && record.questions.length > 0)) {
      return record;
    }
    return { ...record, questions: defaultQuestions };
  };
  const withGateDefaults = (props: unknown): Record<string, unknown> | undefined => {
    const questionDefaults = withQuestionDefaults(props);
    const record = questionDefaults || getRecord(props);
    if (!record) {
      return defaultStyleChoices?.length
        ? { choices: defaultStyleChoices, previews: defaultStylePreviews, fallback: true }
        : undefined;
    }
    if (!defaultStyleChoices?.length) {
      return record;
    }
    const hasChoices = Array.isArray(record.choices) && record.choices.length > 0;
    const hasPreviews = Array.isArray(record.previews) && record.previews.length > 0;
    const hasOptions = Array.isArray(record.options) && record.options.length > 0;
    if (hasOptions && !hasChoices && !hasPreviews) {
      const choices = (record.options as unknown[])
        .map((option, index) => {
          const optionRecord = getRecord(option);
          if (!optionRecord) return null;
          const id = nonEmptyRecordString(optionRecord, ['id', 'choiceId', 'value'])
            || `style-${String.fromCharCode(97 + index)}`;
          const label = nonEmptyRecordString(optionRecord, ['label', 'name', 'title'])
            || `Style ${String.fromCharCode(65 + index)}`;
          const description = nonEmptyRecordString(optionRecord, ['description', 'summary']);
          const value = nonEmptyRecordString(optionRecord, ['value']) || id;
          return { id, label, value, ...(description ? { description } : {}) };
        })
        .filter((choice): choice is NonNullable<typeof choice> => choice !== null);
      const previews = enrichStylePreviews(record.options);
      return {
        ...record,
        choices,
        ...(previews?.length ? { previews } : {}),
        fallback: false,
      };
    }
    if (hasChoices && !hasPreviews) {
      return {
        ...record,
        previews: buildStylePreviewsForChoices(record.choices),
        fallback: record.fallback ?? true,
      };
    }
    if (hasPreviews) {
      return {
        ...record,
        previews: enrichStylePreviews(record.previews),
      };
    }
    if (hasChoices || hasPreviews) {
      return record;
    }
    return {
      ...record,
      choices: defaultStyleChoices,
      previews: defaultStylePreviews,
      fallback: true,
      description: typeof record.description === 'string' && record.description.trim()
        ? record.description
        : 'No generated style previews were provided, so choose from fallback executive styles to continue.',
    };
  };
  const interactionProps = withGateDefaults(interactionRequest?.props);
  const responseSpec = getRecord(normalized.responseSpec);
  const responseSpecWithQuestions =
    defaultQuestions && (!Array.isArray(responseSpec?.questions) || responseSpec.questions.length === 0)
      ? { ...responseSpec, questions: defaultQuestions }
      : responseSpec;
  return {
    ...normalized,
    displayPayload,
    ...(responseSpecWithQuestions ? { responseSpec: responseSpecWithQuestions } : {}),
    ...(interactionRequest
      ? {
          interactionRequest: {
            ...interactionRequest,
            ...(interactionProps ? { props: interactionProps } : {}),
            gateId,
            skill: 'frontend-slides',
            required: interactionRequest.required ?? true,
            metadata: {
              ...getRecord(interactionRequest.metadata),
              ...displayPayload,
            },
          },
        }
      : {}),
  };
};

const isInteractionGatePayload = (payload: Record<string, unknown>): boolean => {
  const displayPayload = extractDisplayPayload(payload);
  const nestedPayload = getRecord(displayPayload?.displayPayload) || getRecord(displayPayload?.display_payload);
  const interactionRequest = getRecord(payload.interactionRequest);
  return Boolean(
    extractInteractionGateId(payload) ||
    interactionRequest?.contract === 'helpudoc.interaction' ||
    displayPayload?.interactionContract === 'helpudoc.interaction' ||
    nestedPayload?.interactionContract === 'helpudoc.interaction'
  );
};

const parseInteractionGateState = (raw: unknown): InteractionGateState => {
  const parsed = typeof raw === 'string'
    ? (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return undefined;
        }
      })()
    : raw;
  const record = getRecord(parsed);
  const completedGateIds = Array.isArray(record?.completedGateIds)
    ? record.completedGateIds.filter(isFrontendSlidesGateId)
    : [];
  return { completedGateIds: Array.from(new Set(completedGateIds)) };
};

const completeInteractionGate = (state: InteractionGateState, gateId: string | undefined): InteractionGateState => {
  if (!isFrontendSlidesGateId(gateId)) {
    return state;
  }
  return {
    completedGateIds: Array.from(new Set([...state.completedGateIds, gateId])),
  };
};

export const isCompletedFrontendSlidesGateInterrupt = (
  payload: Record<string, unknown>,
  state: InteractionGateState,
): boolean => {
  const completedGateId = extractInteractionGateId(payload) || inferFrontendSlidesGateIdFromInteraction(payload);
  return Boolean(
    payload?.type === 'interrupt' &&
    isFrontendSlidesGateId(completedGateId) &&
    state.completedGateIds.includes(completedGateId),
  );
};

const frontendSlidesGateStateThrough = (gateId: string | undefined): InteractionGateState => {
  if (!isFrontendSlidesGateId(gateId)) {
    return { completedGateIds: [] };
  }
  const requiredGates = getFrontendSlidesRequiredGates();
  const gateIndex = requiredGates.indexOf(gateId);
  if (gateIndex < 0) {
    return { completedGateIds: [gateId] };
  }
  return {
    completedGateIds: requiredGates.slice(0, gateIndex + 1),
  };
};

const nextMissingFrontendSlidesGate = (state: InteractionGateState): FrontendSlidesGateId | undefined => (
  getFrontendSlidesRequiredGates().find((gateId) => !state.completedGateIds.includes(gateId))
);

const hasCompletedAllFrontendSlidesGates = (state: InteractionGateState): boolean => (
  !nextMissingFrontendSlidesGate(state)
);

const FRONTEND_SLIDES_WORKFLOW_ACTION_BY_GATE: Record<FrontendSlidesGateId, WorkflowActionEvent['action']> = {
  presentation_context: 'request_user_interaction',
  outline_confirmation: 'request_user_interaction',
  style_path_selection: 'request_user_interaction',
  mood_or_preset_selection: 'request_user_interaction',
  style_preview_selection: 'request_user_interaction',
};

const FRONTEND_SLIDES_GATE_PHASE: Record<FrontendSlidesGateId, string> = {
  presentation_context: 'choose_deck_mode',
  outline_confirmation: 'review_outline',
  style_path_selection: 'choose_style_path',
  mood_or_preset_selection: 'collect_style_direction',
  style_preview_selection: 'review_style_previews',
};

export type FrontendSlidesWorkflowState = {
  workflowType: 'presentation_generation';
  completedGateIds: FrontendSlidesGateId[];
  requiredGateIds: FrontendSlidesGateId[];
  nextRequiredGateId?: FrontendSlidesGateId;
  nextRequiredAction?: WorkflowActionEvent['action'];
  currentPhase: string;
  canComplete: boolean;
};

export const buildFrontendSlidesWorkflowState = (state: InteractionGateState): FrontendSlidesWorkflowState => {
  const completedGateIds = Array.from(new Set(state.completedGateIds.filter(isFrontendSlidesGateId)));
  const requiredGateIds = getFrontendSlidesRequiredGates();
  const nextRequiredGateId = requiredGateIds.find((gateId) => !completedGateIds.includes(gateId));
  return {
    workflowType: 'presentation_generation',
    completedGateIds,
    requiredGateIds,
    nextRequiredGateId,
    nextRequiredAction: nextRequiredGateId ? FRONTEND_SLIDES_WORKFLOW_ACTION_BY_GATE[nextRequiredGateId] : undefined,
    currentPhase: nextRequiredGateId ? FRONTEND_SLIDES_GATE_PHASE[nextRequiredGateId] : 'generate_deck',
    canComplete: !nextRequiredGateId,
  };
};

const buildFrontendSlidesDisplayPayload = (
  gateId: FrontendSlidesGateId,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  skill: 'frontend-slides',
  gateId,
  interactionContract: 'helpudoc.interaction',
  expectedPresentation: EXPECTED_GATES[gateId],
  source: 'implicit_completion_guard',
  synthetic: true,
  ...extra,
});

const buildNativeInteractionRequest = (input: {
  interruptId: string;
  presentation: InteractionPresentation;
  props: Record<string, unknown>;
  gateId?: string | null;
  skill?: string | null;
  required?: boolean;
  endpoint?: 'respond' | 'decision' | 'act';
  actionId?: string;
  metadata?: Record<string, unknown>;
}): InteractionRequest => ({
  contract: 'helpudoc.interaction',
  version: '1',
  interactionId: input.gateId ? `interaction-${input.gateId}` : input.interruptId,
  presentation: input.presentation,
  props: input.props,
  gateId: input.gateId || undefined,
  skill: input.skill || undefined,
  required: input.required ?? true,
  resumeAction: {
    endpoint: input.endpoint || 'respond',
    actionId: input.actionId || 'submit',
  },
  metadata: input.metadata || {},
});

const cleanOutlineSourceLine = (line: string): string => (
  line
    .replace(/^\s*\d+\s*(?:\t| {2,})/, '')
    .replace(/\s+/g, ' ')
    .trim()
);

const uniqueNonEmpty = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const cleaned = cleanOutlineSourceLine(value);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(cleaned);
  });
  return result;
};

const stripMarkdownExtension = (name: string): string => (
  name.replace(/\.(?:md|markdown|txt|pdf|docx?|pptx?|html?)$/i, '').trim()
);

const titleCaseFromSlug = (value: string): string => {
  const cleaned = stripMarkdownExtension(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned
    ? cleaned.replace(/\b[a-z]/g, (match) => match.toUpperCase())
    : 'Presentation';
};

const isLikelyFrontendSlidesOutlineMarkdown = (text: string): boolean => {
  const lowered = text.toLowerCase();
  const listItemCount = (text.match(/^\s*(?:[-*]\s+|\d+[.)]\s+)/gm) || []).length;
  return Boolean(
    /\b(?:slide|deck|presentation)\s+outline\b/i.test(text) ||
    /\bproposed\s+(?:slide\s+)?outline\b/i.test(text) ||
    (/\b(?:slide|deck|presentation)\b/.test(lowered) && listItemCount >= 2) ||
    listItemCount >= 4,
  );
};

const buildFrontendSlidesOutlinePreviewMarkdown = (assistantText?: string): string => {
  const text = String(assistantText || '').trim();
  if (!text || !isLikelyFrontendSlidesOutlineMarkdown(text)) {
    return '';
  }
  const maxLength = 6000;
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}\n\n...` : text;
};

const collectFrontendSlidesSourceText = (input: {
  params?: StartRunParams;
  toolEvents?: ToolEvent[];
}): string => {
  const fragments: string[] = [];
  for (const event of input.toolEvents || []) {
    if (
      event.name === 'read_file' &&
      event.status === 'completed' &&
      typeof event.summary === 'string' &&
      event.summary.trim() &&
      !event.summary.trim().startsWith('Error:')
    ) {
      fragments.push(
        event.summary
          .split(/\r?\n/)
          .map(cleanOutlineSourceLine)
          .filter(Boolean)
          .join('\n'),
      );
    }
  }

  if (typeof input.params?.prompt === 'string' && input.params.prompt.trim()) {
    fragments.push(formatOriginalPromptForContinuation(input.params.prompt));
  }

  return fragments.join('\n\n').trim();
};

const extractFrontendSlidesSourceTitle = (sourceText: string, params?: StartRunParams): string => {
  const heading = sourceText.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  if (heading) {
    return cleanOutlineSourceLine(heading);
  }
  const taggedFile = params?.prompt?.match(/@([^\s]+)/)?.[1];
  if (taggedFile) {
    return titleCaseFromSlug(taggedFile);
  }
  return 'Presentation';
};

const extractFrontendSlidesTopics = (sourceText: string, title: string): string[] => {
  const headings = Array.from(sourceText.matchAll(/^\s*#{2,4}\s+(.+)$/gm))
    .map((match) => match[1] || '');
  const listItems = Array.from(sourceText.matchAll(/^\s*(?:[-*]\s+|\d+[.)]\s+)(.+)$/gm))
    .map((match) => match[1] || '');
  return uniqueNonEmpty([...headings, ...listItems])
    .filter((topic) => topic.toLowerCase() !== title.toLowerCase())
    .slice(0, 8);
};

const buildFrontendSlidesFallbackOutlineMarkdown = (input: {
  params?: StartRunParams;
  toolEvents?: ToolEvent[];
}): string => {
  const sourceText = collectFrontendSlidesSourceText(input);
  const title = extractFrontendSlidesSourceTitle(sourceText, input.params);
  const topics = extractFrontendSlidesTopics(sourceText, title);
  const sourceSummary = topics.slice(0, 3).join('; ') || 'the source material';
  const imagePreference = input.params?.prompt?.match(/(?:Images|Assets|asset_preference):\s*([^\n]+)/i)?.[1]?.trim();
  const slides = [
    `1. Title / hook - Introduce ${title} and frame the main audience takeaway.`,
    `2. Executive TL;DR - Summarize the core message: ${sourceSummary}.`,
    ...topics.slice(0, 6).map((topic, index) => (
      `${index + 3}. ${topic} - Turn this source section into one focused slide with the key point, supporting evidence, and a visual treatment.`
    )),
  ];
  slides.push(`${slides.length + 1}. Closing takeaways - Recap the strategic implications and next step for the audience.`);

  const imagePlan = imagePreference && !/^no images$/i.test(imagePreference)
    ? `Use the requested image/asset direction (${imagePreference}) where it directly supports a slide; otherwise use diagrams, timelines, maps, or typography.`
    : 'No dedicated image assets were confirmed. Use diagrams, timelines, maps, icon treatments, charts, and strong typography instead of placeholder images.';

  return [
    `## Proposed slide outline for ${title}`,
    '',
    ...slides,
    '',
    '### Image and visual assignment plan',
    '',
    imagePlan,
  ].join('\n');
};

const buildFrontendSlidesOutlineReviewMarkdown = (input: {
  assistantText?: string;
  params?: StartRunParams;
  toolEvents?: ToolEvent[];
}): string => (
  buildFrontendSlidesOutlinePreviewMarkdown(input.assistantText) ||
  buildFrontendSlidesFallbackOutlineMarkdown(input)
);

export const findGeneratedFrontendSlidesPreviewPaths = (
  toolEvents: ToolEvent[] | undefined,
): Record<string, string> => {
  const previewPaths: Record<string, string> = {};
  for (const event of toolEvents || []) {
    for (const file of [...(event.outputFiles || []), ...(event.relatedFiles || [])]) {
      const normalizedPath = String(file.path || '').trim().replace(/\\/g, '/');
      const match = normalizedPath.match(/(?:^|\/)(style-[a-c])(?:-preview)?\.html?$/i);
      if (match?.[1]) {
        previewPaths[match[1].toLowerCase()] = normalizedPath;
      }
    }
  }
  return previewPaths;
};

const buildFrontendSlidesGatePendingInterrupt = (input: {
  runId: string;
  gateId: FrontendSlidesGateId;
  assistantText?: string;
  params?: StartRunParams;
  toolEvents?: ToolEvent[];
}): Record<string, unknown> => {
  const { runId, gateId } = input;
  const interruptId = `implicit-${createHash('sha256').update(`${runId}:${gateId}`).digest('hex').slice(0, 20)}`;

  if (gateId === 'style_preview_selection') {
    const choices = extractFrontendSlidesStyleChoices(input.assistantText || '');
    const generatedPreviewPaths = findGeneratedFrontendSlidesPreviewPaths(input.toolEvents);
    const previews = choices
      .filter((choice) => /^style-[a-c]$/.test(choice.id))
      .map((choice) => {
        const generatedPath = generatedPreviewPaths[choice.id];
        return {
          id: choice.id,
          label: choice.label,
          description: choice.description,
          path: generatedPath || `.frontend-slides/slide-previews/${choice.id}.html`,
          ...(generatedPath ? {} : { html: buildFallbackStylePreviewHtml(choice) }),
        };
      });
    const displayPayload = buildFrontendSlidesDisplayPayload(gateId, {
      chooser: 'style-previews',
      stylePreviews: previews,
    });
    const props = {
      title: 'Choose Your Presentation Style',
      description: 'Preview each direction, then choose the one you want to use for the full deck.',
      choices,
      previews,
      submitLabel: 'Use selected style',
    };
    const interactionRequest = buildNativeInteractionRequest({
      interruptId,
      presentation: 'style_preview',
      props,
      gateId,
      skill: 'frontend-slides',
      metadata: displayPayload,
    });
    return {
      type: 'interrupt',
      kind: 'clarification',
      interruptId,
      title: props.title,
      description: props.description,
      actions: [],
      responseSpec: {
        inputMode: 'choice',
        submitLabel: props.submitLabel,
        choices,
      },
      displayPayload,
      interactionRequest,
    };
  }

  const config: Record<Exclude<FrontendSlidesGateId, 'style_preview_selection'>, {
    title: string;
    description: string;
    questions: Array<Record<string, unknown>>;
    submitLabel: string;
  }> = {
    presentation_context: {
      title: 'Choose Deck Mode',
      description: 'Choose whether the deck will be presented live or read on its own.',
      questions: FRONTEND_SLIDES_DISCOVERY_QUESTIONS,
      submitLabel: 'Continue',
    },
    outline_confirmation: {
      title: 'Outline Confirmation',
      description: 'Review the proposed slide outline and image assignments above.',
      questions: FRONTEND_SLIDES_OUTLINE_QUESTIONS,
      submitLabel: 'Continue',
    },
    style_path_selection: {
      title: 'Choose Style Selection Method',
      description: 'Select how you would like to decide on the presentation design.',
      questions: FRONTEND_SLIDES_STYLE_PATH_QUESTIONS,
      submitLabel: 'Continue',
    },
    mood_or_preset_selection: {
      title: 'Vibe & Mood Selection',
      description: 'Choose the desired vibe for this presentation.',
      questions: FRONTEND_SLIDES_MOOD_QUESTIONS,
      submitLabel: 'Generate style previews',
    },
  };
  const selected = config[gateId];
  const outlinePreviewMarkdown = gateId === 'outline_confirmation'
    ? buildFrontendSlidesOutlineReviewMarkdown(input)
    : '';
  const displayPayload = buildFrontendSlidesDisplayPayload(gateId, {
    ...(outlinePreviewMarkdown
      ? {
          slideOutline: outlinePreviewMarkdown,
          markdown: outlinePreviewMarkdown,
        }
      : {}),
  });
  const props = {
    title: selected.title,
    description: selected.description,
    ...(outlinePreviewMarkdown ? { outlineMarkdown: outlinePreviewMarkdown } : {}),
    questions: selected.questions,
    choices: [],
    inputMode: 'text',
    multiple: gateId === 'mood_or_preset_selection',
    submitLabel: selected.submitLabel,
  };
  const interactionRequest = buildNativeInteractionRequest({
    interruptId,
    presentation: 'questionnaire',
    props,
    gateId,
    skill: 'frontend-slides',
    metadata: displayPayload,
  });
  return {
    type: 'interrupt',
    kind: 'clarification',
    interruptId,
    title: selected.title,
    description: selected.description,
    actions: [
      {
        id: 'clarification-text',
        label: selected.submitLabel,
        style: 'primary',
        inputMode: 'text',
        submitLabel: selected.submitLabel,
      },
    ],
    responseSpec: {
      inputMode: 'text',
      multiple: gateId === 'mood_or_preset_selection',
      submitLabel: selected.submitLabel,
      questions: selected.questions,
      choices: [],
    },
    displayPayload,
    interactionRequest,
  };
};

const isFrontendSlidesEditExistingRun = (params: StartRunParams): boolean => {
  const messageText = (params.messageContent || [])
    .map((block) => JSON.stringify(block))
    .join(' ');
  const text = `${params.prompt || ''} ${messageText}`.toLowerCase();
  const mentionsExistingArtifact = (
    text.includes('.html') ||
    text.includes('.ppt') ||
    text.includes('.pptx') ||
    text.includes('existing deck') ||
    text.includes('existing slides') ||
    text.includes('current deck')
  );
  const asksForEdit = /\b(?:edit|revise|update|modify|fix|polish)\b/.test(text);
  return mentionsExistingArtifact && asksForEdit;
};

const isFrontendSlidesRun = (skillId: string | null | undefined, params: StartRunParams): boolean => (
  isFrontendSlidesSkill(skillId) || /\bfrontend-slides\b/i.test(params.prompt || '')
);

export const getFrontendSlidesMissingRequiredGate = (input: {
  skillId?: string | null;
  prompt?: string;
  status: AgentRunStatus;
  gateState?: InteractionGateState;
}): FrontendSlidesGateId | null => {
  const params = { prompt: input.prompt || '' } as StartRunParams;
  if (
    input.status !== 'completed' ||
    !isFrontendSlidesRun(input.skillId, params) ||
    isFrontendSlidesEditExistingRun(params)
  ) {
    return null;
  }
  return nextMissingFrontendSlidesGate(input.gateState || { completedGateIds: [] }) || null;
};

export const getFrontendSlidesInteractionGateCompletionError = (input: {
  skillId?: string | null;
  prompt?: string;
  status: AgentRunStatus;
  gateState?: InteractionGateState;
}): string | null => {
  const missingGate = getFrontendSlidesMissingRequiredGate(input);
  if (missingGate) {
    return `Contract violation: frontend-slides completed before required Interaction gate "${missingGate}" was completed with request_clarification.`;
  }
  const params = { prompt: input.prompt || '' } as StartRunParams;
  if (
    input.status === 'completed' &&
    isFrontendSlidesRun(input.skillId, params) &&
    !isFrontendSlidesEditExistingRun(params) &&
    hasCompletedAllFrontendSlidesGates(input.gateState || { completedGateIds: [] })
  ) {
    return `Contract violation: frontend-slides completed after all Interaction gates but before producing the required artifact: ${requiredArtifactDescriptionForSkill('frontend-slides')}.`;
  }
  return null;
};

export const validateInterrupt = (parsed: Record<string, unknown>, skillId: string | null): string | null => {
  const normalized = normalizeInterruptPayloadRecord(parsed);
  const displayPayloadForSkill = extractDisplayPayload(normalized);
  const payloadSkill = typeof displayPayloadForSkill?.skill === 'string' ? displayPayloadForSkill.skill : null;
  const effectiveSkillId = isFrontendSlidesSkill(skillId) ? skillId : payloadSkill;
  if (!isFrontendSlidesSkill(effectiveSkillId)) {
    return null;
  }

  const gateId = extractInteractionGateId(normalized);
  const isInteraction = isInteractionGatePayload(normalized);

  if (gateId && !isFrontendSlidesGateId(gateId)) {
    return `Contract violation: unknown frontend-slides Interaction gate "${gateId}".`;
  }

  if (normalized.kind !== 'clarification') {
    return isInteraction
      ? `Contract violation: Interaction gate interrupts must use kind "clarification", but got "${normalized.kind}".`
      : null;
  }

  const interactionRequest = normalized.interactionRequest as Record<string, any> | undefined;
  if (!interactionRequest) {
    return 'Contract violation: missing "interactionRequest" in clarification interrupt payload.';
  }

  const displayPayload = extractDisplayPayload(normalized);
  const nestedPayload = getRecord(displayPayload?.displayPayload) || getRecord(displayPayload?.display_payload);
  const expectedPresentation = (
    typeof displayPayload?.expectedPresentation === 'string'
      ? displayPayload.expectedPresentation
      : typeof nestedPayload?.expectedPresentation === 'string'
        ? nestedPayload.expectedPresentation
      : gateId && isFrontendSlidesGateId(gateId)
        ? EXPECTED_GATES[gateId]
        : undefined
  );

  const presentation = interactionRequest.presentation;
  if (!presentation) {
    return 'Contract violation: missing "presentation" in "interactionRequest".';
  }

  if (expectedPresentation && presentation !== expectedPresentation) {
    return `Contract violation: expected presentation "${expectedPresentation}" for gate "${gateId}", but got "${presentation}".`;
  }

  const props = interactionRequest.props as Record<string, any> | undefined;
  if (!props) {
    return 'Contract violation: missing "props" in "interactionRequest".';
  }
  const interactionProps = getRecord(interactionRequest?.props);
  const interactionMetadata = getRecord(interactionRequest?.metadata);

  if (presentation === 'questionnaire') {
    const questions = props.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      return 'Contract violation: questionnaire props.questions must be a non-empty array.';
    }
    if (
      gateId === 'outline_confirmation' &&
      !hasFrontendSlidesOutlineReviewMaterial(props, interactionProps, displayPayload, nestedPayload, interactionMetadata)
    ) {
      return 'Contract violation: outline_confirmation requires real outline review material before asking the user to approve it.';
    }
  } else if (presentation === 'style_preview') {
    const previews = props.previews;
    const choices = props.choices;
    const hasPreviews = Array.isArray(previews) && previews.length > 0;
    const hasChoices = Array.isArray(choices) && choices.length > 0;
    if (!hasPreviews && !hasChoices) {
      return 'Contract violation: style_preview props.previews or props.choices must be a non-empty array.';
    }
  }

  return null;
};

const isFrontendSlidesStyleSelectionContext = (assistantText: string): boolean => {
  const text = String(assistantText || '').toLowerCase();
  return (
    /\b(?:style|visual)\b.{0,180}\b(?:preview|archetype|aesthetic|selector|chooser|window)\b/is.test(text)
    || /\b(?:preview|archetype|aesthetic|selector|chooser|window)\b.{0,180}\b(?:style|visual)\b/is.test(text)
    || /\bstyle\s*[a-c]\s*:/i.test(text)
    || /\btheme\s*[a-c]\s*:/i.test(text)
    || /\boption\s*[1-3]\s*:/i.test(text)
    || /\bcustom\s+html\s+slide\s+style\s+options?\b/i.test(text)
    || /\bhtml\s+style\s+previews?\b/i.test(text)
    || /\bvisual\s+theme\s+selection\b/i.test(text)
    || /\b(?:styling|visual)\s+direction\b/i.test(text)
  ) && (
    /\b(?:choose|select|pick|preferred|favorite)\b.{0,180}\b(?:style|preview|direction|aesthetic|selector|chooser)\b/is.test(text)
    || /\b(?:choose|select|pick|preferred|favorite)\b.{0,180}\b(?:theme|styling\s+direction|visual\s+theme)\b/is.test(text)
    || /\b(?:selection|choose|select|pick)\b.{0,220}\b(?:generating|complete|deck|slides?)\b/is.test(text)
    || /\bonce\s+you\s+confirm\b.{0,180}\b(?:choice|theme|style|deck|slides?)\b/is.test(text)
    || /\b(?:interactive|thumbnail)\s+(?:selector|chooser|window)\b/is.test(text)
  );
};

const inferImplicitInputSkillId = (assistantText: string): string | null => {
  const text = String(assistantText || '').toLowerCase();
  const mentionsPresentation =
    /\b(frontend-slides|html presentation|slide deck|slides?|presentation)\b/.test(text);
  if (mentionsPresentation && isFrontendSlidesStyleSelectionContext(text)) {
    return 'frontend-slides';
  }
  const asksForPresentationContext =
    /\b(?:presentation|deck|slides?)\b.{0,240}\b(?:form|purpose|audience|style|visual|length|assets?)\b/is.test(text)
    || /\b(?:form|purpose|audience|style|visual|length|assets?)\b.{0,240}\b(?:presentation|deck|slides?)\b/is.test(text)
    || /\bto\s+ensure\b.{0,260}\b(?:deck|slides?|presentation)\b.{0,260}\b(?:expectations|ideal\s+length|length|structure|technical\s+features|audience|visual\s+style)\b/is.test(text)
    || (
      /\b(?:propose|generate)\s+a?\s*(?:proposed\s+)?slide\s+outline\b/i.test(text) &&
      /\b(?:move|proceed|continue)\s+to\s+(?:style\s+discovery|visual\s+(?:direction|aesthetic)|style\s+selection)\b/i.test(text)
    );
  return mentionsPresentation && asksForPresentationContext ? 'frontend-slides' : null;
};

const normalizeStyleChoiceId = (label: string, index: number): string => {
  const styleLetter = label.match(/\bstyle\s*([a-c])\b/i)?.[1]?.toLowerCase();
  if (styleLetter) {
    return `style-${styleLetter}`;
  }
  return `style-${String.fromCharCode(97 + index)}`;
};

const extractFrontendSlidesStyleChoices = (assistantText: string) => {
  const matches = [...String(assistantText || '').matchAll(
    /(?:(?:Style|Theme)\s*([A-C])|Option\s*([1-3]))\s*(?:\(([^)]+)\))?\s*:\s*([^—\n*]+)?(?:[—-]\s*([^\n]+))?/gi,
  )];
  const choices = matches.slice(0, 3).map((match, index) => {
    const optionNumber = match[2] ? Number(match[2]) : undefined;
    const letter = (match[1] || (optionNumber ? String.fromCharCode(64 + optionNumber) : String.fromCharCode(65 + index))).toLowerCase();
    const name = String(match[3] || match[4] || '').replace(/[()"“”]/g, '').trim();
    const description = String(match[5] || '').replace(/\s+/g, ' ').trim();
    const label = `Style ${letter.toUpperCase()}${name ? `: ${name}` : ''}`;
    return {
      id: `style-${letter}`,
      label,
      value: label,
      description: description || `Use ${name || `style ${letter.toUpperCase()}`} for the final presentation.`,
    };
  });
  const deduped = choices.filter(
    (choice, index, all) => all.findIndex((candidate) => candidate.id === choice.id) === index,
  );
  const baseChoices = deduped.length >= 2
    ? deduped
    : DEFAULT_FRONTEND_SLIDES_STYLE_CHOICES.slice(0, 3).map((choice, index) => ({
        ...choice,
        id: normalizeStyleChoiceId(choice.label, index),
      }));
  return [
    ...baseChoices,
    {
      id: 'mix-elements',
      label: 'Mix elements',
      value: 'Mix elements',
      description: 'Combine aspects from the generated previews.',
    },
  ];
};

const escapeHtmlText = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] || char));

const buildFallbackStylePreviewHtml = (choice: {
  id: string;
  label: string;
  description?: string;
}): string => {
  const paletteByKey: Record<string, { bg: string; fg: string; accent: string; muted: string }> = {
    swiss: { bg: '#ffffff', fg: '#050505', accent: '#ff3300', muted: '#3f3f46' },
    bold: { bg: '#1a1a1a', fg: '#ffffff', accent: '#ff5722', muted: '#d4d4d8' },
    botanical: { bg: '#0f0f0f', fg: '#e8e4df', accent: '#d4a574', muted: '#9a9590' },
    'style-a': { bg: '#f8fafc', fg: '#0f172a', accent: '#0ea5e9', muted: '#475569' },
    'style-b': { bg: '#111827', fg: '#f9fafb', accent: '#22c55e', muted: '#cbd5e1' },
    'style-c': { bg: '#fff7ed', fg: '#1f2937', accent: '#f97316', muted: '#64748b' },
  };
  const semanticKey = `${choice.label} ${choice.description || ''}`.toLowerCase();
  const palette =
    semanticKey.includes('botanical') || semanticKey.includes('dark botanical')
      ? paletteByKey.botanical
      : semanticKey.includes('bold signal') || semanticKey.includes('bold')
        ? paletteByKey.bold
        : semanticKey.includes('swiss') || semanticKey.includes('modern')
          ? paletteByKey.swiss
          : paletteByKey[choice.id] || paletteByKey['style-a'];
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: ${palette.bg}; color: ${palette.fg}; }
    .slide { min-height: 100vh; padding: 9vh 8vw; display: grid; grid-template-rows: auto 1fr auto; gap: 5vh; }
    .eyebrow { color: ${palette.accent}; font-size: 13px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; max-width: 980px; font-size: clamp(42px, 7vw, 88px); line-height: .95; letter-spacing: 0; }
    p { margin: 0; max-width: 740px; color: ${palette.muted}; font-size: clamp(18px, 2vw, 28px); line-height: 1.35; }
    .grid { display: grid; grid-template-columns: 1.2fr .8fr; align-items: end; gap: 5vw; }
    .metric { border-top: 4px solid ${palette.accent}; padding-top: 18px; font-size: clamp(38px, 6vw, 72px); font-weight: 900; }
    .label { margin-top: 8px; color: ${palette.muted}; font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
  </style>
</head>
<body>
  <main class="slide">
    <div class="eyebrow">HTML style preview</div>
    <section class="grid">
      <div>
        <h1>${escapeHtmlText(choice.label)}</h1>
        <p>${escapeHtmlText(choice.description || 'Presentation style preview.')}</p>
      </div>
      <div>
        <div class="metric">01</div>
        <div class="label">Title slide direction</div>
      </div>
    </section>
    <div class="eyebrow">Choose to generate the full deck</div>
  </main>
</body>
</html>`;
};

const buildImplicitInputPendingInterrupt = (opts: {
  runId: string;
  skillId: string | null;
  prompt?: string;
  interruptType?: 'frontend_slides_context' | 'frontend_slides_style' | 'generic';
  assistantText?: string;
}): RunPendingInterrupt => {
  const interruptId = `implicit-${createHash('sha256').update(`${opts.runId}:${opts.prompt || ''}`).digest('hex').slice(0, 20)}`;
  if (isFrontendSlidesSkill(opts.skillId)) {
    if (opts.interruptType === 'frontend_slides_style') {
      const choices = extractFrontendSlidesStyleChoices(opts.assistantText || opts.prompt || '');
      const stylePreviews = choices
        .filter((choice) => /^style-[a-c]$/.test(choice.id))
        .map((choice) => ({
          id: choice.id,
          label: choice.label,
          description: choice.description,
          path: `.frontend-slides/slide-previews/${choice.id}.html`,
          html: buildFallbackStylePreviewHtml(choice),
        }));
      const displayPayload = {
        source: 'implicit_completion_guard',
        synthetic: true,
        skill: 'frontend-slides',
        chooser: 'style-previews',
        stylePreviews,
        interactionContract: 'helpudoc.interaction',
      };
      const props = {
        title: 'Choose Your Presentation Style',
        description: opts.prompt || 'Preview each direction, then choose the one to use for the full deck.',
        choices,
        previews: stylePreviews,
        submitLabel: 'Use selected style',
      };
      const interactionRequest = buildNativeInteractionRequest({
        interruptId,
        presentation: 'style_preview',
        props,
        skill: 'frontend-slides',
        metadata: displayPayload,
      });
      return {
        kind: 'clarification',
        interruptId,
        title: 'Choose Your Presentation Style',
        description: opts.prompt || 'Preview each direction, then choose the one to use for the full deck.',
        actions: [],
        responseSpec: {
          inputMode: 'choice',
          submitLabel: 'Use selected style',
          allowDismiss: true,
          dismissLabel: 'Dismiss',
          choices,
        },
        displayPayload,
        interactionRequest,
      };
    }
    const displayPayload = {
      source: 'implicit_completion_guard',
      synthetic: true,
      skill: 'frontend-slides',
      gateId: 'presentation_context',
      interactionContract: 'helpudoc.interaction',
      expectedPresentation: 'questionnaire',
    };
    const props = {
      title: 'Choose Deck Mode',
      description: opts.prompt || 'Choose whether the deck will be presented live or read on its own.',
      questions: FRONTEND_SLIDES_DISCOVERY_QUESTIONS,
      choices: [],
      inputMode: 'text',
      multiple: false,
      submitLabel: 'Continue',
    };
    const interactionRequest = buildNativeInteractionRequest({
      interruptId,
      presentation: 'questionnaire',
      props,
      gateId: 'presentation_context',
      skill: 'frontend-slides',
      metadata: displayPayload,
    });
    return {
      kind: 'clarification',
      interruptId,
      title: 'Choose Deck Mode',
      description: opts.prompt || 'Choose whether the deck will be presented live or read on its own.',
      actions: [
        {
          id: 'submit_context',
          label: 'Continue',
          style: 'primary',
          inputMode: 'text',
          submitLabel: 'Continue',
        },
      ],
      responseSpec: {
        inputMode: 'text',
        submitLabel: 'Continue',
        allowDismiss: true,
        dismissLabel: 'Dismiss',
        questions: FRONTEND_SLIDES_DISCOVERY_QUESTIONS,
      },
      displayPayload,
      interactionRequest,
    };
  }
  const genericDescription = opts.prompt || 'The agent needs your input to continue.';
  const genericQuestion = {
    id: 'response',
    header: 'Input',
    question: genericDescription,
    options: [],
  };
  const displayPayload = {
    source: 'implicit_completion_guard',
    synthetic: true,
    interactionContract: 'helpudoc.interaction',
    ...(opts.skillId ? { skill: opts.skillId } : {}),
  };
  const props = {
    title: 'Input Needed',
    description: genericDescription,
    questions: [genericQuestion],
    choices: [],
    inputMode: 'text',
    multiple: false,
    placeholder: 'Enter your response...',
    submitLabel: 'Continue',
  };
  const interactionRequest = buildNativeInteractionRequest({
    interruptId,
    presentation: 'questionnaire',
    props,
    skill: opts.skillId || undefined,
    metadata: displayPayload,
  });
  return {
    kind: 'clarification',
    interruptId,
    title: 'Input Needed',
    description: genericDescription,
    actions: [
      {
        id: 'submit_response',
        label: 'Continue',
        style: 'primary',
        inputMode: 'text',
        placeholder: 'Enter your response...',
        submitLabel: 'Continue',
      },
    ],
    responseSpec: {
      inputMode: 'text',
      placeholder: 'Enter your response...',
      submitLabel: 'Continue',
      allowDismiss: true,
      dismissLabel: 'Dismiss',
      questions: [genericQuestion],
    },
    displayPayload,
    interactionRequest,
  };
};

const coerceText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
};

const normalizeToolFiles = (value: unknown): ToolOutputFile[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const files = value
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }
      const payload = item as Record<string, unknown>;
      const path = coerceText(payload.path).trim();
      if (!path) {
        return null;
      }
      const file: ToolOutputFile = { path };
      const mimeType = payload.mimeType;
      if (typeof mimeType === 'string' || mimeType === null) {
        file.mimeType = mimeType;
      }
      if (typeof payload.size === 'number' && Number.isFinite(payload.size) && payload.size >= 0) {
        file.size = payload.size;
      }
      return file;
    })
    .filter((item): item is ToolOutputFile => item !== null);
  return files.length ? files : undefined;
};

const WORKFLOW_ACTIONS = new Set([
  'request_user_interaction',
  'generate_artifact',
  'revise_artifact',
  'call_tool',
  'complete',
  'fail',
]);

const parseJsonRecord = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

export const normalizeWorkflowActionEvent = (value: unknown): WorkflowActionEvent | null => {
  const record = parseJsonRecord(value);
  const candidate = parseJsonRecord(record?.workflowAction) || record;
  const action = coerceText(candidate?.action).trim();
  if (!WORKFLOW_ACTIONS.has(action)) {
    return null;
  }
  const artifactRefs = Array.isArray(candidate?.artifactRefs)
    ? candidate.artifactRefs
    : Array.isArray(candidate?.artifact_refs)
      ? candidate.artifact_refs
      : undefined;
  const context = parseJsonRecord(candidate?.context) || undefined;
  return {
    action: action as WorkflowActionEvent['action'],
    reason: coerceText(candidate?.reason).trim() || undefined,
    gateId: coerceText(candidate?.gateId || candidate?.gate_id).trim() || null,
    presentation: (coerceText(candidate?.presentation).trim() || null) as WorkflowActionEvent['presentation'],
    artifactRefs,
    context,
    timestamp: new Date().toISOString(),
  };
};

const buildTerminalConversationSummary = (status: AgentRunStatus, error?: string): string => {
  if (status === 'completed') {
    return 'Completed successfully.';
  }
  if (status === 'cancelled') {
    return 'The run was stopped.';
  }
  if (status === 'failed') {
    return error?.trim() ? `The run failed: ${error.trim()}` : 'The run failed.';
  }
  return '';
};

const persistRunConversationMessage = async (
  runId: string,
  params: StartRunParams,
  status: Exclude<AgentRunStatus, 'queued'>,
  snapshot: ConversationRunSnapshot = {},
) => {
  if (!conversationService || !params.userId || !params.conversationId || !params.turnId) {
    return;
  }

  const assistantText = snapshot.assistantText?.trim() ? snapshot.assistantText : '';
  const terminalSummary =
    !assistantText && (status === 'completed' || status === 'failed' || status === 'cancelled')
      ? buildTerminalConversationSummary(status, snapshot.error)
      : '';
  const text = assistantText || terminalSummary;
  const metadata: ConversationMessageMetadata = {
    runId,
    status,
  };

  if (snapshot.thinkingText?.trim()) {
    metadata.thinkingText = snapshot.thinkingText;
  }
  if (snapshot.toolEvents?.length) {
    metadata.toolEvents = snapshot.toolEvents;
  }
  if (snapshot.runPolicy && Object.keys(snapshot.runPolicy).length) {
    metadata.runPolicy = snapshot.runPolicy;
  }
  if (snapshot.progressEvents?.length) {
    metadata.progressEvents = snapshot.progressEvents;
  }
  if (snapshot.workflowActions?.length) {
    metadata.workflowActions = snapshot.workflowActions;
  }
  if (snapshot.pendingInterrupt) {
    metadata.pendingInterrupt = snapshot.pendingInterrupt as ConversationMessageMetadata['pendingInterrupt'];
  }
  if (snapshot.implicitInput?.awaiting) {
    metadata.awaitingImplicitInput = true;
    metadata.implicitInputReason = 'missing_interrupt';
    if (snapshot.implicitInput.prompt) {
      metadata.implicitInputPrompt = snapshot.implicitInput.prompt;
    }
  }
  if (assistantText) {
    metadata.bodySource = 'assistant';
  } else if (terminalSummary) {
    metadata.bodySource = 'summary';
  }

  try {
    await conversationService.appendMessage(
      params.userId,
      params.conversationId,
      'agent',
      text,
      {
        turnId: params.turnId,
        replaceExisting: true,
        metadata: metadata as Record<string, unknown>,
      },
    );
  } catch (error) {
    console.error('Failed to persist agent run conversation message', {
      runId,
      conversationId: params.conversationId,
      turnId: params.turnId,
      status,
      error: safeErrorForLog(error),
    });
  }
};

export const buildAgentErrorPayload = (error: any, persona: string): string => {
  if (error?.response?.status === 404) {
    return `Agent '${persona}' not found.`;
  }
  if (typeof error?.response?.data?.error === 'string') {
    return error.response.data.error;
  }
  const connectionCode = [
    error?.code,
    error?.cause?.code,
    ...(Array.isArray(error?.errors) ? error.errors.map((item: any) => item?.code) : []),
  ].find((value) => typeof value === 'string' && value.trim());
  if (connectionCode && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(connectionCode)) {
    return `Unable to reach the agent service (${connectionCode}).`;
  }
  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return 'Agent run failed.';
};

const STRONG_GATE_PATTERNS = [
  /\bconfirm\b.{0,60}\boutline\b/i,
  /\boutline\b.{0,60}\bconfirm\b/i,
  /\b(?:please\s+)?confirm\b.{0,40}\b(?:form|UI)\b/i,
  /\b(?:select|choose)\b.{0,60}\b(?:form|options?|UI|selector|chooser|previews?|styles?)\b/i,
  /\b(?:once|after)\s+(?:confirmed|you\s+confirm)/i,
  /\b(?:once|after)\s+(?:submitted|you\s+submit)\b.{0,260}\b(?:outline|style\s+discovery|visual\s+aesthetic|proposal|review|generate|move)\b/is,
  /\b(?:once|after)\s+(?:received|submitted|you\s+submit|submitting)\b.{0,260}\b(?:outline|style\s+discovery|visual\s+aesthetic|proposal|review|generate|move|analyze|structure|slides?|gates?)\b/is,
  /\bto\s+ensure\b.{0,260}\b(?:deck|slides?|presentation)\b.{0,260}\b(?:expectations|ideal\s+length|length|structure|technical\s+features|audience|visual\s+style)\b/is,
  /\bnext\s+steps\b.{0,120}\b(?:sidebar|form)/i,
  /\b(?:prompted|prompting|asked|asking)\s+(?:you\s+)?to\s+(?:choose|select|pick|provide|enter)\b.{0,260}\b(?:paus(?:e|ing|ed)|wait(?:ing)?|response|input)\b/is,
  /\b(?:paus(?:e|ing|ed)|wait(?:ing)?)\b.{0,180}\b(?:your\s+)?(?:response|input|choice|selection|answer)\b/is,
];

const SELECTION_PROMPT_PATTERNS = [
  /\bplease\s+select\b|\bselect\s+(?:one|an?\s+option|your\s+(?:preferred\s+)?(?:option|format|path|audience|tone|depth|scope|style|mood|vibe))\b/i,
  /\b(?:please\s+)?choose\b/i,
  /\bwhich\s+(?:one|option|format|path|audience|tone|depth|scope|style|mood|vibe)/i,
  /\b(?:choose|select|pick)\s+(?:the\s+)?(?:output\s+)?(?:format|audience|tone|depth|scope|option|path)\b/i,
  /\bwhat\s+(?:style|mood|vibe)/i,
  /\bready to (?:proceed|continue|move)/i,
  /\bshall I\b/i,
];

const WEAK_COURTESY_PATTERNS = [
  /\bwould you like\b/i,
  /\bany refinements?\b/i,
  /\blet me know if\b/i,
  /\banything else\b/i,
  /\bneed any changes\b/i,
];

const UI_FORM_MISREF_PATTERNS = [
  /\b(?:initialized|prepared|loaded|created|opened)\s+the\s+[\w\s&+-]{1,120}?\s*(?:form|questions?|questionnaires?|UI)\b/i,
  /\b(?:submit|provide|enter|fill)\s+(?:your\s+)?preferences\b/i,
  /\b(?:from|in|using|via)\s+the\s+(?:form|options?|UI)\s+(?:above|below)/i,
  /\b(?:fill\s+out|complete|submit)\s+the\s+(?:form|questions?|questionnaires?)\s+(?:above|below)/i,
  /\b(?:fill\s+out|complete|submit)\s+the\s+(?:form|questions?|questionnaires?)\b.{0,180}\b(?:preferences?|goals?|details?|context|requirements?|purpose|audience|style|assets?|continue|proceed)\b/is,
  /\b(?:fill\s+out|complete|submit)\s+the\s+[\w\s&-]{1,120}?\s+(?:form|questions?|questionnaires?)\s+(?:above|below)/i,
  /\b(?:fill\s+out|complete|submit)\s+the\s+[\w\s&-]{1,120}?\s+(?:form|questions?|questionnaires?)\b.{0,180}\b(?:preferences?|goals?|details?|context|requirements?|purpose|audience|style|assets?|continue|proceed)\b/is,
  /\b(?:prepared|created|generated|provided)\s+(?:a\s+)?(?:context\s+)?form\s+(?:above|below)/i,
  /\bfill\s+(?:this|it)\s+out\b.{0,180}\b(?:submit|proceed|continue|outline|review)\b/is,
  /\b(?:forms?|options?|choices?|selectors?|choosers?)\s+in\s+the\s+sidebar/i,
  /\buse\s+the\s+(?:forms?|options?|choices?|selectors?|choosers?)\s+(?:in\s+the\s+sidebar|below|above)/i,
  /\b(?:interactive|thumbnail)\s+(?:selector|chooser|window)\s+(?:above|below)?/i,
  /\b(?:select|choose|pick|review).{0,120}\b(?:selector|chooser|preview|style).{0,80}\b(?:above|below|window)\b/i,
  /\bselect.*(?:above|below)/i,
  /\bpick.*(?:above|below)/i,
  /\bconfirm.*(?:form|UI)\s+above/i,
];

const collectImplicitInputSignals = (lastParagraphs: string): Set<string> => {
  const signals = new Set<string>();

  if (/\?\s*$/.test(lastParagraphs)) {
    signals.add('ends_with_question');
  }
  if (STRONG_GATE_PATTERNS.some((pattern) => pattern.test(lastParagraphs))) {
    signals.add('strong_gate');
  }
  if (SELECTION_PROMPT_PATTERNS.some((pattern) => pattern.test(lastParagraphs))) {
    signals.add('selection_prompt');
  }
  if (WEAK_COURTESY_PATTERNS.some((pattern) => pattern.test(lastParagraphs))) {
    signals.add('weak_courtesy');
  }
  if (UI_FORM_MISREF_PATTERNS.some((pattern) => pattern.test(lastParagraphs))) {
    signals.add('phantom_ui_reference');
  }
  if (/(?:^|\n)\s*[-•*]\s+.+(?:\n\s*[-•*]\s+.+){2,}/m.test(lastParagraphs)) {
    signals.add('enumerated_choices');
  }
  if (/(?:^|\n)\s*\d+\.\s+.+(?:\n\s*\d+\.\s+.+){1,}/m.test(lastParagraphs)) {
    signals.add('enumerated_choices');
  }
  if (
    /\b(?:propose|generate)\s+a?\s*(?:proposed\s+)?slide\s+outline\b/i.test(lastParagraphs) &&
    /\b(?:move|proceed|continue)\s+to\s+(?:style\s+discovery|visual\s+(?:direction|aesthetic)|style\s+selection)\b/i.test(lastParagraphs)
  ) {
    signals.add('enumerated_choices');
  }

  return signals;
};

const shouldAwaitImplicitInput = (signals: Set<string>): boolean => {
  if (signals.size === 0) {
    return false;
  }
  const isOnlyWeakCourtesy = [...signals].every(
    (signal) => signal === 'weak_courtesy' || signal === 'ends_with_question',
  );
  if (isOnlyWeakCourtesy) {
    return false;
  }
  if (signals.has('phantom_ui_reference') || signals.has('strong_gate')) {
    return true;
  }
  if (
    signals.has('enumerated_choices') &&
    (signals.has('phantom_ui_reference') || signals.has('strong_gate') || signals.has('selection_prompt'))
  ) {
    return true;
  }
  const strongCount = ['phantom_ui_reference', 'strong_gate', 'enumerated_choices'].filter((key) =>
    signals.has(key),
  ).length;
  if (strongCount >= 2) {
    return true;
  }
  if (
    signals.has('phantom_ui_reference') &&
    (signals.has('selection_prompt') || signals.has('enumerated_choices'))
  ) {
    return true;
  }
  return false;
};

/**
 * Detects whether a completed skill run is implicitly awaiting user input
 * (the agent asked a question in prose but failed to emit a request_clarification interrupt).
 *
 * Heuristics mirror agent/helpudoc_agent/implicit_input_detection.py. The graph guard blocks
 * completion; this fallback only annotates completed runs for frontend continuation.
 */
export const detectImplicitInputAwaiting = (opts: {
  status: AgentRunStatus;
  skillId: string | null;
  hadInterrupt: boolean;
  assistantText: string;
}): { awaiting: boolean; prompt?: string; skillId?: string | null; interruptType?: 'frontend_slides_context' | 'frontend_slides_style' | 'generic' } => {
  if (opts.status !== 'completed' || opts.hadInterrupt) {
    return { awaiting: false };
  }

  const text = (opts.assistantText || '').trim();
  if (!text) {
    return { awaiting: false };
  }

  const inferredSkillId = inferImplicitInputSkillId(text);
  const effectiveSkillId = inferredSkillId || opts.skillId;
  if (!effectiveSkillId) {
    return { awaiting: false };
  }
  const isFrontendSlidesStyle = isFrontendSlidesSkill(effectiveSkillId) && isFrontendSlidesStyleSelectionContext(text);

  const lastParagraphs = text.slice(-1500);
  const signals = collectImplicitInputSignals(lastParagraphs);

  if (!isFrontendSlidesStyle && !shouldAwaitImplicitInput(signals)) {
    return { awaiting: false };
  }

  const promptMatch = lastParagraphs.match(/[^.!?\n]*\?\s*$/);
  const sidebarPromptMatch = lastParagraphs.match(/Please use the\s+.+?(?:\n\s*\d+\.\s+.+)+/is);
  const prompt = promptMatch
    ? promptMatch[0].trim()
    : sidebarPromptMatch
      ? sidebarPromptMatch[0].trim()
      : undefined;

  const interruptType = isFrontendSlidesStyle
    ? 'frontend_slides_style'
    : isFrontendSlidesSkill(effectiveSkillId)
      ? 'frontend_slides_context'
      : 'generic';

  return { awaiting: true, prompt, skillId: effectiveSkillId, interruptType };
};

const parsePendingInterrupt = (raw: string | undefined): RunPendingInterrupt | undefined => {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  try {
    const parsed = normalizeInterruptPayloadRecord(JSON.parse(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const payload = parsed as Record<string, unknown>;
    return {
      kind:
        payload.kind === 'clarification' || payload.kind === 'approval'
          ? payload.kind
          : undefined,
      resumeStrategy:
        payload.resumeStrategy === 'fresh_prompt' || payload.resumeStrategy === 'checkpoint'
          ? payload.resumeStrategy
          : undefined,
      interruptId: typeof payload.interruptId === 'string' ? payload.interruptId : undefined,
      title: typeof payload.title === 'string' ? payload.title : undefined,
      description: typeof payload.description === 'string' ? payload.description : undefined,
      stepIndex: typeof payload.stepIndex === 'number' ? payload.stepIndex : undefined,
      stepCount: typeof payload.stepCount === 'number' ? payload.stepCount : undefined,
      actions: Array.isArray(payload.actions)
        ? payload.actions.filter(
            (
              item,
            ): item is NonNullable<RunPendingInterrupt['actions']>[number] =>
              Boolean(item) &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              typeof (item as { id?: unknown }).id === 'string' &&
              typeof (item as { label?: unknown }).label === 'string',
          )
        : undefined,
      actionRequests: Array.isArray(payload.actionRequests)
        ? payload.actionRequests.filter(
            (item): item is { name?: string; args?: Record<string, unknown> } =>
              Boolean(item) && typeof item === 'object' && !Array.isArray(item),
          )
        : undefined,
      reviewConfigs: Array.isArray(payload.reviewConfigs)
        ? payload.reviewConfigs.filter(
            (item): item is { action_name?: string; allowed_decisions?: string[] } =>
              Boolean(item) && typeof item === 'object' && !Array.isArray(item),
          )
        : undefined,
      responseSpec:
        payload.responseSpec && typeof payload.responseSpec === 'object' && !Array.isArray(payload.responseSpec)
          ? (payload.responseSpec as RunPendingInterrupt['responseSpec'])
          : undefined,
      displayPayload:
        payload.displayPayload && typeof payload.displayPayload === 'object' && !Array.isArray(payload.displayPayload)
          ? (payload.displayPayload as Record<string, unknown>)
          : undefined,
      interactionRequest:
        payload.interactionRequest && typeof payload.interactionRequest === 'object' && !Array.isArray(payload.interactionRequest)
          ? (payload.interactionRequest as RunPendingInterrupt['interactionRequest'])
          : undefined,
    };
  } catch {
    return undefined;
  }
};

const serializeRunContext = (params: StartRunParams): string =>
  JSON.stringify({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    persona: params.persona,
    prompt: params.prompt,
    userId: params.userId,
    history: params.history,
    forceReset: params.forceReset,
    turnId: params.turnId,
    messageContent: params.messageContent,
    internetSearchEnabled: params.internetSearchEnabled,
    knowledgeRefs: params.knowledgeRefs,
  } satisfies PersistedRunContext);

const parseRunContext = (raw: string | undefined): RunContext | undefined => {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as PersistedRunContext;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof parsed.workspaceId !== 'string' ||
      typeof parsed.persona !== 'string' ||
      typeof parsed.prompt !== 'string'
    ) {
      return undefined;
    }
    return {
      params: {
        workspaceId: parsed.workspaceId,
        conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : undefined,
        persona: parsed.persona,
        prompt: parsed.prompt,
        userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
        history: Array.isArray(parsed.history) ? parsed.history : undefined,
        forceReset: typeof parsed.forceReset === 'boolean' ? parsed.forceReset : undefined,
        turnId: typeof parsed.turnId === 'string' ? parsed.turnId : undefined,
        messageContent: Array.isArray(parsed.messageContent) ? parsed.messageContent as AgentMessageContentBlock[] : undefined,
        internetSearchEnabled: typeof parsed.internetSearchEnabled === 'boolean' ? parsed.internetSearchEnabled : undefined,
        knowledgeRefs: Array.isArray(parsed.knowledgeRefs) ? parsed.knowledgeRefs as AgentKnowledgeRef[] : undefined,
      },
    };
  } catch {
    return undefined;
  }
};

type RunStreamRecoveryInspection = {
  latestInterruptPayload: Record<string, unknown> | null;
  latestTerminalEvent?: { status: AgentRunStatus; error?: string };
  assistantText?: string;
  latestRealActivityAt?: number;
  latestEntryAt?: number;
  latestFrontendSlidesArtifactPaths?: Record<string, string>;
};

export type RunConversationRecoverySnapshot = {
  assistantText: string;
  status: AgentRunStatus;
  error?: string;
};

export const reconstructAssistantTextFromStreamPayloads = (
  payloads: Array<Record<string, unknown> | null>,
): string => payloads.reduce((text, parsed) => {
  if (
    !parsed
    || (parsed.type !== 'token' && parsed.type !== 'chunk')
    || (parsed.role && parsed.role !== 'assistant')
  ) {
    return text;
  }
  return mergeAssistantTextChunk(text, coerceText(parsed.content));
}, '');

const parseRedisStreamEntryTimestamp = (entryId: unknown): number | undefined => {
  if (typeof entryId !== 'string') {
    return undefined;
  }
  const timestamp = Number(entryId.split('-')[0]);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
};

const streamEntryIsRelevantToStartedAt = (entryAt: number | undefined, startedAtMs: number | undefined): boolean => {
  if (!startedAtMs || !entryAt) {
    return true;
  }
  return entryAt >= startedAtMs - 1000;
};

export const terminalEventFromStreamPayload = (parsed: Record<string, unknown> | null): { status: AgentRunStatus; error?: string } | undefined => {
  if (!parsed) {
    return undefined;
  }
  const type = coerceText(parsed.type).trim();
  if (type === 'done') {
    const status = coerceText(parsed.status).trim();
    if (status === 'failed' || status === 'error') {
      return {
        status: 'failed',
        error: coerceText(parsed.error || parsed.message).trim() || 'Agent run failed.',
      };
    }
    if (status === 'cancelled' || status === 'canceled') {
      return { status: 'cancelled' };
    }
    if (status === 'interrupted') {
      return undefined;
    }
    return { status: 'completed' };
  }
  if (type === 'error' || type === 'contract_error') {
    return {
      status: 'failed',
      error: coerceText(parsed.message || parsed.error).trim() || 'Agent run failed.',
    };
  }
  return undefined;
};

const matchingRequiredFrontendSlidesArtifacts = (path: string): string[] => {
  const declaredRequirements = requiredArtifactsForSkill('frontend-slides');
  if (!declaredRequirements.length) {
    const baseName = path.split(/[\\/]/).pop() || path;
    return /\.html?$/i.test(baseName) && /(?:-deck|deck|slides?|presentation)/i.test(baseName)
      ? ['final_deck']
      : [];
  }
  return declaredRequirements
    .filter((requirement) => artifactPathMatchesRequirement(path, requirement))
    .map((requirement) => requirement.artifactId);
};

const requiredArtifactDescriptionForSkill = (skillId: string | null | undefined): string => {
  const requirements = requiredArtifactsForSkill(skillId);
  if (!requirements.length) {
    return 'required workspace artifact';
  }
  return requirements
    .map((requirement) => (
      requirement.instructions ||
      requirement.description ||
      requirement.patterns.join(', ') ||
      requirement.artifactId
    ))
    .join('; ');
};

const extractFrontendSlidesArtifactPaths = (parsed: Record<string, unknown> | null): Record<string, string> => {
  if (!parsed) {
    return {};
  }
  const candidates: string[] = [];
  const artifactPath = coerceText(parsed.artifactPath).trim();
  if (artifactPath) {
    candidates.push(artifactPath);
  }
  const outputFiles = Array.isArray(parsed.outputFiles) ? parsed.outputFiles : [];
  outputFiles.forEach((file) => {
    const path = getRecord(file)?.path;
    if (typeof path === 'string' && path.trim()) {
      candidates.push(path.trim());
    }
  });
  const artifacts: Record<string, string> = {};
  candidates.forEach((candidate) => {
    matchingRequiredFrontendSlidesArtifacts(candidate).forEach((artifactId) => {
      artifacts[artifactId] = candidate;
    });
  });
  return artifacts;
};

const mergeFrontendSlidesArtifactPaths = (
  current: Record<string, string>,
  next: Record<string, string>,
): Record<string, string> => ({ ...current, ...next });

const missingRequiredFrontendSlidesArtifactIds = (paths: Record<string, string>): string[] => {
  const required = requiredArtifactsForSkill('frontend-slides');
  if (!required.length) {
    return paths.final_deck ? [] : ['final_deck'];
  }
  return required
    .filter((requirement) => !paths[requirement.artifactId])
    .map((requirement) => requirement.artifactId);
};

const hasAllRequiredFrontendSlidesArtifacts = (paths: Record<string, string>): boolean => (
  missingRequiredFrontendSlidesArtifactIds(paths).length === 0
);

const firstFrontendSlidesArtifactPath = (paths: Record<string, string>): string | undefined => (
  paths.final_deck || Object.values(paths)[0]
);

const frontendSlidesArtifactCompletionError = (
  input: {
    skillId?: string | null;
    prompt?: string;
    status: AgentRunStatus;
    gateState?: InteractionGateState;
  },
  paths: Record<string, string>,
): string | null => {
  const missingGate = getFrontendSlidesMissingRequiredGate(input);
  if (missingGate) {
    return `Contract violation: frontend-slides completed before required Interaction gate "${missingGate}" was completed with request_clarification.`;
  }
  const params = { prompt: input.prompt || '' } as StartRunParams;
  if (
    input.status === 'completed' &&
    isFrontendSlidesRun(input.skillId, params) &&
    !isFrontendSlidesEditExistingRun(params) &&
    hasCompletedAllFrontendSlidesGates(input.gateState || { completedGateIds: [] })
  ) {
    const missing = missingRequiredFrontendSlidesArtifactIds(paths);
    if (missing.length) {
      return `Contract violation: frontend-slides completed after all Interaction gates but before producing required artifact(s): ${missing.join(', ')}. Required: ${requiredArtifactDescriptionForSkill('frontend-slides')}.`;
    }
  }
  return null;
};

const inspectRunStreamForRecovery = async (
  runId: string,
  startedAt?: string,
): Promise<RunStreamRecoveryInspection> => {
  const streamKey = buildStreamKey(runId);
  const startedAtMs = Number.isFinite(Date.parse(startedAt || ''))
    ? Date.parse(startedAt || '')
    : undefined;
  const inspection: RunStreamRecoveryInspection = {
    latestInterruptPayload: null,
  };
  const assistantPayloadsNewestFirst: Array<Record<string, unknown>> = [];
  try {
    const pageSize = 500;
    let maximumId = '+';
    while (true) {
      const entries = await redisClient.sendCommand([
        'XREVRANGE',
        streamKey,
        maximumId,
        '-',
        'COUNT',
        String(pageSize),
      ]) as unknown;
      if (!Array.isArray(entries) || !entries.length) {
        break;
      }
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length < 2 || !Array.isArray(entry[1])) {
          continue;
        }
        const entryAt = parseRedisStreamEntryTimestamp(entry[0]);
        const isRelevantToCurrentResume = streamEntryIsRelevantToStartedAt(entryAt, startedAtMs);
        const fields = entry[1] as unknown[];
        for (let index = 0; index < fields.length - 1; index += 2) {
          if (fields[index] !== 'data' || typeof fields[index + 1] !== 'string') {
            continue;
          }
          const parsed = parseLine(fields[index + 1] as string);
          inspection.latestFrontendSlidesArtifactPaths = mergeFrontendSlidesArtifactPaths(
            inspection.latestFrontendSlidesArtifactPaths || {},
            extractFrontendSlidesArtifactPaths(parsed),
          );
          if (!isRelevantToCurrentResume) {
            continue;
          }
          if (
            parsed
            && (parsed.type === 'token' || parsed.type === 'chunk')
            && (!parsed.role || parsed.role === 'assistant')
          ) {
            assistantPayloadsNewestFirst.push(parsed);
          }
          if (!inspection.latestEntryAt && entryAt) {
            inspection.latestEntryAt = entryAt;
          }
          if (isRealRunProgressEvent(parsed) && !inspection.latestRealActivityAt && entryAt) {
            inspection.latestRealActivityAt = entryAt;
          }
          if (!inspection.latestTerminalEvent) {
            inspection.latestTerminalEvent = terminalEventFromStreamPayload(parsed);
          }
          if (!inspection.latestInterruptPayload && parsed?.type === 'interrupt') {
            inspection.latestInterruptPayload = normalizeInterruptPayloadRecord(parsed);
          }
        }
      }
      if (entries.length < pageSize) {
        break;
      }
      const oldestEntry = entries[entries.length - 1];
      const oldestEntryId = Array.isArray(oldestEntry) ? oldestEntry[0] : undefined;
      if (typeof oldestEntryId !== 'string' || !oldestEntryId) {
        break;
      }
      maximumId = `(${oldestEntryId}`;
    }
    const assistantText = reconstructAssistantTextFromStreamPayloads(
      assistantPayloadsNewestFirst.reverse(),
    );
    if (assistantText.trim()) {
      inspection.assistantText = assistantText;
    }
  } catch (error) {
    console.error('Failed to inspect run stream for stale run recovery', {
      runId,
      error: safeErrorForLog(error),
    });
  }
  return inspection;
};

export const getRunConversationRecoverySnapshot = async (
  runId: string,
): Promise<RunConversationRecoverySnapshot | null> => {
  const meta = await redisClient.hGetAll(buildMetaKey(runId));
  if (!Object.keys(meta).length) {
    return null;
  }

  const inspection = await inspectRunStreamForRecovery(
    runId,
    meta.startedAt || meta.createdAt,
  );
  const assistantText = inspection.assistantText?.trim() || '';
  if (!assistantText) {
    return null;
  }

  const persistedStatus = meta.status as AgentRunStatus;
  const status = inspection.latestTerminalEvent?.status
    || (persistedStatus === 'completed'
      || persistedStatus === 'failed'
      || persistedStatus === 'cancelled'
      || persistedStatus === 'awaiting_approval'
      ? persistedStatus
      : 'running');

  return {
    assistantText,
    status,
    error: inspection.latestTerminalEvent?.error || meta.error || undefined,
  };
};

export const shouldFailRunningRunForStaleActivity = (input: {
  status?: string;
  lastActivityAt?: number;
  now: number;
  timeoutMs?: number;
}): boolean => {
  if (input.status !== 'running' && input.status !== 'queued') {
    return false;
  }
  if (!input.lastActivityAt) {
    return false;
  }
  const timeoutMs = input.timeoutMs ?? RUNNING_RUN_STALE_TIMEOUT_MS;
  return timeoutMs > 0 && input.now - input.lastActivityAt >= timeoutMs;
};

const loadRunContext = async (runId: string): Promise<RunContext | undefined> => {
  const inMemory = runContexts.get(runId);
  if (inMemory) {
    return inMemory;
  }
  const metaKey = buildMetaKey(runId);
  const persisted = await redisClient.hGet(metaKey, 'runContext');
  const parsed = parseRunContext(persisted ?? undefined);
  if (parsed) {
    runContexts.set(runId, parsed);
  }
  return parsed;
};

const cleanupRun = (runId: string, upstream?: IncomingMessage) => {
  const controller = runAbortControllers.get(runId);
  if (controller) {
    runAbortControllers.delete(runId);
  }
  if (upstream && !upstream.destroyed) {
    upstream.destroy();
  }
};

const cleanupRunWorker = async (runId: string, upstream?: IncomingMessage) => {
  try {
    await workspaceRunLease.release(runId);
  } catch (error) {
    console.error('Failed to release workspace run lock', safeErrorForLog(error));
  }
  cleanupRun(runId, upstream);
};

const markRunFinished = async (runId: string, status: AgentRunStatus, error?: string): Promise<string> => {
  const completedAt = new Date().toISOString();
  await persistMeta(runId, {
    status,
    completedAt,
    error,
    pendingInterrupt: '',
    runContext: '',
  });
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    runContexts.delete(runId);
  }
  return completedAt;
};

const markRunAwaitingApproval = async (runId: string, interruptPayload: string, params?: StartRunParams) => {
  await persistMeta(runId, {
    status: 'awaiting_approval',
    pendingInterrupt: interruptPayload,
    error: '',
    ...(params ? { runContext: serializeRunContext(params) } : {}),
  });
};

export async function startAgentRun(params: StartRunParams): Promise<{ runId: string; status: AgentRunStatus }> {
  if (params.turnId?.trim()) {
    const existingRunId = await redisClient.get(
      buildRunDedupeKey(params.workspaceId, params.persona, params.turnId.trim(), params.userId),
    );
    if (existingRunId) {
      const existingMeta = await getRunMeta(existingRunId);
      if (existingMeta && !['completed', 'failed', 'cancelled'].includes(existingMeta.status)) {
        return { runId: existingRunId, status: existingMeta.status };
      }
    }
  }
  const runId = randomUUID();
  const streamKey = buildStreamKey(runId);
  const metaKey = buildMetaKey(runId);
  const queuedAt = new Date().toISOString();

  await redisClient.del(streamKey);
  await redisClient.del(metaKey);
  await persistMeta(runId, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    persona: params.persona,
    status: 'queued',
    createdAt: queuedAt,
    turnId: params.turnId,
    pendingInterrupt: '',
    interactionGateState: JSON.stringify({ completedGateIds: [] }),
    runContext: serializeRunContext(params),
  });
  if (params.turnId?.trim()) {
    await redisClient.set(
      buildRunDedupeKey(params.workspaceId, params.persona, params.turnId.trim(), params.userId),
      runId,
      { EX: STREAM_TTL_SECONDS },
    );
  }
  runContexts.set(runId, { params });
  if (runTelemetryService) {
    await runTelemetryService.recordQueuedRun({
      runId,
      workspaceId: params.workspaceId,
      userId: params.userId,
      conversationId: params.conversationId,
      turnId: params.turnId,
      persona: params.persona,
      queuedAt,
    });
  }

  // Fire and forget worker
  launchAgentRunWorker(runId, params);

  return { runId, status: 'queued' };
}

const parseLine = (line: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

type InterruptStopState = {
  sawInterruptPayload: Record<string, unknown> | null;
  buffer: string;
  upstream: { destroy(): void; destroyed: boolean } | null;
};

export async function persistInterruptAndStopRun(
  runId: string,
  parsed: Record<string, unknown>,
  state: InterruptStopState,
  persistInterrupt: (runId: string, interruptPayload: string) => Promise<void> = (pendingRunId, interruptPayload) =>
    markRunAwaitingApproval(pendingRunId, interruptPayload),
): Promise<boolean> {
  if (state.sawInterruptPayload) {
    return false;
  }
  const normalized = normalizeInterruptPayloadRecord(parsed);
  state.sawInterruptPayload = normalized;
  await persistInterrupt(runId, JSON.stringify(normalized));
  return true;
}

async function runAgentRunWorker(
  runId: string,
  params: StartRunParams,
  resumePayload?: ResumePayload,
  previousInterrupt?: RunPendingInterrupt,
) {
  const controller = new AbortController();
  runAbortControllers.set(runId, controller);
  try {
    await workspaceRunLease.acquire(runId, params.workspaceId, controller);
  } catch (error) {
    const persistedStatus = await redisClient.hGet(buildMetaKey(runId), 'status').catch(() => undefined);
    if (!persistedStatus || ['queued', 'running'].includes(persistedStatus)) {
      const cancelled = controller.signal.aborted;
      await markRunFinished(
        runId,
        cancelled ? 'cancelled' : 'failed',
        cancelled ? undefined : error instanceof Error ? error.message : 'Failed to acquire workspace execution lock',
      );
    }
    await cleanupRunWorker(runId);
    return;
  }
  if (fileService && params.userId) {
    await fileService.reconcileWorkspaceMirror(
      params.workspaceId,
      params.userId,
      () => workspaceRunLease.assertOwned(runId),
    );
  }
  const startedAt = new Date().toISOString();
  const runProgress = resumePayload && runTelemetryService
    ? await runTelemetryService.getRunProgress(runId)
    : null;
  const runMetaAtStart = await getRunMeta(runId);
  let eventIndex = runProgress?.maxEventIndex ?? 0;
  let skillId: string | null = null;
  let hadInterrupt = runProgress?.hadInterrupt ?? false;
  let approvalInterruptCount = runProgress?.approvalInterruptCount ?? 0;
  let clarificationInterruptCount = runProgress?.clarificationInterruptCount ?? 0;
  let toolCallCount = runProgress?.toolCallCount ?? 0;
  let toolErrorCount = runProgress?.toolErrorCount ?? 0;
  const usesFreshResumeThread = Boolean(
    params.forceReset && isSyntheticClarificationInterrupt(previousInterrupt),
  );
  const traceContext: AgentTraceContext = {
    runId,
    // Keep the LangGraph checkpoint stable for a run even if the agent
    // runtime is rebuilt between the initial request and a real interrupt
    // response. Only synthetic fresh-prompt resumes intentionally start a
    // new checkpoint thread.
    threadId: usesFreshResumeThread
      ? `${runId}:reset:${randomUUID()}`
      : runId,
    turnId: params.turnId,
    userId: params.userId,
    workspaceId: params.workspaceId,
    persona: params.persona,
    conversationId: params.conversationId,
    skillId: skillId || undefined,
  };

  let langfuseStreamMeta: Record<string, unknown> = {};

  if (DEBUG_AGENT_RUN_STREAM) {
    console.info('[agent-run-stream] start', {
      runId,
      workspaceId: params.workspaceId,
      persona: params.persona,
      hasHistory: Boolean(params.history?.length),
      resumeDecisions: Boolean(resumePayload && 'decisions' in resumePayload && resumePayload.decisions?.length),
      resumeResponse: Boolean(resumePayload && 'response' in resumePayload),
      resumeAction: Boolean(resumePayload && 'action' in resumePayload && resumePayload.action),
    });
  }

  await persistMeta(runId, {
    status: 'running',
    startedAt,
    error: '',
    pendingInterrupt: '',
  });
  if (runTelemetryService) {
    await runTelemetryService.markRunStarted(runId, startedAt);
  }

  let upstream: IncomingMessage | null = null;
  let buffer = '';
  let sawInterruptPayload: Record<string, unknown> | null = null;
  let interruptPublished = false;
  let contractErrorMessage = '';
  let loopErrorMessage = '';
  let stallErrorMessage = '';
  let streamErrorMessage = '';
  let latestFrontendSlidesArtifactPaths: Record<string, string> = {};
  let settled = false;
  let processingQueue: Promise<void> = Promise.resolve();
  let activeToolCalls = 0;
  let lastRealActivityAt = Date.now();
  const skillSandboxFailureCounts = new Map<string, number>();
  let assistantText = '';
  let thinkingText = '';
  let conversationRunPolicy: ConversationRunPolicy | undefined;
  let interactionGateState = runMetaAtStart?.interactionGateState || { completedGateIds: [] };
  traceContext.interactionGateState = interactionGateState;
  const toolEvents: ToolEvent[] = [];
  const progressEvents: RunProgressEvent[] = [];
  const workflowActions: WorkflowActionEvent[] = [];
  let artifactsCommitted = false;
  let artifactBaseline: WorkspaceArtifactBaseline | null = null;
  let agentStreamEstablished = false;

  const commitRunArtifacts = async () => {
    if (artifactsCommitted || !fileService || !params.userId) return;
    // A failed connection cannot have generated workspace artifacts. Skipping
    // this commit also keeps a secondary lease failure from masking the real
    // transport error during stale-run recovery.
    if (!agentStreamEstablished) {
      artifactsCommitted = true;
      return;
    }
    await workspaceRunLease.assertOwned(runId);
    // The reconciled workspace is protected by an exclusive run lease, so the
    // filesystem delta is the source of truth for generated artifacts. Tool
    // outputFiles remain useful UI metadata, but must never decide durability:
    // tools such as image generators can write valid files without returning a
    // structured artifact response.
    await fileService.commitWorkspaceArtifacts(params.workspaceId, params.userId, runId, {
      baseline: artifactBaseline,
      assertLeaseOwned: () => workspaceRunLease.assertOwned(runId),
    });
    artifactsCommitted = true;
  };

  const snapshotConversationRun = (overrides: Partial<ConversationRunSnapshot> = {}): ConversationRunSnapshot => ({
    assistantText,
    thinkingText,
    toolEvents: toolEvents.length ? [...toolEvents] : undefined,
    runPolicy: conversationRunPolicy,
    progressEvents: progressEvents.length ? [...progressEvents] : undefined,
    workflowActions: workflowActions.length ? [...workflowActions] : undefined,
    ...overrides,
  });

  const settleRunningToolEvents = (status: AgentRunStatus) => {
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
      return;
    }
    const now = new Date().toISOString();
    toolEvents.forEach((event) => {
      if (event.status !== 'running') {
        return;
      }
      event.status = status === 'completed' ? 'completed' : 'error';
      event.finishedAt = event.finishedAt || now;
    });
  };

  const updateConversationFromRun = (
    status: Exclude<AgentRunStatus, 'queued'>,
    overrides: Partial<ConversationRunSnapshot> = {},
  ) => persistRunConversationMessage(runId, params, status, snapshotConversationRun(overrides));

  const upsertToolEvent = (
    parsed: Record<string, unknown>,
    status: ToolEvent['status'],
  ) => {
    const name = coerceText(parsed.name || parsed.content).trim() || 'tool';
    const now = new Date().toISOString();
    const outputFiles = normalizeToolFiles(parsed.outputFiles);
    const relatedFiles = normalizeToolFiles(parsed.relatedFiles);
    const summary = coerceText(parsed.summary || parsed.content).trim();
    const existingIndex =
      status === 'running'
        ? -1
        : [...toolEvents]
          .reverse()
          .findIndex((event) => event.name === name && event.status === 'running');
    const targetIndex = existingIndex >= 0 ? toolEvents.length - 1 - existingIndex : -1;

    if (targetIndex >= 0) {
      toolEvents[targetIndex] = {
        ...toolEvents[targetIndex],
        status,
        summary: summary || toolEvents[targetIndex].summary,
        finishedAt: status === 'running' ? undefined : now,
        outputFiles: outputFiles || toolEvents[targetIndex].outputFiles,
        relatedFiles: relatedFiles || toolEvents[targetIndex].relatedFiles,
      };
      return;
    }

    toolEvents.push({
      id: coerceText(parsed.id).trim() || `tool-${toolEvents.length + 1}-${name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40)}`,
      name,
      status,
      startedAt: now,
      finishedAt: status === 'running' ? undefined : now,
      summary: summary || undefined,
      outputFiles,
      relatedFiles,
    });
  };

  const completeLatestRunningWorkflowAction = (summary: string) => {
    const targetIndex = [...toolEvents]
      .reverse()
      .findIndex((event) => event.name === 'workflow_action' && event.status === 'running');
    if (targetIndex < 0) {
      return;
    }
    const index = toolEvents.length - 1 - targetIndex;
    toolEvents[index] = {
      ...toolEvents[index],
      status: 'completed',
      summary,
      finishedAt: new Date().toISOString(),
    };
    activeToolCalls = Math.max(0, activeToolCalls - 1);
  };

  const captureConversationEvent = (parsed: Record<string, unknown> | null) => {
    if (!parsed) {
      return;
    }
    if ((parsed.type === 'token' || parsed.type === 'chunk') && (!parsed.role || parsed.role === 'assistant')) {
      const content = coerceText(parsed.content);
      if (!isLineNumberedToolOutput(content)) {
        assistantText = mergeAssistantTextChunk(assistantText, content);
      }
      return;
    }
    if (parsed.type === 'thought') {
      const content = coerceText(parsed.content).trim();
      if (content) {
        thinkingText = thinkingText ? `${thinkingText}\n${content}` : content;
      }
      return;
    }
    if (parsed.type === 'policy') {
      conversationRunPolicy = {
        ...(typeof parsed.skill === 'string' && parsed.skill.trim() ? { skill: parsed.skill.trim() } : {}),
        ...(parsed.skillVersion && typeof parsed.skillVersion === 'object'
          ? { skillVersion: parsed.skillVersion }
          : {}),
        ...(typeof parsed.requiresHitlPlan === 'boolean' ? { requiresHitlPlan: parsed.requiresHitlPlan } : {}),
        ...(typeof parsed.requiresArtifacts === 'boolean' ? { requiresArtifacts: parsed.requiresArtifacts } : {}),
        ...(typeof parsed.requiredArtifactsMode === 'string' && parsed.requiredArtifactsMode.trim()
          ? { requiredArtifactsMode: parsed.requiredArtifactsMode.trim() }
          : {}),
        ...(typeof parsed.prePlanSearchLimit === 'number' ? { prePlanSearchLimit: parsed.prePlanSearchLimit } : {}),
        ...(typeof parsed.prePlanSearchUsed === 'number' ? { prePlanSearchUsed: parsed.prePlanSearchUsed } : {}),
      };
      return;
    }
    if (parsed.type === 'progress') {
      const statusValue = coerceText(parsed.status);
      const status: RunProgressEvent['status'] | undefined = ['pending', 'running', 'completed', 'error'].includes(statusValue)
        ? (statusValue as RunProgressEvent['status'])
        : undefined;

      const nextEvent: RunProgressEvent = {
        phase: coerceText(parsed.phase),
        label: coerceText(parsed.label),
        detail: coerceText(parsed.detail) || undefined,
        status,
        stepIndex: typeof parsed.stepIndex === 'number' ? parsed.stepIndex : undefined,
        stepCount: typeof parsed.stepCount === 'number' ? parsed.stepCount : undefined,
        toolName: coerceText(parsed.toolName) || undefined,
        artifactPath: coerceText(parsed.artifactPath) || undefined,
        timestamp: coerceText(parsed.timestamp) || new Date().toISOString(),
      };

      const lastEvent = progressEvents[progressEvents.length - 1];
      const isDuplicate = lastEvent &&
        lastEvent.phase === nextEvent.phase &&
        lastEvent.label === nextEvent.label &&
        lastEvent.status === nextEvent.status &&
        lastEvent.toolName === nextEvent.toolName &&
        lastEvent.stepIndex === nextEvent.stepIndex &&
        lastEvent.stepCount === nextEvent.stepCount &&
        lastEvent.detail === nextEvent.detail &&
        lastEvent.artifactPath === nextEvent.artifactPath;

      if (!isDuplicate) {
        if (nextEvent.status === 'running') {
          progressEvents.forEach((event) => {
            if (event.status === 'running') {
              event.status = 'completed';
            }
          });
        }
        progressEvents.push(nextEvent);
        const MAX_PROGRESS_EVENTS = 80;
        if (progressEvents.length > MAX_PROGRESS_EVENTS) {
          progressEvents.splice(0, progressEvents.length - MAX_PROGRESS_EVENTS);
        }
      }
      return;
    }
    if (parsed.type === 'tool_start') {
      upsertToolEvent(parsed, 'running');
      return;
    }
    if (parsed.type === 'tool_end') {
      if (parsed.name === 'workflow_action') {
        const workflowAction = normalizeWorkflowActionEvent(parsed.content);
        if (workflowAction) {
          workflowActions.push(workflowAction);
          const MAX_WORKFLOW_ACTIONS = 80;
          if (workflowActions.length > MAX_WORKFLOW_ACTIONS) {
            workflowActions.splice(0, workflowActions.length - MAX_WORKFLOW_ACTIONS);
          }
        }
      }
      upsertToolEvent(parsed, 'completed');
      return;
    }
    if (parsed.type === 'tool_error') {
      upsertToolEvent(parsed, 'error');
    }
  };

  await updateConversationFromRun('running');

  const failIfResumedRunIsIdle = async () => {
    if (stallErrorMessage || settled) {
      return false;
    }
    if (!shouldFailResumedRunForIdle({
      resumePayload,
      sawInterruptPayload,
      activeToolCalls,
      lastRealActivityAt,
      now: Date.now(),
    })) {
      return false;
    }
    stallErrorMessage = 'Agent stalled after human clarification. No tool call, token, interrupt, or completion was emitted after the clarification response.';
    await appendStreamEvent(runId, JSON.stringify({ type: 'error', message: stallErrorMessage }));
    if (upstream && !upstream.destroyed) {
      upstream.destroy();
    }
    return true;
  };

  const finalizeRun = async (status: AgentRunStatus, error?: string) => {
    if (settled) {
      return;
    }
    settled = true;

    let effectiveStatus = status;
    let effectiveError = error;
    let completionFailureReplacesAssistantText = false;
    if (status === 'completed' || status === 'failed') {
      try {
        await commitRunArtifacts();
      } catch (artifactError) {
        effectiveStatus = 'failed';
        completionFailureReplacesAssistantText = status === 'completed';
        const artifactCommitError = `Failed to commit generated workspace files: ${
          artifactError instanceof Error ? artifactError.message : 'unknown storage error'
        }`;
        console.error(artifactCommitError, {
          runId,
          originalRunError: effectiveError,
          error: safeErrorForLog(artifactError),
        });
        if (!effectiveError?.trim()) {
          effectiveError = artifactCommitError;
        }
      }
    }

    const missingGate = getFrontendSlidesMissingRequiredGate({
      skillId,
      prompt: params.prompt,
      status: effectiveStatus,
      gateState: interactionGateState,
    });

    if (missingGate) {
      const recoveredInterrupt = normalizeInterruptPayloadRecord(
        buildFrontendSlidesGatePendingInterrupt({
          runId,
          gateId: missingGate,
          assistantText,
          params,
          toolEvents,
        }),
      );
      const pendingInterrupt = parsePendingInterrupt(JSON.stringify(recoveredInterrupt));
      const validationError = validateInterrupt(recoveredInterrupt, skillId);
      if (validationError) {
        effectiveStatus = 'failed';
        effectiveError = validationError;
      } else {
        sawInterruptPayload = recoveredInterrupt;
        hadInterrupt = true;
        clarificationInterruptCount += 1;
        await appendStreamEvent(runId, JSON.stringify(recoveredInterrupt));
        settleRunningToolEvents('awaiting_approval');
        await markRunAwaitingApproval(runId, JSON.stringify(recoveredInterrupt), params);
        if (runTelemetryService) {
          await runTelemetryService.finalizeRun(runId, {
            status: 'awaiting_approval',
            startedAt,
            skillId,
            hadInterrupt,
            approvalInterruptCount,
            clarificationInterruptCount,
            toolCallCount,
            toolErrorCount,
            metadata: {
              resumed: Boolean(resumePayload),
              interactionPendingGateId: missingGate,
              interactionGateState,
              recoveredMissingGate: true,
              ...langfuseStreamMeta,
            },
          });
        }
        await updateConversationFromRun('awaiting_approval', { pendingInterrupt });
        await cleanupRunWorker(runId, upstream || undefined);
        return;
      }
    }

    const frontendSlidesCompletionError = frontendSlidesArtifactCompletionError({
      skillId,
      prompt: params.prompt,
      status: effectiveStatus,
      gateState: interactionGateState,
    }, latestFrontendSlidesArtifactPaths);
    if (frontendSlidesCompletionError) {
      effectiveStatus = 'failed';
      effectiveError = frontendSlidesCompletionError;
      completionFailureReplacesAssistantText = status === 'completed';
    }

    const implicitInput = detectImplicitInputAwaiting({
      status: effectiveStatus,
      skillId,
      hadInterrupt: resumePayload ? Boolean(sawInterruptPayload) : hadInterrupt,
      assistantText,
    });

    if (implicitInput.awaiting) {
      const recoveredInterruptPayload = normalizeInterruptPayloadRecord({
        type: 'interrupt',
        ...buildImplicitInputPendingInterrupt({
          runId,
          skillId: implicitInput.skillId || skillId,
          prompt: implicitInput.prompt,
          interruptType: implicitInput.interruptType,
          assistantText,
        }),
      });
      const pendingInterrupt = parsePendingInterrupt(JSON.stringify(recoveredInterruptPayload));
      const validationError = validateInterrupt(recoveredInterruptPayload, implicitInput.skillId || skillId);
      if (validationError) {
        effectiveStatus = 'failed';
        effectiveError = validationError;
      } else {
        sawInterruptPayload = recoveredInterruptPayload;
        hadInterrupt = true;
        clarificationInterruptCount += 1;
        await appendStreamEvent(runId, JSON.stringify(recoveredInterruptPayload));
        settleRunningToolEvents('awaiting_approval');
        await markRunAwaitingApproval(runId, JSON.stringify(recoveredInterruptPayload), params);
        if (runTelemetryService) {
          await runTelemetryService.finalizeRun(runId, {
            status: 'awaiting_approval',
            startedAt,
            skillId: implicitInput.skillId || skillId,
            hadInterrupt,
            approvalInterruptCount,
            clarificationInterruptCount,
            toolCallCount,
            toolErrorCount,
            metadata: {
              resumed: Boolean(resumePayload),
              implicitInput,
              recoveredImplicitInput: true,
              interactionGateState,
              ...langfuseStreamMeta,
            },
          });
        }
        await updateConversationFromRun('awaiting_approval', {
          pendingInterrupt,
          implicitInput,
        });
        await cleanupRunWorker(runId, upstream || undefined);
        return;
      }
    }

    if (effectiveStatus === 'failed' && effectiveError && status !== 'failed') {
      await appendStreamEvent(runId, JSON.stringify({ type: 'error', message: effectiveError }));
    }

    settleRunningToolEvents(effectiveStatus);

    // Shadow Mode: Never emit synthetic implicit interrupts or transition run status to awaiting_approval.
    const implicitPendingInterrupt: Record<string, unknown> | undefined = undefined;

    await updateConversationFromRun(
      effectiveStatus === 'queued' ? 'running' : effectiveStatus,
      {
        ...(completionFailureReplacesAssistantText && effectiveError
          ? { assistantText: `The run did not complete: ${effectiveError}` }
          : {}),
        error: effectiveError,
        ...(implicitInput.awaiting ? { implicitInput } : {}),
      },
    );
    if (implicitPendingInterrupt) {
      const implicitInterruptPayload = {
        type: 'interrupt',
        ...(implicitPendingInterrupt as Record<string, unknown>),
      };
      await markRunAwaitingApproval(runId, JSON.stringify(implicitInterruptPayload), params);
      if (runTelemetryService) {
        await runTelemetryService.finalizeRun(runId, {
          status: 'awaiting_approval',
          startedAt,
          completedAt: new Date().toISOString(),
          error: effectiveError,
          skillId,
          hadInterrupt: true,
          approvalInterruptCount,
          clarificationInterruptCount: clarificationInterruptCount + 1,
          toolCallCount,
          toolErrorCount,
          metadata: {
            resumed: Boolean(resumePayload),
            implicitInputReason: 'missing_interrupt',
            interactionGateState,
            ...langfuseStreamMeta,
          },
        });
      }
      await cleanupRunWorker(runId, upstream || undefined);
      return;
    }
    await markRunFinished(runId, effectiveStatus, effectiveError);
    if (runTelemetryService) {
      await runTelemetryService.finalizeRun(runId, {
        status: effectiveStatus,
        startedAt,
        completedAt: new Date().toISOString(),
        error: effectiveError,
        skillId,
        hadInterrupt,
        approvalInterruptCount,
        clarificationInterruptCount,
        toolCallCount,
        toolErrorCount,
        metadata: {
          resumed: Boolean(resumePayload),
          interactionGateState,
          ...langfuseStreamMeta,
        },
      });
    }
    if (effectiveStatus === 'completed' && userMemoryService) {
      void userMemoryService
        .suggestForCompletedRun({
          runId,
          userId: params.userId,
          workspaceId: params.workspaceId,
          conversationId: params.conversationId,
        })
        .catch((memoryError) => {
          console.error('Failed to build memory suggestions for completed run', {
            runId,
            error: safeErrorForLog(memoryError),
          });
        });
    }
    if ((effectiveStatus === 'completed' || effectiveStatus === 'failed') && skillEvolutionService && params.userId && params.conversationId) {
      void skillEvolutionService
        .proposeFromRun({
          runId,
          workspaceId: params.workspaceId,
          userId: params.userId,
          conversationId: params.conversationId,
          persona: params.persona,
          status: effectiveStatus,
          skillId,
          hadInterrupt,
          toolErrorCount,
          approvalInterruptCount,
          clarificationInterruptCount,
        })
        .catch((err) => {
          console.error('Failed to build skill evolution suggestions for run', {
            runId,
            error: safeErrorForLog(err),
          });
        });
    }
    await cleanupRunWorker(runId, upstream || undefined);
  };

  const stopAtInterrupt = async (parsed: Record<string, unknown>) => {
    const normalizedInterrupt = normalizeInterruptPayloadRecord(parsed);
    const pendingGateId = extractInteractionGateId(normalizedInterrupt);
    const pendingInterrupt = parsePendingInterrupt(JSON.stringify(normalizedInterrupt));
    sawInterruptPayload = normalizedInterrupt;
    await markRunAwaitingApproval(runId, JSON.stringify(normalizedInterrupt), params);
    if (runTelemetryService) {
      void runTelemetryService.finalizeRun(runId, {
        status: 'awaiting_approval',
        startedAt,
        skillId,
        hadInterrupt,
        approvalInterruptCount,
        clarificationInterruptCount,
        toolCallCount,
        toolErrorCount,
        metadata: {
          resumed: Boolean(resumePayload),
          interactionPendingGateId: pendingGateId,
          interactionGateState,
          ...langfuseStreamMeta,
        },
      }).catch((telemetryError) => {
        console.error('Failed to finalize interrupted agent run telemetry', {
          runId,
          error: safeErrorForLog(telemetryError),
        });
      });
    }
    await updateConversationFromRun('awaiting_approval', { pendingInterrupt });
  };

  const publishDeferredInterrupt = async (interruptPayload: Record<string, unknown>) => {
    if (interruptPublished) {
      return;
    }
    interruptPublished = true;
    // Finish all lease-protected workspace work before the interrupt becomes
    // visible. getRunMeta() can recover a visible interrupt by transitioning
    // the run to awaiting_approval, which intentionally invalidates the lease.
    await commitRunArtifacts();
    if (interruptPayload.interactionRequest) {
      const interactionChunk = {
        type: 'interaction' as const,
        message: interruptPayload.interactionRequest,
        interactionId: (interruptPayload.interactionRequest as any).interactionId,
        runId,
      };
      await appendStreamEvent(runId, JSON.stringify(interactionChunk));
    }
    await appendStreamEvent(runId, JSON.stringify(normalizeInterruptPayloadRecord(interruptPayload)));
    await appendStreamEvent(runId, JSON.stringify({ type: 'done', status: 'interrupted' }));
    await stopAtInterrupt(interruptPayload);
  };

  const processParsedLine = async (line: string): Promise<'continue' | 'stop'> => {
    const rawParsed = parseLine(line);
    const parsed = rawParsed
      ? safeTelemetryForPersistence(rawParsed) as Record<string, unknown>
      : null;
    captureConversationEvent(parsed);
    latestFrontendSlidesArtifactPaths = mergeFrontendSlidesArtifactPaths(
      latestFrontendSlidesArtifactPaths,
      extractFrontendSlidesArtifactPaths(parsed),
    );
    if (isRealRunProgressEvent(parsed)) {
      lastRealActivityAt = Date.now();
    }
    if (parsed?.type === 'langfuse') {
      const traceId = typeof parsed.traceId === 'string' ? parsed.traceId.trim() : '';
      const traceUrl = typeof parsed.traceUrl === 'string' ? parsed.traceUrl.trim() : '';
      if (traceId) {
        langfuseStreamMeta.langfuseTraceId = traceId;
      }
      if (traceUrl) {
        langfuseStreamMeta.langfuseTraceUrl = traceUrl;
      }
    }
    if (parsed?.type === 'policy' && typeof parsed.skill === 'string' && parsed.skill.trim()) {
      skillId = parsed.skill.trim();
    }
    if (parsed?.type === 'interaction_consumed' && resumePayload && 'response' in resumePayload) {
      await persistMeta(runId, {
        interactionResponseConsumedAt: new Date().toISOString(),
      });
    }
    let eventToAppend = parsed;
    if (parsed?.type === 'interrupt') {
      const inferredGateId = isFrontendSlidesRun(skillId, params)
        ? inferFrontendSlidesGateIdFromInteraction(parsed)
        : undefined;
      const explicitGateId = extractInteractionGateId(parsed);
      const frontendSlidesGateId = isFrontendSlidesGateId(explicitGateId)
        ? explicitGateId
        : inferredGateId;
      let interruptPayload = frontendSlidesGateId
        ? withFrontendSlidesGateMetadata(parsed, frontendSlidesGateId, {
            stylePreviewPaths: findGeneratedFrontendSlidesPreviewPaths(toolEvents),
          })
        : parsed;
      eventToAppend = interruptPayload;
      const interruptDisplayPayload = extractDisplayPayload(interruptPayload);
      if (!skillId && typeof interruptDisplayPayload?.skill === 'string' && interruptDisplayPayload.skill.trim()) {
        skillId = interruptDisplayPayload.skill.trim();
      }
      const completedGateId = extractInteractionGateId(interruptPayload);
      if (isCompletedFrontendSlidesGateInterrupt(interruptPayload, interactionGateState)) {
        completeLatestRunningWorkflowAction(`Skipped completed frontend-slides gate replay: ${completedGateId || 'unknown gate'}.`);
        await appendStreamEvent(runId, JSON.stringify({
          type: 'interaction_gate_skipped',
          gateId: completedGateId,
          reason: 'completed_gate_interrupt_ignored',
        }));
        return 'continue';
      }
      if (isFrontendSlidesRun(skillId, params) && !isFrontendSlidesEditExistingRun(params)) {
        const nextRequiredGateId = nextMissingFrontendSlidesGate(interactionGateState);
        if (nextRequiredGateId && frontendSlidesGateId !== nextRequiredGateId) {
          completeLatestRunningWorkflowAction(
            `Recovered frontend-slides gate order: expected ${nextRequiredGateId}, got ${frontendSlidesGateId || interruptPayload.kind || 'interrupt'}.`,
          );
          await appendStreamEvent(runId, JSON.stringify({
            type: 'interaction_gate_recovered',
            expectedGateId: nextRequiredGateId,
            receivedGateId: frontendSlidesGateId || null,
            receivedInterruptKind: typeof interruptPayload.kind === 'string' ? interruptPayload.kind : null,
            reason: frontendSlidesGateId ? 'out_of_order_gate_interrupt' : 'missing_required_gate_before_interrupt',
          }));
          interruptPayload = normalizeInterruptPayloadRecord(
            buildFrontendSlidesGatePendingInterrupt({
              runId,
              gateId: nextRequiredGateId,
              assistantText,
              params,
              toolEvents,
            }),
          );
          eventToAppend = interruptPayload;
        }
      }
      if (isRepeatedClarificationInterrupt(interruptPayload, previousInterrupt, resumePayload)) {
        loopErrorMessage = 'Clarification response was not consumed. The same clarification was emitted again.';
        const errorPayload = JSON.stringify({ type: 'error', message: loopErrorMessage });
        await appendStreamEvent(runId, errorPayload);
        if (upstream && !upstream.destroyed) {
          upstream.destroy();
        }
        return 'stop';
      }
      const err = validateInterrupt(interruptPayload, skillId);
      if (err) {
        contractErrorMessage = err;
        sawInterruptPayload = null;
        const errorPayload = JSON.stringify({ type: 'error', message: err });
        await appendStreamEvent(runId, errorPayload);
        if (upstream && !upstream.destroyed) {
          upstream.destroy();
        }
        return 'stop';
      }
      hadInterrupt = true;
      if (interruptPayload.kind === 'approval') {
        approvalInterruptCount += 1;
      } else if (interruptPayload.kind === 'clarification') {
        clarificationInterruptCount += 1;
      }
    }
    if (parsed?.type === 'tool_start' || parsed?.type === 'tool_end' || parsed?.type === 'tool_error') {
      let repeatedSkillSandboxFailure = '';
      if (parsed.type === 'tool_start') {
        activeToolCalls += 1;
        toolCallCount += 1;
        if (parsed.name === 'load_skill' && typeof parsed.content === 'string') {
          const skillMatch = parsed.content.match(/skill[_-]?id["']?\s*[:=]\s*["']([^"']+)["']/i);
          if (skillMatch?.[1]) {
            skillId = skillMatch[1].trim();
          }
        }
      }
      if (parsed.type === 'tool_error') {
        activeToolCalls = Math.max(0, activeToolCalls - 1);
        toolErrorCount += 1;
        if (parsed.name === 'run_skill_python_script') {
          const signature = `${coerceText(parsed.name).trim()}\u0000${coerceText(parsed.content).trim()}`;
          const failureCount = (skillSandboxFailureCounts.get(signature) || 0) + 1;
          skillSandboxFailureCounts.set(signature, failureCount);
          if (failureCount >= 2) {
            repeatedSkillSandboxFailure =
              'Agent stopped because the skill sandbox returned the same terminal error twice. Retrying the same request cannot succeed.';
          }
        }
      }
      if (parsed.type === 'tool_end') {
        activeToolCalls = Math.max(0, activeToolCalls - 1);
      }
      eventIndex += 1;
      if (runTelemetryService && typeof parsed.name === 'string' && parsed.name.trim()) {
        try {
          await runTelemetryService.appendToolEvent({
            runId,
            workspaceId: params.workspaceId,
            userId: params.userId,
            conversationId: params.conversationId,
            turnId: params.turnId,
            eventIndex,
            toolName: parsed.name.trim(),
            eventType:
              parsed.type === 'tool_start'
                ? 'start'
                : parsed.type === 'tool_end'
                  ? 'end'
                  : 'error',
            summary: typeof parsed.content === 'string' ? parsed.content : undefined,
            outputFiles: parsed.outputFiles,
            payload: parsed,
            eventAt: new Date().toISOString(),
          });
        } catch (telemetryError) {
          console.error('Failed to append agent run tool event', {
            runId,
            eventIndex,
            error: safeErrorForLog(telemetryError),
          });
        }
      }
      if (repeatedSkillSandboxFailure) {
        loopErrorMessage = repeatedSkillSandboxFailure;
        await appendStreamEvent(
          runId,
          JSON.stringify(normalizeInterruptPayloadRecord(parsed)),
        );
        await appendStreamEvent(runId, JSON.stringify({ type: 'error', message: loopErrorMessage }));
        if (upstream && !upstream.destroyed) {
          upstream.destroy();
        }
        return 'stop';
      }
    }
    if (parsed?.type === 'tool_end' && parsed.name === 'workflow_action') {
      const workflowAction = normalizeWorkflowActionEvent(parsed.content);
      if (workflowAction) {
        await appendStreamEvent(runId, JSON.stringify({ type: 'workflow_action', ...workflowAction }));
      }
    }
    const terminalEvent = terminalEventFromStreamPayload(parsed);
    const missingGateBeforeTerminal = terminalEvent?.status === 'completed'
      ? getFrontendSlidesMissingRequiredGate({
          skillId,
          prompt: params.prompt,
          status: 'completed',
          gateState: interactionGateState,
        })
      : null;
    if (missingGateBeforeTerminal) {
      return 'continue';
    }
    const completionErrorBeforeTerminal = terminalEvent?.status === 'completed'
      ? frontendSlidesArtifactCompletionError({
          skillId,
          prompt: params.prompt,
          status: 'completed',
          gateState: interactionGateState,
        }, latestFrontendSlidesArtifactPaths)
      : null;
    if (completionErrorBeforeTerminal) {
      contractErrorMessage = completionErrorBeforeTerminal;
      return 'continue';
    }
    if (eventToAppend?.type === 'interrupt') {
      // Do not expose the approval gate until the agent HTTP stream has
      // finished. Closing the upstream response as soon as the interrupt
      // arrives can cancel FastAPI's streaming generator before LangGraph's
      // checkpoint is fully committed, leaving an approval that cannot be
      // resumed.
      sawInterruptPayload = normalizeInterruptPayloadRecord(eventToAppend);
      console.info('[AgentInterrupt] deferred until upstream drain', {
        runId,
        interruptId: coerceText(eventToAppend.interruptId).trim() || undefined,
        kind: coerceText(eventToAppend.kind).trim() || undefined,
      });
      return 'continue';
    }
    if (
      sawInterruptPayload
      && parsed?.type === 'done'
      && coerceText(parsed.status).trim() === 'interrupted'
    ) {
      // publishDeferredInterrupt emits the terminal marker after the upstream
      // stream has drained, keeping the interrupt and its resumable checkpoint
      // on the same side of the HTTP lifecycle boundary.
      return 'continue';
    }
    await appendStreamEvent(runId, eventToAppend ? JSON.stringify(normalizeInterruptPayloadRecord(eventToAppend)) : line);
    if (parsed?.type === 'error' || (parsed?.type === 'done' && terminalEvent?.status === 'failed')) {
      // Keep the first upstream cause. Later transport aborts must not replace it.
      // `contract_error` is deliberately excluded: it stays below user cancellation.
      const upstreamError = parsed?.type === 'error'
        ? coerceText(parsed.message || parsed.error).trim()
        : coerceText(terminalEvent?.error).trim();
      if (upstreamError && !streamErrorMessage) {
        streamErrorMessage = upstreamError;
      }
    }
    if (parsed?.type === 'contract_error') {
      contractErrorMessage =
        typeof parsed.message === 'string' && parsed.message.trim()
          ? parsed.message
          : 'Artifact contract validation failed.';
    }
    if (parsed?.type === 'keepalive' && await failIfResumedRunIsIdle()) {
      return 'stop';
    }
    return 'continue';
  };

  const processBuffer = async () => {
    try {
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          const action = await processParsedLine(line);
          if (action === 'stop') {
            break;
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    } catch (error) {
      console.error('Failed to process agent run chunk', safeErrorForLog(error));
    }
  };

  const enqueueProcessBuffer = () => {
    processingQueue = processingQueue.then(() => processBuffer());
    return processingQueue;
  };

  const processTailBuffer = async () => {
    const tail = buffer;
    buffer = '';
    const lines = tail
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      const action = await processParsedLine(line);
      if (action === 'stop') {
        break;
      }
    }
  };

  traceContext.skillId = skillId || undefined;

  try {
    if (fileService && params.userId) {
      artifactBaseline = await fileService.captureWorkspaceArtifactBaseline(
        params.workspaceId,
        params.userId,
      );
    }
    const response =
      resumePayload && 'decisions' in resumePayload && resumePayload.decisions
      ? await agentStreamClient.resumeAgentStream(params.persona, params.workspaceId, resumePayload.decisions, {
          signal: controller.signal,
          authToken: params.authToken,
          traceContext,
          interruptId: resumePayload.interruptId,
          originalPrompt: params.prompt,
        })
      : resumePayload && 'response' in resumePayload && resumePayload.response
      ? await agentStreamClient.resumeAgentResponseStream(params.persona, params.workspaceId, resumePayload.response, {
          signal: controller.signal,
          authToken: params.authToken,
          traceContext,
          interruptId: resumePayload.interruptId,
        })
      : resumePayload && 'action' in resumePayload && resumePayload.action
      ? await agentStreamClient.resumeAgentActionStream(params.persona, params.workspaceId, resumePayload.action, {
          signal: controller.signal,
          authToken: params.authToken,
          traceContext,
        })
      : await agentStreamClient.runAgentStream(params.persona, params.workspaceId, params.prompt, params.history, {
          forceReset: params.forceReset,
          signal: controller.signal,
          authToken: params.authToken,
          messageContent: params.messageContent,
          internetSearchEnabled: params.internetSearchEnabled,
          knowledgeRefs: params.knowledgeRefs,
          traceContext,
        });
    agentStreamEstablished = true;
    upstream = response.data;
    upstream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (DEBUG_AGENT_RUN_STREAM) {
        console.info('[agent-run-stream] chunk', { runId, bytes: chunk.length });
      }
      void enqueueProcessBuffer();
    });
    await new Promise<void>((resolve, reject) => {
      let terminalHandled = false;
      const handleTerminal = (handler: () => Promise<void>) => {
        if (terminalHandled) return;
        terminalHandled = true;
        void handler().then(resolve, reject);
      };
      upstream!.once('end', () => handleTerminal(async () => {
        if (DEBUG_AGENT_RUN_STREAM) {
          console.info('[agent-run-stream] end', { runId, remainingBytes: buffer.length });
        }
        await processingQueue;
        if (buffer.trim()) await processTailBuffer();

        if (sawInterruptPayload) {
          console.info('[AgentInterrupt] upstream drained with deferred interrupt', { runId });
        }
        const disposition = resolveStreamCloseDisposition({
          sawInterruptPayload,
          loopErrorMessage,
          stallErrorMessage,
          streamErrorMessage,
          aborted: controller.signal.aborted,
          contractErrorMessage,
        });
        if (disposition.preserveInterrupt && sawInterruptPayload) {
          await publishDeferredInterrupt(sawInterruptPayload);
          return;
        }
        await finalizeRun(disposition.status, disposition.error);
      }));
      upstream!.once('error', (error: Error) => handleTerminal(async () => {
        const disposition = resolveStreamCloseDisposition({
          sawInterruptPayload,
          loopErrorMessage,
          stallErrorMessage,
          streamErrorMessage,
          aborted: controller.signal.aborted,
        });
        if (disposition.preserveInterrupt && sawInterruptPayload) {
          await publishDeferredInterrupt(sawInterruptPayload);
          return;
        }
        if (disposition.status !== 'completed') {
          await finalizeRun(disposition.status, disposition.error);
          return;
        }
        const status: AgentRunStatus = controller.signal.aborted ? 'cancelled' : 'failed';
        if (!controller.signal.aborted) {
          const errorPayload = JSON.stringify({ type: 'error', message: error.message || 'Agent stream failed.' });
          await appendStreamEvent(runId, errorPayload);
        }
        await finalizeRun(status, error.message);
      }));
      const handlePrematureClose = (reason: string) => handleTerminal(async () => {
        const status: AgentRunStatus = controller.signal.aborted ? 'cancelled' : 'failed';
        const message = controller.signal.aborted ? undefined : `Agent stream ${reason} before completion`;
        if (message) await appendStreamEvent(runId, JSON.stringify({ type: 'error', message }));
        await finalizeRun(status, message);
      });
      upstream!.once('aborted', () => handlePrematureClose('aborted'));
      upstream!.once('close', () => {
        if (!upstream!.complete && !upstream!.readableEnded) handlePrematureClose('closed');
      });
    });
  } catch (error: any) {
    const status: AgentRunStatus = streamErrorMessage
      ? 'failed'
      : controller.signal.aborted
        ? 'cancelled'
        : 'failed';
    const failureMessage = streamErrorMessage || buildAgentErrorPayload(error, params.persona);
    if (!controller.signal.aborted && !streamErrorMessage) {
      const message = buildAgentErrorPayload(error, params.persona);
      const errorPayload = JSON.stringify({ type: 'error', message });
      await appendStreamEvent(runId, errorPayload);
    }
    if (settled) {
      await markRunFinished(runId, status, failureMessage);
    } else {
      await finalizeRun(status, failureMessage);
    }
  } finally {
    await cleanupRunWorker(runId, upstream || undefined);
  }
}

function launchAgentRunWorker(
  runId: string,
  params: StartRunParams,
  resumePayload?: ResumePayload,
  previousInterrupt?: RunPendingInterrupt,
) {
  void runAgentRunWorker(runId, params, resumePayload, previousInterrupt).catch(async (error) => {
    console.error('Agent run worker failed before stream ownership was established', safeErrorForLog(error));
    try {
      const status = await redisClient.hGet(buildMetaKey(runId), 'status');
      if (!status || !['completed', 'failed', 'cancelled', 'awaiting_approval'].includes(status)) {
        const message = error instanceof Error ? error.message : 'Agent run worker failed';
        await appendStreamEvent(runId, JSON.stringify({ type: 'error', message }));
        await markRunFinished(runId, 'failed', message);
      }
    } catch (persistError) {
      console.error('Failed to persist agent run worker failure', safeErrorForLog(persistError));
    } finally {
      await cleanupRunWorker(runId);
    }
  });
}

export async function resumeAgentRun(
  runId: string,
  decisions: AgentDecision[],
  options?: { authToken?: string; interruptId?: string },
): Promise<{ runId: string; status: AgentRunStatus; streamAfterId?: string }> {
  const context = await loadRunContext(runId);
  if (!context) {
    throw new Error('Run context not found. Start a new run.');
  }
  const nextParams = options?.authToken ? { ...context.params, authToken: options.authToken } : context.params;
  runContexts.set(runId, { params: nextParams });
  const acceptedAt = new Date().toISOString();
  const streamAfterId = await appendStreamEvent(runId, JSON.stringify({
    type: 'interaction_response_accepted',
    interruptId: options?.interruptId,
    acceptedAt,
  }));
  await appendStreamEvent(runId, JSON.stringify({
    type: 'progress',
    phase: 'routing',
    label: 'Response received',
    detail: 'Continuing with your decision.',
    status: 'running',
    timestamp: acceptedAt,
  }));
  await persistMeta(runId, {
    status: 'queued',
    startedAt: acceptedAt,
    error: '',
    pendingInterrupt: '',
    runContext: serializeRunContext(nextParams),
  });
  launchAgentRunWorker(runId, nextParams, {
    decisions,
    interruptId: options?.interruptId,
  });
  return { runId, status: 'queued', streamAfterId };
}

export async function resumeAgentRunWithResponse(
  runId: string,
  response: AgentInterruptResponse,
  options?: { authToken?: string; previousInterrupt?: RunPendingInterrupt },
): Promise<{ runId: string; status: AgentRunStatus; streamAfterId?: string }> {
  const context = await loadRunContext(runId);
  if (!context) {
    throw new Error('Run context not found. Start a new run.');
  }
  const baseParams = options?.authToken ? { ...context.params, authToken: options.authToken } : context.params;
  const previousInterruptIsSynthetic = isSyntheticClarificationInterrupt(options?.previousInterrupt);
  const currentMeta = await getRunMeta(runId);
  const previousGateId = extractInteractionGateIdFromPendingInterrupt(options?.previousInterrupt);
  const nextGateState = completeInteractionGate(
    currentMeta?.interactionGateState || { completedGateIds: [] },
    previousGateId,
  );
  const nextParams = previousInterruptIsSynthetic
    ? buildSyntheticResumeParams(
        baseParams,
        response,
        options?.previousInterrupt,
        nextGateState,
      )
    : baseParams;
  const interruptId = options?.previousInterrupt?.interruptId?.trim() || '';
  const enrichedResponse = enrichClarificationResponseWithChoiceIdentity(response, options?.previousInterrupt);
  const serializedResponse = JSON.stringify(enrichedResponse);
  const responseHash = createHash('sha256').update(serializedResponse).digest('hex');
  const acceptedAt = new Date().toISOString();
  runContexts.set(runId, { params: nextParams });
  const streamAfterId = await appendStreamEvent(runId, JSON.stringify({
    type: 'interaction_response_accepted',
    interruptId: interruptId || undefined,
    responseHash,
    acceptedAt,
  }));
  await appendStreamEvent(runId, JSON.stringify({
    type: 'progress',
    phase: 'routing',
    label: 'Response received',
    detail: 'Continuing with your selection.',
    status: 'running',
    timestamp: acceptedAt,
  }));
  await persistMeta(runId, {
    status: 'queued',
    startedAt: acceptedAt,
    error: '',
    pendingInterrupt: '',
    interactionGateState: JSON.stringify(nextGateState),
    runContext: serializeRunContext(nextParams),
    interactionResponse: serializedResponse,
    interactionResponseHash: responseHash,
    interactionResponseInterruptId: interruptId,
    interactionResponseAcceptedAt: acceptedAt,
    interactionResponseConsumedAt: '',
  });
  launchAgentRunWorker(
    runId,
    nextParams,
    previousInterruptIsSynthetic ? undefined : { response: enrichedResponse, interruptId: interruptId || undefined },
    options?.previousInterrupt,
  );
  return { runId, status: 'queued', streamAfterId };
}

export async function resumeAgentRunWithAction(
  runId: string,
  action: AgentInterruptActionResponse,
  options?: { authToken?: string },
): Promise<{ runId: string; status: AgentRunStatus; streamAfterId?: string }> {
  const context = await loadRunContext(runId);
  if (!context) {
    throw new Error('Run context not found. Start a new run.');
  }
  const nextParams = options?.authToken ? { ...context.params, authToken: options.authToken } : context.params;
  runContexts.set(runId, { params: nextParams });
  const acceptedAt = new Date().toISOString();
  const streamAfterId = await appendStreamEvent(runId, JSON.stringify({
    type: 'interaction_response_accepted',
    actionId: action.action.id,
    acceptedAt,
  }));
  await appendStreamEvent(runId, JSON.stringify({
    type: 'progress',
    phase: 'routing',
    label: 'Response received',
    detail: 'Continuing with your action.',
    status: 'running',
    timestamp: acceptedAt,
  }));
  await persistMeta(runId, {
    status: 'queued',
    startedAt: acceptedAt,
    error: '',
    pendingInterrupt: '',
    runContext: serializeRunContext(nextParams),
  });
  launchAgentRunWorker(runId, nextParams, { action });
  return { runId, status: 'queued', streamAfterId };
}

export async function cancelAgentRun(runId: string) {
  const controller = runAbortControllers.get(runId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
  const context = await loadRunContext(runId);
  if (context?.params) {
    await persistRunConversationMessage(runId, context.params, 'cancelled');
  }
  await markRunFinished(runId, 'cancelled');
}

const isFrontendSlidesContextRun = (context: RunContext | undefined): boolean => (
  Boolean(context?.params && isFrontendSlidesRun(null, context.params))
);

const buildStaleRunErrorMessage = (
  context: RunContext | undefined,
  interactionGateState: InteractionGateState,
): string => {
  if (isFrontendSlidesContextRun(context) && hasCompletedAllFrontendSlidesGates(interactionGateState)) {
    return 'Agent stalled after all frontend-slides gates completed before producing the final HTML deck. Please retry the deck generation.';
  }
  return 'Agent run stalled without a terminal event. Please retry the run.';
};

const abortActiveRunWorker = async (runId: string) => {
  const controller = runAbortControllers.get(runId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
  await cleanupRunWorker(runId);
};

const reconcileActiveRunMetaFromStream = async (
  runId: string,
  meta: Record<string, string>,
  interactionGateState: InteractionGateState,
) => {
  if ((meta.status !== 'running' && meta.status !== 'queued') || meta.pendingInterrupt?.trim()) {
    return;
  }
  // The live worker owns status transitions while it is draining the upstream
  // stream and committing files. Stream recovery is only for orphaned runs;
  // reconciling a live run can expose a gate and invalidate its workspace lease
  // before its artifacts have finished committing.
  if (runAbortControllers.has(runId)) {
    return;
  }

  const inspection = await inspectRunStreamForRecovery(runId, meta.startedAt || meta.createdAt);
  const context = await loadRunContext(runId);
  const latestInterrupt = inspection.latestInterruptPayload;
  const recoveredGateId = latestInterrupt ? extractInteractionGateId(latestInterrupt) : undefined;
  const recoveredGateIsComplete = Boolean(
    recoveredGateId && interactionGateState.completedGateIds.includes(recoveredGateId),
  );

  const recoveredFrontendSlidesArtifactPaths = inspection.latestFrontendSlidesArtifactPaths || {};
  const canCompleteFromDeckArtifact =
    isFrontendSlidesContextRun(context) && hasAllRequiredFrontendSlidesArtifacts(recoveredFrontendSlidesArtifactPaths);

  if (!canCompleteFromDeckArtifact && latestInterrupt && !recoveredGateIsComplete) {
    await markRunAwaitingApproval(runId, JSON.stringify(latestInterrupt), context?.params);
    meta.status = 'awaiting_approval';
    meta.pendingInterrupt = JSON.stringify(latestInterrupt);
    meta.error = '';
    return;
  }

  const terminalEvent = canCompleteFromDeckArtifact
    ? { status: 'completed' as AgentRunStatus }
    : inspection.latestTerminalEvent;

  const missingCompletionGate = context?.params
    ? getFrontendSlidesMissingRequiredGate({
        skillId: null,
        prompt: context.params.prompt,
        status: 'completed',
        gateState: interactionGateState,
      })
    : null;
  if (terminalEvent?.status === 'completed' && missingCompletionGate) {
    const recoveredInterrupt = normalizeInterruptPayloadRecord(
      buildFrontendSlidesGatePendingInterrupt({
        runId,
        gateId: missingCompletionGate,
        params: context?.params,
      }),
    );
    const validationError = validateInterrupt(recoveredInterrupt, 'frontend-slides');
    if (validationError) {
      const completedAt = await markRunFinished(runId, 'failed', validationError);
      meta.status = 'failed';
      meta.completedAt = completedAt;
      meta.error = validationError;
      meta.pendingInterrupt = '';
      return;
    }
    await appendStreamEvent(runId, JSON.stringify(recoveredInterrupt));
    await markRunAwaitingApproval(runId, JSON.stringify(recoveredInterrupt), context?.params);
    meta.status = 'awaiting_approval';
    meta.pendingInterrupt = JSON.stringify(recoveredInterrupt);
    meta.error = '';
    return;
  }

  if (terminalEvent) {
    const completedAt = await markRunFinished(runId, terminalEvent.status, terminalEvent.error);
    if (context?.params) {
      await persistRunConversationMessage(runId, context.params, terminalEvent.status === 'queued' ? 'running' : terminalEvent.status, {
        assistantText: inspection.assistantText,
        error: terminalEvent.error,
      });
    }
    if (canCompleteFromDeckArtifact && inspection.latestTerminalEvent?.status !== 'completed') {
      await appendStreamEvent(runId, JSON.stringify({
        type: 'done',
        status: 'completed',
        recovered: true,
        artifactPath: firstFrontendSlidesArtifactPath(recoveredFrontendSlidesArtifactPaths),
        outputFiles: Object.entries(recoveredFrontendSlidesArtifactPaths).map(([artifactId, artifactPath]) => ({
          artifactId,
          path: artifactPath,
        })),
      }));
    }
    await cleanupRunWorker(runId);
    meta.status = terminalEvent.status;
    meta.completedAt = completedAt;
    meta.error = terminalEvent.error || '';
    meta.pendingInterrupt = '';
    return;
  }

  const fallbackStartedAt = Number.isFinite(Date.parse(meta.startedAt || meta.createdAt || ''))
    ? Date.parse(meta.startedAt || meta.createdAt || '')
    : undefined;
  const lastActivityAt = inspection.latestRealActivityAt || inspection.latestEntryAt || fallbackStartedAt;
  if (!shouldFailRunningRunForStaleActivity({
    status: meta.status,
    lastActivityAt,
    now: Date.now(),
  })) {
    return;
  }

  const error = buildStaleRunErrorMessage(context, interactionGateState);
  await appendStreamEvent(runId, JSON.stringify({ type: 'error', message: error, recovered: true }));
  await appendStreamEvent(runId, JSON.stringify({ type: 'done', status: 'failed', recovered: true }));
  const completedAt = await markRunFinished(runId, 'failed', error);
  if (context?.params) {
    await persistRunConversationMessage(runId, context.params, 'failed', {
      assistantText: inspection.assistantText,
      error,
    });
  }
  await abortActiveRunWorker(runId);
  meta.status = 'failed';
  meta.completedAt = completedAt;
  meta.error = error;
  meta.pendingInterrupt = '';
};

export async function getRunMeta(runId: string): Promise<RunMeta | null> {
  const metaKey = buildMetaKey(runId);
  const meta = await redisClient.hGetAll(metaKey);
  if (!Object.keys(meta).length) {
    return null;
  }
  const interactionGateState = parseInteractionGateState(meta.interactionGateState);
  await reconcileActiveRunMetaFromStream(runId, meta, interactionGateState);
  return {
    workspaceId: meta.workspaceId,
    userId: meta.userId,
    persona: meta.persona,
    status: (meta.status as AgentRunStatus) || 'queued',
    createdAt: meta.createdAt,
    startedAt: meta.startedAt,
    completedAt: meta.completedAt,
    error: meta.error,
    turnId: meta.turnId,
    pendingInterrupt: parsePendingInterrupt(meta.pendingInterrupt),
    interactionGateState,
    interactionResponseInterruptId: meta.interactionResponseInterruptId,
    interactionResponseAcceptedAt: meta.interactionResponseAcceptedAt,
    interactionResponseConsumedAt: meta.interactionResponseConsumedAt,
  };
}

export const getRunStreamKey = buildStreamKey;
