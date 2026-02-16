import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import { redisClient } from './redisService';
import {
  runAgentStream,
  resumeAgentStream,
  type AgentDecision,
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

type RunMeta = {
  workspaceId: string;
  persona: string;
  status: AgentRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  turnId?: string;
  pendingInterrupt?: string;
};

type RunContext = {
  params: StartRunParams;
};

const STREAM_TTL_SECONDS = 60 * 60 * 24; // 24h
const DEBUG_AGENT_RUN_STREAM =
  process.env.DEBUG_AGENT_RUN_STREAM === '1' || process.env.DEBUG_AGENT_RUN_STREAM === 'true';

const runAbortControllers = new Map<string, AbortController>();
const runContexts = new Map<string, RunContext>();

const buildStreamKey = (runId: string) => `agent:run:${runId}`;
const buildMetaKey = (runId: string) => `agent:run:${runId}:meta`;

const persistMeta = async (runId: string, meta: Partial<RunMeta>) => {
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

async function runAgentRunWorker(runId: string, params: StartRunParams, resumeDecisions?: AgentDecision[]) {
  const controller = new AbortController();
  runAbortControllers.set(runId, controller);

  if (DEBUG_AGENT_RUN_STREAM) {
    console.info('[agent-run-stream] start', {
      runId,
      workspaceId: params.workspaceId,
      persona: params.persona,
      hasHistory: Boolean(params.history?.length),
      resumeDecisions: Boolean(resumeDecisions?.length),
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
            sawInterruptPayload = parsed;
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
        sawInterruptPayload = parsed;
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
    const response = resumeDecisions?.length
      ? await resumeAgentStream(params.persona, params.workspaceId, resumeDecisions, {
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
): Promise<{ runId: string; status: AgentRunStatus }> {
  const context = runContexts.get(runId);
  if (!context) {
    throw new Error('Run context not found. Start a new run.');
  }
  await persistMeta(runId, {
    status: 'queued',
    startedAt: new Date().toISOString(),
    error: '',
    pendingInterrupt: '',
  });
  void runAgentRunWorker(runId, context.params, decisions);
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
    pendingInterrupt: meta.pendingInterrupt,
  };
}

export const getRunStreamKey = buildStreamKey;
