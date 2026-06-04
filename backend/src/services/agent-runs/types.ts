import type {
  AgentDecision,
  AgentHistoryEntry,
  AgentInterruptActionResponse,
  AgentInterruptResponse,
  AgentMessageContentBlock,
} from '../agentService';
import type { FileContextRef, UIRequest, A2UIRequest } from '@helpudoc/contracts/types';

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StartRunParams = {
  workspaceId: string;
  conversationId?: string;
  persona: string;
  prompt: string;
  userId?: string;
  history?: AgentHistoryEntry[];
  forceReset?: boolean;
  turnId?: string;
  authToken?: string;
  fileContextRefs?: FileContextRef[];
  messageContent?: AgentMessageContentBlock[];
  internetSearchEnabled?: boolean;
};

export type RunPendingInterrupt = {
  kind?: 'approval' | 'clarification';
  interruptId?: string;
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
    choices?: Array<{ id?: string; label?: string; description?: string; value?: string }>;
    questions?: Array<{
      id?: string;
      header?: string;
      question?: string;
      options?: Array<{ id?: string; label?: string; description?: string; value?: string }>;
    }>;
  };
  displayPayload?: Record<string, unknown>;
  uiRequest?: UIRequest;
  a2uiRequest?: A2UIRequest;
};

export type RunMeta = {
  workspaceId: string;
  persona: string;
  status: AgentRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  turnId?: string;
  pendingInterrupt?: RunPendingInterrupt;
};

export type RunContext = {
  params: StartRunParams;
};

export type PersistedRunContext = {
  workspaceId: string;
  conversationId?: string;
  persona: string;
  prompt: string;
  userId?: string;
  history?: AgentHistoryEntry[];
  forceReset?: boolean;
  turnId?: string;
  fileContextRefs?: FileContextRef[];
  messageContent?: AgentMessageContentBlock[];
  internetSearchEnabled?: boolean;
};

export type ResumePayload =
  | { decisions: AgentDecision[]; response?: never }
  | { response: AgentInterruptResponse; decisions?: never }
  | { action: AgentInterruptActionResponse; decisions?: never; response?: never };

export type PersistedRunMeta = Omit<RunMeta, 'pendingInterrupt'> & {
  pendingInterrupt?: string;
  runContext?: string;
};
