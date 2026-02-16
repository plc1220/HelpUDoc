import axios from "axios";
import type { AxiosResponse } from "axios";
import type { IncomingMessage } from "http";

const AGENT_URL = process.env.AGENT_URL || "http://localhost:8001";

export interface AgentMetadata {
  name: string;
  displayName: string;
  description?: string;
  tools?: string[];
  subagents?: Array<{ name: string; description: string }>;
}

interface AgentCatalogResponse {
  agents: AgentMetadata[];
}

const client = axios.create({
  baseURL: AGENT_URL,
});

const resolvePaper2SlidesTimeoutMs = (): number => {
  const raw = process.env.PAPER2SLIDES_TIMEOUT_MS || process.env.PAPER2SLIDES_AGENT_TIMEOUT_MS || '';
  if (!raw) return 30 * 60 * 1000; // 30 minutes
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30 * 60 * 1000;
  return Math.floor(parsed);
};

const PAPER2SLIDES_TIMEOUT_MS = resolvePaper2SlidesTimeoutMs();

export async function fetchAgentCatalog(): Promise<AgentCatalogResponse> {
  const res = await client.get<AgentCatalogResponse>("/agents");
  return res.data;
}

export type AgentHistoryEntry = {
  role: string;
  content: string;
};

export type AgentDecision = {
  type: 'approve' | 'edit' | 'reject';
  edited_action?: { name: string; args: Record<string, unknown> };
  message?: string;
};

type RunAgentOptions = {
  forceReset?: boolean;
  signal?: AbortSignal;
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
  return client.post(
    `/agents/${persona}/workspace/${workspaceId}/chat/stream/resume`,
    { decisions },
    {
      responseType: "stream",
      signal: options?.signal,
      headers,
    }
  );
}

export async function fetchRagStatuses(
  workspaceId: string,
  files: string[],
): Promise<Record<string, { status: string; updatedAt?: string; error?: string }>> {
  const res = await client.post(`/rag/workspaces/${workspaceId}/status`, { files });
  return res.data?.statuses || {};
}

export type Paper2SlidesFilePayload = {
  name: string;
  contentB64: string;
};

export type Paper2SlidesOptionsPayload = {
  output?: 'slides' | 'poster';
  content?: 'paper' | 'general';
  style?: string;
  length?: 'short' | 'medium' | 'long';
  mode?: 'fast' | 'normal';
  parallel?: number | boolean;
  fromStage?: 'rag' | 'summary' | 'plan' | 'generate' | 'analysis';
  exportPptx?: boolean;
};

export type Paper2SlidesImagePayload = {
  name: string;
  contentB64: string;
};

export type Paper2SlidesRunResponse = {
  pdfB64?: string;
  pptxB64?: string;
  images: Paper2SlidesImagePayload[];
};

export async function runPaper2Slides(payload: {
  files: Paper2SlidesFilePayload[];
  options: Paper2SlidesOptionsPayload;
}): Promise<Paper2SlidesRunResponse> {
  const res = await client.post(`/paper2slides/run`, payload, {
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: PAPER2SLIDES_TIMEOUT_MS,
  });
  return res.data;
}

export async function exportPaper2SlidesPptx(payload: {
  fileName: string;
  contentB64: string;
}): Promise<{ pptxB64: string }> {
  const res = await client.post(`/paper2slides/export-pptx`, payload, {
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: PAPER2SLIDES_TIMEOUT_MS,
  });
  return res.data;
}
