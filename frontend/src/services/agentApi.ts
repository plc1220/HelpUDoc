import { streamAgentRunWithReconnect, type AgentStreamChunk } from '../../../packages/shared/src/services/agentStream';
export type { AgentStreamChunk };
import { API_URL, apiFetch } from './apiClient';

const STREAM_DEBUG_ENABLED =
  typeof import.meta !== 'undefined' &&
  typeof import.meta.env !== 'undefined' &&
  (import.meta.env.VITE_DEBUG_STREAM === '1' || import.meta.env.VITE_DEBUG_STREAM === 'true');

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
  await streamAgentRunWithReconnect({
    runId,
    baseUrl: API_URL,
    fetchImpl: apiFetch,
    onChunk,
    signal,
    afterId,
    debug: STREAM_DEBUG_ENABLED,
  });
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
