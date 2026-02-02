import type { AgentPersona, ToolOutputFile } from '../types';
import { API_URL, apiFetch } from './apiClient';

const STREAM_DEBUG_ENABLED =
  typeof import.meta !== 'undefined' &&
  typeof import.meta.env !== 'undefined' &&
  (import.meta.env.VITE_DEBUG_STREAM === '1' || import.meta.env.VITE_DEBUG_STREAM === 'true');

export type AgentStreamChunk =
  | { type: 'token' | 'chunk'; content?: string; role?: string }
  | { type: 'thought'; content?: string; role?: string }
  | { type: 'tool_start'; content?: string; name?: string }
  | { type: 'tool_end'; content?: string; name?: string; outputFiles?: ToolOutputFile[] }
  | { type: 'tool_error'; content?: string; name?: string }
  | { type: 'keepalive' }
  | { type: 'done' }
  | { type: 'error'; message?: string };

type AgentStreamOptions = {
  forceReset?: boolean;
};

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

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
  const url = afterId ? `${API_URL}/agent/runs/${runId}/stream?after=${encodeURIComponent(afterId)}` : `${API_URL}/agent/runs/${runId}/stream`;
  if (STREAM_DEBUG_ENABLED) {
    console.debug('[AgentRunStream] connect', { runId, url });
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
      onChunk(chunk);
      if (STREAM_DEBUG_ENABLED) {
        console.debug('[AgentRunStream] chunk', chunk);
      }
    } catch (error) {
      console.error('Failed to parse trailing stream chunk', error, buffer);
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
