import { createHash, randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import { redisClient } from '../redisService';
import { RunTelemetryService } from '../runTelemetryService';
import { UserMemoryService } from '../userMemoryService';
import type { SkillEvolutionService } from '../skillEvolutionService';
import type { ConversationService } from '../conversationService';
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
} from '../agentService';
import type { ConversationMessageMetadata, FileContextRef, ToolEvent, ToolOutputFile } from '@helpudoc/contracts/types';

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
  fileContextRefs?: FileContextRef[];
  messageContent?: AgentMessageContentBlock[];
  internetSearchEnabled?: boolean;
};

type RunPendingInterrupt = {
  kind?: 'approval' | 'clarification';
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
};

type RunMeta = {
  workspaceId: string;
  persona: string;
  status: AgentRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  turnId?: string;
  pendingInterrupt?: RunPendingInterrupt;
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
  fileContextRefs?: FileContextRef[];
  messageContent?: AgentMessageContentBlock[];
  internetSearchEnabled?: boolean;
};

type ResumePayload =
  | { decisions: AgentDecision[]; response?: never }
  | { response: AgentInterruptResponse; decisions?: never }
  | { action: AgentInterruptActionResponse; decisions?: never; response?: never };

type PersistedRunMeta = Omit<RunMeta, 'pendingInterrupt'> & {
  pendingInterrupt?: string;
  runContext?: string;
};

const STREAM_TTL_SECONDS = 60 * 60 * 24; // 24h
const DEFAULT_RESUMED_RUN_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const RESUMED_RUN_IDLE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AGENT_RESUME_IDLE_TIMEOUT_MS || '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RESUMED_RUN_IDLE_TIMEOUT_MS;
})();
const DEBUG_AGENT_RUN_STREAM =
  process.env.DEBUG_AGENT_RUN_STREAM === '1' || process.env.DEBUG_AGENT_RUN_STREAM === 'true';

const runAbortControllers = new Map<string, AbortController>();
const runContexts = new Map<string, RunContext>();
let runTelemetryService: RunTelemetryService | null = null;
let userMemoryService: UserMemoryService | null = null;
let skillEvolutionService: SkillEvolutionService | null = null;
let conversationService: ConversationService | null = null;

export function configureAgentRunServices(services: {
  telemetryService?: RunTelemetryService | null;
  userMemoryService?: UserMemoryService | null;
  skillEvolutionService?: SkillEvolutionService | null;
  conversationService?: ConversationService | null;
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
}

const buildStreamKey = (runId: string) => `agent:run:${runId}`;
const buildMetaKey = (runId: string) => `agent:run:${runId}:meta`;
const buildRunDedupeKey = (workspaceId: string, persona: string, turnId: string) =>
  `agent:run:key:${workspaceId}:${persona}:${turnId}`;

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

const normalizeInterruptPayloadRecord = (payload: Record<string, unknown>): Record<string, unknown> => {
  if (payload.type !== 'interrupt') {
    return payload;
  }
  const interruptId =
    typeof payload.interruptId === 'string' && payload.interruptId.trim()
      ? payload.interruptId.trim()
      : buildInterruptId(payload);
  if (payload.interruptId === interruptId) {
    return payload;
  }
  return {
    ...payload,
    interruptId,
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
  if (!line.trim()) return;
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
  } catch (error) {
    console.error('[agent-run-stream] failed to append', { runId, streamKey, error });
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
      error,
    });
  }
};

