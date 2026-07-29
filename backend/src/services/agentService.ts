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
): Promise<DocumentExtractionResponse> {
  const res = await client.post('/documents/extract', {
    workspaceId,
    relativePath,
  }, {
    timeout: DOCUMENT_EXTRACTION_TIMEOUT_MS,
  });
  return res.data;
}
