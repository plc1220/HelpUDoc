export type WorkspaceLifecycleAction = 'unshare' | 'reshare' | 'trash' | 'restore' | 'leave' | 'reconnect';

export interface Workspace {
  id: string;
  name: string;
  lastUsed: string;
  status?: 'active' | 'unshared' | 'trashed';
  unsharedAt?: string | null;
  trashedAt?: string | null;
  purgeAfter?: string | null;
  slug?: string;
  role?: 'owner' | 'editor' | 'contributor' | 'commenter' | 'viewer';
  canEdit?: boolean;
  canPublish?: boolean;
  visibility?: 'private' | 'team';
  workspaceType?: 'private' | 'team';
  editingPolicy?: 'direct' | 'review' | null;
  contentRevision?: number;
  audienceType?: 'private' | 'selected_people' | 'team';
  teamId?: string | null;
  teamName?: string | null;
  publicationStatus?:
    | 'private_draft'
    | 'up_to_date'
    | 'changes_to_publish'
    | 'withdrawn'
    | 'team_updates_available'
    | 'review_needed'
    | 'detached';
  linkedTeamWorkspaceId?: string | null;
  privateCopyWorkspaceId?: string | null;
  currentPublishedVersionId?: string | null;
  currentPublishedVersionNumber?: number | null;
  publishedVersionCount?: number;
  pendingProposalCount?: number;
  latestPublisherName?: string | null;
  lastPublishedAt?: string | null;
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
  version?: number;
  currentVersionId?: string | null;
  deletedAt?: string | null;
  staleOverwrite?: boolean;
  status?: FileStatus;
  statusUpdatedAt?: string | null;
  statusUpdatedBy?: string | null;
  approvedAtVersion?: number | null;
  publishedAtVersion?: number | null;
}

/** Stable reference to a workspace file used by chat and agent-run payloads. */
export interface TaggedFileRef {
  fileId: number;
  version?: number;
  name?: string;
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
  relatedFiles?: ToolOutputFile[];
}

export interface ToolOutputFile {
  path: string;
  mimeType?: string | null;
  size?: number;
}