const buildAgentErrorPayload = (error: any, persona: string): string => {
  if (error?.response?.status === 404) {
    return `Agent '${persona}' not found.`;
  }
  if (typeof error?.response?.data?.error === 'string') {
    return error.response.data.error;
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
  /\b(?:select|choose)\b.{0,40}\b(?:form|options?|UI)\b/i,
  /\b(?:once|after)\s+(?:confirmed|you\s+confirm)/i,
  /\bnext\s+steps\b.{0,120}\b(?:sidebar|form)/i,
];

const SELECTION_PROMPT_PATTERNS = [
  /\b(?:please\s+)?select\b/i,
  /\b(?:please\s+)?choose\b/i,
  /\bwhich\s+(?:one|option|style|mood|vibe)/i,
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
  /\b(?:from|in|using|via)\s+the\s+(?:form|options?|UI)\s+(?:above|below)/i,
  /\b(?:forms?|options?|choices?)\s+in\s+the\s+sidebar/i,
  /\buse\s+the\s+(?:forms?|options?|choices?)\s+(?:in\s+the\s+sidebar|below|above)/i,
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
}): { awaiting: boolean; prompt?: string } => {
  if (opts.status !== 'completed' || !opts.skillId || opts.hadInterrupt) {
    return { awaiting: false };
  }

  const text = (opts.assistantText || '').trim();
  if (!text) {
    return { awaiting: false };
  }

  const lastParagraphs = text.slice(-1500);
  const signals = collectImplicitInputSignals(lastParagraphs);

  if (!shouldAwaitImplicitInput(signals)) {
    return { awaiting: false };
  }

  const promptMatch = lastParagraphs.match(/[^.!?\n]*\?\s*$/);
  const sidebarPromptMatch = lastParagraphs.match(/Please use the\s+.+?(?:\n\s*\d+\.\s+.+)+/is);
  const prompt = promptMatch
    ? promptMatch[0].trim()
    : sidebarPromptMatch
      ? sidebarPromptMatch[0].trim()
      : undefined;

  return { awaiting: true, prompt };
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
    fileContextRefs: params.fileContextRefs,
    messageContent: params.messageContent,
    internetSearchEnabled: params.internetSearchEnabled,
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
        fileContextRefs: Array.isArray(parsed.fileContextRefs) ? parsed.fileContextRefs as FileContextRef[] : undefined,
        messageContent: Array.isArray(parsed.messageContent) ? parsed.messageContent as AgentMessageContentBlock[] : undefined,
        internetSearchEnabled: typeof parsed.internetSearchEnabled === 'boolean' ? parsed.internetSearchEnabled : undefined,
      },
    };
  } catch {
    return undefined;
  }
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

const markRunFinished = async (runId: string, status: AgentRunStatus, error?: string) => {
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
};

const markRunAwaitingApproval = async (runId: string, interruptPayload: string) => {
  await persistMeta(runId, {
    status: 'awaiting_approval',
    pendingInterrupt: interruptPayload,
    error: '',
  });
};

