import axios from "axios";
import type { AxiosResponse } from "axios";
import type { IncomingMessage } from "http";

const AGENT_URL = process.env.AGENT_URL || "http://localhost:8001";

const client = axios.create({
  baseURL: AGENT_URL,
});

const DOCUMENT_EXTRACTION_TIMEOUT_MS = 5 * 60 * 1000;

export type AgentHistoryEntry = {
  role: string;
  content: string;
};

export type AgentMessageContentBlock = {
  type: string;
  [key: string]: unknown;
};

export type AgentTraceContext = {
  runId?: string;
  threadId?: string;
  turnId?: string;
  userId?: string;
  workspaceId?: string;
  persona?: string;
  conversationId?: string;
  skillId?: string | null;
  interactionGateState?: {
    completedGateIds?: string[];
  };
};

export type AgentDecision = {
  type: 'approve' | 'edit' | 'reject';
  edited_action?: { name: string; args: Record<string, unknown> };
  message?: string;
};

export type AgentInterruptResponse = {
  message?: string;
  selectedChoiceIds?: string[];
  selectedValues?: string[];
  answersByQuestionId?: Record<string, string | string[]>;
};

export type AgentInterruptAction = {
  id: string;
  value?: string;
  payload?: Record<string, unknown>;
  text?: string;
};

export type AgentInterruptActionResponse = {
  action: AgentInterruptAction;
};

type RunAgentOptions = {
  forceReset?: boolean;
  signal?: AbortSignal;
  authToken?: string;
  messageContent?: AgentMessageContentBlock[];
  internetSearchEnabled?: boolean;
  traceContext?: AgentTraceContext;
  interruptId?: string;
  originalPrompt?: string;
};

export type DocumentExtractionResponse = {
  title: string;
  summary: string;
  markdown: string;
  manifest?: {
    extractorVersion: string;
    sourceType: string;
    discoveredSourceUnits: number;
    processedSourceUnits: number;
    failedSourceUnits: number;
    needsOcrSourceUnits?: number;
    converter?: string;
    markdownConverter?: string | null;
    locatorStrategy?: string;
    mediaType?: string | null;
    ocrMode?: 'off' | 'auto' | 'always';
    ocrProvider?: string | null;
    ocrModel?: string | null;
    ocrTextThreshold?: number;
    modelUsage?: Array<{
      stage: string;
      provider: string;
      model: string;
      sourceUnits: string[];
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      retries: number;
      latencyMs: number;
      outcome: 'completed' | 'failed' | 'cached';
      error?: string | null;
    }>;
    mediaArtifacts?: Array<Record<string, unknown>>;
    warnings?: Array<{ sourceUnit: string; code: string; message: string }>;
  };
  blocks?: Array<Record<string, unknown>>;
  structure?: Array<Record<string, unknown>>;
  windows?: Array<Record<string, unknown>>;
  languageDistribution?: Record<string, number>;
};

export type KnowledgeMapResponse = {
  result: {
    concepts: Array<{
      candidateId: string;
      kind: string;
      name: string;
      description: string;
      aliases: string[];
      tags: string[];
      assertions: Array<{
        text: string;
        confidence: number;
        evidence: Array<{ blockIds: string[]; pageStart?: number | null; pageEnd?: number | null }>;
      }>;
      relationships: Array<{
        targetName: string;
        targetKind: string;
        type: string;
        confidence: number;
        confidenceClass: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
        evidenceBlockIds: string[];
      }>;
    }>;
    summary: string;
    unresolvedReferences: string[];
  };
  provider: string;
  model: string;
  modelProfile: string;
  promptVersion: string;
  schemaVersion: string;
  usage?: {
    events?: Array<Record<string, unknown>>;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    attempts?: number;
  };
  validationWarnings?: string[];
};

type InternalAgentOptions = {
  authToken?: string;
};

export async function runAgent(
  persona: string,
  workspaceId: string,
  prompt: string,
  history?: AgentHistoryEntry[],
  options?: RunAgentOptions
) {
  const payload: Record<string, unknown> = {
    message: prompt,
    history,
  };

  if (options?.forceReset) {
    payload.forceReset = true;
  }
  if (options?.messageContent?.length) {
    payload.messageContent = options.messageContent;
  }
  if (options?.internetSearchEnabled) {
    payload.internetSearchEnabled = true;
  }
  if (options?.traceContext) {
    payload.langfuseTraceContext = options.traceContext;
  }

  const headers: Record<string, string> = {};
  if (options?.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }
  const res = await client.post(`/agents/${persona}/workspace/${workspaceId}/chat`, payload, {
    headers,
  });
  return res.data;
}

