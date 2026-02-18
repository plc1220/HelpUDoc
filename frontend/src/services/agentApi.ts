import type { AgentPersona, ToolOutputFile } from '../types';
import { API_URL, apiFetch } from './apiClient';

const STREAM_DEBUG_ENABLED =
  typeof import.meta !== 'undefined' &&
  typeof import.meta.env !== 'undefined' &&
  (import.meta.env.VITE_DEBUG_STREAM === '1' || import.meta.env.VITE_DEBUG_STREAM === 'true');

export type AgentStreamChunk =
  | { type: 'token' | 'chunk'; content?: string; role?: string }
  | { type: 'thought'; content?: string; role?: string }
  | {
      type: 'policy';
      skill?: string;
      requiresHitlPlan?: boolean;
      requiresArtifacts?: boolean;
      requiredArtifactsMode?: string;
      prePlanSearchLimit?: number;
      prePlanSearchUsed?: number;
    }
  | { type: 'tool_start'; content?: string; name?: string }
  | { type: 'tool_end'; content?: string; name?: string; outputFiles?: ToolOutputFile[] }
  | { type: 'tool_error'; content?: string; name?: string }
  | {
      type: 'interrupt';
      interruptId?: string;
      actionRequests?: Array<{ name?: string; args?: Record<string, unknown> }>;
      reviewConfigs?: Array<{ action_name?: string; allowed_decisions?: string[] }>;
    }
  | { type: 'keepalive' }
  | { type: 'done' }
  | { type: 'error'; message?: string }
  | { type: 'contract_error'; message?: string; missing?: string[] };

type AgentStreamOptions = {
  forceReset?: boolean;
};

export type AgentRunStatus = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export type AgentRunStartResponse = {
  runId: string;
  status: AgentRunStatus;
};

export const startAgentRun = async (
  workspaceId: string,
  persona: string,
  prompt: string,
  history: Array<{ role: string; content: string }> | undefined,
  turnId?: string,
  options?: AgentStreamOptions,
): Promise<AgentRunStartResponse> => {
  const response = await apiFetch(`${API_URL}/agent/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId,
      persona,
      prompt,
      history,
      forceReset: options?.forceReset,
      turnId,
    }),
  });
  if (!response.ok) {
    throw new Error('Failed to start agent run');
  }
  return response.json();
};

export const streamAgentRun = async (
  runId: string,
  onChunk: (chunk: AgentStreamChunk) => void,
  signal?: AbortSignal,
  afterId?: string,
) => {
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  let lastId = afterId;
  let consecutiveFailures = 0;
  const maxAttempts = 5;

  const onChunkWithResume = (chunk: AgentStreamChunk & { id?: unknown }) => {
    if (typeof chunk.id === 'string') {
      lastId = chunk.id;
    }
    onChunk(chunk);
  };

  // Retry on transient network failures (e.g., QUIC/HTTP3 stream drops) and resume from the last seen id.
  // If the client can't resume (no id support), it will behave like the old implementation.
  while (true) {
    const url = lastId
      ? `${API_URL}/agent/runs/${runId}/stream?after=${encodeURIComponent(lastId)}`
      : `${API_URL}/agent/runs/${runId}/stream`;
    if (STREAM_DEBUG_ENABLED) {
      console.debug('[AgentRunStream] connect', { runId, url, consecutiveFailures });
    }

    const response = await apiFetch(url, {
      method: 'GET',
      signal,
    });

    if (!response.ok) {
      if (STREAM_DEBUG_ENABLED) {
        console.debug('[AgentRunStream] error response', { runId, status: response.status });
      }
      throw new Error('Failed to stream agent run');
    }

    if (!response.body) {
      if (STREAM_DEBUG_ENABLED) {
        console.debug('[AgentRunStream] missing body', { runId });
      }
      throw new Error('Streaming not supported by this browser');
    }

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawChunk = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            try {
              const chunk = JSON.parse(line);
              onChunkWithResume(chunk);
              sawChunk = true;
              if (STREAM_DEBUG_ENABLED) {
                console.debug('[AgentRunStream] chunk', chunk);
              }
            } catch (error) {
              console.error('Failed to parse stream chunk', error, line);
            }
          }
          newlineIndex = buffer.indexOf('\n');
        }
      }

      if (buffer.trim()) {
        try {
          const chunk = JSON.parse(buffer.trim());
          onChunkWithResume(chunk);
          sawChunk = true;
          if (STREAM_DEBUG_ENABLED) {
            console.debug('[AgentRunStream] chunk', chunk);
          }
        } catch (error) {
          console.error('Failed to parse trailing stream chunk', error, buffer);
        }
      }

      // A successful read cycle (especially one that received chunks) should
      // reset retry accounting so occasional disconnects don't eventually fail
      // long-running streams.
      if (sawChunk) {
        consecutiveFailures = 0;
      }
      return;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxAttempts) {
        throw error;
      }
      // Exponential backoff: 250ms, 500ms, 1s, 2s...
      await delay(250 * (2 ** (consecutiveFailures - 1)));
      continue;
    }
  }
};

export const getRunStatus = async (runId: string): Promise<{ status: AgentRunStatus; workspaceId: string; persona: string; turnId?: string }> => {
  const response = await apiFetch(`${API_URL}/agent/runs/${runId}`);
  if (!response.ok) {
    throw new Error('Failed to fetch run status');
  }
  return response.json();
};

export const cancelRun = async (runId: string) => {
  const response = await apiFetch(`${API_URL}/agent/runs/${runId}/cancel`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error('Failed to cancel run');
  }
  return response.json();
};

export const submitRunDecision = async (
  runId: string,
  decision: 'approve' | 'edit' | 'reject',
  options?: {
    editedAction?: { name: string; args: Record<string, unknown> };
    message?: string;
  },
) => {
  const response = await apiFetch(`${API_URL}/agent/runs/${runId}/decision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      decision,
      editedAction: options?.editedAction,
      message: options?.message,
    }),
  });
  if (!response.ok) {
    throw new Error('Failed to submit run decision');
  }
  return response.json();
};

export const fetchPersonas = async (): Promise<AgentPersona[]> => {
  const response = await apiFetch(`${API_URL}/agent/personas`);
  if (!response.ok) {
    throw new Error('Failed to fetch personas');
  }
  return response.json();
};

export const runAgentStream = async (
  workspaceId: string,
  persona: string,
  prompt: string,
  history: Array<{ role: string; content: string }> | undefined,
  onChunk: (chunk: AgentStreamChunk) => void,
  signal?: AbortSignal,
  options?: AgentStreamOptions,
) => {
  const response = await apiFetch(`${API_URL}/agent/run-stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId,
      persona,
      prompt,
      history,
      forceReset: options?.forceReset,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error('Failed to stream agent');
  }

  if (!response.body) {
    throw new Error('Streaming not supported by this browser');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          const chunk = JSON.parse(line);
          onChunk(chunk);
          if (STREAM_DEBUG_ENABLED) {
            console.debug('[AgentStream] chunk', chunk);
          }
        } catch (error) {
          console.error('Failed to parse stream chunk', error, line);
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }
  }

  if (buffer.trim()) {
    try {
      const chunk = JSON.parse(buffer.trim());
      onChunk(chunk);
      if (STREAM_DEBUG_ENABLED) {
        console.debug('[AgentStream] chunk', chunk);
      }
    } catch (error) {
      console.error('Failed to parse trailing stream chunk', error, buffer);
    }
  }
};
