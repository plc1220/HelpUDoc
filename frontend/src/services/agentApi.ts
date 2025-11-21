import type { AgentPersona, ToolOutputFile } from '../types';

const API_URL = 'http://localhost:3000/api';

export type AgentStreamChunk =
  | { type: 'token' | 'chunk'; content?: string; role?: string }
  | { type: 'thought'; content?: string; role?: string }
  | { type: 'tool_start'; content?: string; name?: string }
  | { type: 'tool_end'; content?: string; name?: string; outputFiles?: ToolOutputFile[] }
  | { type: 'tool_error'; content?: string; name?: string }
  | { type: 'done' }
  | { type: 'error'; message?: string };

type AgentStreamOptions = {
  forceReset?: boolean;
};

export const fetchPersonas = async (): Promise<AgentPersona[]> => {
  const response = await fetch(`${API_URL}/agent/personas`);
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
  const response = await fetch(`${API_URL}/agent/run-stream`, {
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
          console.debug('[AgentStream] chunk', chunk);
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
      console.debug('[AgentStream] chunk', chunk);
    } catch (error) {
      console.error('Failed to parse trailing stream chunk', error, buffer);
    }
  }
};
