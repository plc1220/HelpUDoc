import type { DashboardArtifactInfo } from './types';

export type AgentStreamChunk =
  | { type: 'token' | 'chunk'; content?: string; role?: string }
  | { type: 'thought'; content?: string; role?: string }
  | { type: 'model_start' | 'model_end'; name?: string }
  | {
      type: 'policy';
      skill?: string;
      requiresHitlPlan?: boolean;
      requiresArtifacts?: boolean;
      requiredArtifactsMode?: string;
      prePlanSearchLimit?: number;
      prePlanSearchUsed?: number;
    }
  | {
      type: 'progress';
      phase:
        | 'queued'
        | 'preparing_context'
        | 'routing'
        | 'loading_skill'
        | 'planning'
        | 'retrieving'
        | 'using_tool'
        | 'writing_artifact'
        | 'awaiting_input'
        | 'finalizing'
        | 'completed'
        | 'failed';
      label: string;
      detail?: string;
      status?: 'pending' | 'running' | 'completed' | 'error';
      stepIndex?: number;
      stepCount?: number;
      toolName?: string;
      artifactPath?: string;
      timestamp?: string;
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
  | { type: 'done'; status?: 'completed' | 'failed' | 'cancelled' | 'interrupted' }
  | { type: 'error'; message?: string }
  | { type: 'contract_error'; message?: string; missing?: string[] };

export type LangChainCompatibleMessage = {
  id?: string;
  role: 'assistant' | 'user' | 'system' | 'tool';
  content: string;
  additional_kwargs?: Record<string, unknown>;
};

export type LangChainCompatibleToolCall = {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  status: 'started' | 'completed' | 'error';
  content?: string;
  outputFiles?: Array<{ path: string; mimeType?: string | null; size?: number }>;
};

export type LangChainCompatibleInterrupt = Extract<AgentStreamChunk, { type: 'interrupt' }>;

export type LangChainStreamProjection = {
  messages?: LangChainCompatibleMessage[];
  toolCalls?: LangChainCompatibleToolCall[];
  interrupts?: LangChainCompatibleInterrupt[];
  values?: Record<string, unknown>;
  custom?: Array<{ name: string; data: unknown }>;
};

type StreamArgs = {
  runId: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  onChunk: (chunk: AgentStreamChunk) => void;
  onLangChainProjection?: (projection: LangChainStreamProjection, chunk: AgentStreamChunk) => void;
  signal?: AbortSignal;
  afterId?: string;
  debug?: boolean;
};

const INTERNAL_STREAM_CONTENT_PATTERNS = [
  /^PLAN_(APPROVAL|EDIT|REJECTION|REJECT|CLARIFICATION|ACTION)_[A-Z_]+/i,
  /^Command\s*\(/i,
  /^\(?HumanMessage\s*\(/i,
  /^\[Clarification response\b/i,
  /^\(\s*\{\s*['"]event['"]\s*:\s*['"]message-start['"]/i,
  /^\(\s*\{\s*['"]event['"]\s*:\s*['"]message-(?:delta|end)['"]/i,
  /^\(\s*\{\s*['"]event['"]\s*:\s*['"]content-block-/i,
  /^\[\s*\{\s*['"]event['"]\s*:\s*['"]content-block-/i,
  /^\{\s*['"]event['"]\s*:\s*['"]message-(?:start|delta|end)['"]/i,
  /^\{\s*['"]event['"]\s*:\s*['"]content-block-/i,
];

export const isInternalStreamContent = (value: string): boolean => {
  const normalized = value.trim();
  if (!normalized) return false;
  return INTERNAL_STREAM_CONTENT_PATTERNS.some((pattern) => pattern.test(normalized));
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

export const normalizeAgentStreamChunk = (chunk: unknown): AgentStreamChunk & { id?: unknown } => {
  if (!chunk || typeof chunk !== 'object') {
    const content = coerceStreamContent(chunk);
    const suppress = isInternalStreamContent(content);
    return {
      type: 'chunk',
      content: suppress ? '' : content,
      role: 'assistant',
      ...(suppress ? { __suppressInternalStream: true } : {}),
    };
  }
  const next = { ...(chunk as Record<string, unknown>) };
  if ('content' in next) {
    const type = typeof next.type === 'string' ? next.type : '';
    const content = coerceStreamContent(next.content, type.startsWith('tool_'));
    const suppress = (type === 'token' || type === 'chunk') && isInternalStreamContent(content);
    next.content = suppress ? '' : content;
    if (suppress) {
      next.__suppressInternalStream = true;
    }
  }
  if (typeof next.message !== 'string' && next.message !== undefined && next.type === 'error') {
    next.message = coerceStreamContent(next.message, true);
  }
  return next as AgentStreamChunk & { id?: unknown };
};

export const toLangChainStreamProjection = (
  chunk: AgentStreamChunk & { id?: unknown },
): LangChainStreamProjection => {
  if ((chunk.type === 'token' || chunk.type === 'chunk') && (!chunk.role || chunk.role === 'assistant')) {
    return {
      messages: [
        {
          id: typeof chunk.id === 'string' ? chunk.id : undefined,
          role: 'assistant',
          content: chunk.content || '',
        },
      ],
    };
  }

  if (chunk.type === 'tool_start') {
    return {
      toolCalls: [
        {
          id: typeof chunk.id === 'string' ? chunk.id : undefined,
          name: chunk.name || chunk.content || 'tool',
          status: 'started',
          content: chunk.content,
        },
      ],
    };
  }

  if (chunk.type === 'tool_end' || chunk.type === 'tool_error') {
    return {
      toolCalls: [
        {
          id: typeof chunk.id === 'string' ? chunk.id : undefined,
          name: chunk.name || 'tool',
          status: chunk.type === 'tool_error' ? 'error' : 'completed',
          content: chunk.content,
          outputFiles: chunk.type === 'tool_end' ? chunk.outputFiles : undefined,
        },
      ],
    };
  }

  if (chunk.type === 'interrupt') {
    return { interrupts: [chunk] };
  }

  if (chunk.type === 'done') {
    return { values: { status: chunk.status || 'completed' } };
  }

  if (chunk.type === 'error' || chunk.type === 'contract_error') {
    return {
      values: {
        status: 'failed',
        message: chunk.message,
        ...(chunk.type === 'contract_error' ? { missing: chunk.missing } : {}),
      },
    };
  }

  if (chunk.type === 'progress' || chunk.type === 'policy' || chunk.type === 'dashboard_artifact') {
    return { custom: [{ name: chunk.type, data: chunk }] };
  }

  if (chunk.type === 'thought' && chunk.content) {
    return { custom: [{ name: 'thought', data: chunk }] };
  }

  return {};
};

export const streamAgentRunWithReconnect = async ({
  runId,
  baseUrl,
  fetchImpl,
  onChunk,
  onLangChainProjection,
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
    onLangChainProjection?.(toLangChainStreamProjection(chunk), chunk);
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
      const emitNormalizedChunk = (chunk: AgentStreamChunk & { id?: unknown }) => {
        const isAssistantTextChunk =
          (chunk.type === 'token' || chunk.type === 'chunk') &&
          (!chunk.role || chunk.role === 'assistant');
        const content = isAssistantTextChunk && typeof chunk.content === 'string' ? chunk.content : '';
        const suppressMarker = (chunk as Record<string, unknown>).__suppressInternalStream === true;

        if (isAssistantTextChunk && (suppressMarker || isInternalStreamContent(content))) {
          const cleanChunk = { ...(chunk as Record<string, unknown>) };
          delete cleanChunk.__suppressInternalStream;
          cleanChunk.content = '';
          onChunkWithResume(cleanChunk as AgentStreamChunk & { id?: unknown });
          return;
        }

        onChunkWithResume(chunk);
      };

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
              emitNormalizedChunk(chunk);
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
          emitNormalizedChunk(chunk);
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