export async function startAgentRun(params: StartRunParams): Promise<{ runId: string; status: AgentRunStatus }> {
  if (params.turnId?.trim()) {
    const existingRunId = await redisClient.get(buildRunDedupeKey(params.workspaceId, params.persona, params.turnId.trim()));
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
    persona: params.persona,
    status: 'queued',
    createdAt: queuedAt,
    turnId: params.turnId,
    pendingInterrupt: '',
    runContext: serializeRunContext(params),
  });
  if (params.turnId?.trim()) {
    await redisClient.set(
      buildRunDedupeKey(params.workspaceId, params.persona, params.turnId.trim()),
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
  void runAgentRunWorker(runId, params);

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
  persistInterrupt: (runId: string, interruptPayload: string) => Promise<void> = markRunAwaitingApproval,
): Promise<boolean> {
  if (state.sawInterruptPayload) {
    return false;
  }
  const normalized = normalizeInterruptPayloadRecord(parsed);
  state.sawInterruptPayload = normalized;
  await persistInterrupt(runId, JSON.stringify(normalized));
  state.buffer = '';
  if (state.upstream && !state.upstream.destroyed) {
    state.upstream.destroy();
  }
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
  const startedAt = new Date().toISOString();
  const runProgress = resumePayload && runTelemetryService
    ? await runTelemetryService.getRunProgress(runId)
    : null;
  let eventIndex = runProgress?.maxEventIndex ?? 0;
  let skillId: string | null = null;
  let hadInterrupt = runProgress?.hadInterrupt ?? false;
  let approvalInterruptCount = runProgress?.approvalInterruptCount ?? 0;
  let clarificationInterruptCount = runProgress?.clarificationInterruptCount ?? 0;
  let toolCallCount = runProgress?.toolCallCount ?? 0;
  let toolErrorCount = runProgress?.toolErrorCount ?? 0;
  const traceContext: AgentTraceContext = {
    runId,
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
  });
  if (runTelemetryService) {
    await runTelemetryService.markRunStarted(runId, startedAt);
  }

  let upstream: IncomingMessage | null = null;
  let buffer = '';
  let sawInterruptPayload: Record<string, unknown> | null = null;
  let contractErrorMessage = '';
  let loopErrorMessage = '';
  let stallErrorMessage = '';
  let settled = false;
  let processingQueue: Promise<void> = Promise.resolve();
  let activeToolCalls = 0;
  let lastRealActivityAt = Date.now();
  let assistantText = '';
  let thinkingText = '';
  let conversationRunPolicy: ConversationRunPolicy | undefined;
  const toolEvents: ToolEvent[] = [];
  const progressEvents: RunProgressEvent[] = [];

  const snapshotConversationRun = (overrides: Partial<ConversationRunSnapshot> = {}): ConversationRunSnapshot => ({
    assistantText,
    thinkingText,
    toolEvents: toolEvents.length ? [...toolEvents] : undefined,
    runPolicy: conversationRunPolicy,
    progressEvents: progressEvents.length ? [...progressEvents] : undefined,
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

  const captureConversationEvent = (parsed: Record<string, unknown> | null) => {
    if (!parsed) {
      return;
    }
    if ((parsed.type === 'token' || parsed.type === 'chunk') && (!parsed.role || parsed.role === 'assistant')) {
      assistantText += coerceText(parsed.content);
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
    settleRunningToolEvents(status);

    const implicitInput = detectImplicitInputAwaiting({
      status,
      skillId,
      hadInterrupt: resumePayload ? Boolean(sawInterruptPayload) : hadInterrupt,
      assistantText,
    });

    await updateConversationFromRun(
      status === 'queued' ? 'running' : status,
      {
        error,
        ...(implicitInput.awaiting ? { implicitInput } : {}),
      },
    );
    await markRunFinished(runId, status, error);
    if (runTelemetryService) {
      await runTelemetryService.finalizeRun(runId, {
        status,
        startedAt,
        completedAt: new Date().toISOString(),
        error,
        skillId,
        hadInterrupt,
        approvalInterruptCount,
        clarificationInterruptCount,
        toolCallCount,
        toolErrorCount,
        metadata: {
          resumed: Boolean(resumePayload),
          ...langfuseStreamMeta,
        },
      });
    }
    if (status === 'completed' && userMemoryService) {
      void userMemoryService
        .suggestForCompletedRun({
          runId,
          userId: params.userId,
          workspaceId: params.workspaceId,
          conversationId: params.conversationId,
        })
        .catch((memoryError) => {
          console.error('Failed to build memory suggestions for completed run', { runId, error: memoryError });
        });
    }
    if ((status === 'completed' || status === 'failed') && skillEvolutionService && params.userId && params.conversationId) {
      void skillEvolutionService
        .proposeFromRun({
          runId,
          workspaceId: params.workspaceId,
          userId: params.userId,
          conversationId: params.conversationId,
          persona: params.persona,
          status,
          skillId,
          hadInterrupt,
          toolErrorCount,
          approvalInterruptCount,
          clarificationInterruptCount,
        })
        .catch((err) => {
          console.error('Failed to build skill evolution suggestions for run', { runId, error: err });
        });
    }
    cleanupRun(runId, upstream || undefined);
  };

  const stopAtInterrupt = async (parsed: Record<string, unknown>) => {
    const normalizedInterrupt = normalizeInterruptPayloadRecord(parsed);
    const pendingInterrupt = parsePendingInterrupt(JSON.stringify(normalizedInterrupt));
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
          ...langfuseStreamMeta,
        },
      });
    }
    await updateConversationFromRun('awaiting_approval', { pendingInterrupt });
    await persistInterruptAndStopRun(
      runId,
      parsed,
      {
        get sawInterruptPayload() {
          return sawInterruptPayload;
        },
        set sawInterruptPayload(value: Record<string, unknown> | null) {
          sawInterruptPayload = value;
        },
        get buffer() {
          return buffer;
        },
        set buffer(value: string) {
          buffer = value;
        },
        get upstream() {
          return upstream;
        },
        set upstream(value: IncomingMessage | null) {
          upstream = value;
        },
      },
    );
  };

  const processParsedLine = async (line: string): Promise<'continue' | 'stop'> => {
    const parsed = parseLine(line);
    captureConversationEvent(parsed);
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
    if (
      parsed?.type === 'interrupt' &&
      isRepeatedClarificationInterrupt(parsed, previousInterrupt, resumePayload)
    ) {
      loopErrorMessage = 'Clarification response was not consumed. The same clarification was emitted again.';
      const errorPayload = JSON.stringify({ type: 'error', message: loopErrorMessage });
      await appendStreamEvent(runId, errorPayload);
      if (upstream && !upstream.destroyed) {
        upstream.destroy();
      }
      return 'stop';
    }
    if (parsed?.type === 'policy' && typeof parsed.skill === 'string' && parsed.skill.trim()) {
      skillId = parsed.skill.trim();
    }
    if (parsed?.type === 'interrupt') {
      hadInterrupt = true;
      if (parsed.kind === 'approval') {
        approvalInterruptCount += 1;
      } else if (parsed.kind === 'clarification') {
        clarificationInterruptCount += 1;
      }
    }
    if (parsed?.type === 'tool_start' || parsed?.type === 'tool_end' || parsed?.type === 'tool_error') {
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
          console.error('Failed to append agent run tool event', { runId, eventIndex, error: telemetryError });
        }
      }
    }
    await appendStreamEvent(runId, parsed ? JSON.stringify(normalizeInterruptPayloadRecord(parsed)) : line);
    if (parsed?.type === 'interrupt') {
      await stopAtInterrupt(parsed);
      return 'stop';
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
      console.error('Failed to process agent run chunk', error);
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
    const response =
      resumePayload && 'decisions' in resumePayload && resumePayload.decisions
      ? await resumeAgentStream(params.persona, params.workspaceId, resumePayload.decisions, {
          signal: controller.signal,
          authToken: params.authToken,
          traceContext,
        })
      : resumePayload && 'response' in resumePayload && resumePayload.response
      ? await resumeAgentResponseStream(params.persona, params.workspaceId, resumePayload.response, {
          signal: controller.signal,
          authToken: params.authToken,
          traceContext,
        })
      : resumePayload && 'action' in resumePayload && resumePayload.action
      ? await resumeAgentActionStream(params.persona, params.workspaceId, resumePayload.action, {
          signal: controller.signal,
          authToken: params.authToken,
          traceContext,
        })
      : await runAgentStream(params.persona, params.workspaceId, params.prompt, params.history, {
          forceReset: params.forceReset,
          signal: controller.signal,
          authToken: params.authToken,
          fileContextRefs: params.fileContextRefs,
          messageContent: params.messageContent,
          internetSearchEnabled: params.internetSearchEnabled,
          traceContext,
        });
    upstream = response.data;
    upstream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (DEBUG_AGENT_RUN_STREAM) {
        console.info('[agent-run-stream] chunk', { runId, bytes: chunk.length });
      }
      void enqueueProcessBuffer();
    });
    upstream.on('end', async () => {
      if (DEBUG_AGENT_RUN_STREAM) {
        console.info('[agent-run-stream] end', { runId, remainingBytes: buffer.length });
      }
      await processingQueue;
      if (buffer.trim()) {
        await processTailBuffer();
      }

      const disposition = resolveStreamCloseDisposition({
        sawInterruptPayload,
        loopErrorMessage,
        stallErrorMessage,
        aborted: controller.signal.aborted,
        contractErrorMessage,
      });

      if (disposition.preserveInterrupt && sawInterruptPayload) {
        await markRunAwaitingApproval(runId, JSON.stringify(sawInterruptPayload));
        cleanupRun(runId, upstream || undefined);
        return;
      }

      await finalizeRun(disposition.status, disposition.error);
    });
    upstream.on('error', async (error: Error) => {
      const disposition = resolveStreamCloseDisposition({
        sawInterruptPayload,
        loopErrorMessage,
        stallErrorMessage,
        aborted: controller.signal.aborted,
      });

      if (disposition.preserveInterrupt && sawInterruptPayload) {
        await markRunAwaitingApproval(runId, JSON.stringify(sawInterruptPayload));
        cleanupRun(runId, upstream || undefined);
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
    });
  } catch (error: any) {
    const status: AgentRunStatus = controller.signal.aborted ? 'cancelled' : 'failed';
    if (!controller.signal.aborted) {
      const message = buildAgentErrorPayload(error, params.persona);
      const errorPayload = JSON.stringify({ type: 'error', message });
      await appendStreamEvent(runId, errorPayload);
    }
    await finalizeRun(status, error?.message || 'Agent run failed');
  }
}

