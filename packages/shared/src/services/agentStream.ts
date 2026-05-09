import type { DashboardArtifactInfo } from '../types';

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
  | {
      type: 'tool_end';
      content?: string;
      name?: string;
      outputFiles?: Array<{ path: string; mimeType?: string | null; size?: number }>;
      dashboardArtifact?: DashboardArtifactInfo;
    }
  | { type: 'tool_error'; content?: string; name?: string }
  | { type: 'dashboard_artifact'; dashboardArtifact: DashboardArtifactInfo }
  | {
      type: 'interrupt';
      interruptId?: string;
      kind?: 'approval' | 'clarification';
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
        choices?: Array<{ id: string; label: string; description?: string; value: string }>;
        questions?: Array<{
          id: string;
          header: string;
          question: string;
          options?: Array<{ id: string; label: string; description?: string; value: string }>;
        }>;
      };
      displayPayload?: Record<string, unknown>;
    }
  | { type: 'keepalive' }
  | { type: 'done' }
  | { type: 'error'; message?: string }
  | { type: 'contract_error'; message?: string; missing?: string[] };

type StreamArgs = {
  runId: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  onChunk: (chunk: AgentStreamChunk) => void;
  signal?: AbortSignal;
  afterId?: string;
  debug?: boolean;
};

const coerceStreamContent = (value: unknown, stringifyObjects = false): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => coerceStreamContent(item, stringifyObjects)).filter(Boolean).join('');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'content', 'message', 'output']) {
      const coerced = coerceStreamContent(record[key], stringifyObjects);
      if (coerced) return coerced;
    }
    return stringifyObjects ? JSON.stringify(record) : '';
  }
  return '';
};

const normalizeAgentStreamChunk = (chunk: unknown): AgentStreamChunk & { id?: unknown } => {
  if (!chunk || typeof chunk !== 'object') {
    return { type: 'chunk', content: coerceStreamContent(chunk), role: 'assistant' };
  }
  const next = { ...(chunk as Record<string, unknown>) };
  if ('content' in next) {
    const type = typeof next.type === 'string' ? next.type : '';
    next.content = coerceStreamContent(next.content, type.startsWith('tool_'));
  }
  if (typeof next.message !== 'string' && next.message !== undefined && next.type === 'error') {
    next.message = coerceStreamContent(next.message, true);
  }
  return next as AgentStreamChunk & { id?: unknown };
};

export const streamAgentRunWithReconnect = async ({
  runId,
  baseUrl,
  fetchImpl,
  onChunk,
  signal,
  afterId,
  debug = false,
}: StreamArgs) => {
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

  while (true) {
    const url = lastId
      ? `${baseUrl}/agent/runs/${runId}/stream?after=${encodeURIComponent(lastId)}`
      : `${baseUrl}/agent/runs/${runId}/stream`;

    if (debug) {
      console.debug('[AgentRunStream] connect', { runId, url, consecutiveFailures });
    }

    const response = await fetchImpl(url, { method: 'GET', signal });

    if (!response.ok) {
      if (debug) {
        console.debug('[AgentRunStream] error response', { runId, status: response.status });
      }
      throw new Error('Failed to stream agent run');
    }

    if (!response.body) {
      throw new Error('Streaming not supported by this runtime');
    }

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawChunk = false;
      let sawTerminalChunk = false;

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
              const chunk = normalizeAgentStreamChunk(JSON.parse(line));
              onChunkWithResume(chunk);
              sawChunk = true;
              if (chunk?.type === 'done') {
                sawTerminalChunk = true;
              }
              if (debug) {
                console.debug('[AgentRunStream] chunk', chunk);
              }
            } catch (error) {
              console.error('Failed to parse stream chunk', error, line);
            }
          }
          if (sawTerminalChunk) {
            break;
          }
          newlineIndex = buffer.indexOf('\n');
        }
        if (sawTerminalChunk) {
          break;
        }
      }

      if (!sawTerminalChunk && buffer.trim()) {
        try {
          const chunk = normalizeAgentStreamChunk(JSON.parse(buffer.trim()));
          onChunkWithResume(chunk);
          sawChunk = true;
          if (chunk?.type === 'done') {
            sawTerminalChunk = true;
          }
          if (debug) {
            console.debug('[AgentRunStream] trailing chunk', chunk);
          }
        } catch (error) {
          console.error('Failed to parse trailing stream chunk', error, buffer);
        }
      }

      if (sawTerminalChunk) {
        await reader.cancel().catch(() => undefined);
      }

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
      await delay(250 * (2 ** (consecutiveFailures - 1)));
    }
  }
};