/** Stream event + durable dashboard package; no TTL or live URL. */
export interface DashboardArtifactInfo {
  dashboardPath: string;
  workspaceId?: string;
  dashboardId?: string;
  title?: string;
  status: 'generating' | 'ready' | 'error';
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

export type InteractionPresentation =
  | 'questionnaire'
  | 'style_preview'
  | 'action_review'
  | 'plan_review';

export type InteractionRequest = {
  contract: 'helpudoc.interaction';
  version: '1';
  interactionId: string;
  presentation: InteractionPresentation;
  props: Record<string, unknown>;
  gateId?: string;
  skill?: string;
  required?: boolean;
  resumeAction?: {
    endpoint: 'respond' | 'decision' | 'act';
    actionId?: string;
  };
  metadata?: Record<string, unknown>;
};

export type InteractionResponse = {
  interactionId: string;
  actionId: string;
  values?: Record<string, unknown>;
  decision?: 'approve' | 'edit' | 'reject' | 'submit' | 'cancel';
  message?: string;
  metadata?: Record<string, unknown>;
};

export type WorkflowActionKind =
  | 'request_user_interaction'
  | 'generate_artifact'
  | 'revise_artifact'
  | 'call_tool'
  | 'complete'
  | 'fail';

export interface WorkflowActionEvent {
  action: WorkflowActionKind;
  reason?: string;
  gateId?: string | null;
  presentation?: InteractionPresentation | null;
  artifactRefs?: unknown[];
  context?: Record<string, unknown>;
  timestamp?: string;
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
  interactionRequest?: InteractionRequest;
}

export interface ConversationMessageMetadata {
  thinkingText?: string;
  toolEvents?: ToolEvent[];
  bodySource?: 'assistant' | 'summary';
  runId?: string;
  status?: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  pendingInterrupt?: PendingInterrupt;
  runPolicy?: {
    skill?: string;
    requiresHitlPlan?: boolean;
    requiresArtifacts?: boolean;
    requiredArtifactsMode?: string;
    prePlanSearchLimit?: number;
    prePlanSearchUsed?: number;
  };
  taggedFiles?: string[];
  taggedFileRefs?: TaggedFileRef[];
  knowledgeRefs?: Array<{
    id: number;
    title: string;
    snapshotHash?: string | null;
  }>;
  awaitingImplicitInput?: boolean;
  implicitInputReason?: 'missing_interrupt';
  implicitInputPrompt?: string;
  workflowActions?: WorkflowActionEvent[];
  progressEvents?: Array<{
    phase: string;
    label: string;
    detail?: string;
    status?: 'pending' | 'running' | 'completed' | 'error';
    stepIndex?: number;
    stepCount?: number;
    toolName?: string;
    artifactPath?: string;
    timestamp?: string;
  }>;
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

export type WorkspaceScheduleStatus = 'active' | 'paused' | 'error';
export type WorkspaceScheduleCadence = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';
export type WorkspaceScheduleOutputMode = 'append_to_conversation' | 'new_conversation_per_run';
export type WorkspaceScheduleNotificationMode = 'none' | 'failure' | 'all';
export type WorkspaceScheduleRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkspaceScheduleRun {
  id: string;
  scheduleId: string;
  workspaceId: string;
  conversationId?: string | null;
  agentRunId?: string | null;
  status: WorkspaceScheduleRunStatus;
  triggeredBy: 'scheduler' | 'manual';
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSchedule {
  id: string;
  workspaceId: string;
  name: string;
  status: WorkspaceScheduleStatus;
  cadence: WorkspaceScheduleCadence;
  cronExpression: string;
  timezone: string;
  prompt: string;
  persona: string;
  selectedSkills: string[];
  contextRefs: string[];
  taggedFiles: string[];
  outputMode: WorkspaceScheduleOutputMode;
  notificationMode: WorkspaceScheduleNotificationMode;
  sourceConversationId?: string | null;
  sourceMessageId?: number | null;
  targetConversationId?: string | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastRunStatus?: WorkspaceScheduleRunStatus | null;
  lastError?: string | null;
  createdBy?: string | null;
  runAsUserId?: string | null;
  createdAt: string;
  updatedAt: string;
  recentRuns?: WorkspaceScheduleRun[];
}

export type WorkspaceScheduleDraft = {
  name: string;
  cadence: WorkspaceScheduleCadence;
  cronExpression: string;
  timezone: string;
  prompt: string;
  persona: string;
  selectedSkills?: string[];
  contextRefs?: string[];
  taggedFiles?: string[];
  outputMode: WorkspaceScheduleOutputMode;
  notificationMode: WorkspaceScheduleNotificationMode;
  sourceConversationId?: string | null;
  sourceMessageId?: number | null;
  targetConversationId?: string | null;
};

export interface SkillDefinition {
  id: string;
  name: string;
  description?: string;
  valid: boolean;
  error?: string;
  warning?: string;
  pluginId?: string;
  pluginName?: string;
}

export interface PluginDefinition {
  id: string;
  displayName: string;
  description?: string;
  defaultSkillId: string;
  skillIds: string[];
  tools: string[];
  mcpServers: string[];
  scripts?: string[];
  valid: boolean;
  errors?: string[];
}

export interface ReflectionScorecard {
  outcome: number;
  reliability: number;
  friction: number;
}

export interface ReflectionRecommendation {
  id: string;
  title: string;
  detail: string;
  priority: 'high' | 'medium' | 'low';
}

export interface ReflectionConversationSample {
  conversationId: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
  userId?: string | null;
  userDisplayName?: string | null;
  title?: string | null;
  status: 'completed' | 'failed' | 'cancelled' | 'awaiting_approval' | 'running' | 'queued';
  excerpt?: string | null;
}

export interface ReflectionBreakdown {
  id: number;
  reflectionId: number;
  dimension: 'skill' | 'tool' | 'user' | 'workspace';
  entityKey: string;
  label: string;
  rank: number;
  metrics: Record<string, unknown>;
  summary?: string | null;
}

export interface DailyReflection {
  id: number;
  reflectionDate: string;
  timezone: string;
  status: 'ready' | 'running' | 'failed';
  scorecard: ReflectionScorecard;
  summaryMarkdown: string;
  metrics: Record<string, unknown>;
  recommendations: ReflectionRecommendation[];
  sampledConversations: ReflectionConversationSample[];
  breakdowns: ReflectionBreakdown[];
  createdAt: string;
  updatedAt: string;
}

export interface ReflectionTrendPoint {
  reflectionDate: string;
  timezone: string;
  scorecard: ReflectionScorecard;
  metrics: Record<string, unknown>;
}

export type UserMemoryScope = 'global' | 'workspace';
export type UserMemorySection = 'preferences' | 'context' | 'skill-routing';
export type UserMemorySuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

export interface UserMemoryView {
  globalPreferences: string;
  globalContext: string;
  globalSkillRouting: string;
  workspacePreferences: string;
  workspaceContext: string;
  workspaceSkillRouting: string;
}

export interface UserMemorySuggestion {
  id: string;
  userId: string;
  workspaceId?: string | null;
  sourceConversationId?: string | null;
  sourceRunId?: string | null;
  targetPath: string;
  targetScope: UserMemoryScope;
  targetSection: UserMemorySection;
  baseContentHash: string;
  proposedContent: string;
  rationale: string;
  status: UserMemorySuggestionStatus;
  reviewedContent?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SkillEvolutionTargetKind = 'memory_skill_routing' | 'skill_learnings';

export type SkillEvolutionSuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

export interface SkillEvolutionEvidence {
  sourceRunIds: string[];
  sourceConversationIds: string[];
  workspaceId?: string | null;
  userId?: string | null;
  persona?: string | null;
  skillId?: string | null;
  transcriptExcerpt?: string | null;
  telemetrySummary?: string | null;
}

export interface SkillEvolutionSuggestion {
  id: string;
  targetKind: SkillEvolutionTargetKind;
  memoryUserId: string;
  memoryTargetPath?: string | null;
  targetSkillId?: string | null;
  workspaceId?: string | null;
  evidence: SkillEvolutionEvidence;
  rationale: string;
  baseContentHash: string;
  /** Snapshot of target file content when the suggestion was created (for admin diff review). */
  baseContentSnapshot?: string | null;
  proposedContent: string;
  status: SkillEvolutionSuggestionStatus;
  reviewedContent?: string | null;
  reviewedAt?: string | null;
  reviewedByUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Per-file provenance audit trail.
 *
 * `file_audit_events` is append-only and deliberately denormalized: workspace
 * deletion hard-deletes `files`/`file_versions`, so the trail carries its own
 * copy of the identity it describes.
 */
export type FileAuditActorType = 'human' | 'agent' | 'system';

export type FileAuditEventType =
  | 'file.created'
  | 'file.content_updated'
  | 'file.agent_generated'
  | 'file.renamed'
  | 'file.moved'
  | 'file.restored'
  | 'file.deleted'
  | 'file.canonicalized'
  | 'file.synced_from_publication'
  | 'file.tombstoned_by_sync'
  | 'file.workspace_published'
  | 'file.workspace_withdrawn'
  | 'status.submitted'
  | 'status.approved'
  | 'status.changes_requested'
  | 'status.published'
  | 'status.reverted'
  | 'status.unpublished';

export interface FileAuditEvent {
  id: string;
  fileId: number;
  workspaceId: string;
  filePath: string;
  seq: number;
  eventType: FileAuditEventType;
  actorUserId?: string | null;
  actorType: FileAuditActorType;
  actorDisplayName?: string | null;
  sha256?: string | null;
  objectKey?: string | null;
  fileVersionId?: string | null;
  sourceFileVersionId?: string | null;
  fileVersion?: number | null;
  runId?: string | null;
  conversationId?: string | null;
  turnId?: string | null;
  conversationMessageId?: number | null;
  langfuseTraceId?: string | null;
  payload: Record<string, unknown>;
  prevEventHash?: string | null;
  eventHash: string;
  occurredAt: string;
}

/** One event as rendered into a provenance document. */
export interface FileProvenanceEvent extends FileAuditEvent {
  /**
   * `prior` marks events inherited from another workspace across a publication
   * boundary — `files.id` is workspace-scoped, so a published document's
   * history spans two chains.
   */
  chain: 'current' | 'prior';
  actor?: { userId: string | null; displayName: string | null } | null;
  /** Agent run detail, joined in when the event came from a run. */
  provenance?: FileAgentProvenance | null;
}

export interface FileAgentProvenance {
  runId: string;
  userPrompt?: string | null;
  enrichedPrompt?: string | null;
  responseText?: string | null;
  skillsInvoked?: Array<{ skillId: string; loadedAt?: string | null }>;
  knowledgeRefsDeclared?: Array<{
    id: number;
    title: string;
    snapshotHash?: string | null;
    okfVersion?: string | null;
  }>;
  knowledgeChunksRetrieved?: Array<{
    path: string;
    title?: string | null;
    snapshotId?: string | null;
    score?: number | null;
    sourceLocations?: unknown[];
  }>;
  taggedFileRefs?: TaggedFileRef[];
  langfuseTraceId?: string | null;
  langfuseTraceUrl?: string | null;
  conversationMessageId?: number | null;
  truncated?: Record<string, boolean>;
}

export type FileProvenanceOriginKind =
  | 'uploaded'
  | 'agent_generated'
  | 'synced'
  | 'unknown';

export interface FileProvenanceOrigin {
  kind: FileProvenanceOriginKind;
  occurredAt: string | null;
  actor?: { userId: string | null; displayName: string | null } | null;
  runId?: string | null;
  /** Set when the trail continues in a workspace this file was published from. */
  priorWorkspace?: {
    workspaceId: string;
    fileId: number | null;
    linkedVia: 'sourceFileVersionId';
    bridgeVersionId: string;
    eventCount: number;
    accessible: boolean;
  } | null;
}

export interface FileProvenanceDocument {
  schemaVersion: string;
  file: {
    id: number;
    workspaceId: string;
    name: string;
    currentVersion: number;
    createdAt?: string | null;
    deletedAt?: string | null;
  };
  origin: FileProvenanceOrigin;
  events: FileProvenanceEvent[];
  integrity: {
    chainHead: string | null;
    verified: boolean;
    brokenAtSeq?: number | null;
    eventCount: number;
  };
}

/**
 * Editorial lifecycle of a file.
 *
 * `published` is reached only by the per-file publication step, which exports
 * an immutable artifact — it is never set directly through the status API.
 */
export type FileStatus = 'draft' | 'in_review' | 'approved' | 'published';

/** A transition the calling user is currently permitted to make. */
export interface FileStatusTransition {
  toStatus: FileStatus;
  /** True when the server will reject the call without a reason. */
  requiresReason: boolean;
  /** Moves the file backwards; restricted to privileged roles. */
  isRevert: boolean;
  label: string;
}

export interface FileStatusState {
  fileId: number;
  workspaceId: string;
  status: FileStatus;
  version: number;
  statusUpdatedAt?: string | null;
  statusUpdatedBy?: string | null;
  approvedAtVersion?: number | null;
  publishedAtVersion?: number | null;
  /**
   * The content has changed since it was approved or published. Approval
   * attaches to a specific version, so this is how a reviewer sees that what
   * they signed off is no longer what is there.
   */
  drift: boolean;
  /** Rendered by the UI; the server remains the authority. */
  allowedTransitions: FileStatusTransition[];
}

export interface FileStatusTransitionRequest {
  toStatus: FileStatus;
  reason?: string;
  /** Rejects the change if the file moved on since it was read. */
  expectedVersion?: number;
}

export interface WorkspaceFileStatusSummary {
  counts: Record<FileStatus, number>;
  reviewQueue: Array<{
    fileId: number;
    name: string;
    version: number;
    status: FileStatus;
    statusUpdatedAt?: string | null;
    drift: boolean;
  }>;
}
