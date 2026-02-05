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

export async function fetchAgentCatalog(): Promise<AgentCatalogResponse> {
  const res = await client.get<AgentCatalogResponse>("/agents");
  return res.data;
}

export type AgentHistoryEntry = {
  role: string;
  content: string;
};

type RunAgentOptions = {
  forceReset?: boolean;
  signal?: AbortSignal;
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

  const res = await client.post(`/agents/${persona}/workspace/${workspaceId}/chat`, payload);
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

  return client.post(`/agents/${persona}/workspace/${workspaceId}/chat/stream`, payload, {
    responseType: "stream",
    signal: options?.signal,
  });
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
  });
  return res.data;
}
