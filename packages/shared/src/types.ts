export interface Workspace {
  id: string;
  name: string;
  lastUsed: string;
}

export interface File {
  id: string;
  name: string;
  workspaceId?: string;
  storageType?: 'local' | 's3';
  path?: string;
  mimeType?: string | null;
  publicUrl?: string | null;
  content?: string;
}

export interface AgentPersona {
  name: string;
  displayName: string;
  description?: string;
}

export interface ConversationSummary {
  id: string;
  workspaceId: string;
  persona: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolEvent {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  summary?: string;
  startedAt: string;
  finishedAt?: string;
  outputFiles?: ToolOutputFile[];
}

export interface ToolOutputFile {
  path: string;
  mimeType?: string | null;
  size?: number;
}

export interface ConversationMessageMetadata {
  thinkingText?: string;
  toolEvents?: ToolEvent[];
  runId?: string;
  status?: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  pendingInterrupt?: {
    actionRequests?: Array<{ name?: string; args?: Record<string, unknown> }>;
    reviewConfigs?: Array<{ action_name?: string; allowed_decisions?: string[] }>;
  };
  runPolicy?: {
    skill?: string;
    requiresHitlPlan?: boolean;
    requiresArtifacts?: boolean;
    requiredArtifactsMode?: string;
    prePlanSearchLimit?: number;
    prePlanSearchUsed?: number;
  };
}

export interface ConversationMessage {
  id: number | string;
  conversationId: string;
  sender: 'user' | 'agent';
  text: string;
  createdAt: string;
  updatedAt?: string;
  turnId?: string;
  thinkingText?: string;
  toolEvents?: ToolEvent[];
  metadata?: ConversationMessageMetadata | null;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description?: string;
  valid: boolean;
  error?: string;
  warning?: string;
}