export async function resumeAgentRun(
  runId: string,
  decisions: AgentDecision[],
  options?: { authToken?: string },
): Promise<{ runId: string; status: AgentRunStatus }> {
  const context = await loadRunContext(runId);
  if (!context) {
    throw new Error('Run context not found. Start a new run.');
  }
  const nextParams = options?.authToken ? { ...context.params, authToken: options.authToken } : context.params;
  runContexts.set(runId, { params: nextParams });
  await persistMeta(runId, {
    status: 'queued',
    startedAt: new Date().toISOString(),
    error: '',
    pendingInterrupt: '',
  });
  void runAgentRunWorker(runId, nextParams, { decisions });
  return { runId, status: 'queued' };
}

export async function resumeAgentRunWithResponse(
  runId: string,
  response: AgentInterruptResponse,
  options?: { authToken?: string; previousInterrupt?: RunPendingInterrupt },
): Promise<{ runId: string; status: AgentRunStatus }> {
  const context = await loadRunContext(runId);
  if (!context) {
    throw new Error('Run context not found. Start a new run.');
  }
  const nextParams = options?.authToken ? { ...context.params, authToken: options.authToken } : context.params;
  runContexts.set(runId, { params: nextParams });
  await persistMeta(runId, {
    status: 'queued',
    startedAt: new Date().toISOString(),
    error: '',
    pendingInterrupt: '',
  });
  void runAgentRunWorker(runId, nextParams, { response }, options?.previousInterrupt);
  return { runId, status: 'queued' };
}

