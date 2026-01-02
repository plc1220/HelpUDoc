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
