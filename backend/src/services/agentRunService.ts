import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import { redisClient } from './redisService';
import { runAgentStream, type AgentHistoryEntry } from './agentService';

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

type StartRunParams = {
  workspaceId: string;
  persona: string;
  prompt: string;
  history?: AgentHistoryEntry[];
  forceReset?: boolean;
  turnId?: string;
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
};

const STREAM_TTL_SECONDS = 60 * 60 * 24; // 24h
const DEBUG_AGENT_RUN_STREAM =
  process.env.DEBUG_AGENT_RUN_STREAM === '1' || process.env.DEBUG_AGENT_RUN_STREAM === 'true';

const runAbortControllers = new Map<string, AbortController>();

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
  });

  // Fire and forget worker
  void runAgentRunWorker(runId, params);

  return { runId, status: 'queued' };
}

const markRunFinished = async (runId: string, status: AgentRunStatus, error?: string) => {
  const completedAt = new Date().toISOString();
  await persistMeta(runId, {
    status,
    completedAt,
    error,
  });
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

async function runAgentRunWorker(runId: string, params: StartRunParams) {
  const controller = new AbortController();
  runAbortControllers.set(runId, controller);

  if (DEBUG_AGENT_RUN_STREAM) {
    console.info('[agent-run-stream] start', {
      runId,
      workspaceId: params.workspaceId,
      persona: params.persona,
      hasHistory: Boolean(params.history?.length),
    });
  }

  await persistMeta(runId, {
    status: 'running',
    startedAt: new Date().toISOString(),
  });

  let upstream: IncomingMessage | null = null;
  let buffer = '';

  const processBuffer = async () => {
    try {
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          await appendStreamEvent(runId, line);
        }
        newlineIndex = buffer.indexOf('\n');
      }
    } catch (error) {
      console.error('Failed to process agent run chunk', error);
    }
  };

  try {
    const response = await runAgentStream(
      params.persona,
      params.workspaceId,
      params.prompt,
      params.history,
      { forceReset: params.forceReset, signal: controller.signal }
    );
    upstream = response.data;
    upstream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (DEBUG_AGENT_RUN_STREAM) {
        console.info('[agent-run-stream] chunk', { runId, bytes: chunk.length });
      }
      void processBuffer();
    });
    upstream.on('end', async () => {
      if (DEBUG_AGENT_RUN_STREAM) {
        console.info('[agent-run-stream] end', { runId, remainingBytes: buffer.length });
      }
      if (buffer.trim()) {
        await appendStreamEvent(runId, buffer.trim());
      }
      const status: AgentRunStatus = controller.signal.aborted ? 'cancelled' : 'completed';
      await markRunFinished(runId, status);
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
  };
}

export const getRunStreamKey = buildStreamKey;
