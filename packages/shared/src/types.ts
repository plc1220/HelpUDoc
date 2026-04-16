export interface Workspace {
  id: string;
  name: string;
  lastUsed: string;
  slug?: string;
  role?: 'owner' | 'editor' | 'viewer';
  canEdit?: boolean;
  skipPlanApprovals?: boolean;
  createdAt?: string;
  updatedAt?: string;
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
  understandingStatus?: DerivedArtifactStatus | null;
  understandingMode?: DerivedArtifactMode | null;
  understandingError?: string | null;
  derivedArtifactFileId?: number | null;
}

export type GoogleDrivePickerScope = 'recent' | 'my-drive' | 'shared';

export type GoogleDriveIconHint = 'docs' | 'sheets' | 'slides' | 'pdf' | 'image' | 'file';

export interface GoogleDrivePickerItem {
  id: string;
  name: string;
  mimeType: string;
  webViewUrl?: string | null;
  modifiedTime?: string | null;
  ownerNames?: string[];
  size?: string | null;
  iconHint: GoogleDriveIconHint;
  scope?: GoogleDrivePickerScope;
}

export interface GoogleDriveSearchResult {
  files: GoogleDrivePickerItem[];
  nextPageToken?: string | null;
}

export type DerivedArtifactStatus = 'pending' | 'partial' | 'ready' | 'failed' | 'superseded';
export type DerivedArtifactMode = 'part' | 'parser' | 'hybrid';
export type AttachmentPrepStatus = 'pending' | 'running' | 'ready' | 'failed';

export interface FileContextRef {
  sourceFileId: number;
  sourceName: string;
  sourceMimeType?: string | null;
  sourceVersionFingerprint: string;
  artifactId: string;
  artifactVersion: number;
  derivedArtifactFileId?: number | null;
  derivedArtifactPath?: string | null;
  effectiveMode: DerivedArtifactMode;
  status: DerivedArtifactStatus;
  summary?: string | null;
  lastError?: string | null;
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

export interface InterruptChoice {
  id: string;
  label: string;
  description?: string;
  value: string;
}

export interface InterruptQuestionOption {
  id: string;
  label: string;
  description?: string;
  value: string;
}

export interface InterruptQuestion {
  id: string;
  header: string;
  question: string;
  options?: InterruptQuestionOption[];
}

export type InterruptAnswerValue = string | string[];
export type InterruptAnswersByQuestionId = Record<string, InterruptAnswerValue>;

export interface InterruptAction {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'danger';
  inputMode?: 'none' | 'text';
  placeholder?: string;
  submitLabel?: string;
  confirm?: boolean;
  value?: string;
  payload?: Record<string, unknown>;
}

export interface InterruptResponseSpec {
  inputMode?: 'none' | 'text' | 'choice' | 'text_or_choice';
  multiple?: boolean;
  submitLabel?: string;
  placeholder?: string;
  allowDismiss?: boolean;
  dismissLabel?: string;
  choices?: InterruptChoice[];
  questions?: InterruptQuestion[];
}

export interface PendingInterrupt {
  kind?: 'approval' | 'clarification';
  interruptId?: string;
  title?: string;
  description?: string;
  stepIndex?: number;
  stepCount?: number;
  actions?: InterruptAction[];
  actionRequests?: Array<{ name?: string; args?: Record<string, unknown> }>;
  reviewConfigs?: Array<{ action_name?: string; allowed_decisions?: string[] }>;
  responseSpec?: InterruptResponseSpec;
  displayPayload?: Record<string, unknown>;
}

export interface ConversationMessageMetadata {
  thinkingText?: string;
  toolEvents?: ToolEvent[];
  bodySource?: 'assistant' | 'summary';
  runId?: string;
  status?: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  attachmentJobId?: string;
  attachmentPrepStatus?: AttachmentPrepStatus;
  attachmentPrepError?: string;
  pendingInterrupt?: PendingInterrupt;
  runPolicy?: {
    skill?: string;
    requiresHitlPlan?: boolean;
    requiresArtifacts?: boolean;
    requiredArtifactsMode?: string;
    prePlanSearchLimit?: number;
    prePlanSearchUsed?: number;
  };
  fileContextRefs?: FileContextRef[];
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