export async function runAgentStream(
  persona: string,
  workspaceId: string,
  prompt: string,
  history?: AgentHistoryEntry[],
  options?: RunAgentOptions
): Promise<AxiosResponse<IncomingMessage>> {
  const payload: Record<string, unknown> = {
    message: prompt,
    history,
  };

  if (options?.forceReset) {
    payload.forceReset = true;
  }
  if (options?.messageContent?.length) {
    payload.messageContent = options.messageContent;
  }
  if (options?.internetSearchEnabled) {
    payload.internetSearchEnabled = true;
  }
  if (options?.traceContext) {
    payload.langfuseTraceContext = options.traceContext;
  }

  const headers: Record<string, string> = {};
  if (options?.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }
  return client.post(`/agents/${persona}/workspace/${workspaceId}/chat/stream`, payload, {
    responseType: "stream",
    signal: options?.signal,
    headers,
  });
}

export async function resumeAgentStream(
  persona: string,
  workspaceId: string,
  decisions: AgentDecision[],
  options?: RunAgentOptions
): Promise<AxiosResponse<IncomingMessage>> {
  const headers: Record<string, string> = {};
  if (options?.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }
  const payload: Record<string, unknown> = { decisions };
  if (options?.interruptId) {
    payload.interruptId = options.interruptId;
  }
  if (options?.originalPrompt) {
    payload.originalPrompt = options.originalPrompt;
  }
  if (options?.traceContext) {
    payload.langfuseTraceContext = options.traceContext;
  }
  return client.post(
    `/agents/${persona}/workspace/${workspaceId}/chat/stream/resume`,
    payload,
    {
      responseType: "stream",
      signal: options?.signal,
      headers,
    }
  );
}

export async function resumeAgentResponseStream(
  persona: string,
  workspaceId: string,
  response: AgentInterruptResponse,
  options?: RunAgentOptions
): Promise<AxiosResponse<IncomingMessage>> {
  const headers: Record<string, string> = {};
  if (options?.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }
  const payload: Record<string, unknown> = { ...response };
  if (options?.interruptId) {
    payload.interruptId = options.interruptId;
  }
  if (options?.traceContext) {
    payload.langfuseTraceContext = options.traceContext;
  }
  return client.post(
    `/agents/${persona}/workspace/${workspaceId}/chat/stream/respond`,
    payload,
    {
      responseType: "stream",
      signal: options?.signal,
      headers,
    }
  );
}

export async function resumeAgentActionStream(
  persona: string,
  workspaceId: string,
  actionResponse: AgentInterruptActionResponse,
  options?: RunAgentOptions
): Promise<AxiosResponse<IncomingMessage>> {
  const headers: Record<string, string> = {};
  if (options?.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }
  const payload: Record<string, unknown> = { ...actionResponse };
  if (options?.traceContext) {
    payload.langfuseTraceContext = options.traceContext;
  }
  return client.post(
    `/agents/${persona}/workspace/${workspaceId}/chat/stream/act`,
    payload,
    {
      responseType: "stream",
      signal: options?.signal,
      headers,
    }
  );
}

export type InternalAnalyzeResponse = {
  text: string;
};

export async function runInternalAnalysis(
  payload: {
    systemPrompt: string;
    userPrompt: string;
  },
  options?: InternalAgentOptions,
): Promise<InternalAnalyzeResponse> {
  const headers: Record<string, string> = {};
  if (options?.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }
  const res = await client.post('/internal/analyze', payload, { headers });
  return res.data;
}

export type InternalMemoryFileResponse = {
  path: string;
  exists: boolean;
  content: string;
  modifiedAt?: string | null;
};

export async function getInternalMemoryFile(
  path: string,
  options?: InternalAgentOptions,
): Promise<InternalMemoryFileResponse> {
  const headers: Record<string, string> = {};
  if (options?.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }
  const res = await client.get('/internal/memories', {
    headers,
    params: { path },
  });
  return res.data;
}

export async function putInternalMemoryFile(
  payload: { path: string; content: string },
  options?: InternalAgentOptions,
): Promise<InternalMemoryFileResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options?.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }
  const res = await client.put('/internal/memories', payload, { headers });
  return res.data;
}

export async function deleteInternalMemoryFile(
  path: string,
  options?: InternalAgentOptions,
): Promise<{ ok: true; path: string }> {
  const headers: Record<string, string> = {};
  if (options?.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }
  const res = await client.delete('/internal/memories', {
    headers,
    data: { path },
  });
  return res.data;
}

