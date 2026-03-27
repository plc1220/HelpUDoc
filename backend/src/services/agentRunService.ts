import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import { redisClient } from './redisService';
import {
  runAgentStream,
  resumeAgentStream,
  resumeAgentActionStream,
  resumeAgentResponseStream,
  type AgentDecision,
  type AgentInterruptActionResponse,
  type AgentInterruptResponse,
  type AgentHistoryEntry,
} from './agentService';

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

type StartRunParams = {
  workspaceId: string;
  persona: string;
  prompt: string;
  history?: AgentHistoryEntry[];
  forceReset?: boolean;
  turnId?: string;
  authToken?: string;
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
  persona: string;
  prompt: string;
  history?: AgentHistoryEntry[];
  forceReset?: boolean;
  turnId?: string;
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
const DEBUG_AGENT_RUN_STREAM =
  process.env.DEBUG_AGENT_RUN_STREAM === '1' || process.env.DEBUG_AGENT_RUN_STREAM === 'true';

const runAbortControllers = new Map<string, AbortController>();
const runContexts = new Map<string, RunContext>();

const buildStreamKey = (runId: string) => `agent:run:${runId}`;
const buildMetaKey = (runId: string) => `agent:run:${runId}:meta`;

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

const parsePendingInterrupt = (raw: string | undefined): RunPendingInterrupt | undefined => {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
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
    persona: params.persona,
    prompt: params.prompt,
    history: params.history,
    forceReset: params.forceReset,
    turnId: params.turnId,
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
        persona: parsed.persona,
        prompt: parsed.prompt,
        history: Array.isArray(parsed.history) ? parsed.history : undefined,
        forceReset: typeof parsed.forceReset === 'boolean' ? parsed.forceReset : undefined,
        turnId: typeof parsed.turnId === 'string' ? parsed.turnId : undefined,
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
  const runId = randomUUID();
  const streamKey = buildStreamKey(runId);
  const metaKey = buildMetaKey(runId);

  await redisClient.del(streamKey);
  await redisClient.del(metaKey);
  await persistMeta(runId, {
    workspaceId: params.workspaceId,
    persona: params.persona,
    status: 'queued',
    createdAt: new Date().toISOString(),
    turnId: params.turnId,
    pendingInterrupt: '',
    runContext: serializeRunContext(params),
  });
  runContexts.set(runId, { params });

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
  state.sawInterruptPayload = parsed;
  await persistInterrupt(runId, JSON.stringify(parsed));
  state.buffer = '';
  if (state.upstream && !state.upstream.destroyed) {
    state.upstream.destroy();
  }
  return true;
}

async function runAgentRunWorker(runId: string, params: StartRunParams, resumePayload?: ResumePayload) {
  const controller = new AbortController();
  runAbortControllers.set(runId, controller);

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
    startedAt: new Date().toISOString(),
    error: '',
  });

  let upstream: IncomingMessage | null = null;
  let buffer = '';
  let sawInterruptPayload: Record<string, unknown> | null = null;
  let contractErrorMessage = '';
  let processingQueue: Promise<void> = Promise.resolve();

  const stopAtInterrupt = async (parsed: Record<string, unknown>) => {
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

  const processBuffer = async () => {
    try {
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          await appendStreamEvent(runId, line);
          const parsed = parseLine(line);
          if (parsed?.type === 'interrupt') {
            await stopAtInterrupt(parsed);
            break;
          }
          if (parsed?.type === 'contract_error') {
            contractErrorMessage =
              typeof parsed.message === 'string' && parsed.message.trim()
                ? parsed.message
                : 'Artifact contract validation failed.';
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
      await appendStreamEvent(runId, line);
      const parsed = parseLine(line);
      if (parsed?.type === 'interrupt') {
        await stopAtInterrupt(parsed);
        break;
      }
      if (parsed?.type === 'contract_error') {
        contractErrorMessage =
          typeof parsed.message === 'string' && parsed.message.trim()
            ? parsed.message
            : 'Artifact contract validation failed.';
      }
    }
  };

  try {
    const response =
      resumePayload && 'decisions' in resumePayload && resumePayload.decisions
      ? await resumeAgentStream(params.persona, params.workspaceId, resumePayload.decisions, {
          signal: controller.signal,
          authToken: params.authToken,
        })
      : resumePayload && 'response' in resumePayload && resumePayload.response
      ? await resumeAgentResponseStream(params.persona, params.workspaceId, resumePayload.response, {
          signal: controller.signal,
          authToken: params.authToken,
        })
      : resumePayload && 'action' in resumePayload && resumePayload.action
      ? await resumeAgentActionStream(params.persona, params.workspaceId, resumePayload.action, {
          signal: controller.signal,
          authToken: params.authToken,
        })
      : await runAgentStream(params.persona, params.workspaceId, params.prompt, params.history, {
          forceReset: params.forceReset,
          signal: controller.signal,
          authToken: params.authToken,
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

      if (controller.signal.aborted) {
        await markRunFinished(runId, 'cancelled');
        cleanupRun(runId, upstream || undefined);
        return;
      }

      if (contractErrorMessage) {
        await markRunFinished(runId, 'failed', contractErrorMessage);
        cleanupRun(runId, upstream || undefined);
        return;
      }

      if (sawInterruptPayload) {
        await markRunAwaitingApproval(runId, JSON.stringify(sawInterruptPayload));
        cleanupRun(runId, upstream || undefined);
        return;
      }

      await markRunFinished(runId, 'completed');
      cleanupRun(runId, upstream || undefined);
    });
    upstream.on('error', async (error: Error) => {
      if (sawInterruptPayload) {
        await markRunAwaitingApproval(runId, JSON.stringify(sawInterruptPayload));
        cleanupRun(runId, upstream || undefined);
        return;
      }
      const status: AgentRunStatus = controller.signal.aborted ? 'cancelled' : 'failed';
      if (!controller.signal.aborted) {
        const errorPayload = JSON.stringify({ type: 'error', message: error.message || 'Agent stream failed.' });
        await appendStreamEvent(runId, errorPayload);
      }
      await markRunFinished(runId, status, error.message);
      cleanupRun(runId, upstream || undefined);
    });
  } catch (error: any) {
    const status: AgentRunStatus = controller.signal.aborted ? 'cancelled' : 'failed';
    if (!controller.signal.aborted) {
      const message = buildAgentErrorPayload(error, params.persona);
      const errorPayload = JSON.stringify({ type: 'error', message });
      await appendStreamEvent(runId, errorPayload);
    }
    await markRunFinished(runId, status, error?.message || 'Agent run failed');
    cleanupRun(runId, upstream || undefined);
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
  void runAgentRunWorker(runId, nextParams, { response });
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
