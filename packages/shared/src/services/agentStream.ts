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
  | { type: 'tool_end'; content?: string; name?: string; outputFiles?: Array<{ path: string; mimeType?: string | null; size?: number }> }
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

type StreamArgs = {
  runId: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  onChunk: (chunk: AgentStreamChunk) => void;
  signal?: AbortSignal;
  afterId?: string;
  debug?: boolean;
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
              if (debug) {
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
          if (debug) {
            console.debug('[AgentRunStream] trailing chunk', chunk);
          }
        } catch (error) {
          console.error('Failed to parse trailing stream chunk', error, buffer);
        }
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
