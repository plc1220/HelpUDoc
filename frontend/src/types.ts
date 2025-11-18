export interface Workspace {
  id: string;
  name: string;
  lastUsed: string; // Or Date
}

export interface File {
  id: string;
  name: string;
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
  status: 'running' | 'completed';
  summary?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface ConversationMessage {
  id: number | string;
  conversationId: string;
  sender: 'user' | 'agent';
  text: string;
  createdAt: string;
  thinkingText?: string;
  toolEvents?: ToolEvent[];
}