export async function extractWorkspaceDocument(
  workspaceId: string,
  relativePath: string,
  options?: InternalAgentOptions,
): Promise<DocumentExtractionResponse> {
  const headers: Record<string, string> = {};
  if (options?.authToken) headers.Authorization = `Bearer ${options.authToken}`;
  const res = await client.post('/documents/extract', {
    workspaceId,
    relativePath,
  }, {
    timeout: DOCUMENT_EXTRACTION_TIMEOUT_MS,
    headers,
  });
  return res.data;
}

export async function preflightWorkspaceDocument(
  workspaceId: string,
  relativePath: string,
  options?: InternalAgentOptions,
): Promise<{
  sourceType: string;
  bytes: number;
  sourceUnits: number | null;
  nativeCharacters: number | null;
  ocrSourceUnits: number;
  ocrPages: number[];
  ocrTextThreshold: number;
}> {
  const headers: Record<string, string> = {};
  if (options?.authToken) headers.Authorization = `Bearer ${options.authToken}`;
  const res = await client.post('/documents/preflight', { workspaceId, relativePath }, {
    timeout: DOCUMENT_EXTRACTION_TIMEOUT_MS,
    headers,
  });
  return res.data;
}

export async function enrichKnowledgeWindow(payload: {
  workspaceId: string;
  window: Record<string, unknown>;
  blocks: Array<Record<string, unknown>>;
  sourceType: string;
  languageDistribution?: Record<string, number>;
  structuralPath?: string[];
}, options?: InternalAgentOptions): Promise<KnowledgeMapResponse> {
  const headers: Record<string, string> = {};
  if (options?.authToken) headers.Authorization = `Bearer ${options.authToken}`;
  const res = await client.post('/knowledge/ingestion/map', payload, {
    timeout: DOCUMENT_EXTRACTION_TIMEOUT_MS,
    headers,
  });
  return res.data;
}

export async function reduceKnowledgeMapResults(payload: {
  workspaceId: string;
  mapResults: KnowledgeMapResponse[];
  blocks: Array<Record<string, unknown>>;
  fanIn?: number;
}, options?: InternalAgentOptions): Promise<KnowledgeMapResponse> {
  const headers: Record<string, string> = {};
  if (options?.authToken) headers.Authorization = `Bearer ${options.authToken}`;
  const res = await client.post('/knowledge/ingestion/reduce', payload, {
    timeout: DOCUMENT_EXTRACTION_TIMEOUT_MS,
    headers,
  });
  return res.data;
}

export type KnowledgeEmbeddingResponse = {
  provider: string;
  model: string;
  dimensions: number;
  embeddings: Array<{
    id: string;
    values: number[];
    tokenCount: number;
    contentHash?: string | null;
    page?: number | null;
  }>;
};

export async function embedKnowledgeInputs(payload: {
  workspaceId: string;
  inputs: Array<{ id: string; text: string; title?: string }>;
  dimensions?: number;
  taskType?: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
}, options?: InternalAgentOptions): Promise<KnowledgeEmbeddingResponse> {
  const headers: Record<string, string> = {};
  if (options?.authToken) headers.Authorization = `Bearer ${options.authToken}`;
  const res = await client.post('/knowledge/ingestion/embed', payload, {
    timeout: DOCUMENT_EXTRACTION_TIMEOUT_MS,
    headers,
  });
  return res.data;
}

export async function embedKnowledgeMedia(payload: {
  workspaceId: string;
  relativePath: string;
  pages: number[];
  dimensions?: number;
}, options?: InternalAgentOptions): Promise<KnowledgeEmbeddingResponse> {
  const headers: Record<string, string> = {};
  if (options?.authToken) headers.Authorization = `Bearer ${options.authToken}`;
  const res = await client.post('/knowledge/ingestion/embed-media', payload, {
    timeout: DOCUMENT_EXTRACTION_TIMEOUT_MS,
    headers,
  });
  return res.data;
}

export async function analyzeKnowledgeGraph(payload: {
  workspaceId: string;
  concepts: Array<Record<string, unknown>>;
}, options?: InternalAgentOptions): Promise<Record<string, any>> {
  const headers: Record<string, string> = {};
  if (options?.authToken) headers.Authorization = `Bearer ${options.authToken}`;
  const res = await client.post('/knowledge/ingestion/graph-analysis', payload, {
    timeout: DOCUMENT_EXTRACTION_TIMEOUT_MS,
    headers,
  });
  return res.data;
}