export async function resumeAgentRunWithAction(
  runId: string,
  action: AgentInterruptActionResponse,
  options?: { authToken?: string },
): Promise<{ runId: string; status: AgentRunStatus }> {
  const context = await loadRunContext(runId);
  if (!context) {
    throw new Error('Run context not found. Start a new run.');
  }
  const nextParams = options?.authToken ? { ...context.params, authToken: options.authToken } : context.params;
  runContexts.set(runId, { params: nextParams });
  await persistMeta(runId, {
    status: 'queued',
    startedAt: new Date().toISOString(),
    error: '',
    pendingInterrupt: '',
  });
  void runAgentRunWorker(runId, nextParams, { action });
  return { runId, status: 'queued' };
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

export async function getRunMeta(runId: string): Promise<RunMeta | null> {
  const metaKey = buildMetaKey(runId);
  const meta = await redisClient.hGetAll(metaKey);
  if (!Object.keys(meta).length) {
    return null;
  }
  return {
    workspaceId: meta.workspaceId,
    persona: meta.persona,
    status: (meta.status as AgentRunStatus) || 'queued',
    createdAt: meta.createdAt,
    startedAt: meta.startedAt,
    completedAt: meta.completedAt,
    error: meta.error,
    turnId: meta.turnId,
    pendingInterrupt: parsePendingInterrupt(meta.pendingInterrupt),
  };
}

export const getRunStreamKey = buildStreamKey;
