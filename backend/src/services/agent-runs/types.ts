import type {
  AgentDecision,
  AgentHistoryEntry,
  AgentInterruptActionResponse,
  AgentInterruptResponse,
  AgentMessageContentBlock,
  AgentKnowledgeRef,
} from '../agentService';
import type { InteractionRequest } from '@helpudoc/contracts/types';

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
  messageContent?: AgentMessageContentBlock[];
  internetSearchEnabled?: boolean;
  knowledgeRefs?: AgentKnowledgeRef[];
};

export type RunPendingInterrupt = {
  kind?: 'approval' | 'clarification';
  resumeStrategy?: 'fresh_prompt' | 'checkpoint';
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
  interactionRequest?: InteractionRequest;
};

export type RunMeta = {
  workspaceId: string;
  userId?: string;
  persona: string;
  status: AgentRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  turnId?: string;
  pendingInterrupt?: RunPendingInterrupt;
  interactionResponseInterruptId?: string;
  interactionResponseAcceptedAt?: string;
  interactionResponseConsumedAt?: string;
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
  messageContent?: AgentMessageContentBlock[];
  internetSearchEnabled?: boolean;
  knowledgeRefs?: AgentKnowledgeRef[];
};

export type ResumePayload =
  | { decisions: AgentDecision[]; response?: never }
  | { response: AgentInterruptResponse; interruptId?: string; decisions?: never }
  | { action: AgentInterruptActionResponse; decisions?: never; response?: never };

export type PersistedRunMeta = Omit<RunMeta, 'pendingInterrupt'> & {
  pendingInterrupt?: string;
  runContext?: string;
  interactionResponse?: string;
  interactionResponseHash?: string;
  interactionResponseInterruptId?: string;
  interactionResponseAcceptedAt?: string;
  interactionResponseConsumedAt?: string;
};
