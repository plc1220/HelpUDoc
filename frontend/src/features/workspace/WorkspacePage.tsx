import { lazy, Suspense, useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent } from 'react';
import type { ComponentProps, CSSProperties } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  CssBaseline,
  ThemeProvider,
  type PaletteMode,
} from '@mui/material';
import { Check, CheckSquare, Copy, Edit, Trash, Plus, Minus, X, ChevronLeft, ChevronDown, RotateCcw, Printer, Download, Link as LinkIcon, Loader2, FolderPlus, FolderUp, Upload, Home, ArrowUp, Search, File as FileIcon, Wrench, Plug, Sparkles, Info } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getWorkspaces, createWorkspace, deleteWorkspace, renameWorkspace } from '../../services/workspaceApi';
import {
  getFiles,
  createFile,
  createFolder,
  createTextFile,
  getFolders,
  importGoogleDriveFiles,
  updateFileContent,
  deleteFolder,
  deleteFile,
  getFileContent,
  renameFolder,
  renameFile,
  getRagStatuses,
  resolveFileContextRefs,
} from '../../services/fileApi';
import {
  createAttachmentPrepJob,
  getAttachmentPrepJob,
  type AttachmentPrepJob,
} from '../../services/attachmentPrepApi';
import {
  cancelRun,
  fetchSlashMetadata,
  getRunStatus,
  startAgentRun,
  streamAgentRun,
  submitRunAction,
  submitRunDecision,
  submitRunResponse,
  type AgentRunStatus,
  type AgentStreamChunk,
} from '../../services/agentApi';
import { vitePublicEnv } from '../../config/env';
import {
  fetchRecentConversations,
  createConversation as createConversationApi,
  fetchConversationDetail,
  appendMessage as appendConversationMessage,
  deleteConversation as deleteConversationApi,
  truncateConversationMessages,
} from '../../services/conversationApi';
import type {
  Workspace,
  File as WorkspaceFile,
  AgentPersona,
  ConversationSummary,
  ConversationMessage,
  ToolEvent,
  ToolOutputFile,
  DashboardArtifactInfo,
  ConversationMessageMetadata,
  InterruptAction,
  InterruptAnswersByQuestionId,
  InterruptQuestion,
  GoogleDrivePickerItem,
  FileContextRef,
  SkillDefinition,
} from '../../types';
import CollapsibleDrawer from '../../components/CollapsibleDrawer';
import WorkspaceShareDialog from '../../components/WorkspaceShareDialog';
import type { UIBlock } from '../../components/UIBlockRenderer';
import ExpandableSidebar from '../../components/ExpandableSidebar';
import PaneResizeHandle from '../../components/PaneResizeHandle';
import { useHorizontalPaneResize } from '../../hooks/useHorizontalPaneResize';
import WorkspaceFileTree from '../../components/WorkspaceFileTree';
import DashboardCanvas from '../dashboard/components/DashboardCanvas';
import AgentChatPane from '../../components/chat/AgentChatPane';
import LumoPet from '../../components/lumo/LumoPet';
import { buildApprovalDraftContent, buildApprovalReview } from '../chat/interrupts/approvalReview';
import type { RenderableInterruptAction } from '../chat/interrupts/actions';
import DrivePickerModal from '../../components/chat/DrivePickerModal';
import GoogleDriveIcon from '../../components/chat/GoogleDriveIcon';
import type { ChatComposerAttachment } from '../chat/types';
import {
  getDashboardManifestPath,
  normalizeWorkspaceRelativePath,
  resolveDashboardPackagePath,
} from './utils/workspacePaths';
import { useAuth } from '../../auth/useAuth';
import {
  extractToolPathFiles,
  getFriendlyToolName,
  isBenignToolNoise,
  isBenignToolStreamContent,
  translateToolChunkForStorage,
} from '../../utils/toolActivitySummary';
import {
  CANVAS_ZOOM_STEP,
  MAX_CANVAS_ZOOM,
  MIN_CANVAS_ZOOM,
  SLASH_COMMANDS,
} from '../../constants/workspace';
import { isSystemFile, normalizeFilePath } from '../../utils/files';
import { isBinaryOfficeDocument } from '../../utils/officeFiles';
import {
  areStructuredClarificationQuestionsComplete,
  buildClarificationDraftStorageKey,
  buildStructuredClarificationMessage,
  hasStructuredClarificationAnswers,
} from '../../utils/clarifications';
import {
  buildWorkspaceDestinationPath,
  getWorkspaceParentFolderPath,
  normalizeWorkspaceFolderPath,
} from '../../utils/workspaceFileTree';
import { buildMessageMetadata, mapMessagesToAgentHistory, mergeMessageMetadata, sanitizeRunPolicy } from '../../utils/messages';
import { getImplicitContinuationContext, buildContinuationPrompt } from '../../utils/implicitSkillContinuation';
import { createMarkdownComponents } from '../../components/markdown/MarkdownShared';
import { applyColorModeToDocument, buildAppTheme, resolveInitialColorMode, useUITheme } from '../../theme';

const FileEditor = lazy(() => import('../../components/FileEditor'));
const UIBlockRenderer = lazy(() => import('../../components/UIBlockRenderer'));

const drawerWidth = 280;
const FILE_PANE_WIDTH_STORAGE_KEY = 'helpudoc.workspace.filePaneWidth';
const AGENT_PANE_WIDTH_STORAGE_KEY = 'helpudoc.workspace.agentPaneWidth';
const DEFAULT_FILE_PANE_WIDTH = 320;
const DEFAULT_AGENT_PANE_WIDTH = 352;
const COLLAPSED_FILE_PANE_WIDTH = 52;
const COLLAPSED_AGENT_PANE_WIDTH = 48;
const MIN_FILE_PANE_WIDTH = 200;
const MAX_FILE_PANE_WIDTH = 520;
const MIN_AGENT_PANE_WIDTH = 280;
const MAX_AGENT_PANE_WIDTH = 720;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const summarizeComposerAttachments = (attachments: ChatComposerAttachment[]): string => {
  if (!attachments.length) {
    return '';
  }
  return attachments
    .map((attachment) => (attachment.source === 'drive' ? `${attachment.name} (Drive)` : attachment.name))
    .join(', ');
};

const createLocalComposerAttachment = (file: File): Extract<ChatComposerAttachment, { source: 'local' }> => ({
  id: `local:${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(16).slice(2)}`,
  name: file.name || `Pasted image ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
  source: 'local',
  file,
  previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
});

const createDriveComposerAttachment = (
  item: GoogleDrivePickerItem,
): Extract<ChatComposerAttachment, { source: 'drive' }> => ({
  id: `drive:${item.id}:${Math.random().toString(16).slice(2)}`,
  name: item.name,
  source: 'drive',
  driveItem: item,
});

const revokeLocalAttachmentPreview = (attachment: ChatComposerAttachment) => {
  if (attachment.source === 'local' && attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
};

const findLatestFileContextRefs = (messages: ConversationMessage[]): FileContextRef[] | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = messages[index]?.metadata as ConversationMessageMetadata | undefined;
    if (metadata?.fileContextRefs?.length) {
      return metadata.fileContextRefs;
    }
  }
  return undefined;
};

const mergeFileContextRefs = (
  ...groups: Array<FileContextRef[] | undefined>
): FileContextRef[] | undefined => {
  const merged: FileContextRef[] = [];
  const seen = new Set<string>();

  groups.forEach((group) => {
    group?.forEach((ref) => {
      const sourceFileId = String(ref.sourceFileId || '').trim();
      const artifactId = typeof ref.artifactId === 'string' ? ref.artifactId.trim() : '';
      const derivedArtifactFileId = String(ref.derivedArtifactFileId || '').trim();
      const dedupeKey = sourceFileId || artifactId || derivedArtifactFileId;
      if (!dedupeKey || seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);
      merged.push(ref);
    });
  });

  return merged.length ? merged : undefined;
};

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const addFolderPath = (paths: string[], folderPath: string) => {
  const normalized = normalizeWorkspaceFolderPath(folderPath);
  if (!normalized) {
    return paths;
  }
  const next = new Set(paths);
  const parts = normalized.split('/');
  for (let index = 1; index <= parts.length; index += 1) {
    next.add(parts.slice(0, index).join('/'));
  }
  return Array.from(next).sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
};

const replaceFolderPathPrefix = (value: string, sourceFolder: string, destinationFolder: string) => {
  if (value === sourceFolder) {
    return destinationFolder;
  }
  const sourcePrefix = `${sourceFolder}/`;
  if (value.startsWith(sourcePrefix)) {
    return `${destinationFolder}/${value.slice(sourcePrefix.length)}`;
  }
  return value;
};

const getUploadRelativePath = (file: File) => {
  const relativePath = file.webkitRelativePath || file.name;
  return normalizeFilePath(relativePath).replace(/^\/+/, '');
};

const DEFAULT_PERSONA_NAME = 'fast';
const DEFAULT_PERSONAS: AgentPersona[] = [
  {
    name: 'fast',
    displayName: 'Fast',
    description: 'Gemini 3.5 Flash',
  },
  {
    name: 'lite',
    displayName: 'Lite',
    description: 'Gemini Flash Lite (latest)',
  },
  {
    name: 'pro',
    displayName: 'Pro',
    description: 'Gemini 3 Pro (Preview)',
  },
];
const LANDING_PERSONA_ORDER = ['lite', 'fast', 'pro'];
type WorkspaceFileDialogState =
  | { kind: 'create-folder'; value: string; busy: boolean; error?: string }
  | { kind: 'rename-folder'; folder: { path: string; name: string; fileCount: number }; value: string; busy: boolean; error?: string }
  | { kind: 'rename-file'; file: WorkspaceFile; value: string; busy: boolean; error?: string }
  | { kind: 'delete-file'; file: WorkspaceFile; busy: boolean; error?: string }
  | { kind: 'delete-folder'; folder: { path: string; fileCount: number }; busy: boolean; error?: string }
  | { kind: 'bulk-delete'; fileIds: string[]; fileCount: number; busy: boolean; error?: string };

const normalizePersonaName = (name: string): string => {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized || normalized === 'general-assistant') {
    return DEFAULT_PERSONA_NAME;
  }
  if (normalized === 'pro') {
    return 'pro';
  }
  if (normalized === 'lite') {
    return 'lite';
  }
  return 'fast';
};
const STREAM_DEBUG_ENABLED = vitePublicEnv.debugStream;

const editorLoadingFallback = (
  <div className="flex h-full items-center justify-center text-sm text-slate-500">
    Loading editor…
  </div>
);

const canvasLoadingFallback = (
  <div className="flex h-full items-center justify-center text-sm text-slate-500">
    Loading preview…
  </div>
);

type CommandSuggestion = {
  id: string;
  command: string;
  description: string;
};

const getCommandCategory = (command: CommandSuggestion) => {
  if (command.command.startsWith('/skill')) {
    return 'Skills';
  }
  if (command.command.startsWith('/mcp')) {
    return 'Data Sources';
  }
  return 'Automation';
};

type ParsedSlashDirective =
  | { kind: 'skill'; skillId: string; prompt: string; raw: string }
  | { kind: 'mcp'; serverId: string; prompt: string; raw: string }
  | { kind: 'none'; prompt: string; raw: string };

type ActiveRunInfo = {
  runId: string;
  conversationId: string;
  workspaceId: string;
  persona: string;
  turnId: string;
  placeholderId: ConversationMessage['id'];
  lastStreamId?: string;
  streamReconnectAttempts?: number;
  status: AgentRunStatus;
};

type ConversationAttentionState = {
  status: Exclude<AgentRunStatus, 'queued'>;
  label?: string;
  updatedAt: string;
};

const ACTIVE_RUNS_STORAGE_KEY = 'helpudoc-active-runs';
const MARKDOWN_FILE_EXTENSIONS = ['.md'];
const HTML_FILE_EXTENSIONS = ['.html', '.htm'];
const IMAGE_FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];

const generateTurnId = () => {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const DEFAULT_PLAN_FILE_PATH = 'research_plan.md';

const normalizeRunStatus = (
  status?: ConversationMessageMetadata['status'] | AgentRunStatus,
): Exclude<AgentRunStatus, 'queued'> => {
  if (!status || status === 'queued') {
    return 'running';
  }
  return status;
};

const isTerminalRunStatus = (
  status?: ConversationMessageMetadata['status'] | AgentRunStatus,
): status is 'completed' | 'failed' | 'cancelled' => (
  status === 'completed' || status === 'failed' || status === 'cancelled'
);

const trimMilestone = (value?: string): string => {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
};

const isSummaryLikeAgentText = (value?: string): boolean => {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }
  return (
    /^Updated file\s+\//i.test(text) ||
    /^Completed successfully\.?$/i.test(text) ||
    /^The run (failed|was stopped)/i.test(text) ||
    /^Artifact contract failed\.?$/i.test(text) ||
    /^Missing:/i.test(text) ||
    /^PLAN_(APPROVAL|EDIT|REJECTION|REJECT|CLARIFICATION|ACTION)_[A-Z_]+/i.test(text) ||
    /^Command\s*\(/i.test(text)
  );
};

const summarizeMessageFromToolEvents = (
  message?: ConversationMessage | null,
  status?: AgentRunStatus,
): string => {
  const toolEvents = message?.toolEvents || [];
  const latestFinishedEvent = [...toolEvents]
    .reverse()
    .find((event) => {
      if (!(event.status === 'completed' || event.status === 'error')) {
        return false;
      }
      const summary = String(event.summary || '').trim();
      if (!summary || isSummaryLikeAgentText(summary)) {
        return false;
      }
      if (isBenignToolNoise(event)) {
        return false;
      }
      return true;
    });
  if (latestFinishedEvent?.summary?.trim()) {
    return latestFinishedEvent.summary.trim();
  }
  const latestOutputFile = [...toolEvents]
    .reverse()
    .flatMap((event) => event.outputFiles || [])
    .find((file) => typeof file.path === 'string' && file.path.trim());
  if (latestOutputFile?.path) {
    return `Updated file ${latestOutputFile.path}`;
  }
  if (status === 'completed') {
    return 'Completed successfully.';
  }
  if (status === 'failed') {
    return 'The run failed before it could finish.';
  }
  if (status === 'cancelled') {
    return 'The run was stopped before completion.';
  }
  return '';
};

const settleRunningToolEventsForStatus = (
  events: ToolEvent[] | undefined,
  status?: AgentRunStatus,
): ToolEvent[] | undefined => {
  if (!events?.length || !isTerminalRunStatus(status)) {
    return events;
  }
  const finishedAt = new Date().toISOString();
  let changed = false;
  const next = events.map((event) => {
    if (event.status !== 'running') {
      return event;
    }
    changed = true;
    return {
      ...event,
      status: status === 'completed' ? 'completed' as const : 'error' as const,
      finishedAt: event.finishedAt || finishedAt,
    };
  });
  return changed ? next : events;
};

const formatWorkspaceLastUsed = (updatedAt?: string) => {
  if (!updatedAt) {
    return 'Recently';
  }
  const timestamp = new Date(updatedAt).getTime();
  if (Number.isNaN(timestamp)) {
    return 'Recently';
  }
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) {
    return 'Just now';
  }
  if (diffMs < 86_400_000) {
    return 'Today';
  }
  if (diffMs < 172_800_000) {
    return 'Yesterday';
  }
  return new Date(updatedAt).toLocaleDateString();
};

const hydrateWorkspace = (workspace: Omit<Workspace, 'lastUsed'> & { lastUsed?: string }): Workspace => ({
  ...workspace,
  lastUsed: workspace.lastUsed ?? formatWorkspaceLastUsed(workspace.updatedAt),
});

const isDraftWorkspaceFile = (file?: WorkspaceFile | null): boolean =>
  Boolean(file && typeof file.id === 'string' && String(file.id).startsWith('draft:'));

const mergePersistedAgentMessage = (
  persisted: ConversationMessage,
  existing?: ConversationMessage | null,
): ConversationMessage => {
  const hydrated = mergeMessageMetadata(persisted);
  const persistedMetadata = (hydrated.metadata as ConversationMessageMetadata | null | undefined) || {};
  const existingMetadata = (existing?.metadata as ConversationMessageMetadata | null | undefined) || {};
  const persistedStatus = persistedMetadata.status;
  const existingStatus = existingMetadata.status;
  const effectiveStatus = persistedStatus ?? existingStatus;

  const mergedMetadata: ConversationMessageMetadata = {
    ...existingMetadata,
    ...persistedMetadata,
    status: effectiveStatus,
    runPolicy: persistedMetadata.runPolicy ?? existingMetadata.runPolicy,
    pendingInterrupt:
      persistedMetadata.pendingInterrupt !== undefined
        ? persistedMetadata.pendingInterrupt
        : persistedStatus === undefined && effectiveStatus === 'awaiting_approval'
          ? existingMetadata.pendingInterrupt
          : undefined,
  };

  const persistedText = typeof hydrated.text === 'string' ? hydrated.text : '';
  const existingText = typeof existing?.text === 'string' ? existing.text : '';
  const persistedBodySource =
    persistedMetadata.bodySource
    || (persistedText.trim().length ? (isSummaryLikeAgentText(persistedText) ? 'summary' : 'assistant') : undefined);
  const existingBodySource =
    existingMetadata.bodySource
    || (existingText.trim().length ? (isSummaryLikeAgentText(existingText) ? 'summary' : 'assistant') : undefined);

  let mergedText = persistedText;
  let mergedBodySource = persistedBodySource;
  if (!persistedText.trim().length && existingText.trim().length) {
    mergedText = existingText;
    mergedBodySource = existingBodySource;
  } else if (persistedBodySource !== 'assistant' && existingBodySource === 'assistant' && existingText.trim().length) {
    mergedText = existingText;
    mergedBodySource = existingBodySource;
  }

  if (mergedBodySource) {
    mergedMetadata.bodySource = mergedBodySource;
  } else {
    delete mergedMetadata.bodySource;
  }

  return {
    ...hydrated,
    text: mergedText,
    thinkingText: hydrated.thinkingText ?? existing?.thinkingText,
    toolEvents: settleRunningToolEventsForStatus(hydrated.toolEvents ?? existing?.toolEvents, effectiveStatus),
    metadata: Object.keys(mergedMetadata).length ? mergedMetadata : undefined,
  };
};

const loadActiveRunsFromStorage = (): Record<string, ActiveRunInfo> => {
  if (typeof window === 'undefined') {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(ACTIVE_RUNS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, ActiveRunInfo>;
    }
  } catch (error) {
    console.error('Failed to load active runs from storage', error);
  }
  return {};
};

type PersistProgressRequest = {
  runInfo: ActiveRunInfo;
  statusOverride?: AgentRunStatus;
  options?: {
    metadataOverride?: Partial<ConversationMessageMetadata>;
  };
};

export default function WorkspacePage() {
  const navigate = useNavigate();
  const { signOut, user: authUser } = useAuth();
  const [colorMode, setColorMode] = useState<PaletteMode>(resolveInitialColorMode);
  const [uiTheme] = useUITheme();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const [isLandingPageVisible, setIsLandingPageVisible] = useState(true);
  const selectedWorkspaceIdRef = useRef<string | null>(null);
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState('');
  const [isWorkspaceRenameActive, setIsWorkspaceRenameActive] = useState(false);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState('');
  const [workspaceRenameBusy, setWorkspaceRenameBusy] = useState(false);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [folderPaths, setFolderPaths] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFile | null>(null);
  const [selectedFileDetails, setSelectedFileDetails] = useState<WorkspaceFile | null>(null);
  const [selectedDashboardPath, setSelectedDashboardPath] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [dashboardArtifactsByPath, setDashboardArtifactsByPath] = useState<Record<string, DashboardArtifactInfo>>({});
  const [fileContent, setFileContent] = useState('');
  const [conversationMessages, setConversationMessages] = useState<Record<string, ConversationMessage[]>>({});
  const [chatMessage, setChatMessage] = useState('');
  const [editingRetryMessageId, setEditingRetryMessageId] = useState<ConversationMessage['id'] | null>(null);
  const [chatAttachments, setChatAttachments] = useState<ChatComposerAttachment[]>([]);
  const [internetSearchEnabled, setInternetSearchEnabled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [shareWorkspace, setShareWorkspace] = useState<Workspace | null>(null);
  const personas = DEFAULT_PERSONAS;
  const [selectedPersona, setSelectedPersona] = useState(DEFAULT_PERSONA_NAME);
  const [isEditMode, setIsEditMode] = useState(false);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [isAgentPaneVisible, setIsAgentPaneVisible] = useState(true);
  const [isFilePaneVisible, setIsFilePaneVisible] = useState(true);
  const [isFileActionMenuOpen, setIsFileActionMenuOpen] = useState(false);
  const [showSystemFiles, setShowSystemFiles] = useState(false);
  const [conversationStreaming, setConversationStreaming] = useState<Record<string, boolean>>({});
  const [isAgentPaneFullScreen, setIsAgentPaneFullScreen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeConversationPersona, setActiveConversationPersona] = useState<string | null>(null);
  const [isDrivePickerOpen, setIsDrivePickerOpen] = useState(false);
  const [isDriveImporting, setIsDriveImporting] = useState(false);
  const [workspaceFileDialog, setWorkspaceFileDialog] = useState<WorkspaceFileDialogState | null>(null);
  const [isLandingAttachmentMenuOpen, setIsLandingAttachmentMenuOpen] = useState(false);
  const [isLandingWorkspacePickerOpen, setIsLandingWorkspacePickerOpen] = useState(false);
  const [landingWorkspaceQuery, setLandingWorkspaceQuery] = useState('');
  const streamAbortMapRef = useRef<Map<string, AbortController>>(new Map());
  const conversationMessagesRef = useRef<Record<string, ConversationMessage[]>>({});
  const chatAttachmentsRef = useRef<ChatComposerAttachment[]>([]);
  const agentMessageBufferRef = useRef<Map<ConversationMessage['id'], string>>(new Map());
  const agentChunkBufferRef = useRef<Map<string, Map<number, string>>>(new Map());
  const agentChunkFlushTimerRef = useRef<number | null>(null);
  const lastUserMessageMapRef = useRef<Record<string, string>>({});
  const activeRunsRef = useRef<Record<string, ActiveRunInfo>>({});
  const lastPersistedAgentTextRef = useRef<Record<string, string>>({});
  const lastPersistedStatusRef = useRef<Record<string, AgentRunStatus | undefined>>({});
  const lastPersistedMetadataRef = useRef<Record<string, string | undefined>>({});
  const lastPersistAttemptRef = useRef<Record<string, number>>({});
  const persistInFlightRef = useRef<Set<string>>(new Set());
  const pendingPersistRef = useRef<Record<string, PersistProgressRequest>>({});
  const stopRequestedRef = useRef(false);
  const sendLockRef = useRef(false);
  const attachmentPrepPromiseRef = useRef<Map<string, Promise<AttachmentPrepJob>>>(new Map());
  const attachmentPrepResumeRef = useRef<Set<string>>(new Set());
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const fileUploadInputRef = useRef<HTMLInputElement | null>(null);
  const folderUploadInputRef = useRef<HTMLInputElement | null>(null);
  const fileActionMenuRef = useRef<HTMLDivElement | null>(null);
  const landingWorkspacePickerRef = useRef<HTMLDivElement | null>(null);
  const workspaceNameInputRef = useRef<HTMLInputElement | null>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const lastAutoSavedContentRef = useRef<string>('');
  const fileContentRequestIdRef = useRef(0);
  const [isMentionOpen, setIsMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionTriggerIndex, setMentionTriggerIndex] = useState<number | null>(null);
  const [mentionCursorPosition, setMentionCursorPosition] = useState<number | null>(null);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandTriggerIndex, setCommandTriggerIndex] = useState<number | null>(null);
  const [commandCursorPosition, setCommandCursorPosition] = useState<number | null>(null);
  const [commandSelectedIndex, setCommandSelectedIndex] = useState(0);
  const [expandedToolMessages, setExpandedToolMessages] = useState<Set<ConversationMessage['id']>>(new Set());
  const [expandedThinkingMessages, setExpandedThinkingMessages] = useState<Set<ConversationMessage['id']>>(new Set());
  const [copiedCodeBlockId, setCopiedCodeBlockId] = useState<string | null>(null);

  const filteredWorkspaces = useMemo(() => {
    const query = workspaceSearchQuery.trim().toLowerCase();
    if (!query) {
      return workspaces;
    }
    return workspaces.filter((workspace) => workspace.name.toLowerCase().includes(query));
  }, [workspaceSearchQuery, workspaces]);
  const landingFilteredWorkspaces = useMemo(() => {
    const query = landingWorkspaceQuery.trim().toLowerCase();
    if (!query) {
      return workspaces;
    }
    return workspaces.filter((workspace) => workspace.name.toLowerCase().includes(query));
  }, [landingWorkspaceQuery, workspaces]);
  const landingUserName = useMemo(() => {
    const normalized = authUser?.name?.trim();
    if (!normalized) {
      return '';
    }
    return normalized.split(/\s+/)[0] || normalized;
  }, [authUser?.name]);
  const landingPersonas = useMemo(
    () => [...personas].sort((left, right) => {
      const leftIndex = LANDING_PERSONA_ORDER.indexOf(left.name);
      const rightIndex = LANDING_PERSONA_ORDER.indexOf(right.name);
      return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
    }),
    [personas],
  );
  const [copiedImageUrl, setCopiedImageUrl] = useState(false);
  const [ragStatuses, setRagStatuses] = useState<Record<string, { status?: string; updatedAt?: string; error?: string }>>({});
  const [copiedWorkspaceContent, setCopiedWorkspaceContent] = useState(false);
  const [copiedPublicUrlFileId, setCopiedPublicUrlFileId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<ConversationMessage['id'] | null>(null);
  const [availableSkills, setAvailableSkills] = useState<SkillDefinition[]>([]);
  const [availableMcpServers, setAvailableMcpServers] = useState<Array<{ name: string; description?: string }>>([]);
  const [interruptInputByMessageId, setInterruptInputByMessageId] = useState<Record<string, string>>({});
  const [interruptStructuredAnswersByMessageId, setInterruptStructuredAnswersByMessageId] = useState<
    Record<string, InterruptAnswersByQuestionId>
  >({});
  const [interruptSelectedChoicesByMessageId, setInterruptSelectedChoicesByMessageId] = useState<Record<string, string[]>>({});
  const [interruptSubmittingByMessageId, setInterruptSubmittingByMessageId] = useState<Record<string, boolean>>({});
  const [interruptErrorByMessageId, setInterruptErrorByMessageId] = useState<Record<string, string>>({});
  const [conversationAttentionById, setConversationAttentionById] = useState<Record<string, ConversationAttentionState>>({});
  const ragStatusFetchedRef = useRef<Record<string, boolean>>({});
  const resumeInFlightRef = useRef<Set<string>>(new Set());
  const resumeAttemptedRef = useRef<Set<string>>(new Set());
  const theme = useMemo(() => buildAppTheme(colorMode, uiTheme), [colorMode, uiTheme]);

  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspace?.id ?? null;
  }, [selectedWorkspace]);

  useEffect(() => {
    chatAttachmentsRef.current = chatAttachments;
  }, [chatAttachments]);

  useEffect(() => () => {
    chatAttachmentsRef.current.forEach(revokeLocalAttachmentPreview);
  }, []);

  useEffect(() => {
    if (!isFileActionMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const menu = fileActionMenuRef.current;
      if (menu && event.target instanceof Node && menu.contains(event.target)) {
        return;
      }
      setIsFileActionMenuOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isFileActionMenuOpen]);

  useEffect(() => {
    if (!isLandingWorkspacePickerOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const picker = landingWorkspacePickerRef.current;
      if (picker && event.target instanceof Node && picker.contains(event.target)) {
        return;
      }
      setIsLandingWorkspacePickerOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isLandingWorkspacePickerOpen]);

  const messages = useMemo(
    () => (activeConversationId ? conversationMessages[activeConversationId] || [] : []),
    [activeConversationId, conversationMessages],
  );
  const hasRunningAgentMessage = useMemo(
    () =>
      messages.some(
        (message) => message.sender === 'agent' && message.metadata?.status === 'running',
      ),
    [messages],
  );
  const hasPendingInterruptMessage = useMemo(
    () =>
      messages.some(
        (message) =>
          message.sender === 'agent' &&
          (Boolean(message.metadata?.pendingInterrupt) || message.metadata?.status === 'awaiting_approval'),
      ),
    [messages],
  );
  const isStreaming = useMemo(
    () =>
      !hasPendingInterruptMessage &&
      ((activeConversationId ? conversationStreaming[activeConversationId] || false : false) || hasRunningAgentMessage),
    [activeConversationId, conversationStreaming, hasPendingInterruptMessage, hasRunningAgentMessage],
  );
  const systemFiles = useMemo(() => files.filter(isSystemFile), [files]);
  const visibleFiles = useMemo(
    () => (showSystemFiles ? files : files.filter((file) => !isSystemFile(file))),
    [files, showSystemFiles],
  );
  const visibleFolderPaths = useMemo(
    () => (showSystemFiles ? folderPaths : folderPaths.filter((path) => !isSystemFile({ id: `folder:${path}`, name: path }))),
    [folderPaths, showSystemFiles],
  );
  const visibleFileIds = useMemo(() => new Set(visibleFiles.map((file) => file.id)), [visibleFiles]);
  const allFilesSelected = useMemo(() => {
    if (!visibleFiles.length) {
      return false;
    }
    return visibleFiles.every((file) => selectedFiles.has(file.id));
  }, [visibleFiles, selectedFiles]);
  const hiddenFileCount = systemFiles.length;
  const persistActiveRuns = useCallback((runs: Record<string, ActiveRunInfo>) => {
    activeRunsRef.current = runs;
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(ACTIVE_RUNS_STORAGE_KEY, JSON.stringify(runs));
      } catch (error) {
        console.error('Failed to persist active runs', error);
      }
    }
  }, []);

  const setConversationAttention = useCallback((
    conversationId: string,
    status: Exclude<AgentRunStatus, 'queued'>,
    label?: string,
  ) => {
    if (!conversationId) {
      return;
    }
    setConversationAttentionById((prev) => ({
      ...prev,
      [conversationId]: {
        status,
        label: trimMilestone(label),
        updatedAt: new Date().toISOString(),
      },
    }));
  }, []);

  const removeConflictingRuns = useCallback((runs: Record<string, ActiveRunInfo>, runInfo: ActiveRunInfo) => {
    const next = { ...runs };
    Object.entries(next).forEach(([candidateRunId, candidate]) => {
      if (candidateRunId === runInfo.runId) {
        return;
      }
      if (candidate.conversationId === runInfo.conversationId && candidate.turnId === runInfo.turnId) {
        delete next[candidateRunId];
        delete lastPersistedAgentTextRef.current[candidateRunId];
        delete lastPersistedStatusRef.current[candidateRunId];
        delete lastPersistedMetadataRef.current[candidateRunId];
        delete lastPersistAttemptRef.current[candidateRunId];
        resumeInFlightRef.current.delete(candidateRunId);
        resumeAttemptedRef.current.delete(candidateRunId);
      }
    });
    return next;
  }, []);

  const registerActiveRun = useCallback((runInfo: ActiveRunInfo) => {
    const next = {
      ...removeConflictingRuns(activeRunsRef.current, runInfo),
      [runInfo.runId]: runInfo,
    };
    persistActiveRuns(next);
  }, [persistActiveRuns, removeConflictingRuns]);

  const removeActiveRun = useCallback((runId: string) => {
    if (!activeRunsRef.current[runId]) return;
    const next = { ...activeRunsRef.current };
    delete next[runId];
    persistActiveRuns(next);
    delete lastPersistedAgentTextRef.current[runId];
    delete lastPersistedStatusRef.current[runId];
    delete lastPersistedMetadataRef.current[runId];
    delete lastPersistAttemptRef.current[runId];
    resumeInFlightRef.current.delete(runId);
    resumeAttemptedRef.current.delete(runId);
  }, [persistActiveRuns]);

  const removeActiveRunsForTurn = useCallback((conversationId: string, turnId?: string, keepRunId?: string) => {
    if (!turnId) {
      return;
    }
    const next = { ...activeRunsRef.current };
    let changed = false;
    Object.entries(next).forEach(([candidateRunId, candidate]) => {
      if (candidateRunId === keepRunId) {
        return;
      }
      if (candidate.conversationId === conversationId && candidate.turnId === turnId) {
        delete next[candidateRunId];
        delete lastPersistedAgentTextRef.current[candidateRunId];
        delete lastPersistedStatusRef.current[candidateRunId];
        delete lastPersistedMetadataRef.current[candidateRunId];
        resumeInFlightRef.current.delete(candidateRunId);
        resumeAttemptedRef.current.delete(candidateRunId);
        changed = true;
      }
    });
    if (changed) {
      persistActiveRuns(next);
    }
  }, [persistActiveRuns]);

  const getActiveRunForConversation = useCallback((conversationId: string | null) => {
    if (!conversationId) {
      return null;
    }
    const runs = Object.values(activeRunsRef.current);
    const active = runs.find((run) =>
      run.conversationId === conversationId &&
      (run.status === 'running' || run.status === 'awaiting_approval')
    ) || null;
    if (!active) {
      return null;
    }
    const messages = conversationMessagesRef.current[conversationId] || [];
    const hasPlaceholder = messages.some((message) =>
      message.id === active.placeholderId ||
      (message.sender === 'agent' && message.metadata?.runId === active.runId)
    );
    if (!hasPlaceholder) {
      removeActiveRun(active.runId);
      return null;
    }
    return active;
  }, [removeActiveRun]);

  const findRunIdForMessage = useCallback((message: ConversationMessage): string | undefined => {
    const metadataRunId = (message.metadata as ConversationMessageMetadata | undefined)?.runId;
    if (metadataRunId) {
      return metadataRunId;
    }
    const runs = Object.values(activeRunsRef.current);
    const exactRun = runs.find((run) => run.runId === message.id || run.placeholderId === message.id);
    if (exactRun?.runId) {
      return exactRun.runId;
    }
    const sameTurnRun = runs.find(
      (run) => run.conversationId === message.conversationId && message.turnId && run.turnId === message.turnId,
    );
    if (sameTurnRun?.runId) {
      return sameTurnRun.runId;
    }
    const sameConversationRun = runs.find((run) => run.conversationId === message.conversationId);
    return sameConversationRun?.runId;
  }, []);

  const rebuildRunInfoForMessage = useCallback(async (message: ConversationMessage, runId: string): Promise<ActiveRunInfo> => {
    const status = await getRunStatus(runId);
    return {
      runId,
      conversationId: message.conversationId,
      workspaceId: status.workspaceId,
      persona: status.persona,
      turnId: message.turnId || status.turnId || generateTurnId(),
      placeholderId: message.id,
      status: status.status,
    };
  }, []);

  const markRunStreamLaunching = useCallback((runId: string) => {
    resumeAttemptedRef.current.add(runId);
    resumeInFlightRef.current.add(runId);
  }, []);

  useEffect(() => {
    applyColorModeToDocument(colorMode);
  }, [colorMode]);

  useEffect(() => {
    const storedRuns = loadActiveRunsFromStorage();
    persistActiveRuns(storedRuns);
  }, [persistActiveRuns]);

  useEffect(() => {
    if (showSystemFiles) {
      return;
    }
    setSelectedFiles((prev) => {
      let hasHiddenSelections = false;
      for (const id of prev) {
        if (!visibleFileIds.has(id)) {
          hasHiddenSelections = true;
          break;
        }
      }
      if (!hasHiddenSelections) {
        return prev;
      }
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleFileIds.has(id)) {
          next.add(id);
        }
      }
      return next;
    });
  }, [showSystemFiles, visibleFileIds]);

  const toggleColorMode = useCallback(
    () => setColorMode((prev) => (prev === 'light' ? 'dark' : 'light')),
    []
  );
  const mentionSuggestions = useMemo(() => {
    if (!isMentionOpen) {
      return [] as WorkspaceFile[];
    }
    const normalized = mentionQuery.trim().toLowerCase();
    const filtered = visibleFiles.filter((file) =>
      !normalized || file.name.toLowerCase().includes(normalized)
    );
    return filtered.slice(0, 8);
  }, [visibleFiles, isMentionOpen, mentionQuery]);

  const availableSkillMap = useMemo(() => {
    const map = new Map<string, SkillDefinition>();
    availableSkills.forEach((skill) => {
      const skillId = typeof skill.id === 'string' ? skill.id.trim() : '';
      if (skillId) {
        const normalizedSkillId = skillId.toLowerCase();
        map.set(normalizedSkillId, skill);
        if (normalizedSkillId.endsWith('-slides')) {
          map.set(normalizedSkillId.slice(0, -1), skill);
        }
        if (normalizedSkillId.endsWith('/slides')) {
          map.set(normalizedSkillId.slice(0, -1), skill);
        }
      }
    });
    return map;
  }, [availableSkills]);

  const availableMcpServerMap = useMemo(() => {
    const map = new Map<string, { name: string; description?: string }>();
    availableMcpServers.forEach((server) => {
      const serverId = typeof server.name === 'string' ? server.name.trim() : '';
      if (serverId) {
        map.set(serverId.toLowerCase(), server);
      }
    });
    return map;
  }, [availableMcpServers]);

  const commandSuggestions = useMemo(() => {
    if (!isCommandOpen) {
      return [] as CommandSuggestion[];
    }
    const rawQuery = commandQuery.toLowerCase();
    const normalized = rawQuery.trim();
    if (!normalized) {
      const rootCommands = SLASH_COMMANDS.map((command) => ({ ...command }));
      const featuredSkills = availableSkills.slice(0, 5).map((skill) => ({
        id: `skill:${skill.id}`,
        command: `/skill ${skill.id}`,
        description: skill.description || `Use the ${skill.id} skill`,
      }));
      const featuredMcpServers = availableMcpServers.slice(0, 3).map((server) => ({
        id: `mcp:${server.name}`,
        command: `/mcp ${server.name}`,
        description: server.description || `Prefer tools from ${server.name}`,
      }));
      return [...rootCommands, ...featuredSkills, ...featuredMcpServers];
    }
    const skillMatch = rawQuery.match(/^skill(?:\s+(.*))?$/);
    if (skillMatch) {
      const filter = (skillMatch[1] || '').trim();
      return availableSkills
        .filter((skill) => !filter || skill.id.toLowerCase().includes(filter) || (skill.name || '').toLowerCase().includes(filter))
        .slice(0, 8)
        .map((skill) => ({
          id: `skill:${skill.id}`,
          command: `/skill ${skill.id}`,
          description: skill.description || `Use the ${skill.id} skill`,
        }));
    }
    const mcpMatch = rawQuery.match(/^mcp(?:\s+(.*))?$/);
    if (mcpMatch) {
      const filter = (mcpMatch[1] || '').trim();
      return availableMcpServers
        .filter((server) => !filter || server.name.toLowerCase().includes(filter))
        .slice(0, 8)
        .map((server) => ({
          id: `mcp:${server.name}`,
          command: `/mcp ${server.name}`,
          description: server.description || `Prefer tools from ${server.name}`,
        }));
    }
    const matches = SLASH_COMMANDS
      .filter((command) => {
        const commandValue = command.command.slice(1).toLowerCase();
        return commandValue.startsWith(normalized) || command.command.toLowerCase().includes(normalized);
      })
      .map((command) => ({ ...command }));
    if (normalized.startsWith('skill')) {
      return [
        ...matches,
        ...availableSkills.slice(0, 8).map((skill) => ({
          id: `skill:${skill.id}`,
          command: `/skill ${skill.id}`,
          description: skill.description || `Use the ${skill.id} skill`,
        })),
      ];
    }
    if (normalized.startsWith('mcp')) {
      return [
        ...matches,
        ...availableMcpServers.slice(0, 8).map((server) => ({
          id: `mcp:${server.name}`,
          command: `/mcp ${server.name}`,
          description: server.description || `Prefer tools from ${server.name}`,
        })),
      ];
    }
    return matches;
  }, [availableMcpServers, availableSkills, commandQuery, isCommandOpen]);

  const landingCommandGroups = useMemo(() => {
    const order = ['Creation', 'Skills', 'Data Sources', 'Automation'];
    return order
      .map((category) => ({
        category,
        commands: commandSuggestions.filter((command) => getCommandCategory(command) === category),
      }))
      .filter((group) => group.commands.length > 0);
  }, [commandSuggestions]);

  const personaDisplayName = useMemo(() => {
    const personaId = activeConversationPersona || selectedPersona;
    if (!personaId) {
      return 'Agent';
    }
    const normalized = normalizePersonaName(personaId);
    const persona = personas.find((item) => item.name === normalized);
    return persona?.displayName || normalized;
  }, [activeConversationPersona, selectedPersona, personas]);

  const handleModeChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextPersona = normalizePersonaName(event.target.value);
      setSelectedPersona(nextPersona);
      setActiveConversationPersona(nextPersona);
    },
    [],
  );

  const handleLandingWorkspaceSelect = useCallback((workspace: Workspace) => {
    setIsWorkspaceRenameActive(false);
    setWorkspaceNameDraft(workspace.name);
    setFolderPaths([]);
    setSelectedWorkspace(workspace);
    setLandingWorkspaceQuery('');
    setIsLandingWorkspacePickerOpen(false);
  }, []);

  const handleOpenLandingPage = useCallback(() => {
    setIsLandingPageVisible(true);
    setIsAgentPaneFullScreen(false);
    setIsHistoryOpen(false);
  }, []);

  const formatMessageTimestamp = useCallback((value?: string) => {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, []);

  const handleCopyCodeBlock = useCallback(async (blockId: string, content: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      setCopiedCodeBlockId(blockId);
      window.setTimeout(() => {
        setCopiedCodeBlockId((current) => (current === blockId ? null : current));
      }, 1500);
    } catch (error) {
      console.error('Failed to copy code snippet', error);
    }
  }, []);

  const markdownComponents = useMemo(
    () => ({
      ...createMarkdownComponents({
        workspaceId: selectedWorkspace?.id,
        colorMode: colorMode === 'dark' ? 'dark' : 'light',
        paragraphClassName: `mb-4 leading-relaxed ${colorMode === 'dark' ? 'text-slate-200' : 'text-slate-700'}`,
        inlineCodeClassName: colorMode === 'dark'
          ? 'rounded-md border border-slate-700/70 bg-slate-900/80 px-1.5 py-0.5 font-mono text-xs text-slate-100'
          : 'rounded-md border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800',
        codeBlockShell: ({ blockId, codeContent, languageLabel, className, children }) => {
          const copyLabel = copiedCodeBlockId === blockId ? 'Copied' : 'Copy';
          return (
            <div className={`mb-4 mt-2 overflow-hidden rounded-2xl border shadow-lg ${
              colorMode === 'dark'
                ? 'border-slate-700/70 bg-slate-950/90 text-slate-100'
                : 'border-slate-200 bg-white text-slate-900 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.16)]'
            }`}>
              <div className={`flex items-center justify-between border-b px-4 py-2 text-[11px] font-semibold tracking-wide uppercase ${
                colorMode === 'dark'
                  ? 'border-slate-800 bg-slate-900/60 text-slate-300'
                  : 'border-slate-200 bg-slate-50 text-slate-500'
              }`}>
                <span>{languageLabel}</span>
                <button
                  type="button"
                  onClick={() => handleCopyCodeBlock(blockId, codeContent)}
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${
                    colorMode === 'dark'
                      ? 'border-slate-600 text-slate-200 hover:border-slate-400'
                      : 'border-slate-300 text-slate-700 hover:border-slate-400'
                  }`}
                >
                  {copyLabel}
                </button>
              </div>
              <pre className="overflow-x-auto px-4 py-3 text-xs leading-relaxed whitespace-pre-wrap break-words sm:text-sm">
                <code className={`font-mono ${className || ''}`.trim()}>
                  {children}
                </code>
              </pre>
            </div>
          );
        },
      }),
      a({ ...props }: ComponentProps<'a'>) {
        return (
          <a
            {...props}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-blue-600 underline decoration-2 underline-offset-2 hover:text-blue-500"
          />
        );
      },
    }),
    [colorMode, copiedCodeBlockId, handleCopyCodeBlock, selectedWorkspace?.id]
  );

  const toggleToolActivityVisibility = useCallback((messageId: ConversationMessage['id']) => {
    setExpandedToolMessages((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const toggleThinkingVisibility = useCallback((messageId: ConversationMessage['id']) => {
    setExpandedThinkingMessages((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const handleCopyMessageText = useCallback(async (message: ConversationMessage) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return;
    }
    const content = (message.text || message.thinkingText || '').trim();
    if (!content) {
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(message.id);
      window.setTimeout(
        () => setCopiedMessageId((current) => (current === message.id ? null : current)),
        1500
      );
    } catch (error) {
      console.error('Failed to copy message text', error);
    }
  }, []);

  const filePaneResize = useHorizontalPaneResize({
    storageKey: FILE_PANE_WIDTH_STORAGE_KEY,
    defaultWidth: DEFAULT_FILE_PANE_WIDTH,
    minWidth: MIN_FILE_PANE_WIDTH,
    maxWidth: MAX_FILE_PANE_WIDTH,
    enabled: isFilePaneVisible && !isAgentPaneFullScreen,
  });
  const agentPaneResize = useHorizontalPaneResize({
    storageKey: AGENT_PANE_WIDTH_STORAGE_KEY,
    defaultWidth: DEFAULT_AGENT_PANE_WIDTH,
    minWidth: MIN_AGENT_PANE_WIDTH,
    maxWidth: MAX_AGENT_PANE_WIDTH,
    enabled: isAgentPaneVisible && !isAgentPaneFullScreen,
  });

  const filePaneWidth = isFilePaneVisible ? filePaneResize.width : COLLAPSED_FILE_PANE_WIDTH;
  const agentPaneWidth = isAgentPaneFullScreen
    ? '100%'
    : isAgentPaneVisible
      ? agentPaneResize.width
      : COLLAPSED_AGENT_PANE_WIDTH;
  const isPaneResizing = filePaneResize.isResizing || agentPaneResize.isResizing;

  const layoutHeight = '100%';

  useEffect(() => {
    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
    };
  }, []);

  const agentPaneStyles: CSSProperties = {
    flexBasis: agentPaneWidth,
    width: agentPaneWidth,
    flexGrow: isAgentPaneFullScreen ? 1 : 0,
    flexShrink: isAgentPaneFullScreen ? 1 : 0,
    transition: isPaneResizing
      ? 'none'
      : 'flex-basis 0.35s ease, flex-grow 0.35s ease, width 0.35s ease',
  };
  const messageBubbleMaxWidth = isAgentPaneFullScreen ? '100%' : '720px';
  const isDarkMode = colorMode === 'dark';

  const activeFile = selectedDashboardPath ? null : (selectedFileDetails || selectedFile);
  const activeFileName = activeFile?.name ?? '';
  const activeDashboardPath = normalizeWorkspaceRelativePath(selectedDashboardPath || activeFile?.path || activeFile?.name);
  const isDashboardCanvas = Boolean(selectedDashboardPath);
  const activeDashboardArtifact = activeDashboardPath ? dashboardArtifactsByPath[activeDashboardPath] : undefined;
  const activeDashboardDisplayName = activeDashboardPath
    ? (activeDashboardArtifact?.title || activeDashboardPath.split('/').filter(Boolean).pop() || 'Dashboard')
    : '';
  const resolvedDashboardFolder = useMemo(
    () =>
      selectedDashboardPath
        ? resolveDashboardPackagePath(files, selectedDashboardPath)
          || normalizeWorkspaceRelativePath(selectedDashboardPath)
        : '',
    [files, selectedDashboardPath],
  );
  const normalizedFileName = activeFileName.toLowerCase();
  const isMarkdownFile = !!activeFile && MARKDOWN_FILE_EXTENSIONS.some((ext) => normalizedFileName.endsWith(ext));
  const isHtmlFile = !!activeFile && HTML_FILE_EXTENSIONS.some((ext) => normalizedFileName.endsWith(ext));
  const isImageFile = !!activeFile && IMAGE_FILE_EXTENSIONS.some((ext) => normalizedFileName.endsWith(ext));
  const canPrintOrDownloadFile = Boolean(activeFile && (isMarkdownFile || isHtmlFile));
  const canCopyImageUrl = Boolean(isImageFile && activeFile?.publicUrl);
  const canvasBlocks = useMemo<UIBlock[]>(() => {
    if (!activeFile) {
      return [];
    }
    return [
      {
        kind: 'file',
        id: activeFile.id,
        file: activeFile,
        content: fileContent,
      },
    ];
  }, [activeFile, fileContent]);
  const canvasTitle = activeDashboardPath ? activeDashboardDisplayName : selectedFile ? selectedFile.name : 'Editor';
  const canZoomOutCanvas = canvasZoom > MIN_CANVAS_ZOOM;
  const canZoomInCanvas = canvasZoom < MAX_CANVAS_ZOOM;
  const handleCanvasZoomIn = useCallback(() => {
    setCanvasZoom((prev) => Math.min(MAX_CANVAS_ZOOM, Number((prev + CANVAS_ZOOM_STEP).toFixed(2))));
  }, []);
  const handleCanvasZoomOut = useCallback(() => {
    setCanvasZoom((prev) => Math.max(MIN_CANVAS_ZOOM, Number((prev - CANVAS_ZOOM_STEP).toFixed(2))));
  }, []);
  const handleCanvasZoomReset = useCallback(() => {
    setCanvasZoom(1);
  }, []);

  const handleDownloadActiveFile = useCallback(() => {
    if (!activeFile || !(isMarkdownFile || isHtmlFile)) {
      return;
    }
    const blob = new Blob([fileContent], {
      type: isMarkdownFile ? 'text/markdown;charset=utf-8' : 'text/html;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = activeFile.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [activeFile, fileContent, isHtmlFile, isMarkdownFile]);

  const handlePrintActiveFile = useCallback(() => {
    if (!activeFile || !(isMarkdownFile || isHtmlFile)) {
      return;
    }

    const wrapInDocument = (body: string) => `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>${activeFile.name}</title><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;line-height:1.6;color:#0f172a;}pre{background:#0f172a;color:#f8fafc;padding:12px 16px;border-radius:12px;overflow-x:auto;}code{font-family:'SFMono-Regular',Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;font-size:0.9em;}img{max-width:100%;height:auto;border-radius:8px;}h1,h2,h3,h4,h5,h6{margin-top:1.5em;}</style></head><body>${body}</body></html>`;

    const hasHtmlShell = /<html[\s>]/i.test(fileContent);
    const printableContent = isHtmlFile
      ? hasHtmlShell
        ? fileContent
        : wrapInDocument(fileContent)
      : wrapInDocument(
        renderToStaticMarkup(
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{fileContent}</ReactMarkdown>
        )
      );

    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (!printWindow) {
      return;
    }
    printWindow.document.open();
    printWindow.document.write(printableContent);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 300);
  }, [activeFile, fileContent, isHtmlFile, isMarkdownFile]);

  const handleCopyImageUrl = useCallback(async () => {
    if (!activeFile?.publicUrl || !navigator?.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(activeFile.publicUrl);
      setCopiedImageUrl(true);
      window.setTimeout(() => setCopiedImageUrl(false), 1500);
    } catch (error) {
      console.error('Failed to copy image URL', error);
    }
  }, [activeFile]);

  const handleCopyWorkspaceContent = useCallback(async () => {
    if (!selectedFile || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(fileContent);
      setCopiedWorkspaceContent(true);
      window.setTimeout(() => setCopiedWorkspaceContent(false), 1500);
    } catch (error) {
      console.error('Failed to copy workspace content', error);
    }
  }, [fileContent, selectedFile]);

  const handleCopyFilePublicUrl = useCallback(async (file: WorkspaceFile) => {
    if (!file.publicUrl || !navigator?.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(file.publicUrl);
      setCopiedPublicUrlFileId(file.id);
      window.setTimeout(() => {
        setCopiedPublicUrlFileId((current) => (current === file.id ? null : current));
      }, 1500);
    } catch (error) {
      console.error('Failed to copy file public URL', error);
    }
  }, []);

  const applyWorkspaceFileUpdate = useCallback((previousName: string, updated: WorkspaceFile) => {
    const mergeFile = (current: WorkspaceFile) => ({
      ...current,
      ...updated,
      content: updated.content ?? current.content,
    });

    setFiles((prev) => prev.map((item) => (item.id === updated.id ? mergeFile(item) : item)));
    setSelectedFile((prev) => (prev?.id === updated.id ? mergeFile(prev) : prev));
    setSelectedFileDetails((prev) => (prev?.id === updated.id ? mergeFile(prev) : prev));

    if (previousName !== updated.name) {
      setRagStatuses((prev) => {
        const existing = prev[previousName];
        if (!existing) {
          return prev;
        }
        const next = { ...prev };
        next[updated.name] = existing;
        delete next[previousName];
        return next;
      });
    }
  }, []);

  const handleRenameFile = async (file: WorkspaceFile) => {
    if (!selectedWorkspace) return;
    setWorkspaceFileDialog({ kind: 'rename-file', file, value: file.name, busy: false });
  };

  const handleRenameFolder = async (folder: { path: string; name: string; fileCount: number }) => {
    if (!selectedWorkspace || !folder.path) return;
    setWorkspaceFileDialog({ kind: 'rename-folder', folder, value: folder.name, busy: false });
  };

  const handleMoveFiles = async (filesToMove: WorkspaceFile[], destinationFolderPath: string) => {
    if (!selectedWorkspace || filesToMove.length === 0) {
      return;
    }

    const normalizedFolder = normalizeWorkspaceFolderPath(destinationFolderPath);
    const uniqueFiles = Array.from(
      new Map(filesToMove.map((file) => [file.id, file])).values(),
    ).filter((file) => !isDraftWorkspaceFile(file));

    for (const file of uniqueFiles) {
      const destinationPath = buildWorkspaceDestinationPath(file.name, normalizedFolder);
      if (destinationPath === file.name) {
        continue;
      }

      try {
        const updated = await renameFile(selectedWorkspace.id, file.id, { path: normalizedFolder });
        applyWorkspaceFileUpdate(file.name, updated);
      } catch (error) {
        console.error('Failed to move file:', error);
      }
    }

    if (normalizedFolder) {
      setFolderPaths((prev) => addFolderPath(prev, normalizedFolder));
    }
  };

  const handleDeleteSingleFile = async (file: WorkspaceFile) => {
    const removeFromState = () => {
      setFiles((prev) => prev.filter((item) => item.id !== file.id));
      setSelectedFiles((prev) => {
        const next = new Set(prev);
        next.delete(file.id);
        return next;
      });
      setRagStatuses((prev) => {
        if (!prev[file.name]) {
          return prev;
        }
        const next = { ...prev };
        delete next[file.name];
        return next;
      });
      if (selectedFile?.id === file.id) {
        setSelectedFile(null);
        setSelectedFileDetails(null);
        setFileContent('');
      }
    };

    if (isDraftWorkspaceFile(file)) {
      removeFromState();
      return;
    }
    if (!selectedWorkspace) return;
    setWorkspaceFileDialog({ kind: 'delete-file', file, busy: false });
  };

  const handleDeleteFolder = async (folder: { path: string; fileCount: number }) => {
    if (!selectedWorkspace || !folder.path) return;
    setWorkspaceFileDialog({ kind: 'delete-folder', folder, busy: false });
  };

  const filePaneStyles: CSSProperties = {
    width: filePaneWidth,
    minWidth: filePaneWidth,
    flexShrink: 0,
    transition: isPaneResizing ? 'none' : 'width 0.35s ease',
  };

  const workspacePaneStyles: CSSProperties = {
    flexGrow: isAgentPaneFullScreen ? 0 : 1,
    flexShrink: isAgentPaneFullScreen ? 0 : 1,
    flexBasis: 0,
    opacity: isAgentPaneFullScreen ? 0 : 1,
    pointerEvents: isAgentPaneFullScreen ? 'none' : 'auto',
    transition: 'flex-grow 0.35s ease, opacity 0.35s ease',
  };

  const setStreamingForConversation = useCallback((conversationId: string, value: boolean) => {
    setConversationStreaming((prev) => ({ ...prev, [conversationId]: value }));
  }, []);

  const updateMessagesForConversation = useCallback(
    (conversationId: string, updater: (prev: ConversationMessage[]) => ConversationMessage[]) => {
      if (!conversationId) {
        return;
      }
      setConversationMessages((prev) => {
        const next = { ...prev };
        const current = next[conversationId] || [];
        next[conversationId] = updater(current);
        return next;
      });
    },
    [],
  );

  const getConversationMessagesSnapshot = useCallback(
    (conversationId: string | null) => {
      if (!conversationId) return [];
      return conversationMessagesRef.current[conversationId] || [];
    },
    [],
  );

  const cancelStreamForConversation = useCallback(
    (conversationId?: string | null) => {
      if (!conversationId) {
        return;
      }
      const controller = streamAbortMapRef.current.get(conversationId);
      if (controller) {
        controller.abort();
        streamAbortMapRef.current.delete(conversationId);
      }
      setStreamingForConversation(conversationId, false);
    },
    [setStreamingForConversation],
  );

  const cancelAllStreams = useCallback(() => {
    streamAbortMapRef.current.forEach((controller) => controller.abort());
    streamAbortMapRef.current.clear();
    setConversationStreaming({});
  }, []);

  const handleStopStreaming = async () => {
    stopRequestedRef.current = true;
    const activeRun = getActiveRunForConversation(activeConversationId);
    if (activeRun) {
      updateMessagesForConversation(activeRun.conversationId, (prev) =>
        prev.map((message) => {
          if (message.sender !== 'agent') {
            return message;
          }
          const metadata = (message.metadata as ConversationMessageMetadata | undefined) || undefined;
          const matchesRun =
            metadata?.runId === activeRun.runId ||
            message.id === activeRun.placeholderId ||
            (activeRun.turnId && message.turnId === activeRun.turnId);
          if (!matchesRun) {
            return message;
          }
          return {
            ...message,
            metadata: {
              ...(metadata || {}),
              runId: metadata?.runId || activeRun.runId,
              status: 'cancelled',
              pendingInterrupt: undefined,
            },
          };
        }),
      );
      await persistAgentProgress(
        { ...activeRun, status: 'cancelled' },
        'cancelled',
        {
          metadataOverride: {
            pendingInterrupt: undefined,
          },
        },
      ).catch((error) => {
        console.error('Failed to persist cancelled run state', error);
      });
      removeActiveRun(activeRun.runId);
      resumeInFlightRef.current.delete(activeRun.runId);
      resumeAttemptedRef.current.add(activeRun.runId);
      cancelRun(activeRun.runId).catch((error) => {
        console.error('Failed to cancel run', error);
      });
    }
    cancelStreamForConversation(activeConversationId);
  };

  const loadFilesForWorkspace = useCallback(async (workspaceId: string | null) => {
    if (!workspaceId) return;
    try {
      const [files, folders] = await Promise.all([
        getFiles(workspaceId),
        getFolders(workspaceId),
      ]);
      setFolderPaths(folders);
      setFiles(files);
    } catch (error) {
      console.error('Failed to load files for workspace', error);
    }
  }, []);

  const upsertDashboardPlaceholder = useCallback((artifact: DashboardArtifactInfo) => {
    const normalizedPath = normalizeWorkspaceRelativePath(artifact.dashboardPath);
    if (!normalizedPath || !selectedWorkspace) {
      return;
    }
    if (artifact.workspaceId && artifact.workspaceId !== selectedWorkspace.id) {
      return;
    }
    const draftId = `draft:${normalizedPath}/dashboard.meta.json`;
    const manifestPath = getDashboardManifestPath(normalizedPath);
    const placeholder: WorkspaceFile = {
      id: draftId,
      name: manifestPath,
      path: manifestPath,
      workspaceId: selectedWorkspace.id,
      storageType: 'local',
      mimeType: 'application/json',
      content: '',
    };
    setFiles((prev) => {
      if (prev.some((file) => normalizeWorkspaceRelativePath(file.path || file.name) === manifestPath)) {
        return prev;
      }
      return [placeholder, ...prev];
    });
    setSelectedDashboardPath((prev) => prev || normalizedPath);
    setSelectedFile(null);
    setSelectedFileDetails(null);
    setFileContent('');
  }, [selectedWorkspace]);

  const mergeDashboardArtifact = useCallback((artifact: DashboardArtifactInfo) => {
    const normalizedPath = normalizeWorkspaceRelativePath(artifact.dashboardPath);
    if (!normalizedPath) {
      return;
    }
    if (artifact.workspaceId && selectedWorkspace && artifact.workspaceId !== selectedWorkspace.id) {
      return;
    }
    const next: DashboardArtifactInfo = { ...artifact, dashboardPath: normalizedPath };
    setDashboardArtifactsByPath((prev) => ({
      ...prev,
      [normalizedPath]: next,
    }));
    if (next.status === 'generating' || next.status === 'ready') {
      upsertDashboardPlaceholder(next);
    }
    if (next.status === 'ready' && (!selectedDashboardPath || selectedDashboardPath === normalizedPath)) {
      setSelectedDashboardPath(normalizedPath);
      setSelectedFile(null);
      setSelectedFileDetails(null);
      setFileContent('');
    }
  }, [selectedDashboardPath, selectedWorkspace, upsertDashboardPlaceholder]);

  const handleDashboardFolderSelect = useCallback((dashboardPath: string) => {
    const normalizedPath = resolveDashboardPackagePath(files, dashboardPath);
    if (!normalizedPath) {
      return;
    }
    setSelectedDashboardPath(normalizedPath);
    setSelectedFile(null);
    setSelectedFileDetails(null);
    setFileContent('');
    setIsEditMode(false);
    setCanvasZoom(1);
  }, [files]);

  const fetchRagStatusForFiles = useCallback(async () => {
    if (!selectedWorkspace) {
      setRagStatuses((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    const names = files
      .filter((file) => !isSystemFile(file))
      .map((file) => file.name)
      .filter((name) => typeof name === 'string' && name.trim().length > 0);
    if (!names.length) {
      setRagStatuses((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    try {
      const response = await getRagStatuses(selectedWorkspace.id, names);
      setRagStatuses(response?.statuses || {});
      ragStatusFetchedRef.current[selectedWorkspace.id] = true;
    } catch (error) {
      console.error('Failed to load RAG status', error);
    }
  }, [files, selectedWorkspace]);

  useEffect(() => {
    return () => cancelAllStreams();
  }, [cancelAllStreams]);

  useEffect(() => {
    conversationMessagesRef.current = conversationMessages;
  }, [conversationMessages]);

  useEffect(() => {
    setExpandedToolMessages(new Set());
    setExpandedThinkingMessages(new Set());
  }, [activeConversationId]);

  useEffect(() => {
    if (!isAgentPaneVisible && isAgentPaneFullScreen) {
      setIsAgentPaneFullScreen(false);
    }
  }, [isAgentPaneVisible, isAgentPaneFullScreen]);

  useEffect(() => {
    if (!isAgentPaneVisible) {
      setIsHistoryOpen(false);
    }
  }, [isAgentPaneVisible]);

  useEffect(() => {
    if (!selectedWorkspace || !isStreaming) {
      return;
    }
    const interval = setInterval(() => {
      loadFilesForWorkspace(selectedWorkspace.id);
    }, 12000);
    return () => clearInterval(interval);
  }, [isStreaming, selectedWorkspace, loadFilesForWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace) {
      return;
    }
    const hasPendingUnderstanding = files.some((file) =>
      String(file.understandingStatus || '').toLowerCase() === 'pending',
    );
    if (!hasPendingUnderstanding) {
      return;
    }
    const interval = window.setInterval(() => {
      void loadFilesForWorkspace(selectedWorkspace.id);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [files, loadFilesForWorkspace, selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace) {
      return;
    }
    const workspaceId = selectedWorkspace.id;
    const hasPendingStatus = Object.values(ragStatuses).some((status) => {
      const normalized = String(status?.status || '').toLowerCase();
      return ['pending', 'processing', 'preprocessed'].includes(normalized);
    });
    if (!ragStatusFetchedRef.current[workspaceId] || hasPendingStatus) {
      void fetchRagStatusForFiles();
    }

    if (!hasPendingStatus) {
      return;
    }
    const shouldPoll = files.some((file) => {
      if (!file?.name || typeof file.name !== 'string') {
        return false;
      }
      const status = ragStatuses[file.name]?.status;
      if (!status) {
        return false;
      }
      const normalized = String(status).toLowerCase();
      return ['pending', 'processing', 'preprocessed'].includes(normalized);
    });

    if (!shouldPoll) {
      return;
    }

    const interval = window.setInterval(() => {
      void fetchRagStatusForFiles();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [fetchRagStatusForFiles, files, ragStatuses, selectedWorkspace]);

  useEffect(() => {
    if (!mentionSuggestions.length) {
      setMentionSelectedIndex(0);
    } else {
      setMentionSelectedIndex((current) =>
        Math.min(current, mentionSuggestions.length - 1)
      );
    }
  }, [mentionSuggestions.length]);

  useEffect(() => {
    if (!commandSuggestions.length) {
      setCommandSelectedIndex(0);
    } else {
      setCommandSelectedIndex((current) =>
        Math.min(current, commandSuggestions.length - 1)
      );
    }
  }, [commandSuggestions.length]);

  useEffect(() => {
    let cancelled = false;

    const loadSlashMetadata = async () => {
      try {
        const { skills, mcpServers } = await fetchSlashMetadata();
        if (cancelled) {
          return;
        }
        setAvailableSkills(skills);
        setAvailableMcpServers(mcpServers);
      } catch (error) {
        console.error('Failed to load slash metadata', error);
      }
    };

    void loadSlashMetadata();

    return () => {
      cancelled = true;
    };
  }, []);

  const isFileEditable = (fileName: string): boolean => {
    const editableExtensions = [
      '.md', '.mermaid', '.txt', '.json', '.html', '.css', '.js', '.ts', '.tsx', '.jsx',
      '.py', '.java', '.c', '.cpp', '.go', '.rs', '.php', '.rb', '.sh', '.yaml', '.yml', '.xml', '.sql', '.csv'
    ];
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    return editableExtensions.includes(ext);
  };

  const shouldForceEditMode = (fileName: string): boolean => {
    const normalizedName = normalizeFilePath(fileName).toLowerCase();
    if (
      normalizedName.endsWith('.plotly.json') ||
      normalizedName.endsWith('.plot.json') ||
      normalizedName.endsWith('.chart.json') ||
      normalizedName.endsWith('.plotly')
    ) {
      return false;
    }
    const ext = normalizedName.slice(normalizedName.lastIndexOf('.'));
    // Code files that are NOT md or html
    const codeExtensions = [
      '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.go', '.rs', '.php', '.rb', '.sh', '.yaml', '.yml', '.xml', '.sql', '.json', '.css'
    ];
    return codeExtensions.includes(ext);
  };

  const handleDrawerToggle = () => {
    setDrawerOpen(!drawerOpen);
  };

  const toggleAgentPaneFullScreen = () => {
    if (!isAgentPaneVisible) {
      setIsAgentPaneVisible(true);
    }
    setIsAgentPaneFullScreen((prev) => !prev);
  };

  const handleOpenAgentSettings = useCallback(() => {
    navigate('/settings');
  }, [navigate]);

  const handleSignOut = useCallback(async () => {
    setDrawerOpen(false);
    await signOut();
    navigate('/login', { replace: true });
  }, [navigate, signOut]);

  const closeMention = useCallback(() => {
    setIsMentionOpen(false);
    setMentionQuery('');
    setMentionTriggerIndex(null);
    setMentionCursorPosition(null);
    setMentionSelectedIndex(0);
  }, []);

  const closeCommand = useCallback(() => {
    setIsCommandOpen(false);
    setCommandQuery('');
    setCommandTriggerIndex(null);
    setCommandCursorPosition(null);
    setCommandSelectedIndex(0);
  }, []);

  useEffect(() => {
    closeMention();
    closeCommand();
  }, [closeMention, closeCommand, selectedWorkspace]);

  const updateMentionState = useCallback(
    (value: string, cursor: number | null | undefined) => {
      if (!selectedWorkspace) {
        closeMention();
        return;
      }
      if (cursor === null || cursor === undefined) {
        closeMention();
        return;
      }
      const textBeforeCursor = value.slice(0, cursor);
      const mentionMatch = textBeforeCursor.match(/(^|[\s([{])@([^\s@]*)$/);
      if (!mentionMatch) {
        closeMention();
        return;
      }
      const query = mentionMatch[2] || '';
      const triggerIndex = cursor - query.length - 1; // include '@'
      setIsMentionOpen(true);
      setMentionQuery(query);
      setMentionTriggerIndex(triggerIndex);
      setMentionCursorPosition(cursor);
      setMentionSelectedIndex(0);
    },
    [closeMention, selectedWorkspace]
  );

  const updateCommandState = useCallback(
    (value: string, cursor: number | null | undefined) => {
      if (cursor === null || cursor === undefined) {
        closeCommand();
        return false;
      }
      const textBeforeCursor = value.slice(0, cursor);
      const resolvedDirectiveMatch = textBeforeCursor.match(/^\s*\/(skill|mcp)\s+([^\s]+)(?:\s+([\s\S]*))?$/i);
      if (resolvedDirectiveMatch) {
        const kind = resolvedDirectiveMatch[1]?.toLowerCase();
        const targetId = (resolvedDirectiveMatch[2] || '').trim().toLowerCase();
        const trailingPrompt = resolvedDirectiveMatch[3] || '';
        const targetExists =
          kind === 'skill'
            ? availableSkillMap.has(targetId)
            : kind === 'mcp'
              ? availableMcpServerMap.has(targetId)
              : false;
        if (targetExists && (trailingPrompt.trim().length > 0 || /\s$/.test(textBeforeCursor))) {
          closeCommand();
          return false;
        }
      }
      const commandMatch = textBeforeCursor.match(/(^|[\s([{])\/([^\n/]*)$/);
      if (!commandMatch) {
        closeCommand();
        return false;
      }
      const query = commandMatch[2] || '';
      const triggerIndex = cursor - query.length - 1;
      setIsCommandOpen(true);
      setCommandQuery(query);
      setCommandTriggerIndex(triggerIndex);
      setCommandCursorPosition(cursor);
      setCommandSelectedIndex(0);
      closeMention();
      return true;
    },
    [availableMcpServerMap, availableSkillMap, closeCommand, closeMention],
  );

  const updateAutocompleteState = useCallback(
    (value: string, cursor: number | null | undefined) => {
      const commandActive = updateCommandState(value, cursor);
      if (!commandActive) {
        updateMentionState(value, cursor);
      }
    },
    [updateCommandState, updateMentionState],
  );

  const handleSelectMention = useCallback(
    (file: WorkspaceFile) => {
      if (mentionTriggerIndex === null || mentionCursorPosition === null) {
        closeMention();
        return;
      }
      const mentionText = `@${file.name}`;
      const before = chatMessage.slice(0, mentionTriggerIndex);
      const after = chatMessage.slice(mentionCursorPosition);
      const needsSpace = after.length === 0 || after.startsWith(' ') ? '' : ' ';
      const nextValue = `${before}${mentionText}${needsSpace}${after}`;
      setChatMessage(nextValue);
      closeMention();
      requestAnimationFrame(() => {
        if (chatInputRef.current) {
          const cursorPosition = before.length + mentionText.length + (needsSpace ? 1 : 0);
          chatInputRef.current.focus();
          chatInputRef.current.setSelectionRange(cursorPosition, cursorPosition);
        }
      });
    },
    [chatMessage, closeMention, mentionCursorPosition, mentionTriggerIndex]
  );

  const handleSelectCommand = useCallback(
    (command: CommandSuggestion) => {
      if (commandTriggerIndex === null || commandCursorPosition === null) {
        closeCommand();
        return;
      }
      const before = chatMessage.slice(0, commandTriggerIndex);
      const after = chatMessage.slice(commandCursorPosition);
      const shouldKeepCommandMenuOpen = command.command === '/skill' || command.command === '/mcp';
      const insertedCommand = shouldKeepCommandMenuOpen ? `${command.command} ` : command.command;
      const needsSpace = after.length === 0 || after.startsWith(' ') || shouldKeepCommandMenuOpen ? '' : ' ';
      const nextValue = `${before}${insertedCommand}${needsSpace}${after}`;
      setChatMessage(nextValue);
      requestAnimationFrame(() => {
        const cursorPosition = before.length + insertedCommand.length + (needsSpace ? 1 : 0);
        if (chatInputRef.current) {
          chatInputRef.current.focus();
          chatInputRef.current.setSelectionRange(cursorPosition, cursorPosition);
        }
        if (shouldKeepCommandMenuOpen) {
          updateCommandState(nextValue, cursorPosition);
        } else {
          closeCommand();
        }
      });
    },
    [chatMessage, closeCommand, commandCursorPosition, commandTriggerIndex, updateCommandState],
  );

  const parseSlashDirective = useCallback((rawMessage: string): ParsedSlashDirective => {
    const trimmed = rawMessage.trim();
    const skillMatch = trimmed.match(/^\/skill\s+([^\s]+)(?:\s+([\s\S]*))?$/i);
    if (skillMatch) {
      const requestedSkillId = (skillMatch[1] || '').trim();
      const resolvedSkill = requestedSkillId ? availableSkillMap.get(requestedSkillId.toLowerCase()) : undefined;
      return {
        kind: 'skill',
        skillId: resolvedSkill?.id || requestedSkillId,
        prompt: (skillMatch[2] || '').trim(),
        raw: trimmed,
      };
    }
    const mcpMatch = trimmed.match(/^\/mcp\s+([^\s]+)(?:\s+([\s\S]*))?$/i);
    if (mcpMatch) {
      return {
        kind: 'mcp',
        serverId: (mcpMatch[1] || '').trim(),
        prompt: (mcpMatch[2] || '').trim(),
        raw: trimmed,
      };
    }
    return {
      kind: 'none',
      prompt: trimmed,
      raw: trimmed,
    };
  }, [availableSkillMap]);

  const buildAgentPromptFromDirective = useCallback((directive: ParsedSlashDirective): string => {
    switch (directive.kind) {
      case 'skill':
        return [
          '<<<HELPUDOC_DIRECTIVE',
          JSON.stringify({ kind: 'skill', skillId: directive.skillId }),
          '>>>',
          directive.prompt || 'Continue with the selected skill.',
        ].join('\n');
      case 'mcp':
        return [
          '<<<HELPUDOC_DIRECTIVE',
          JSON.stringify({ kind: 'mcp', serverId: directive.serverId }),
          '>>>',
          directive.prompt || `Use ${directive.serverId} for this task.`,
        ].join('\n');
      case 'none':
      default:
        return directive.raw;
    }
  }, []);

  const commandTags = useMemo(() => {
    const directive = parseSlashDirective(chatMessage);
    if (directive.kind === 'skill' && directive.skillId) {
      return [{ id: 'skill', label: `Skill: ${directive.skillId}` }];
    }
    if (directive.kind === 'mcp' && directive.serverId) {
      return [{ id: 'mcp', label: `MCP: ${directive.serverId}` }];
    }
    return [] as Array<{ id: string; label: string }>;
  }, [chatMessage, parseSlashDirective]);

  const handleRemoveCommandTag = useCallback((tagId: string) => {
    const directive = parseSlashDirective(chatMessage);
    if (tagId === 'skill' && directive.kind === 'skill') {
      setChatMessage(directive.prompt);
      closeCommand();
      return;
    }
    if (tagId === 'mcp' && directive.kind === 'mcp') {
      setChatMessage(directive.prompt);
      closeCommand();
    }
  }, [chatMessage, closeCommand, parseSlashDirective]);

  const findMentionedFiles = useCallback(
    (value: string): WorkspaceFile[] => {
      if (!value) {
        return [];
      }
      const normalizedValue = normalizeFilePath(value);
      return visibleFiles.filter((file) => {
        const escapedName = escapeRegExp(normalizeFilePath(file.name));
        const mentionPattern = new RegExp(`(^|[\\s([{])@${escapedName}(?=$|[\\s)\\]}])`, 'i');
        return mentionPattern.test(normalizedValue);
      });
    },
    [visibleFiles],
  );

  const stripMentionedFilesFromPrompt = useCallback(
    (value: string): string => {
      if (!value) {
        return '';
      }
      let nextValue = normalizeFilePath(value);
      const filesByLongestNameFirst = [...visibleFiles].sort((left, right) => right.name.length - left.name.length);
      filesByLongestNameFirst.forEach((file) => {
        const escapedName = escapeRegExp(normalizeFilePath(file.name));
        const mentionPattern = new RegExp(`(^|[\\s([{])@${escapedName}(?=$|[\\s)\\]}])`, 'gi');
        nextValue = nextValue.replace(mentionPattern, (_match, prefix: string) => prefix);
      });
      return nextValue.replace(/\s{2,}/g, ' ').trim();
    },
    [visibleFiles],
  );

  const deriveWorkspaceNameFromPrompt = useCallback((rawMessage = chatMessage): string | undefined => {
    const directive = parseSlashDirective(rawMessage);
    const source = stripMentionedFilesFromPrompt(directive.prompt || directive.raw)
      .replace(/@\S+/g, ' ')
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!source) {
      return undefined;
    }

    const stopWords = new Set([
      'a', 'an', 'and', 'are', 'as', 'at', 'build', 'can', 'create', 'draft', 'for',
      'from', 'generate', 'help', 'in', 'make', 'me', 'of', 'on', 'please', 'prepare',
      'the', 'to', 'with',
    ]);
    const keywords = source
      .split(/\s+/)
      .map((word) => word.replace(/^-+|-+$/g, ''))
      .filter((word) => word && !stopWords.has(word.toLowerCase()))
      .slice(0, 5);
    const words = keywords.length ? keywords : source.split(/\s+/).slice(0, 5);
    const title = words
      .join(' ')
      .replace(/\b[\p{L}\p{N}][\p{L}\p{N}-]*/gu, (word) => {
        if (word.length <= 4 && word === word.toUpperCase()) {
          return word;
        }
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .slice(0, 60)
      .trim();
    return title || undefined;
  }, [chatMessage, parseSlashDirective, stripMentionedFilesFromPrompt]);

  const toNumericFileId = (value: WorkspaceFile['id']): number | null => {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    const parsed = parseInt(String(value), 10);
    return Number.isNaN(parsed) ? null : parsed;
  };

  const refreshConversationHistory = useCallback(async (workspaceId: string) => {
    try {
      const conversations = await fetchRecentConversations(workspaceId, 5);
      setConversationHistory(conversations);
      return conversations;
    } catch (error) {
      console.error('Failed to load conversation history', error);
      setConversationHistory([]);
      return [] as ConversationSummary[];
    }
  }, []);

  const loadConversationMessages = useCallback(async (conversationId: string) => {
    try {
      const detail = await fetchConversationDetail(conversationId);
      const hydratedMessages = detail.messages
        .map(mergeMessageMetadata)
        .map((message) => {
          if (message.sender !== 'agent' || message.text?.trim()) {
            return message;
          }
          const synthesizedText = summarizeMessageFromToolEvents(
            message,
            (message.metadata as ConversationMessageMetadata | undefined)?.status,
          );
          return synthesizedText ? { ...message, text: synthesizedText } : message;
        });
      const filteredMessages = hydratedMessages.filter((message) => {
        if (message.sender !== 'agent') {
          return true;
        }
        if (message.text?.trim()) {
          return true;
        }
        if (message.thinkingText?.trim()) {
          return true;
        }
        if (message.toolEvents?.length) {
          return true;
        }
        return message.metadata?.status === 'running' || message.metadata?.status === 'awaiting_approval';
      });
      const buffer = agentMessageBufferRef.current;
      filteredMessages.forEach((message) => {
        if (message.sender === 'agent') {
          buffer.set(message.id, message.text || '');
        }
      });
      setConversationMessages((prev) => ({ ...prev, [conversationId]: filteredMessages }));
      const normalizedPersona = normalizePersonaName(detail.conversation.persona);
      setActiveConversationPersona(normalizedPersona);
      setSelectedPersona(normalizedPersona);
      const activeRunIds = new Set(
        filteredMessages
          .filter((message) =>
            message.sender === 'agent' &&
            message.metadata?.runId &&
            (message.metadata?.status === 'running' || message.metadata?.status === 'awaiting_approval')
          )
          .map((message) => message.metadata?.runId as string)
      );
      filteredMessages
        .filter((message) =>
          message.sender === 'agent' &&
          message.metadata?.runId &&
          (message.metadata?.status === 'running' || message.metadata?.status === 'awaiting_approval')
        )
        .forEach((activeAgentMessage) => {
          const runId = activeAgentMessage.metadata?.runId as string;
          if (activeRunsRef.current[runId]) {
            return;
          }
          const placeholderId = activeAgentMessage.id;
          const turnId = activeAgentMessage.turnId || generateTurnId();
          const status = (activeAgentMessage.metadata?.status || 'running') as AgentRunStatus;
          const runInfo: ActiveRunInfo = {
            runId,
            conversationId,
            workspaceId: detail.conversation.workspaceId,
            persona: detail.conversation.persona,
            turnId,
            placeholderId,
            status,
          };
          registerActiveRun(runInfo);
        });
      Object.values(activeRunsRef.current)
        .filter(
          (run) =>
            run.conversationId === conversationId &&
            (run.status === 'running' || run.status === 'awaiting_approval')
        )
        .forEach((run) => {
          if (!activeRunIds.has(run.runId)) {
            removeActiveRun(run.runId);
          }
        });
    } catch (error) {
      console.error('Failed to load conversation messages', error);
      setConversationMessages((prev) => ({ ...prev, [conversationId]: [] }));
      setActiveConversationPersona(null);
    }
  }, [registerActiveRun, removeActiveRun]);

  const addLocalSystemMessage = useCallback((text: string) => {
    const systemMessage: ConversationMessage = {
      id: `local-${Date.now()}`,
      conversationId: activeConversationId || 'local',
      sender: 'agent',
      text,
      createdAt: new Date().toISOString(),
    };
    const conversationId = activeConversationId || 'local';
    updateMessagesForConversation(conversationId, (prev) => [...prev, systemMessage]);
    agentMessageBufferRef.current.set(systemMessage.id, systemMessage.text || '');
  }, [activeConversationId, updateMessagesForConversation]);

  const ensureConversation = useCallback(async (workspaceOverride?: Workspace | null) => {
    const targetWorkspaceId = workspaceOverride?.id || selectedWorkspace?.id || null;
    if (activeConversationId && (!targetWorkspaceId || targetWorkspaceId === selectedWorkspaceIdRef.current)) {
      return activeConversationId;
    }
    const workspace = workspaceOverride || selectedWorkspace;
    if (!workspace || !selectedPersona) {
      return null;
    }
    try {
      const conversation = await createConversationApi(workspace.id, selectedPersona);
      setActiveConversationId(conversation.id);
      setActiveConversationPersona(normalizePersonaName(conversation.persona));
      setSelectedPersona(normalizePersonaName(conversation.persona));
      setConversationMessages((prev) => ({ ...prev, [conversation.id]: [] }));
      setStreamingForConversation(conversation.id, false);
      await refreshConversationHistory(workspace.id);
      return conversation.id;
    } catch (error) {
      console.error('Failed to create conversation', error);
      return null;
    }
  }, [activeConversationId, selectedWorkspace, selectedPersona, refreshConversationHistory, setStreamingForConversation]);

  const upsertConversationMessage = useCallback(
    (conversationId: string, nextMessage: ConversationMessage) => {
      updateMessagesForConversation(conversationId, (prev) => {
        const next = [...prev];
        const existingIndex = next.findIndex((message) => {
          if (nextMessage.id !== undefined && message.id === nextMessage.id) {
            return true;
          }
          return Boolean(nextMessage.turnId) && message.sender === nextMessage.sender && message.turnId === nextMessage.turnId;
        });
        if (existingIndex >= 0) {
          next[existingIndex] = nextMessage;
          return next;
        }
        return [...next, nextMessage];
      });
    },
    [updateMessagesForConversation],
  );

  const persistUserMessageMetadata = useCallback(
    async (
      conversationId: string,
      message: ConversationMessage,
      metadata: ConversationMessageMetadata,
    ): Promise<ConversationMessage> => {
      const persisted = await appendConversationMessage(conversationId, 'user', message.text, {
        turnId: message.turnId,
        replaceExisting: true,
        metadata,
      });
      const normalized = mergeMessageMetadata(persisted);
      upsertConversationMessage(conversationId, normalized);
      return normalized;
    },
    [upsertConversationMessage],
  );

  const waitForAttachmentPrepJob = useCallback(
    (workspaceId: string, jobId: string): Promise<AttachmentPrepJob> => {
      const existing = attachmentPrepPromiseRef.current.get(jobId);
      if (existing) {
        return existing;
      }
      const promise = (async () => {
        while (true) {
          const job = await getAttachmentPrepJob(workspaceId, jobId);
          if (job.status === 'ready' || job.status === 'failed') {
            return job;
          }
          await delay(1500);
        }
      })().finally(() => {
        attachmentPrepPromiseRef.current.delete(jobId);
      });
      attachmentPrepPromiseRef.current.set(jobId, promise);
      return promise;
    },
    [],
  );

  useEffect(() => {
    const loadConversations = async () => {
      if (!selectedWorkspace) {
        setConversationHistory([]);
        setActiveConversationId(null);
        agentMessageBufferRef.current.clear();
        setConversationMessages({});
        setConversationStreaming({});
        lastUserMessageMapRef.current = {};
        setActiveConversationPersona(null);
        return;
      }
      const conversations = await refreshConversationHistory(selectedWorkspace.id);
      if (conversations.length) {
        const firstConversation = conversations[0];
        setActiveConversationId(firstConversation.id);
        await loadConversationMessages(firstConversation.id);
      } else {
        setActiveConversationId(null);
        setActiveConversationPersona(null);
      }
    };

    loadConversations();
  }, [selectedWorkspace, refreshConversationHistory, loadConversationMessages, cancelAllStreams]);

  useEffect(() => {
    const fetchWorkspaces = async () => {
      const fetchedWorkspaces = await getWorkspaces();
      setWorkspaces((fetchedWorkspaces || []).map((ws: Omit<Workspace, 'lastUsed'>) => hydrateWorkspace(ws)));
    };
    fetchWorkspaces();
  }, []);

  useEffect(() => {
    if (!selectedWorkspace) {
      setWorkspaceNameDraft('');
      setIsWorkspaceRenameActive(false);
      return;
    }
    setWorkspaceNameDraft(selectedWorkspace.name);
  }, [selectedWorkspace]);

  useEffect(() => {
    if (isWorkspaceRenameActive && workspaceNameInputRef.current) {
      workspaceNameInputRef.current.focus();
      workspaceNameInputRef.current.select();
    }
  }, [isWorkspaceRenameActive]);

  const commitWorkspaceRename = useCallback(async () => {
    if (!selectedWorkspace || !selectedWorkspace.canEdit || workspaceRenameBusy) {
      return;
    }

    const nextName = workspaceNameDraft.trim();
    if (!nextName || nextName === selectedWorkspace.name) {
      setWorkspaceNameDraft(selectedWorkspace.name);
      setIsWorkspaceRenameActive(false);
      return;
    }

    setWorkspaceRenameBusy(true);
    try {
      const renamedWorkspace = hydrateWorkspace(await renameWorkspace(selectedWorkspace.id, nextName));
      setWorkspaces((prev) => prev.map((workspace) => (
        workspace.id === renamedWorkspace.id ? { ...workspace, ...renamedWorkspace } : workspace
      )));
      setSelectedWorkspace((prev) => (
        prev && prev.id === renamedWorkspace.id ? { ...prev, ...renamedWorkspace } : prev
      ));
      setWorkspaceNameDraft(renamedWorkspace.name);
    } catch (error) {
      console.error('Failed to rename workspace:', error);
      setWorkspaceNameDraft(selectedWorkspace.name);
    } finally {
      setWorkspaceRenameBusy(false);
      setIsWorkspaceRenameActive(false);
    }
  }, [selectedWorkspace, workspaceNameDraft, workspaceRenameBusy]);

  const cancelWorkspaceRename = useCallback(() => {
    setWorkspaceNameDraft(selectedWorkspace?.name || '');
    setIsWorkspaceRenameActive(false);
  }, [selectedWorkspace]);

  const handleSelectWorkspace = useCallback((workspace: Workspace) => {
    setIsWorkspaceRenameActive(false);
    setWorkspaceNameDraft(workspace.name);
    setFolderPaths([]);
    setSelectedWorkspace(workspace);
    setIsLandingPageVisible(false);
  }, []);

  useEffect(() => {
    if (selectedWorkspace) {
      loadFilesForWorkspace(selectedWorkspace.id);
    }
  }, [selectedWorkspace, loadFilesForWorkspace]);
  const handleRefreshFiles = () => {
    if (selectedWorkspace) {
      loadFilesForWorkspace(selectedWorkspace.id);
    }
  };

  const openPlanApprovalEditor = useCallback((
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => {
    if (!selectedWorkspace) {
      return;
    }
    const actionRequests = Array.isArray(pendingInterrupt?.actionRequests) ? pendingInterrupt.actionRequests : [];
    const review = buildApprovalReview(pendingInterrupt, actionRequests[0]);
    const targetPath = normalizeWorkspaceRelativePath(review?.planFilePath || DEFAULT_PLAN_FILE_PATH) || DEFAULT_PLAN_FILE_PATH;
    const existingFile = files.find((file) => normalizeWorkspaceRelativePath(file.name || file.path) === targetPath);
    setIsAgentPaneVisible(true);
    setIsFilePaneVisible(true);
    setCanvasZoom(1);
    setIsEditMode(true);

    if (existingFile) {
      setSelectedFile(existingFile);
      setSelectedFileDetails(null);
      setFileContent('');
      return;
    }

    const draftContent = buildApprovalDraftContent(review);
    const draftFile: WorkspaceFile = {
      id: `draft:${targetPath}`,
      name: targetPath,
      path: targetPath,
      workspaceId: selectedWorkspace.id,
      storageType: 'local',
      mimeType: 'text/markdown',
      content: draftContent,
    };
    setFiles((prev) => {
      if (prev.some((file) => String(file.id) === draftFile.id)) {
        return prev;
      }
      return [draftFile, ...prev];
    });
    setSelectedFile(draftFile);
    setSelectedFileDetails(draftFile);
    setFileContent(draftContent);
    lastAutoSavedContentRef.current = draftContent;
  }, [files, selectedWorkspace]);

  const fetchFileContent = useCallback(async () => {
    const requestId = fileContentRequestIdRef.current + 1;
    fileContentRequestIdRef.current = requestId;
    const isCurrentRequest = () => fileContentRequestIdRef.current === requestId;

    if (selectedDashboardPath) {
      setFileContent('');
      setSelectedFileDetails(null);
      lastAutoSavedContentRef.current = '';
      return;
    }
    if (selectedFile && selectedWorkspace) {
      if (isDraftWorkspaceFile(selectedFile)) {
        if (!isCurrentRequest()) return;
        const draftContent = selectedFile.content || '';
        setSelectedFileDetails(selectedFile);
        setFileContent(draftContent);
        lastAutoSavedContentRef.current = draftContent;
        return;
      }
      try {
        const fileWithContent = await getFileContent(selectedWorkspace.id, selectedFile.id);
        if (!isCurrentRequest()) return;
        const hydratedFile = { ...selectedFile, ...fileWithContent };
        setSelectedFileDetails(hydratedFile);
        const content = hydratedFile.content || '';
        setFileContent(content);
        lastAutoSavedContentRef.current = content;
      } catch (error) {
        if (!isCurrentRequest()) return;
        console.error('Failed to fetch file content:', error);
        setFileContent('Failed to load file content.');
        setSelectedFileDetails(null);
      }
    } else {
      if (!isCurrentRequest()) return;
      setFileContent('');
      setSelectedFileDetails(null);
      lastAutoSavedContentRef.current = '';
    }
  }, [selectedDashboardPath, selectedFile, selectedWorkspace]);

  useEffect(() => {
    void fetchFileContent();
  }, [fetchFileContent]);

  useEffect(() => {
    if (!selectedWorkspace || !selectedDashboardPath) {
      return;
    }
    const dashboardPath = resolveDashboardPackagePath(files, selectedDashboardPath);
    if (dashboardPath && dashboardPath !== selectedDashboardPath) {
      setSelectedDashboardPath(dashboardPath);
    }
  }, [files, selectedDashboardPath, selectedWorkspace]);

  useEffect(() => {
    setDashboardArtifactsByPath({});
    setSelectedDashboardPath(null);
  }, [selectedWorkspace?.id]);

  useEffect(() => {
    if (selectedFile) {
      setSelectedDashboardPath(null);
    }
  }, [selectedFile]);

  useEffect(() => {
    if (!selectedFile || !String(selectedFile.id).startsWith('draft:')) {
      return;
    }
    const selectedPath = normalizeWorkspaceRelativePath(selectedFile.path || selectedFile.name);
    if (!selectedPath) {
      return;
    }
    const persistedFile = files.find(
      (file) =>
        !String(file.id).startsWith('draft:') &&
        normalizeWorkspaceRelativePath(file.path || file.name) === selectedPath,
    );
    if (!persistedFile) {
      return;
    }
    setSelectedFile(persistedFile);
    setSelectedFileDetails(null);
  }, [files, selectedFile]);

  useEffect(() => {
    const name = selectedFile?.name ?? '';
    if (isBinaryOfficeDocument(name, selectedFile?.mimeType)) {
      setIsEditMode(false);
    }
  }, [selectedFile?.id, selectedFile?.name, selectedFile?.mimeType]);

  const handleCreateWorkspace = async (options?: { stayOnLanding?: boolean; rename?: boolean; name?: string }): Promise<Workspace | null> => {
    try {
      const newWorkspace = {
        ...hydrateWorkspace(await createWorkspace(options?.name)),
        canEdit: true,
        role: 'owner' as const,
      };
      setWorkspaces((prev) => [newWorkspace, ...prev]);
      setSelectedWorkspace(newWorkspace);
      setFolderPaths([]);
      setWorkspaceSearchQuery('');
      setWorkspaceNameDraft(newWorkspace.name);
      setIsWorkspaceRenameActive(options?.rename ?? true);
      setIsLandingPageVisible(options?.stayOnLanding ?? false);
      return newWorkspace;
    } catch (error) {
      console.error('Failed to create workspace:', error);
      return null;
    }
  };

  const handleCreateLandingWorkspace = async () => {
    setIsLandingWorkspacePickerOpen(false);
    setLandingWorkspaceQuery('');
    await handleCreateWorkspace({
      stayOnLanding: true,
      rename: false,
      name: deriveWorkspaceNameFromPrompt(),
    });
  };

  const handleSelectConversationFromHistory = async (conversationId: string) => {
    setActiveConversationId(conversationId);
    await loadConversationMessages(conversationId);
    setChatMessage('');
    closeMention();
  };

  const handleDeleteConversation = useCallback(
    async (conversationId: string) => {
      try {
        await deleteConversationApi(conversationId);
        cancelStreamForConversation(conversationId);
        setConversationMessages((prev) => {
          const next = { ...prev };
          delete next[conversationId];
          return next;
        });
        setConversationStreaming((prev) => {
          const next = { ...prev };
          delete next[conversationId];
          return next;
        });
        const existingMessages = conversationMessagesRef.current[conversationId] || [];
        existingMessages.forEach((message) => agentMessageBufferRef.current.delete(message.id));
        delete lastUserMessageMapRef.current[conversationId];
        Object.values(activeRunsRef.current).forEach((run) => {
          if (run.conversationId === conversationId) {
            removeActiveRun(run.runId);
          }
        });
        setConversationHistory((prev) => prev.filter((conversation) => conversation.id !== conversationId));
        if (activeConversationId === conversationId) {
          setActiveConversationId(null);
          setConversationMessages((prev) => ({ ...prev, [conversationId]: [] }));
          setActiveConversationPersona(null);
        }
      } catch (error) {
        console.error('Failed to delete conversation', error);
      }
    },
    [activeConversationId, cancelStreamForConversation, removeActiveRun],
  );

  const updateToolEvents = useCallback((
    conversationId: string,
    index: number,
    updater: (events: ToolEvent[]) => ToolEvent[],
  ) => {
    updateMessagesForConversation(conversationId, (prev) => {
      const updated = [...prev];
      const target = updated[index];
      if (!target) {
        return updated;
      }
      const existing = target.toolEvents || [];
      updated[index] = {
        ...target,
        toolEvents: updater(existing),
      };
      return updated;
    });
  }, [updateMessagesForConversation]);

  const updateMessageMetadataAtIndex = useCallback((
    conversationId: string,
    index: number,
    updater: (metadata: ConversationMessageMetadata) => ConversationMessageMetadata,
  ) => {
    updateMessagesForConversation(conversationId, (prev) => {
      const updated = [...prev];
      const target = updated[index];
      if (!target) {
        return updated;
      }
      const current = (target.metadata as ConversationMessageMetadata | null | undefined) || {};
      const nextMetadata = updater({ ...current });
      updated[index] = {
        ...target,
        metadata: nextMetadata,
      };
      return updated;
    });
  }, [updateMessagesForConversation]);

  const createToolEvent = (name: string, status: ToolEvent['status'] = 'running'): ToolEvent => ({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    status,
    startedAt: new Date().toISOString(),
  });

  const appendAgentThought = useCallback((conversationId: string, index: number, chunk: string) => {
    if (!chunk || index < 0) {
      return;
    }
    updateMessagesForConversation(conversationId, (prevMessages) => {
      const updated = [...prevMessages];
      const target = updated[index];
      if (!target) {
        return updated;
      }
      updated[index] = {
        ...target,
        thinkingText: `${target.thinkingText || ''}${chunk}`,
      };
      return updated;
    });
  }, [updateMessagesForConversation]);

  const truncateToolOutput = (text: string, maxLength = 200) => {
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength)}…`;
  };

  const mergeToolFiles = (
    ...groups: Array<ToolOutputFile[] | undefined>
  ): ToolOutputFile[] | undefined => {
    const byPath = new Map<string, ToolOutputFile>();
    for (const group of groups) {
      for (const file of group || []) {
        const path = file.path?.trim();
        if (!path) {
          continue;
        }
        byPath.set(path, { ...byPath.get(path), ...file, path });
      }
    }
    return byPath.size ? [...byPath.values()] : undefined;
  };

  const appendToolStart = useCallback((conversationId: string, index: number, chunk: AgentStreamChunk & { type: 'tool_start' }) => {
    const label = chunk.name || chunk.content || 'tool';
    const relatedFiles = mergeToolFiles(extractToolPathFiles(chunk.content));
    updateToolEvents(conversationId, index, (events) => [
      ...events,
      {
        ...createToolEvent(label),
        relatedFiles,
      },
    ]);
  }, [updateToolEvents]);

  const appendToolEnd = useCallback((
    conversationId: string,
    index: number,
    chunk: (AgentStreamChunk & { type: 'tool_end' | 'tool_error' }),
    status: ToolEvent['status'] = 'completed',
  ) => {
    const label = chunk.name || 'tool';
    const raw = chunk.content?.trim();
    const translated = raw ? translateToolChunkForStorage(raw, label, 200) : undefined;
    const summary =
      translated
      ?? (raw ? truncateToolOutput(raw) : '');
    const outputFiles = 'outputFiles' in chunk ? chunk.outputFiles : undefined;
    const relatedFiles = mergeToolFiles(extractToolPathFiles(raw), outputFiles);
    updateToolEvents(conversationId, index, (events) => {
      if (!events.length) {
        return [
          {
            ...createToolEvent(label, status),
            finishedAt: new Date().toISOString(),
            summary,
            outputFiles,
            relatedFiles,
          },
        ];
      }
      const next = [...events];
      const lastRunningOffset = [...next].reverse().findIndex((event) => event.status === 'running');
      if (lastRunningOffset === -1) {
        next.push({
          ...createToolEvent(label, status),
          finishedAt: new Date().toISOString(),
          summary,
          outputFiles,
          relatedFiles,
        });
        return next;
      }
      const targetIndex = next.length - 1 - lastRunningOffset;
      next[targetIndex] = {
        ...next[targetIndex],
        status,
        finishedAt: new Date().toISOString(),
        summary: summary || next[targetIndex].summary,
        outputFiles: mergeToolFiles(next[targetIndex].outputFiles, outputFiles),
        relatedFiles: mergeToolFiles(next[targetIndex].relatedFiles, relatedFiles),
      };
      return next;
    });
  }, [updateToolEvents]);

  const combineBufferedAgentText = useCallback(
    (conversationId: string, existingText: string, nextChunk: string): string => {
      if (!nextChunk) {
        return existingText;
      }
      let sanitizedChunk = nextChunk;
      const userPrompt = (lastUserMessageMapRef.current[conversationId] || '').trim();
      if (!existingText && userPrompt) {
        const chunkNoLeading = sanitizedChunk.replace(/^\s+/, '');
        if (chunkNoLeading.startsWith(userPrompt)) {
          const remainder = chunkNoLeading.slice(userPrompt.length).replace(/^\s+/, '');
          if (!remainder) {
            return existingText;
          }
          sanitizedChunk = remainder;
        }
      }
      return `${existingText}${sanitizedChunk}`;
    },
    [],
  );

  const flushBufferedAgentChunks = useCallback(() => {
    if (!agentChunkBufferRef.current.size) {
      return;
    }
    const pending = agentChunkBufferRef.current;
    agentChunkBufferRef.current = new Map();
    pending.forEach((messageChunks, conversationId) => {
      updateMessagesForConversation(conversationId, (prevMessages) => {
        if (!messageChunks.size || !prevMessages.length) {
          return prevMessages;
        }
        const updated = [...prevMessages];
        messageChunks.forEach((chunkText, index) => {
          if (!chunkText || index < 0) {
            return;
          }
          const target = updated[index];
          if (!target) {
            return;
          }
          const combinedText = combineBufferedAgentText(conversationId, target.text || '', chunkText);
          if (combinedText === (target.text || '')) {
            return;
          }
          const updatedMessage: ConversationMessage = {
            ...target,
            text: combinedText,
          };
          updated[index] = updatedMessage;
          if (
            updatedMessage.sender === 'agent' &&
            updatedMessage.id !== undefined &&
            updatedMessage.id !== null
          ) {
            agentMessageBufferRef.current.set(updatedMessage.id, combinedText);
          }
        });
        return updated;
      });
    });
  }, [combineBufferedAgentText, updateMessagesForConversation]);

  const ensureAgentPlaceholder = useCallback(
    (conversationId: string, placeholderId: ConversationMessage['id'], turnId: string, resetText = false) => {
      if (!conversationId) {
        return -1;
      }
      const inferredRunId =
        typeof placeholderId === 'string' && placeholderId.startsWith('agent-')
          ? placeholderId.slice('agent-'.length)
          : undefined;
      const snapshot = conversationMessagesRef.current[conversationId] || [];
      const existingSnapshotIndex = snapshot.findIndex((message) => message.id === placeholderId);
      const targetIndex = existingSnapshotIndex !== -1 ? existingSnapshotIndex : snapshot.length;
      updateMessagesForConversation(conversationId, (prevMessages) => {
        const existingIndex = prevMessages.findIndex((message) => message.id === placeholderId);
        if (existingIndex !== -1) {
          const existing = prevMessages[existingIndex];
          const existingMetadata = (existing?.metadata as ConversationMessageMetadata | undefined) || undefined;
          const metadata =
            inferredRunId && (!existingMetadata?.runId || !existingMetadata?.status)
              ? {
                ...(existingMetadata || {}),
                runId: existingMetadata?.runId || inferredRunId,
                status: existingMetadata?.status || 'running',
              }
              : existingMetadata;
          if (resetText && existing) {
            const resetMessage: ConversationMessage = { ...existing, text: '', metadata };
            agentMessageBufferRef.current.set(placeholderId, '');
            const next = [...prevMessages];
            next[existingIndex] = resetMessage;
            return next;
          }
          if (metadata && metadata !== existingMetadata) {
            const next = [...prevMessages];
            next[existingIndex] = {
              ...existing,
              metadata,
            };
            return next;
          }
          return prevMessages;
        }
        const placeholderMetadata = inferredRunId
          ? ({
            runId: inferredRunId,
            status: 'running',
          } as ConversationMessageMetadata)
          : undefined;
        const placeholder: ConversationMessage = {
          id: placeholderId,
          conversationId,
          sender: 'agent',
          text: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          turnId,
          metadata: placeholderMetadata,
        };
        return [...prevMessages, placeholder];
      });
      return targetIndex;
    },
    [updateMessagesForConversation],
  );

  const findAgentMessageForRun = useCallback(
    (conversationId: string, placeholderId: ConversationMessage['id'], turnId: string) => {
      const messages = conversationMessagesRef.current[conversationId] || [];
      const byId = messages.find((message) => message.id === placeholderId);
      if (byId) return byId;
      return messages.find((message) => message.turnId === turnId && message.sender === 'agent') || null;
    },
    [],
  );

  const findAgentMessageIndexForRun = useCallback(
    (
      conversationId: string,
      placeholderId: ConversationMessage['id'],
      turnId: string,
      runId?: string,
    ) => {
      const messages = conversationMessagesRef.current[conversationId] || [];
      if (runId) {
        const byRunId = messages.findIndex((message) => (
          message.sender === 'agent' && message.metadata?.runId === runId
        ));
        if (byRunId !== -1) {
          return byRunId;
        }
      }
      const byId = messages.findIndex((message) => message.id === placeholderId);
      if (byId !== -1) {
        return byId;
      }
      return messages.findIndex((message) => message.sender === 'agent' && message.turnId === turnId);
    },
    [],
  );

  const getBufferedAgentState = useCallback(
    (runInfo: ActiveRunInfo) => {
      const { placeholderId, conversationId, turnId, runId } = runInfo;
      const message = findAgentMessageForRun(conversationId, placeholderId, turnId);
      const messageIndex = findAgentMessageIndexForRun(conversationId, placeholderId, turnId, runId);
      const baseText =
        agentMessageBufferRef.current.get(placeholderId) ??
        (message ? agentMessageBufferRef.current.get(message.id) : undefined) ??
        message?.text ??
        '';
      if (messageIndex < 0) {
        return {
          text: baseText,
          messageIndex,
          pendingChunk: '',
        };
      }
      const pendingChunk = agentChunkBufferRef.current.get(conversationId)?.get(messageIndex) || '';
      return {
        text: combineBufferedAgentText(conversationId, baseText, pendingChunk),
        messageIndex,
        pendingChunk,
      };
    },
    [combineBufferedAgentText, findAgentMessageForRun, findAgentMessageIndexForRun],
  );

  const isAgentMessageEmpty = useCallback((message?: ConversationMessage | null) => {
    if (!message || message.sender !== 'agent') {
      return true;
    }
    const metadata = (message.metadata as ConversationMessageMetadata | undefined) || undefined;
    if (metadata?.pendingInterrupt || metadata?.status === 'awaiting_approval') {
      return false;
    }
    return !message.text && !message.thinkingText && !message.toolEvents?.length;
  }, []);

  const upsertPersistedAgentMessage = useCallback(
    (
      conversationId: string,
      persisted: ConversationMessage,
      options?: {
        placeholderId?: ConversationMessage['id'];
        existing?: ConversationMessage | null;
      },
    ) => {
      updateMessagesForConversation(conversationId, (prev) => {
        const updated = [...prev];
        const matchingIndexes = updated
          .map((message, index) => ({ message, index }))
          .filter(({ message }) => {
            if (message.sender !== 'agent') {
              return false;
            }
            if (message.id === persisted.id) {
              return true;
            }
            if (options?.placeholderId !== undefined && message.id === options.placeholderId) {
              return true;
            }
            return Boolean(persisted.turnId && message.turnId === persisted.turnId);
          })
          .map(({ index }) => index);

        const primaryIndex = matchingIndexes[0] ?? updated.length;
        const existing =
          matchingIndexes[0] !== undefined
            ? updated[matchingIndexes[0]]
            : options?.existing || undefined;
        const merged = mergePersistedAgentMessage(persisted, existing);

        if (matchingIndexes[0] !== undefined) {
          updated[primaryIndex] = merged;
        } else {
          updated.push(merged);
        }

        if (matchingIndexes.length <= 1) {
          return updated;
        }

        const duplicatesToRemove = new Set(matchingIndexes.slice(1));
        return updated.filter((_, index) => !duplicatesToRemove.has(index));
      });
    },
    [updateMessagesForConversation],
  );

  const clearPendingInterruptForRun = useCallback(
    (
      conversationId: string,
      runId: string,
      turnId?: string,
    ) => {
      updateMessagesForConversation(conversationId, (prev) => {
        const matchingIndexes = prev
          .map((message, index) => ({ message, index }))
          .filter(({ message }) => {
            if (message.sender !== 'agent') {
              return false;
            }
            const metadata = (message.metadata as ConversationMessageMetadata | undefined) || undefined;
            return metadata?.runId === runId || Boolean(turnId && message.turnId === turnId);
          })
          .map(({ index }) => index);

        if (!matchingIndexes.length) {
          return prev;
        }

        const next = [...prev];
        const chooseScore = (message: ConversationMessage) => (
          (message.text?.length || 0) * 1000 +
          (message.thinkingText?.length || 0) * 100 +
          (message.toolEvents?.length || 0) * 10 +
          ((((message.metadata as ConversationMessageMetadata | undefined) || {}).pendingInterrupt) ? 5 : 0)
        );

        const primaryIndex = matchingIndexes.reduce((best, current) => (
          chooseScore(next[current]) > chooseScore(next[best]) ? current : best
        ), matchingIndexes[0]);

        const merged = matchingIndexes.reduce((acc, index) => {
          const candidate = next[index];
          return {
            ...acc,
            text: (candidate.text?.length || 0) > (acc.text?.length || 0) ? candidate.text : acc.text,
            thinkingText:
              (candidate.thinkingText?.length || 0) > (acc.thinkingText?.length || 0)
                ? candidate.thinkingText
                : acc.thinkingText,
            toolEvents:
              (candidate.toolEvents?.length || 0) > (acc.toolEvents?.length || 0)
                ? candidate.toolEvents
                : acc.toolEvents,
          };
        }, next[primaryIndex]);

        const metadata = {
          ...(((merged.metadata as ConversationMessageMetadata | undefined) || {})),
          runId,
          status: 'running' as AgentRunStatus,
          pendingInterrupt: undefined,
        };

        next[primaryIndex] = {
          ...merged,
          metadata,
        };

        if (matchingIndexes.length === 1) {
          return next;
        }

        const duplicatesToRemove = new Set(matchingIndexes.filter((index) => index !== primaryIndex));
        return next.filter((_, index) => !duplicatesToRemove.has(index));
      });
    },
    [updateMessagesForConversation],
  );

  const persistAgentProgress = useCallback(
    async (
      runInfo: ActiveRunInfo,
      statusOverride?: AgentRunStatus,
      options?: {
        metadataOverride?: Partial<ConversationMessageMetadata>;
      },
    ) => {
      const { runId, conversationId, turnId, placeholderId } = runInfo;
      if (persistInFlightRef.current.has(runId)) {
        pendingPersistRef.current[runId] = { runInfo, statusOverride, options };
        return;
      }
      const now = Date.now();
      const forcedStatus = Boolean(statusOverride || options?.metadataOverride);
      if (!forcedStatus && runInfo.status !== 'running') {
        return;
      }
      const lastAttempt = lastPersistAttemptRef.current[runId] || 0;
      if (!forcedStatus && now - lastAttempt < 2000) {
        return;
      }
      lastPersistAttemptRef.current[runId] = now;
      const message = findAgentMessageForRun(conversationId, placeholderId, turnId);
      const bufferedState = getBufferedAgentState(runInfo);
      const nextStatus = statusOverride || message?.metadata?.status || runInfo.status || 'running';
      const assistantText = bufferedState.text;
      const summaryText =
        !assistantText.trim() && isTerminalRunStatus(nextStatus)
          ? summarizeMessageFromToolEvents(message, nextStatus)
          : '';
      const text = assistantText || summaryText;
      const bodySource = assistantText.trim()
        ? 'assistant'
        : summaryText.trim()
          ? 'summary'
          : undefined;
      const lastText = lastPersistedAgentTextRef.current[runId];
      const lastStatus = lastPersistedStatusRef.current[runId];
      const metadata = {
        ...(buildMessageMetadata(message) || {}),
        ...(options?.metadataOverride || {}),
        runId,
        status: nextStatus,
        bodySource,
      } satisfies ConversationMessageMetadata;
      if (!bodySource) {
        delete metadata.bodySource;
      }
      const metadataSignature = JSON.stringify(metadata);
      const lastMetadataSignature = lastPersistedMetadataRef.current[runId];
      if (text === lastText && nextStatus === lastStatus && metadataSignature === lastMetadataSignature) {
        return;
      }
      if (
        !text &&
        !message?.thinkingText &&
        !message?.toolEvents?.length &&
        !message?.metadata?.pendingInterrupt &&
        nextStatus !== 'running'
      ) {
        return;
      }
      persistInFlightRef.current.add(runId);
      try {
        const persisted = await appendConversationMessage(conversationId, 'agent', text, {
          turnId,
          replaceExisting: true,
          metadata,
        });
        upsertPersistedAgentMessage(conversationId, persisted, {
          placeholderId,
          existing: message,
        });
        if (bufferedState.pendingChunk && bufferedState.messageIndex >= 0) {
          const conversationBuffer = agentChunkBufferRef.current.get(conversationId);
          if (conversationBuffer?.has(bufferedState.messageIndex)) {
            conversationBuffer.delete(bufferedState.messageIndex);
            if (conversationBuffer.size) {
              agentChunkBufferRef.current.set(conversationId, conversationBuffer);
            } else {
              agentChunkBufferRef.current.delete(conversationId);
            }
          }
        }
        lastPersistedAgentTextRef.current[runId] = text;
        lastPersistedStatusRef.current[runId] = nextStatus;
        lastPersistedMetadataRef.current[runId] = metadataSignature;
        agentMessageBufferRef.current.set(persisted.id, persisted.text || '');
        if (placeholderId !== persisted.id) {
          agentMessageBufferRef.current.delete(placeholderId);
        }
      } catch (error) {
        console.error('Failed to persist agent progress', error);
      } finally {
        persistInFlightRef.current.delete(runId);
        const pending = pendingPersistRef.current[runId];
        if (pending) {
          delete pendingPersistRef.current[runId];
          void persistAgentProgress(pending.runInfo, pending.statusOverride, pending.options);
        }
      }
    },
    [findAgentMessageForRun, getBufferedAgentState, upsertPersistedAgentMessage],
  );

  const syncRunStateToConversation = useCallback(
    async (
      runInfo: ActiveRunInfo,
      status: Exclude<AgentRunStatus, 'queued'>,
      pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
    ) => {
      const agentMessageIndex = findAgentMessageIndexForRun(
        runInfo.conversationId,
        runInfo.placeholderId,
        runInfo.turnId,
        runInfo.runId,
      );
      if (agentMessageIndex >= 0) {
        if (isTerminalRunStatus(status)) {
          updateToolEvents(runInfo.conversationId, agentMessageIndex, (events) =>
            settleRunningToolEventsForStatus(events, status) || events,
          );
        }
        updateMessageMetadataAtIndex(runInfo.conversationId, agentMessageIndex, (metadata) => ({
          ...metadata,
          runId: runInfo.runId,
          status,
          pendingInterrupt: status === 'awaiting_approval' ? pendingInterrupt : undefined,
        }));
      }
      await persistAgentProgress(
        { ...runInfo, status },
        status,
        pendingInterrupt
          ? {
              metadataOverride: {
                pendingInterrupt,
              },
            }
          : {
              metadataOverride: {
                pendingInterrupt: undefined,
              },
            },
      );
    },
    [findAgentMessageIndexForRun, persistAgentProgress, updateMessageMetadataAtIndex, updateToolEvents],
  );

  const bufferAgentChunk = useCallback((conversationId: string, index: number, chunk: string) => {
    if (!conversationId || !chunk || index < 0) {
      return;
    }
    const conversationBuffer = agentChunkBufferRef.current.get(conversationId) ?? new Map();
    conversationBuffer.set(index, `${conversationBuffer.get(index) || ''}${chunk}`);
    agentChunkBufferRef.current.set(conversationId, conversationBuffer);
  }, []);

  useEffect(() => {
    if (agentChunkFlushTimerRef.current !== null) {
      return;
    }
    agentChunkFlushTimerRef.current = window.setInterval(() => {
      flushBufferedAgentChunks();
    }, 75);
    return () => {
      if (agentChunkFlushTimerRef.current !== null) {
        window.clearInterval(agentChunkFlushTimerRef.current);
        agentChunkFlushTimerRef.current = null;
      }
    };
  }, [flushBufferedAgentChunks]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const runs = Object.values(activeRunsRef.current);
      runs.forEach((run) => {
        if (run.status === 'running') {
          void persistAgentProgress(run);
        }
      });
    }, 2000);
    return () => window.clearInterval(interval);
  }, [persistAgentProgress]);

  const getPrimaryInterruptAction = useCallback((
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ): { name?: string; args?: Record<string, unknown> } | undefined => {
    const actionRequests = Array.isArray(pendingInterrupt?.actionRequests) ? pendingInterrupt.actionRequests : [];
    return actionRequests[0];
  }, []);

  const getInterruptKind = useCallback((
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ): 'approval' | 'clarification' => {
    if (pendingInterrupt?.kind === 'approval') {
      return 'approval';
    }
    if (pendingInterrupt?.kind === 'clarification') {
      return 'clarification';
    }

    const responseSpec =
      pendingInterrupt?.responseSpec && typeof pendingInterrupt.responseSpec === 'object'
        ? pendingInterrupt.responseSpec
        : undefined;
    if (responseSpec) {
      return 'clarification';
    }

    const actions = Array.isArray(pendingInterrupt?.actions) ? pendingInterrupt.actions : [];
    const actionRequests = Array.isArray(pendingInterrupt?.actionRequests) ? pendingInterrupt.actionRequests : [];
    const reviewConfigs = Array.isArray(pendingInterrupt?.reviewConfigs) ? pendingInterrupt.reviewConfigs : [];
    const interruptTitle = typeof pendingInterrupt?.title === 'string' ? pendingInterrupt.title.trim().toLowerCase() : '';
    const interruptDescription = typeof pendingInterrupt?.description === 'string'
      ? pendingInterrupt.description.trim().toLowerCase()
      : '';
    const hasClarificationRequest = actionRequests.some((request) => {
      const name = typeof request?.name === 'string' ? request.name.trim().toLowerCase() : '';
      return name.includes('clarification');
    });
    const hasClarificationReviewConfig = reviewConfigs.some((config) => {
      const name = typeof config?.action_name === 'string' ? config.action_name.trim().toLowerCase() : '';
      return name.includes('clarification');
    });
    const hasApprovalConfig = actionRequests.length > 0 || reviewConfigs.length > 0;
    const hasClarificationAction = actions.some((action) => {
      if (!action || typeof action !== 'object') {
        return false;
      }
      if (action.id === 'clarification-text') {
        return true;
      }
      if (action.payload && typeof action.payload === 'object' && 'selectedChoiceId' in action.payload) {
        return true;
      }
      return false;
    });

    if (
      hasClarificationRequest ||
      hasClarificationReviewConfig ||
      /clarification|need(s)? more detail|question/i.test(interruptTitle) ||
      /clarification|need(s)? more detail|question/i.test(interruptDescription)
    ) {
      return 'clarification';
    }

    if (hasClarificationAction && !hasApprovalConfig) {
      return 'clarification';
    }

    return 'approval';
  }, []);

  const isPlanApprovalInterrupt = useCallback((
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ): boolean => {
    if (getInterruptKind(pendingInterrupt) === 'clarification') {
      return false;
    }
    const actionRequests = Array.isArray(pendingInterrupt?.actionRequests) ? pendingInterrupt.actionRequests : [];
    const reviewConfigs = Array.isArray(pendingInterrupt?.reviewConfigs) ? pendingInterrupt.reviewConfigs : [];
    const firstActionName = typeof actionRequests[0]?.name === 'string'
      ? actionRequests[0].name.trim().toLowerCase()
      : '';
    if (firstActionName === 'request_plan_approval') {
      return true;
    }
    if (firstActionName && firstActionName.includes('plan') && firstActionName.includes('approval')) {
      return true;
    }
    return reviewConfigs.some((config) => {
      const name = typeof config?.action_name === 'string' ? config.action_name.trim().toLowerCase() : '';
      return name === 'request_plan_approval' || (name.includes('plan') && name.includes('approval'));
    });
  }, [getInterruptKind]);

  const interruptFieldKey = useCallback((
    messageKey: string,
    field: 'feedback' | 'edit-json' | 'reject-note' | 'clarification-text',
  ): string => `${messageKey}:${field}`, []);

  const interruptActionFieldKey = useCallback((messageKey: string, actionId: string): string => (
    `${messageKey}:action:${actionId}`
  ), []);

  const getAllowedDecisions = useCallback((
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ): Array<'approve' | 'edit' | 'reject'> => {
    const defaults: Array<'approve' | 'edit' | 'reject'> = ['approve', 'edit', 'reject'];
    if (getInterruptKind(pendingInterrupt) === 'clarification') {
      return [];
    }
    const actionRequests = Array.isArray(pendingInterrupt?.actionRequests) ? pendingInterrupt.actionRequests : [];
    const reviewConfigs = Array.isArray(pendingInterrupt?.reviewConfigs) ? pendingInterrupt.reviewConfigs : [];
    if (reviewConfigs.length) {
      const firstActionName = typeof actionRequests[0]?.name === 'string' ? actionRequests[0]?.name : undefined;
      const matchingConfigs = firstActionName
        ? reviewConfigs.filter((config) => config?.action_name === firstActionName)
        : reviewConfigs;
      const allowed = Array.from(
        new Set(
          matchingConfigs.flatMap((config) =>
            Array.isArray(config?.allowed_decisions) ? config.allowed_decisions : [],
          ),
        ),
      ).filter(
        (value): value is 'approve' | 'edit' | 'reject' => value === 'approve' || value === 'edit' || value === 'reject',
      );
      if (allowed.length) {
        return allowed;
      }
    }
    return defaults;
  }, [getInterruptKind]);

  const getInterruptActions = useCallback((
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ): RenderableInterruptAction[] => {
    const interruptActions = Array.isArray(pendingInterrupt?.actions)
      ? pendingInterrupt.actions.filter(
          (action): action is InterruptAction =>
            Boolean(action) &&
            typeof action === 'object' &&
            !Array.isArray(action) &&
            typeof action.id === 'string' &&
            typeof action.label === 'string',
        )
      : [];
    if (interruptActions.length) {
      const responseSpec = pendingInterrupt?.responseSpec;
      const clarificationChoices = Array.isArray(responseSpec?.choices) ? responseSpec.choices : [];
      return interruptActions.map((action) => ({
        ...action,
        description:
          typeof action.payload?.selectedChoiceId === 'string'
            ? clarificationChoices.find((choice) => choice.id === action.payload?.selectedChoiceId)?.description
            : clarificationChoices.find((choice) => choice.id === action.id)?.description,
        source: 'dynamic',
      }));
    }

    if (getInterruptKind(pendingInterrupt) === 'clarification') {
      const responseSpec = pendingInterrupt?.responseSpec;
      const clarificationChoices = Array.isArray(responseSpec?.choices) ? responseSpec.choices : [];
      const derivedActions: RenderableInterruptAction[] = clarificationChoices.map((choice) => ({
        id: `choice:${choice.id}`,
        label: choice.label,
        description: choice.description,
        style: 'secondary',
        inputMode: 'none',
        value: choice.value,
        source: 'clarification-choice',
        choiceId: choice.id,
      }));
      if (responseSpec?.multiple && derivedActions.length) {
        derivedActions.push({
          id: 'clarification-submit',
          label: responseSpec?.submitLabel || 'Continue',
          style: 'primary',
          inputMode: 'none',
          source: 'clarification-text',
        });
      }
      const inputMode = responseSpec?.inputMode || 'text';
      if (inputMode === 'text' || inputMode === 'text_or_choice' || !derivedActions.length) {
        derivedActions.push({
          id: 'clarification-text',
          label: responseSpec?.submitLabel || 'Continue',
          style: 'primary',
          inputMode: 'text',
          placeholder: responseSpec?.placeholder || 'Type your answer for the agent',
          submitLabel: responseSpec?.submitLabel || 'Continue',
          source: 'clarification-text',
        });
      }
      return derivedActions;
    }

    const isPlanApproval = isPlanApprovalInterrupt(pendingInterrupt);
    return getAllowedDecisions(pendingInterrupt).map((decision) => {
      if (decision === 'approve') {
        return {
          id: 'approve',
          label: 'Approve',
          style: 'primary',
          inputMode: 'none',
          source: 'approval',
          legacyDecision: 'approve',
        } satisfies RenderableInterruptAction;
      }
      if (decision === 'edit') {
        return {
          id: 'edit',
          label: 'Edit',
          style: 'secondary',
          inputMode: 'text',
          placeholder: isPlanApproval
            ? 'Describe the revisions you want before the agent resubmits the plan'
            : 'Optional edit feedback or updated args JSON',
          submitLabel: 'Save Changes',
          source: 'approval',
          legacyDecision: 'edit',
        } satisfies RenderableInterruptAction;
      }
      return {
        id: 'reject',
        label: 'Reject',
        style: 'danger',
        inputMode: 'text',
        placeholder: 'Reason for rejection (optional)',
        submitLabel: 'Confirm Rejection',
        confirm: true,
        source: 'approval',
        legacyDecision: 'reject',
      } satisfies RenderableInterruptAction;
    });
  }, [getAllowedDecisions, getInterruptKind, isPlanApprovalInterrupt]);

  const waitForInterruptResumeReady = useCallback(
    async (
      runId: string,
      expected: 'approval' | 'clarification' | 'action',
    ): Promise<boolean> => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try {
          const status = await getRunStatus(runId);
          if (status.status === 'awaiting_approval') {
            const interruptKind = getInterruptKind(status.pendingInterrupt);
            if (expected === 'approval' && interruptKind !== 'clarification') {
              return true;
            }
            if (expected === 'clarification' && interruptKind === 'clarification') {
              return true;
            }
            if (
              expected === 'action' &&
              Array.isArray(status.pendingInterrupt?.actions) &&
              status.pendingInterrupt.actions.length > 0
            ) {
              return true;
            }
          }
        } catch (error) {
          console.error('Failed to poll run status before interrupt retry', error);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 200));
      }
      return false;
    },
    [getInterruptKind],
  );

  const submitInterruptWithRetry = useCallback(
    async (
      runId: string,
      expected: 'approval' | 'clarification' | 'action',
      submit: () => Promise<unknown>,
    ) => {
      try {
        return await submit();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || '');
        if (!/Run is not awaiting/i.test(message)) {
          throw error;
        }
        const ready = await waitForInterruptResumeReady(runId, expected);
        if (!ready) {
          throw error;
        }
        return submit();
      }
    },
    [waitForInterruptResumeReady],
  );

  const handleStreamChunk = useCallback((
    conversationId: string,
    agentMessageIndex: number,
    chunk: AgentStreamChunk,
    runId?: string,
  ) => {
    const markStreamingState = (
      metadata: ConversationMessageMetadata | undefined,
    ): ConversationMessageMetadata => {
      const nextMetadata = { ...(metadata || {}) };
      if (runId) {
        nextMetadata.runId = runId;
      }
      // Any real stream activity after resume means the prior interrupt has been
      // consumed; keeping it here causes stale approval/clarification cards to linger.
      nextMetadata.status = 'running';
      nextMetadata.pendingInterrupt = undefined;
      return nextMetadata;
    };

    if (chunk.type === 'keepalive') {
      setStreamingForConversation(conversationId, true);
      setConversationAttention(conversationId, 'running', 'Working through the current request.');
      return;
    }

    if (chunk.type === 'policy') {
      const nextRunPolicy = sanitizeRunPolicy({
        skill: chunk.skill,
        requiresHitlPlan: chunk.requiresHitlPlan,
        requiresArtifacts: chunk.requiresArtifacts,
        requiredArtifactsMode: chunk.requiredArtifactsMode,
        prePlanSearchLimit: chunk.prePlanSearchLimit,
        prePlanSearchUsed: chunk.prePlanSearchUsed,
      });
      updateMessageMetadataAtIndex(conversationId, agentMessageIndex, (metadata) => ({
        ...markStreamingState(metadata),
        runPolicy: nextRunPolicy,
      }));
      return;
    }

    if (chunk.type === 'thought') {
      updateMessageMetadataAtIndex(conversationId, agentMessageIndex, markStreamingState);
      appendAgentThought(conversationId, agentMessageIndex, chunk.content || '');
      if (chunk.content?.trim()) {
        setConversationAttention(conversationId, 'running', chunk.content);
      }
      return;
    }

    if (chunk.type === 'tool_start') {
      updateMessageMetadataAtIndex(conversationId, agentMessageIndex, markStreamingState);
      appendToolStart(conversationId, agentMessageIndex, chunk);
      setConversationAttention(
        conversationId,
        'running',
        `${getFriendlyToolName(chunk.name || chunk.content || '')}…`,
      );
      return;
    }

    if (chunk.type === 'tool_end') {
      updateMessageMetadataAtIndex(conversationId, agentMessageIndex, markStreamingState);
      if (chunk.dashboardArtifact) {
        mergeDashboardArtifact(chunk.dashboardArtifact);
      }
      appendToolEnd(conversationId, agentMessageIndex, chunk);
      const streamLabel = chunk.name || 'tool';
      const streamRaw = chunk.content?.trim();
      const friendly = streamRaw
        ? translateToolChunkForStorage(streamRaw, streamLabel, 160) ?? trimMilestone(streamRaw)
        : '';
      setConversationAttention(
        conversationId,
        'running',
        friendly || `${getFriendlyToolName(streamLabel)} · done`,
      );
      return;
    }

    if (chunk.type === 'tool_error') {
      updateMessageMetadataAtIndex(conversationId, agentMessageIndex, markStreamingState);
      appendToolEnd(conversationId, agentMessageIndex, chunk, 'error');
      const errLabel = chunk.name || 'tool';
      const errRaw = chunk.content?.trim();
      const translatedErr = translateToolChunkForStorage(errRaw || '', errLabel, 160);
      const benignAttention = isBenignToolStreamContent(errRaw || '')
        || (translatedErr && /File already exists,\s*switching to edit mode/i.test(translatedErr));
      setConversationAttention(
        conversationId,
        'running',
        benignAttention && translatedErr
          ? translatedErr
          : benignAttention
            ? 'File already exists, switching to edit mode.'
            : translatedErr?.trim()
              ? translatedErr.trim()
              : `${getFriendlyToolName(errLabel)} hit a snag—details are in the activity log.`,
      );
      return;
    }

    if (chunk.type === 'dashboard_artifact') {
      mergeDashboardArtifact(chunk.dashboardArtifact);
      return;
    }

    if (chunk.type === 'interrupt') {
      updateMessageMetadataAtIndex(conversationId, agentMessageIndex, (metadata) => ({
        ...metadata,
        ...(runId ? { runId } : {}),
        status: 'awaiting_approval',
        pendingInterrupt: {
          kind: chunk.kind,
          interruptId: chunk.interruptId,
          title: chunk.title,
          description: chunk.description,
          stepIndex: chunk.stepIndex,
          stepCount: chunk.stepCount,
          actions: chunk.actions,
          actionRequests: chunk.actionRequests,
          reviewConfigs: chunk.reviewConfigs,
          responseSpec: chunk.responseSpec,
          displayPayload: chunk.displayPayload,
        },
      }));
      setConversationAttention(
        conversationId,
        'awaiting_approval',
        chunk.title || chunk.description || 'Waiting for your input.',
      );
      return;
    }

    if (chunk.type === 'token' || chunk.type === 'chunk') {
      updateMessageMetadataAtIndex(conversationId, agentMessageIndex, (metadata) => ({
        ...markStreamingState(metadata),
        bodySource: 'assistant',
      }));
      if (chunk.role && chunk.role !== 'assistant') {
        return;
      }
      bufferAgentChunk(conversationId, agentMessageIndex, chunk.content || '');
      return;
    }

    if (chunk.type === 'contract_error') {
      setConversationAttention(conversationId, 'failed', chunk.message || 'Artifact contract failed.');
      return;
    }

    if (chunk.type === 'error') {
      setConversationAttention(conversationId, 'failed', chunk.message || 'Agent stream failed.');
    }
  }, [
    appendAgentThought,
    appendToolEnd,
    appendToolStart,
    bufferAgentChunk,
    mergeDashboardArtifact,
    setConversationAttention,
    setStreamingForConversation,
    updateMessageMetadataAtIndex,
  ]);

  const streamRunForConversation = useCallback(
    async (runInfo: ActiveRunInfo, replayFromStart = false, resumeAfterId?: string) => {
      const { conversationId, runId, turnId, placeholderId } = runInfo;
      // Mark the run as actively handled before any state updates land so the
      // resume effect does not start a second stream for the same run.
      resumeAttemptedRef.current.add(runId);
      resumeInFlightRef.current.add(runId);
      cancelStreamForConversation(conversationId);
      const initialAgentMessageIndex = ensureAgentPlaceholder(conversationId, placeholderId, turnId, replayFromStart);
      if (initialAgentMessageIndex < 0) {
        if (STREAM_DEBUG_ENABLED) {
          console.debug('[WorkspacePage] missing placeholder', { runId, conversationId });
        }
        removeActiveRun(runId);
        return;
      }

      if (replayFromStart) {
        agentChunkBufferRef.current.delete(conversationId);
        agentMessageBufferRef.current.set(placeholderId, '');
      }

      const controller = new AbortController();
      streamAbortMapRef.current.set(conversationId, controller);
      setStreamingForConversation(conversationId, true);
      setConversationAttention(conversationId, 'running', 'Streaming the latest agent updates...');
      let finalStatus: AgentRunStatus = 'completed';
      let lastStreamId = resumeAfterId || runInfo.lastStreamId;
      let latestStatusSnapshot:
        | Awaited<ReturnType<typeof getRunStatus>>
        | null = null;
      let latestInterrupt:
        | ConversationMessageMetadata['pendingInterrupt']
        | undefined;

      try {
        if (STREAM_DEBUG_ENABLED) {
          console.debug('[WorkspacePage] start stream', { runId, conversationId });
        }
        await streamAgentRun(
          runId,
          (chunk) => {
            const agentMessageIndex = (() => {
              const resolved = findAgentMessageIndexForRun(conversationId, placeholderId, turnId, runId);
              return resolved >= 0 ? resolved : initialAgentMessageIndex;
            })();
            const resumableChunk = chunk as AgentStreamChunk & { id?: string };
            if (typeof resumableChunk.id === 'string') {
              lastStreamId = resumableChunk.id;
            }
            if (chunk.type === 'interrupt') {
              latestInterrupt = {
                kind: chunk.kind,
                interruptId: chunk.interruptId,
                title: chunk.title,
                description: chunk.description,
                stepIndex: chunk.stepIndex,
                stepCount: chunk.stepCount,
                actions: chunk.actions,
                actionRequests: chunk.actionRequests,
                reviewConfigs: chunk.reviewConfigs,
                responseSpec: chunk.responseSpec,
                displayPayload: chunk.displayPayload,
              };
            }
            handleStreamChunk(conversationId, agentMessageIndex, chunk, runId);
          },
          controller.signal,
          replayFromStart ? undefined : (resumeAfterId || runInfo.lastStreamId)
        );
      } catch (error) {
        const supersededByNewerStream = streamAbortMapRef.current.get(conversationId) !== controller;
        const agentMessageIndex = (() => {
          const resolved = findAgentMessageIndexForRun(conversationId, placeholderId, turnId, runId);
          return resolved >= 0 ? resolved : initialAgentMessageIndex;
        })();
        if ((error as DOMException)?.name === 'AbortError') {
          if (stopRequestedRef.current) {
            finalStatus = 'cancelled';
            setConversationAttention(conversationId, 'cancelled', 'The latest run was stopped.');
          } else if (!supersededByNewerStream) {
            finalStatus = 'cancelled';
            setConversationAttention(conversationId, 'cancelled', 'The latest run was cancelled.');
          }
        } else {
          console.error('Failed to stream agent run', error);
          try {
            latestStatusSnapshot = await getRunStatus(runId);
            finalStatus = latestStatusSnapshot.status;
            latestInterrupt = latestStatusSnapshot.pendingInterrupt ?? latestInterrupt;
          } catch (statusError) {
            console.error('Failed to fetch run status after stream error', statusError);
          }
          if (
            finalStatus === 'awaiting_approval'
            || finalStatus === 'completed'
            || finalStatus === 'cancelled'
          ) {
            if (finalStatus === 'awaiting_approval' && latestInterrupt) {
              updateMessageMetadataAtIndex(conversationId, agentMessageIndex, (metadata) => ({
                ...metadata,
                ...(runId ? { runId } : {}),
                status: 'awaiting_approval',
                pendingInterrupt: latestInterrupt,
              }));
            }
          } else {
            finalStatus = 'failed';
            setConversationAttention(conversationId, 'failed', 'Sorry, something went wrong.');
          }
        }
      } finally {
        const supersededByNewerStream = streamAbortMapRef.current.get(conversationId) !== controller;
        let latestRunMeta:
          | Awaited<ReturnType<typeof getRunStatus>>
          | null = latestStatusSnapshot;
        try {
          latestRunMeta = await getRunStatus(runId);
          finalStatus = latestRunMeta.status;
          // The stream can close before the backend worker updates Redis from
          // "running" to its settled terminal/approval state. Poll briefly so
          // we don't persist a stale running bubble and drop the pending interrupt.
          if (finalStatus === 'running' || finalStatus === 'queued') {
            for (let attempt = 0; attempt < 8; attempt += 1) {
              await new Promise((resolve) => window.setTimeout(resolve, 250));
              latestRunMeta = await getRunStatus(runId);
              finalStatus = latestRunMeta.status;
              if (finalStatus !== 'running' && finalStatus !== 'queued') {
                break;
              }
            }
          }
          if (finalStatus === 'awaiting_approval' && !latestRunMeta?.pendingInterrupt && !latestInterrupt) {
            for (let attempt = 0; attempt < 8; attempt += 1) {
              await new Promise((resolve) => window.setTimeout(resolve, 250));
              latestRunMeta = await getRunStatus(runId);
              finalStatus = latestRunMeta.status;
              if (latestRunMeta.pendingInterrupt) {
                break;
              }
            }
          }
        } catch (statusError) {
          console.error('Failed to fetch final run status', statusError);
        }
        const effectivePendingInterrupt = latestRunMeta ? latestRunMeta.pendingInterrupt : latestInterrupt;
        if (!supersededByNewerStream && effectivePendingInterrupt) {
            const agentMessageIndex = (() => {
              const resolved = findAgentMessageIndexForRun(conversationId, placeholderId, turnId, runId);
              return resolved >= 0 ? resolved : initialAgentMessageIndex;
            })();
            finalStatus = 'awaiting_approval';
            updateMessageMetadataAtIndex(conversationId, agentMessageIndex, (metadata) => ({
              ...metadata,
              ...(runId ? { runId } : {}),
              status: 'awaiting_approval',
              pendingInterrupt: effectivePendingInterrupt,
            }));
        }
        if (STREAM_DEBUG_ENABLED) {
          console.debug('[WorkspacePage] stream finished', { runId, status: finalStatus });
        }
        flushBufferedAgentChunks();
        if (!supersededByNewerStream && (finalStatus === 'running' || finalStatus === 'queued')) {
          const reconnectAttempts = (runInfo.streamReconnectAttempts || 0) + 1;
          if (reconnectAttempts > 5) {
            const failedStatus: AgentRunStatus = 'failed';
            await syncRunStateToConversation(
              {
                ...runInfo,
                status: failedStatus,
                lastStreamId,
              },
              failedStatus,
              undefined,
            );
            setConversationAttention(
              conversationId,
              failedStatus,
              'The run stream did not settle after several reconnects.',
            );
            setStreamingForConversation(conversationId, false);
            if (streamAbortMapRef.current.get(conversationId) === controller) {
              streamAbortMapRef.current.delete(conversationId);
            }
            stopRequestedRef.current = false;
            resumeInFlightRef.current.delete(runId);
            removeActiveRun(runId);
          } else {
            const resumedRunInfo: ActiveRunInfo = {
              ...runInfo,
              status: 'running',
              lastStreamId,
              streamReconnectAttempts: reconnectAttempts,
            };
            registerActiveRun(resumedRunInfo);
            setConversationAttention(conversationId, 'running', 'Streaming the latest agent updates...');
            if (streamAbortMapRef.current.get(conversationId) === controller) {
              streamAbortMapRef.current.delete(conversationId);
            }
            window.setTimeout(() => {
              const activeRun = activeRunsRef.current[runId];
              if (!activeRun || activeRun.status !== 'running') {
                return;
              }
              void streamRunForConversation(activeRun, false, activeRun.lastStreamId);
            }, Math.min(10000, 1000 * reconnectAttempts));
          }
        } else if (!supersededByNewerStream) {
          const normalizedFinalStatus = normalizeRunStatus(finalStatus);
          await syncRunStateToConversation(
            {
              ...runInfo,
              status: normalizedFinalStatus,
              lastStreamId,
            },
            normalizedFinalStatus,
            normalizedFinalStatus === 'awaiting_approval' ? effectivePendingInterrupt : undefined,
          );
          setConversationAttention(
            conversationId,
            normalizedFinalStatus,
            normalizedFinalStatus === 'awaiting_approval'
              ? effectivePendingInterrupt?.title || effectivePendingInterrupt?.description || 'Waiting for your input.'
              : normalizedFinalStatus === 'completed'
                ? 'The latest run completed.'
                : normalizedFinalStatus === 'cancelled'
                  ? 'The latest run was stopped.'
                  : latestRunMeta?.error || 'The latest run failed.',
          );
          setStreamingForConversation(conversationId, false);
          if (streamAbortMapRef.current.get(conversationId) === controller) {
            streamAbortMapRef.current.delete(conversationId);
          }
          stopRequestedRef.current = false;
          resumeInFlightRef.current.delete(runId);
          if (finalStatus === 'awaiting_approval') {
            registerActiveRun({ ...runInfo, status: finalStatus, lastStreamId, streamReconnectAttempts: 0 });
          } else {
            removeActiveRun(runId);
            removeActiveRunsForTurn(conversationId, turnId);
            const workspaceId = selectedWorkspace?.id;
            if (workspaceId) {
              loadFilesForWorkspace(workspaceId);
            }
          }
        }
      }
    },
    [
      registerActiveRun,
      cancelStreamForConversation,
      ensureAgentPlaceholder,
      handleStreamChunk,
      flushBufferedAgentChunks,
      findAgentMessageIndexForRun,
      removeActiveRun,
      removeActiveRunsForTurn,
      selectedWorkspace?.id,
      loadFilesForWorkspace,
      setConversationAttention,
      setStreamingForConversation,
      syncRunStateToConversation,
      updateMessageMetadataAtIndex,
    ],
  );

  const launchPreparedAgentRun = useCallback(async (params: {
    workspaceId: string;
    persona: string;
    conversationId: string;
    turnId: string;
    prompt: string;
    historyPayload: Array<{ role: string; content: string }>;
    fileContextRefs?: FileContextRef[];
    currentTurnFileIds?: number[];
    taggedFiles?: string[];
    internetSearchEnabled?: boolean;
  }) => {
    const {
      workspaceId,
      persona,
      conversationId,
      turnId,
      prompt,
      historyPayload,
      fileContextRefs,
      currentTurnFileIds,
      taggedFiles,
      internetSearchEnabled,
    } = params;
    const { runId } = await startAgentRun(
      workspaceId,
      conversationId,
      persona,
      prompt,
      historyPayload.length ? historyPayload : undefined,
      turnId,
      {
        forceReset: true,
        taggedFiles,
        fileContextRefs,
        currentTurnFileIds,
        internetSearchEnabled,
      },
    );
    if (STREAM_DEBUG_ENABLED) {
      console.debug('[WorkspacePage] run started', { runId, conversationId });
    }
    const placeholderId = `agent-${runId}`;
    ensureAgentPlaceholder(conversationId, placeholderId, turnId, true);
    agentMessageBufferRef.current.set(placeholderId, '');
    const runInfo: ActiveRunInfo = {
      runId,
      conversationId,
      workspaceId,
      persona,
      turnId,
      placeholderId,
      status: 'running',
    };
    markRunStreamLaunching(runId);
    registerActiveRun(runInfo);
    setConversationAttention(conversationId, 'running', 'Queued the latest run...');
    await streamRunForConversation(runInfo, true);

    const messagesSnapshot = getConversationMessagesSnapshot(conversationId);
    const targetIndex = messagesSnapshot.findIndex((message) => message.id === placeholderId);
    const agentMessage = targetIndex >= 0 ? messagesSnapshot[targetIndex] : null;
    const metadata = buildMessageMetadata(agentMessage) || {};
    const bufferedText =
      placeholderId !== null && placeholderId !== undefined
        ? agentMessageBufferRef.current.get(placeholderId) ?? agentMessage?.text
        : agentMessage?.text;
    const placeholderTurnId = agentMessage?.turnId || turnId;
    if (bufferedText) {
      try {
        const persisted = await appendConversationMessage(conversationId, 'agent', bufferedText, {
          turnId: placeholderTurnId,
          metadata: { ...metadata, runId },
          replaceExisting: true,
        });
        upsertPersistedAgentMessage(conversationId, persisted, {
          placeholderId,
          existing: agentMessage,
        });
        if (placeholderId !== null && placeholderId !== undefined) {
          agentMessageBufferRef.current.delete(placeholderId);
        }
        agentMessageBufferRef.current.set(persisted.id, persisted.text || '');
        await refreshConversationHistory(workspaceId);
      } catch (error) {
        console.error('Failed to store agent message', error);
      }
    } else if (placeholderId !== null && placeholderId !== undefined) {
      agentMessageBufferRef.current.delete(placeholderId);
    }
  }, [
    ensureAgentPlaceholder,
    getConversationMessagesSnapshot,
    markRunStreamLaunching,
    refreshConversationHistory,
    registerActiveRun,
    setConversationAttention,
    streamRunForConversation,
    upsertPersistedAgentMessage,
  ]);

  useEffect(() => {
    if (!selectedWorkspace?.id || !activeConversationId) {
      return;
    }
    const workspaceId = selectedWorkspace.id;
    const conversationId = activeConversationId;
    const messagesForConversation = conversationMessages[conversationId] || [];
    const pendingMessages = messagesForConversation.filter((message) => {
      if (message.sender !== 'user' || !message.turnId) {
        return false;
      }
      const metadata = message.metadata as ConversationMessageMetadata | undefined;
      return Boolean(
        metadata?.attachmentJobId
        && (metadata.attachmentPrepStatus === 'pending' || metadata.attachmentPrepStatus === 'running'),
      );
    });
    pendingMessages.forEach((message) => {
      const metadata = message.metadata as ConversationMessageMetadata | undefined;
      const jobId = metadata?.attachmentJobId;
      if (!jobId || attachmentPrepResumeRef.current.has(jobId)) {
        return;
      }
      attachmentPrepResumeRef.current.add(jobId);
      void (async () => {
        try {
          const turnId = message.turnId;
          if (!turnId) {
            return;
          }
          setIsDriveImporting(true);
          const settledJob = await waitForAttachmentPrepJob(workspaceId, jobId);
          if (settledJob.status === 'failed') {
            await persistUserMessageMetadata(conversationId, message, {
              ...(metadata || {}),
              attachmentJobId: jobId,
              attachmentPrepStatus: 'failed',
              attachmentPrepError: settledJob.error || 'Failed to prepare attachments.',
            });
            return;
          }
          const readyRefs = settledJob.result?.fileContextRefs?.length
            ? settledJob.result.fileContextRefs
            : undefined;
          await persistUserMessageMetadata(conversationId, message, {
            ...(metadata || {}),
            attachmentJobId: jobId,
            attachmentPrepStatus: 'ready',
            attachmentPrepError: undefined,
            fileContextRefs: readyRefs,
          });
          const agentExistsForTurn = getConversationMessagesSnapshot(conversationId).some(
            (candidate) => candidate.sender === 'agent' && candidate.turnId === message.turnId,
          );
          if (agentExistsForTurn) {
            return;
          }
          const updatedMessages = getConversationMessagesSnapshot(conversationId);
          const historyPayload = mapMessagesToAgentHistory(updatedMessages);
          const directive = parseSlashDirective(message.text.trim());
          const agentPromptBase = buildAgentPromptFromDirective(directive) || message.text;
          const attachmentPrompt = readyRefs?.length
            ? `Use these attached files as primary context: ${readyRefs.map((ref) => ref.sourceName).join(', ')}`
            : '';
          await launchPreparedAgentRun({
            workspaceId,
            persona: normalizePersonaName(activeConversationPersona || selectedPersona || DEFAULT_PERSONA_NAME),
            conversationId,
            turnId,
            prompt: attachmentPrompt
              ? `${agentPromptBase}${agentPromptBase ? '\n\n' : ''}${attachmentPrompt}`
              : agentPromptBase,
            historyPayload,
            fileContextRefs: readyRefs,
            currentTurnFileIds: settledJob.result?.multimodalFileIds,
            taggedFiles: readyRefs?.map((ref) => ref.sourceName).filter(Boolean),
          });
        } catch (error) {
          console.error('Failed to resume attachment prep job', error);
        } finally {
          attachmentPrepResumeRef.current.delete(jobId);
          setIsDriveImporting(false);
        }
      })();
    });
  }, [
    activeConversationId,
    activeConversationPersona,
    buildAgentPromptFromDirective,
    conversationMessages,
    getConversationMessagesSnapshot,
    launchPreparedAgentRun,
    parseSlashDirective,
    persistUserMessageMetadata,
    selectedPersona,
    selectedWorkspace?.id,
    waitForAttachmentPrepJob,
  ]);

  const handleInterruptDecision = useCallback(
    async (
      message: ConversationMessage,
      decision: 'approve' | 'edit' | 'reject',
      pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
    ) => {
      const allowedDecisions = getAllowedDecisions(pendingInterrupt);
      if (!allowedDecisions.includes(decision)) {
        addLocalSystemMessage(`"${decision}" is not allowed for this approval request.`);
        return;
      }
      const runId = findRunIdForMessage(message);
      if (!runId) {
        addLocalSystemMessage('Missing run id for approval action.');
        return;
      }
      updateMessagesForConversation(message.conversationId, (prev) => {
        const next = [...prev];
        const idx = next.findIndex((item) => item.id === message.id);
        if (idx === -1) return next;
        const current = next[idx];
        const metadata = { ...((current.metadata as ConversationMessageMetadata | undefined) || {}) };
        if (!metadata.runId) {
          metadata.runId = runId;
          next[idx] = { ...current, metadata };
        }
        return next;
      });
      const messageKey = String(message.id);
      const primaryAction = getPrimaryInterruptAction(pendingInterrupt);
      const isPlanApproval = isPlanApprovalInterrupt(pendingInterrupt);
      const approvalReview = isPlanApproval ? buildApprovalReview(pendingInterrupt, primaryAction) : null;
      const approvalPlanPath = normalizeWorkspaceRelativePath(approvalReview?.planFilePath || DEFAULT_PLAN_FILE_PATH);
      const activeEditorPath = normalizeWorkspaceRelativePath(selectedFile?.name || selectedFile?.path);
      const editedPlanContent =
        isPlanApproval && approvalPlanPath && activeEditorPath === approvalPlanPath
          ? fileContent.trim()
          : '';
      const feedbackKey = isPlanApproval
        ? interruptFieldKey(messageKey, 'feedback')
        : interruptFieldKey(messageKey, 'reject-note');
      const rawFeedback = (interruptInputByMessageId[feedbackKey] || '').trim();
      setInterruptSubmittingByMessageId((prev) => ({ ...prev, [messageKey]: true }));
      setInterruptErrorByMessageId((prev) => {
        if (!prev[messageKey]) return prev;
        const next = { ...prev };
        delete next[messageKey];
        return next;
      });
      try {
        const options: {
          editedAction?: { name: string; args: Record<string, unknown> };
          message?: string;
        } = {};
        if (decision === 'reject') {
          options.message = rawFeedback || 'Rejected by user';
        }
        if (decision === 'edit') {
          if (isPlanApproval) {
            const originalArgs =
              primaryAction?.args && typeof primaryAction.args === 'object' && !Array.isArray(primaryAction.args)
                ? primaryAction.args
                : {};
            options.editedAction = {
              name: (primaryAction?.name as string) || 'request_plan_approval',
              args: {
                ...originalArgs,
                reviewer_feedback: rawFeedback,
                plan_file_path: approvalPlanPath || DEFAULT_PLAN_FILE_PATH,
                ...(editedPlanContent ? { edited_plan_content: editedPlanContent } : {}),
              },
            };
            options.message = rawFeedback || 'User requested edits.';
          } else {
            const rawEditArgs = (interruptInputByMessageId[interruptFieldKey(messageKey, 'edit-json')] || '').trim();
            let parsedArgs: Record<string, unknown> = {};
            if (rawEditArgs) {
              try {
                const parsed = JSON.parse(rawEditArgs);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  parsedArgs = parsed as Record<string, unknown>;
                } else {
                  parsedArgs = { reviewer_feedback: rawEditArgs };
                }
              } catch {
                parsedArgs = { reviewer_feedback: rawEditArgs };
              }
              if (!options.message) {
                options.message = 'User requested edits.';
              }
            }
            options.editedAction = {
              name: (primaryAction?.name as string) || 'request_plan_approval',
              args: parsedArgs,
            };
          }
        }
        await submitInterruptWithRetry(runId, 'approval', () => submitRunDecision(runId, decision, options));
        clearPendingInterruptForRun(message.conversationId, runId, message.turnId);
        setInterruptInputByMessageId((prev) => {
          const next = { ...prev };
          delete next[interruptFieldKey(messageKey, 'feedback')];
          delete next[interruptFieldKey(messageKey, 'edit-json')];
          delete next[interruptFieldKey(messageKey, 'reject-note')];
          return next;
        });
        setInterruptErrorByMessageId((prev) => {
          if (!prev[messageKey]) return prev;
          const next = { ...prev };
          delete next[messageKey];
          return next;
        });
        const existingRunInfo = activeRunsRef.current[runId];
        const rebuiltRunInfo = await rebuildRunInfoForMessage(message, runId).catch(() => undefined);
        const runInfo = {
          ...(existingRunInfo || rebuiltRunInfo || {
            runId,
            conversationId: message.conversationId,
            workspaceId: selectedWorkspace?.id || '',
            persona: normalizePersonaName(activeConversationPersona || selectedPersona || DEFAULT_PERSONA_NAME),
            turnId: message.turnId || generateTurnId(),
            placeholderId: message.id,
            status: 'running' as AgentRunStatus,
          }),
          status: 'running' as AgentRunStatus,
        };
        markRunStreamLaunching(runId);
        registerActiveRun(runInfo);
        setConversationAttention(message.conversationId, 'running', 'Resuming the run...');
        if (runInfo) {
          await streamRunForConversation(runInfo, false);
        } else {
          addLocalSystemMessage('Approval saved. Refreshing stream state...');
        }
      } catch (error) {
        console.error('Failed to submit approval decision', error);
        setInterruptErrorByMessageId((prev) => ({
          ...prev,
          [messageKey]: error instanceof Error ? error.message : 'Failed to submit approval decision.',
        }));
      } finally {
        setInterruptSubmittingByMessageId((prev) => ({ ...prev, [messageKey]: false }));
      }
    },
    [
      activeConversationPersona,
      addLocalSystemMessage,
      fileContent,
      interruptInputByMessageId,
      interruptFieldKey,
      findRunIdForMessage,
      getPrimaryInterruptAction,
      getAllowedDecisions,
      isPlanApprovalInterrupt,
      selectedFile,
      selectedPersona,
      selectedWorkspace?.id,
      rebuildRunInfoForMessage,
      clearPendingInterruptForRun,
      markRunStreamLaunching,
      registerActiveRun,
      setConversationAttention,
      submitInterruptWithRetry,
      streamRunForConversation,
      updateMessagesForConversation,
    ],
  );

  const handleClarificationResponse = useCallback(
    async (
      message: ConversationMessage,
      pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
    ) => {
      if (getInterruptKind(pendingInterrupt) !== 'clarification') {
        addLocalSystemMessage('This interruption expects an approval decision, not a clarification response.');
        return;
      }
      const runId = findRunIdForMessage(message);
      if (!runId) {
        addLocalSystemMessage('Missing run id for clarification response.');
        return;
      }
      const messageKey = String(message.id);
      const textKey = interruptFieldKey(messageKey, 'clarification-text');
      const rawMessage = (interruptInputByMessageId[textKey] || '').trim();
      const structuredQuestions = Array.isArray(pendingInterrupt?.responseSpec?.questions)
        ? pendingInterrupt.responseSpec.questions as InterruptQuestion[]
        : [];
      const structuredAnswers = interruptStructuredAnswersByMessageId[messageKey];
      const hasStructuredQuestionnaire = structuredQuestions.length > 0;
      const hasCompleteStructuredAnswers = hasStructuredQuestionnaire
        ? areStructuredClarificationQuestionsComplete(structuredQuestions, structuredAnswers)
        : false;
      const selectedChoiceIds = interruptSelectedChoicesByMessageId[messageKey] || [];
      const choices = pendingInterrupt?.responseSpec?.choices || [];
      const selectedValues = selectedChoiceIds
        .map((choiceId) => choices.find((choice) => choice.id === choiceId)?.value)
        .filter((value): value is string => typeof value === 'string');
      const structuredSummary = hasStructuredQuestionnaire && structuredAnswers
        ? buildStructuredClarificationMessage(structuredQuestions, structuredAnswers, rawMessage)
        : rawMessage;
      const answersByQuestionId = hasStructuredClarificationAnswers(structuredAnswers)
        ? structuredAnswers
        : undefined;

      if (hasStructuredQuestionnaire && !hasCompleteStructuredAnswers) {
        setInterruptErrorByMessageId((prev) => ({
          ...prev,
          [messageKey]: 'Answer each clarification step before continuing.',
        }));
        return;
      }

      if (!structuredSummary && !selectedChoiceIds.length && !selectedValues.length && !answersByQuestionId) {
        addLocalSystemMessage('Choose an option or enter a clarification response before continuing.');
        return;
      }

      setInterruptSubmittingByMessageId((prev) => ({ ...prev, [messageKey]: true }));
      setInterruptErrorByMessageId((prev) => {
        if (!prev[messageKey]) return prev;
        const next = { ...prev };
        delete next[messageKey];
        return next;
      });
      try {
        await submitInterruptWithRetry(runId, 'clarification', () =>
          submitRunResponse(runId, {
            message: structuredSummary || undefined,
            selectedChoiceIds: selectedChoiceIds.length ? selectedChoiceIds : undefined,
            selectedValues: selectedValues.length ? selectedValues : undefined,
            answersByQuestionId,
          })
        );
        clearPendingInterruptForRun(message.conversationId, runId, message.turnId);
        setInterruptInputByMessageId((prev) => {
          const next = { ...prev };
          delete next[textKey];
          return next;
        });
        setInterruptStructuredAnswersByMessageId((prev) => {
          if (!prev[messageKey]) {
            return prev;
          }
          const next = { ...prev };
          delete next[messageKey];
          return next;
        });
        setInterruptSelectedChoicesByMessageId((prev) => {
          const next = { ...prev };
          delete next[messageKey];
          return next;
        });
        if (typeof window !== 'undefined' && pendingInterrupt?.interruptId) {
          window.localStorage.removeItem(
            buildClarificationDraftStorageKey(message.conversationId, message.id, pendingInterrupt.interruptId),
          );
        }
        setInterruptErrorByMessageId((prev) => {
          if (!prev[messageKey]) return prev;
          const next = { ...prev };
          delete next[messageKey];
          return next;
        });
        const existingRunInfo = activeRunsRef.current[runId];
        const rebuiltRunInfo = await rebuildRunInfoForMessage(message, runId).catch(() => undefined);
        const runInfo = {
          ...(existingRunInfo || rebuiltRunInfo || {
            runId,
            conversationId: message.conversationId,
            workspaceId: selectedWorkspace?.id || '',
            persona: normalizePersonaName(activeConversationPersona || selectedPersona || DEFAULT_PERSONA_NAME),
            turnId: message.turnId || generateTurnId(),
            placeholderId: message.id,
            status: 'running' as AgentRunStatus,
          }),
          status: 'running' as AgentRunStatus,
        };
        markRunStreamLaunching(runId);
        registerActiveRun(runInfo);
        setConversationAttention(message.conversationId, 'running', 'Resuming the run...');
        if (runInfo) {
          await streamRunForConversation(runInfo, false);
        } else {
          addLocalSystemMessage('Response saved. Refreshing stream state...');
        }
      } catch (error) {
        console.error('Failed to submit clarification response', error);
        setInterruptErrorByMessageId((prev) => ({
          ...prev,
          [messageKey]: error instanceof Error ? error.message : 'Failed to submit clarification response.',
        }));
      } finally {
        setInterruptSubmittingByMessageId((prev) => ({ ...prev, [messageKey]: false }));
      }
    },
    [
      activeConversationPersona,
      addLocalSystemMessage,
      findRunIdForMessage,
      getInterruptKind,
      interruptFieldKey,
      interruptInputByMessageId,
      interruptStructuredAnswersByMessageId,
      interruptSelectedChoicesByMessageId,
      rebuildRunInfoForMessage,
      selectedPersona,
      selectedWorkspace?.id,
      setConversationAttention,
      clearPendingInterruptForRun,
      markRunStreamLaunching,
      registerActiveRun,
      setInterruptStructuredAnswersByMessageId,
      submitInterruptWithRetry,
      streamRunForConversation,
    ],
  );

  const toggleInterruptSelectedChoice = useCallback((messageKey: string, choiceId: string, multiple: boolean) => {
    setInterruptSelectedChoicesByMessageId((prev) => {
      const current = prev[messageKey] || [];
      let nextChoices: string[];
      if (multiple) {
        nextChoices = current.includes(choiceId)
          ? current.filter((id) => id !== choiceId)
          : [...current, choiceId];
      } else {
        nextChoices = current.length === 1 && current[0] === choiceId ? [] : [choiceId];
      }
      if (!nextChoices.length) {
        const next = { ...prev };
        delete next[messageKey];
        return next;
      }
      return {
        ...prev,
        [messageKey]: nextChoices,
      };
    });
    setInterruptErrorByMessageId((prev) => {
      if (!prev[messageKey]) return prev;
      const next = { ...prev };
      delete next[messageKey];
      return next;
    });
  }, []);

  const handleInterruptAction = useCallback(
    async (
      message: ConversationMessage,
      action: RenderableInterruptAction,
      pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
    ) => {
      if (action.source === 'approval' && action.legacyDecision) {
        await handleInterruptDecision(message, action.legacyDecision, pendingInterrupt);
        return;
      }

      if (getInterruptKind(pendingInterrupt) === 'clarification' && action.inputMode === 'text') {
        await handleClarificationResponse(message, pendingInterrupt);
        return;
      }

      const runId = findRunIdForMessage(message);
      if (!runId) {
        addLocalSystemMessage('Missing run id for interrupt action.');
        return;
      }

      const messageKey = String(message.id);
      const actionTextKey = interruptActionFieldKey(messageKey, action.id);
      const actionText = (interruptInputByMessageId[actionTextKey] || '').trim();

      if (action.source === 'clarification-choice') {
        if (getInterruptKind(pendingInterrupt) !== 'clarification') {
          addLocalSystemMessage(
            'This run is waiting for a plan approval. Use Approve, Edit plan, or Reject instead of a quick reply.',
          );
          return;
        }
        if (pendingInterrupt?.responseSpec?.multiple && action.choiceId) {
          toggleInterruptSelectedChoice(messageKey, action.choiceId, true);
          return;
        }
        setInterruptSubmittingByMessageId((prev) => ({ ...prev, [messageKey]: true }));
        setInterruptErrorByMessageId((prev) => {
          if (!prev[messageKey]) return prev;
          const next = { ...prev };
          delete next[messageKey];
          return next;
        });
        try {
          await submitInterruptWithRetry(runId, 'clarification', () =>
            submitRunResponse(runId, {
              selectedChoiceIds: action.choiceId ? [action.choiceId] : undefined,
              selectedValues: action.value ? [action.value] : undefined,
            })
          );
          clearPendingInterruptForRun(message.conversationId, runId, message.turnId);
          setInterruptErrorByMessageId((prev) => {
            if (!prev[messageKey]) return prev;
            const next = { ...prev };
            delete next[messageKey];
            return next;
          });
          const existingRunInfo = activeRunsRef.current[runId];
          const rebuiltRunInfo = await rebuildRunInfoForMessage(message, runId).catch(() => undefined);
          const runInfo = {
            ...(existingRunInfo || rebuiltRunInfo || {
              runId,
              conversationId: message.conversationId,
              workspaceId: selectedWorkspace?.id || '',
              persona: normalizePersonaName(activeConversationPersona || selectedPersona || DEFAULT_PERSONA_NAME),
              turnId: message.turnId || generateTurnId(),
              placeholderId: message.id,
              status: 'running' as AgentRunStatus,
            }),
            status: 'running' as AgentRunStatus,
          };
          markRunStreamLaunching(runId);
          registerActiveRun(runInfo);
          setConversationAttention(message.conversationId, 'running', 'Resuming the run...');
          if (runInfo) {
            await streamRunForConversation(runInfo, false);
          } else {
            addLocalSystemMessage('Response saved. Refreshing stream state...');
          }
        } catch (error) {
          console.error('Failed to submit clarification choice', error);
          setInterruptErrorByMessageId((prev) => ({
            ...prev,
            [messageKey]: error instanceof Error ? error.message : 'Failed to submit clarification response.',
          }));
        } finally {
          setInterruptSubmittingByMessageId((prev) => ({ ...prev, [messageKey]: false }));
        }
        return;
      }

      if (action.inputMode === 'text' && !actionText) {
        setInterruptErrorByMessageId((prev) => ({
          ...prev,
          [messageKey]: 'This action requires text input before continuing.',
        }));
        return;
      }

      setInterruptSubmittingByMessageId((prev) => ({ ...prev, [messageKey]: true }));
      setInterruptErrorByMessageId((prev) => {
        if (!prev[messageKey]) return prev;
        const next = { ...prev };
        delete next[messageKey];
        return next;
      });
      try {
        await submitInterruptWithRetry(runId, 'action', () =>
          submitRunAction(runId, {
            actionId: action.id,
            text: actionText || undefined,
          })
        );
        clearPendingInterruptForRun(message.conversationId, runId, message.turnId);
        setInterruptInputByMessageId((prev) => {
          const next = { ...prev };
          Object.keys(next).forEach((key) => {
            if (key.startsWith(`${messageKey}:action:`)) {
              delete next[key];
            }
          });
          return next;
        });
        setInterruptErrorByMessageId((prev) => {
          if (!prev[messageKey]) return prev;
          const next = { ...prev };
          delete next[messageKey];
          return next;
        });
        const existingRunInfo = activeRunsRef.current[runId];
        const rebuiltRunInfo = await rebuildRunInfoForMessage(message, runId).catch(() => undefined);
        const runInfo = {
          ...(existingRunInfo || rebuiltRunInfo || {
            runId,
            conversationId: message.conversationId,
            workspaceId: selectedWorkspace?.id || '',
            persona: normalizePersonaName(activeConversationPersona || selectedPersona || DEFAULT_PERSONA_NAME),
            turnId: message.turnId || generateTurnId(),
            placeholderId: message.id,
            status: 'running' as AgentRunStatus,
          }),
          status: 'running' as AgentRunStatus,
        };
        markRunStreamLaunching(runId);
        registerActiveRun(runInfo);
        setConversationAttention(message.conversationId, 'running', 'Resuming the run...');
        if (runInfo) {
          await streamRunForConversation(runInfo, false);
        } else {
          addLocalSystemMessage('Action saved. Refreshing stream state...');
        }
      } catch (error) {
        console.error('Failed to submit interrupt action', error);
        setInterruptErrorByMessageId((prev) => ({
          ...prev,
          [messageKey]: error instanceof Error ? error.message : 'Failed to submit interrupt action.',
        }));
      } finally {
        setInterruptSubmittingByMessageId((prev) => ({ ...prev, [messageKey]: false }));
      }
    },
    [
      activeConversationPersona,
      addLocalSystemMessage,
      findRunIdForMessage,
      getInterruptKind,
      handleClarificationResponse,
      handleInterruptDecision,
      interruptActionFieldKey,
      interruptInputByMessageId,
      rebuildRunInfoForMessage,
      selectedPersona,
      selectedWorkspace?.id,
      clearPendingInterruptForRun,
      markRunStreamLaunching,
      registerActiveRun,
      setConversationAttention,
      submitInterruptWithRetry,
      streamRunForConversation,
      toggleInterruptSelectedChoice,
    ],
  );

  const prepareInterruptAction = useCallback((
    _message: ConversationMessage,
    action: RenderableInterruptAction,
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => {
    if (action.source === 'approval' && action.legacyDecision === 'edit' && isPlanApprovalInterrupt(pendingInterrupt)) {
      openPlanApprovalEditor(pendingInterrupt);
    }
  }, [isPlanApprovalInterrupt, openPlanApprovalEditor]);

  useEffect(() => {
    if (!activeConversationId) {
      return;
    }
    if (conversationStreaming[activeConversationId]) {
      return;
    }
    const activeRun = getActiveRunForConversation(activeConversationId);
    if (activeRun) {
      if (resumeAttemptedRef.current.has(activeRun.runId)) {
        return;
      }
      if (resumeInFlightRef.current.has(activeRun.runId)) {
        return;
      }
      resumeInFlightRef.current.add(activeRun.runId);
      resumeAttemptedRef.current.add(activeRun.runId);
      if (STREAM_DEBUG_ENABLED) {
        console.debug('[WorkspacePage] resume run', {
          runId: activeRun.runId,
          conversationId: activeConversationId,
        });
      }
      getRunStatus(activeRun.runId)
        .then((status) => {
          const persistedMessage = findAgentMessageForRun(
            activeRun.conversationId,
            activeRun.placeholderId,
            activeRun.turnId
          );
          const needsRecovery = isAgentMessageEmpty(persistedMessage);
          if (status.status === 'running' || status.status === 'queued') {
            const shouldReplayFromStart = needsRecovery || !activeRun.lastStreamId;
            if (STREAM_DEBUG_ENABLED) {
              console.debug('[WorkspacePage] resume stream', {
                runId: activeRun.runId,
                replayFromStart: shouldReplayFromStart,
                lastStreamId: activeRun.lastStreamId,
              });
            }
            setConversationAttention(activeRun.conversationId, 'running', 'Resuming the latest run...');
            streamRunForConversation(
              activeRun,
              shouldReplayFromStart,
              shouldReplayFromStart ? undefined : activeRun.lastStreamId,
            )
              .catch((error) => {
                console.error('Failed to resume agent stream', error);
                removeActiveRun(activeRun.runId);
              })
              .finally(() => {
                resumeInFlightRef.current.delete(activeRun.runId);
              });
          } else if (status.status === 'awaiting_approval') {
            const targetMessage = findAgentMessageForRun(
              activeRun.conversationId,
              activeRun.placeholderId,
              activeRun.turnId
            );
            if (!targetMessage && status.pendingInterrupt) {
              ensureAgentPlaceholder(
                activeRun.conversationId,
                activeRun.placeholderId,
                activeRun.turnId,
                true,
              );
            }
            const resolvedTargetMessage = findAgentMessageForRun(
              activeRun.conversationId,
              activeRun.placeholderId,
              activeRun.turnId
            );
            if (resolvedTargetMessage?.metadata?.runId || status.pendingInterrupt) {
              updateMessagesForConversation(activeRun.conversationId, (prev) => {
                const updated = [...prev];
                const idx = updated.findIndex((message) => message.id === resolvedTargetMessage?.id);
                if (idx === -1) {
                  return updated;
                }
                const current = updated[idx];
                const metadata = { ...((current.metadata as ConversationMessageMetadata | undefined) || {}) };
                metadata.runId = metadata.runId || activeRun.runId;
                metadata.status = 'awaiting_approval';
                if (status.pendingInterrupt) {
                  metadata.pendingInterrupt = status.pendingInterrupt;
                }
                updated[idx] = { ...current, metadata };
                return updated;
              });
            }
            void syncRunStateToConversation(
              { ...activeRun, status: 'awaiting_approval' },
              'awaiting_approval',
              status.pendingInterrupt,
            );
            setConversationAttention(
              activeRun.conversationId,
              'awaiting_approval',
              status.pendingInterrupt?.title || status.pendingInterrupt?.description || 'Waiting for your input.',
            );
            resumeInFlightRef.current.delete(activeRun.runId);
          } else if (needsRecovery) {
            streamRunForConversation({ ...activeRun, status: status.status }, true)
              .catch((error) => {
                console.error('Failed to recover agent stream', error);
                removeActiveRun(activeRun.runId);
              })
              .finally(() => {
                resumeInFlightRef.current.delete(activeRun.runId);
              });
          } else {
            void persistAgentProgress(
              { ...activeRun, status: status.status },
              status.status,
              {
                metadataOverride: {
                  pendingInterrupt: undefined,
                },
              },
            ).catch((error) => {
              console.error('Failed to persist settled run state', error);
            });
            resumeInFlightRef.current.delete(activeRun.runId);
            const staleMessage = findAgentMessageForRun(
              activeRun.conversationId,
              activeRun.placeholderId,
              activeRun.turnId
            );
            if (
              staleMessage &&
              staleMessage.sender === 'agent' &&
              !staleMessage.text &&
              !staleMessage.thinkingText &&
              !staleMessage.toolEvents?.length
            ) {
              updateMessagesForConversation(activeRun.conversationId, (prev) =>
                prev.filter((message) => message.id !== staleMessage.id)
              );
              agentMessageBufferRef.current.delete(staleMessage.id);
            } else {
              const normalizedSettledStatus = normalizeRunStatus(status.status);
              void syncRunStateToConversation(
                { ...activeRun, status: normalizedSettledStatus },
                normalizedSettledStatus,
              );
            }
            setConversationAttention(
              activeRun.conversationId,
              normalizeRunStatus(status.status),
              status.status === 'completed'
                ? 'The latest run completed.'
                : status.status === 'cancelled'
                  ? 'The latest run was stopped.'
                  : 'The latest run failed.',
            );
            removeActiveRun(activeRun.runId);
          }
        })
        .catch((error) => {
          console.error('Failed to resume run status', error);
          resumeInFlightRef.current.delete(activeRun.runId);
          void persistAgentProgress(
            { ...activeRun, status: 'failed' },
            'failed',
            {
              metadataOverride: {
                pendingInterrupt: undefined,
              },
            },
          ).catch((persistError) => {
            console.error('Failed to persist stale run failure state', persistError);
          });
          const staleMessage = findAgentMessageForRun(
            activeRun.conversationId,
            activeRun.placeholderId,
            activeRun.turnId
          );
          if (
            staleMessage &&
            staleMessage.sender === 'agent' &&
            !staleMessage.text &&
            !staleMessage.thinkingText &&
            !staleMessage.toolEvents?.length
          ) {
            updateMessagesForConversation(activeRun.conversationId, (prev) =>
              prev.filter((message) => message.id !== staleMessage.id)
            );
            agentMessageBufferRef.current.delete(staleMessage.id);
          }
          removeActiveRun(activeRun.runId);
        });
    }
  }, [
    activeConversationId,
    conversationStreaming,
    ensureAgentPlaceholder,
    findAgentMessageForRun,
    getActiveRunForConversation,
    isAgentMessageEmpty,
    persistAgentProgress,
    removeActiveRun,
    setConversationAttention,
    syncRunStateToConversation,
    streamRunForConversation,
    updateMessagesForConversation,
  ]);

  const handleRerunMessage = async (
    messageId: ConversationMessage['id'],
    options?: { replacementText?: string; skipConfirm?: boolean },
  ) => {
    if (!selectedWorkspace || !activeConversationId) {
      addLocalSystemMessage('Please select a workspace and conversation before rerunning messages.');
      return;
    }

    const persona = normalizePersonaName(activeConversationPersona || selectedPersona || DEFAULT_PERSONA_NAME);

    const conversationId = activeConversationId;
    const currentMessages = [...getConversationMessagesSnapshot(conversationId)];
    const targetIndex = currentMessages.findIndex((message) => message.id === messageId);
    if (targetIndex === -1) {
      addLocalSystemMessage('Could not find that message to rerun.');
      return;
    }
    const targetMessage = currentMessages[targetIndex];
    if (targetMessage.sender !== 'user') {
      addLocalSystemMessage('Only your own messages can be rerun.');
      return;
    }
    const trimmed = (options?.replacementText ?? targetMessage.text ?? '').trim();
    if (!trimmed) {
      addLocalSystemMessage('Cannot rerun an empty message.');
      return;
    }
    const directive = parseSlashDirective(trimmed);
    if (directive.kind === 'skill') {
      if (!directive.skillId) {
        addLocalSystemMessage('Use /skill <skill-id>. Example: /skill sales prep me for tomorrow\'s call.');
        return;
      }
      if (!availableSkillMap.has(directive.skillId.toLowerCase())) {
        addLocalSystemMessage(`Skill "${directive.skillId}" is not available in this workspace.`);
        return;
      }
    }
    if (directive.kind === 'mcp') {
      if (!directive.serverId || !directive.prompt) {
        addLocalSystemMessage('Use /mcp <server-id> <task>. Example: /mcp google-workspace search my inbox for BMMB.');
        return;
      }
      if (!availableMcpServerMap.has(directive.serverId.toLowerCase())) {
        addLocalSystemMessage(`MCP server "${directive.serverId}" is not configured.`);
        return;
      }
    }
    if (!options?.skipConfirm) {
      const confirmed = window.confirm(
        'Redo from this message? This will remove all messages below it.'
      );
      if (!confirmed) {
        return;
      }
    }

    const targetMessageId = Number(targetMessage.id);
    if (!Number.isFinite(targetMessageId)) {
      addLocalSystemMessage('This message is not saved yet, so it cannot be redone.');
      return;
    }

    stopRequestedRef.current = false;
    const targetTurnId = targetMessage.turnId || generateTurnId();
    let effectiveTargetMessage = targetMessage;

    if (options?.replacementText !== undefined) {
      if (!targetMessage.turnId) {
        addLocalSystemMessage('This message cannot be edited for retry because it is missing a turn id.');
        return;
      }
      try {
        const updatedMessage = await appendConversationMessage(conversationId, 'user', trimmed, {
          turnId: targetTurnId,
          replaceExisting: true,
          metadata: targetMessage.metadata as ConversationMessageMetadata | undefined,
        });
        effectiveTargetMessage = mergeMessageMetadata(updatedMessage);
      } catch (error) {
        console.error('Failed to update message for retry', error);
        addLocalSystemMessage('Failed to update your message for retry. Please try again.');
        return;
      }
    }

    cancelStreamForConversation(conversationId);

    try {
      await truncateConversationMessages(conversationId, targetMessageId);
    } catch (error) {
      console.error('Failed to truncate conversation messages', error);
      addLocalSystemMessage('Failed to clear messages for redo. Please try again.');
      return;
    }

    const removedMessages = currentMessages.slice(targetIndex + 1);
    const historyMessages = [
      ...currentMessages.slice(0, targetIndex),
      effectiveTargetMessage,
    ];
    const historyPayload = mapMessagesToAgentHistory(historyMessages);

    if (removedMessages.length) {
      const removedIds = new Set(removedMessages.map((message) => message.id));
      removedIds.forEach((id) => agentMessageBufferRef.current.delete(id));
      agentChunkBufferRef.current.delete(conversationId);
      setExpandedToolMessages((prev) => {
        if (!prev.size) return prev;
        const next = new Set(prev);
        removedIds.forEach((id) => next.delete(id));
        return next;
      });
      setExpandedThinkingMessages((prev) => {
        if (!prev.size) return prev;
        const next = new Set(prev);
        removedIds.forEach((id) => next.delete(id));
        return next;
      });
      setCopiedMessageId((prev) => (prev && removedIds.has(prev) ? null : prev));
    }

    updateMessagesForConversation(conversationId, () => historyMessages);
    lastUserMessageMapRef.current[conversationId] = trimmed;

    try {
      const agentPrompt = buildAgentPromptFromDirective(directive);
      const { runId } = await startAgentRun(
        selectedWorkspace.id,
        conversationId,
        persona,
        agentPrompt,
        historyPayload.length ? historyPayload : undefined,
        effectiveTargetMessage.turnId || targetTurnId,
        { forceReset: true }
      );
      const placeholderId = `agent-${runId}`;
      ensureAgentPlaceholder(conversationId, placeholderId, targetTurnId, true);
      agentMessageBufferRef.current.set(placeholderId, '');
      const runInfo: ActiveRunInfo = {
        runId,
        conversationId,
        workspaceId: selectedWorkspace.id,
        persona,
        turnId: targetTurnId,
        placeholderId,
        status: 'running',
      };
      markRunStreamLaunching(runId);
      registerActiveRun(runInfo);
      setConversationAttention(conversationId, 'running', 'Queued the latest run...');
      await streamRunForConversation(runInfo, true);

      const messagesSnapshot = getConversationMessagesSnapshot(conversationId);
      const targetIndex = messagesSnapshot.findIndex((message) => message.id === placeholderId);
      const agentMessage = targetIndex >= 0 ? messagesSnapshot[targetIndex] : null;
      const metadata = buildMessageMetadata(agentMessage) || {};
      const bufferedText =
        placeholderId !== null && placeholderId !== undefined
          ? agentMessageBufferRef.current.get(placeholderId) ?? agentMessage?.text
          : agentMessage?.text;
      const placeholderTurnId = agentMessage?.turnId || targetTurnId;
      if (bufferedText) {
        try {
          const persisted = await appendConversationMessage(conversationId, 'agent', bufferedText, {
            turnId: placeholderTurnId,
            replaceExisting: true,
            metadata: { ...metadata, runId },
          });
          upsertPersistedAgentMessage(conversationId, persisted, {
            placeholderId,
            existing: agentMessage,
          });
          if (placeholderId !== null && placeholderId !== undefined) {
            agentMessageBufferRef.current.delete(placeholderId);
          }
          agentMessageBufferRef.current.set(persisted.id, persisted.text || '');
          await refreshConversationHistory(selectedWorkspace.id);
        } catch (error) {
          console.error('Failed to store rerun agent message', error);
        }
      } else if (placeholderId !== null && placeholderId !== undefined) {
        agentMessageBufferRef.current.delete(placeholderId);
      }
    } catch (error) {
      console.error('Failed to rerun agent response', error);
      addLocalSystemMessage('Rerun failed. Please try again.');
    }
  };

  const handleEditAndRerunMessage = (message: ConversationMessage) => {
    if (message.sender !== 'user') {
      addLocalSystemMessage('Only your own messages can be edited for retry.');
      return;
    }
    const draft = message.text?.trim();
    if (!draft) {
      addLocalSystemMessage('Cannot edit an empty message for retry.');
      return;
    }
    setEditingRetryMessageId(message.id);
    setChatMessage(draft);
    requestAnimationFrame(() => {
      const input = chatInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      input.setSelectionRange(draft.length, draft.length);
    });
  };

  const handleSendMessage = async (workspaceOverride?: Workspace | null) => {
    if (sendLockRef.current || isDriveImporting) {
      return;
    }
    const trimmed = chatMessage.trim();
    const localAttachments = chatAttachments.filter(
      (attachment): attachment is Extract<ChatComposerAttachment, { source: 'local' }> => attachment.source === 'local',
    );
    const driveAttachments = chatAttachments.filter(
      (attachment): attachment is Extract<ChatComposerAttachment, { source: 'drive' }> => attachment.source === 'drive',
    );
    const hasAttachments = chatAttachments.length > 0;
    const hasLocalAttachments = localAttachments.length > 0;
    if (!trimmed && !hasAttachments) return;
    sendLockRef.current = true;

    try {
      if (editingRetryMessageId !== null) {
        if (hasAttachments) {
          addLocalSystemMessage('Attachments cannot be changed while editing a message for retry.');
          return;
        }
        const retryMessageId = editingRetryMessageId;
        setEditingRetryMessageId(null);
        setChatMessage('');
        closeMention();
        closeCommand();
        await handleRerunMessage(retryMessageId, {
          replacementText: trimmed,
          skipConfirm: true,
        });
        return;
      }

      stopRequestedRef.current = false;
      const directive = parseSlashDirective(trimmed);
      const mentionedFiles = findMentionedFiles(trimmed);
      const mentionedFileIds = Array.from(
        new Set(
          mentionedFiles
            .map((file) => toNumericFileId(file.id))
            .filter((id): id is number => typeof id === 'number' && Number.isFinite(id)),
        ),
      );

      if (directive.kind === 'skill') {
        if (hasLocalAttachments) {
          addLocalSystemMessage('Attachments are not supported with /skill yet. Please upload files to the workspace first and reference them in your request.');
          return;
        }
        if (!directive.skillId) {
          addLocalSystemMessage('Use /skill <skill-id>. Example: /skill sales draft follow-up from today\'s call.');
          return;
        }
        if (!availableSkillMap.has(directive.skillId.toLowerCase())) {
          addLocalSystemMessage(`Skill "${directive.skillId}" is not available.`);
          return;
        }
      }
      if (directive.kind === 'mcp') {
        if (hasLocalAttachments) {
          addLocalSystemMessage('Attachments are not supported with /mcp yet. Please upload files to the workspace first if needed.');
          return;
        }
        if (!directive.serverId || !directive.prompt) {
          addLocalSystemMessage('Use /mcp <server-id> <task>. Example: /mcp google-workspace search my inbox for BMMB.');
          return;
        }
        if (!availableMcpServerMap.has(directive.serverId.toLowerCase())) {
          addLocalSystemMessage(`MCP server "${directive.serverId}" is not configured.`);
          return;
        }
      }
      const activeWorkspace = workspaceOverride || selectedWorkspace;
      if (!activeWorkspace) {
        addLocalSystemMessage('Please select a workspace before chatting with an agent.');
        return;
      }

      const workspaceId = activeWorkspace.id;
      const persona = normalizePersonaName(activeConversationPersona || selectedPersona || DEFAULT_PERSONA_NAME);
      const attachmentSummary = hasAttachments ? `Attachments: ${summarizeComposerAttachments(chatAttachments)}` : '';
      const messageContent = hasAttachments
        ? `${trimmed}${trimmed ? '\n\n' : ''}[${attachmentSummary}]`
        : trimmed;
      const agentPromptBase = buildAgentPromptFromDirective(directive) || messageContent;
      const conversationId = await ensureConversation(activeWorkspace);
      if (!conversationId) {
        addLocalSystemMessage('Unable to start a conversation right now.');
        return;
      }

      cancelStreamForConversation(conversationId);
      lastUserMessageMapRef.current[conversationId] = messageContent;
      setChatMessage('');
      setChatAttachments((prev) => {
        prev.forEach(revokeLocalAttachmentPreview);
        return [];
      });
      setIsDrivePickerOpen(false);
      closeMention();
      closeCommand();

      const pendingTurnId = generateTurnId();
      let resolvedTurnId = pendingTurnId;
      let userMessageRecord: ConversationMessage | null = null;
      const existingMessages = getConversationMessagesSnapshot(conversationId);

      try {
        const createdMessage = await appendConversationMessage(conversationId, 'user', messageContent, {
          turnId: pendingTurnId,
          metadata: hasAttachments ? { attachmentPrepStatus: 'pending' } : undefined,
        });
        const normalizedMessage = mergeMessageMetadata(createdMessage);
        userMessageRecord = normalizedMessage;
        resolvedTurnId = normalizedMessage.turnId || pendingTurnId;
        upsertConversationMessage(conversationId, normalizedMessage);
        await refreshConversationHistory(workspaceId);
      } catch (error) {
        console.error('Failed to send user message', error);
        addLocalSystemMessage('Failed to send your message. Please try again.');
        return;
      }
      if (!userMessageRecord) {
        addLocalSystemMessage('Failed to record your message. Please try again.');
        return;
      }

      let resolvedFileContextRefs: FileContextRef[] | undefined;
      let currentTurnFileIds: number[] | undefined;
      let taggedFiles: string[] | undefined;

      if (hasAttachments) {
        setIsDriveImporting(true);
        try {
          const sourceFileIds: number[] = [];
          for (const attachment of localAttachments) {
            const uploaded = await createFile(workspaceId, attachment.file);
            const uploadedId = toNumericFileId(uploaded.id);
            if (uploadedId) {
              sourceFileIds.push(uploadedId);
            }
          }
          if (sourceFileIds.length && selectedWorkspaceIdRef.current === workspaceId) {
            await loadFilesForWorkspace(workspaceId);
          }
          const prepJob = await createAttachmentPrepJob(workspaceId, {
            conversationId,
            turnId: resolvedTurnId,
            driveFileIds: driveAttachments.map((attachment) => attachment.driveItem.id),
            sourceFileIds,
          });
          attachmentPrepResumeRef.current.add(prepJob.id);
          userMessageRecord = await persistUserMessageMetadata(conversationId, userMessageRecord, {
            ...((userMessageRecord.metadata as ConversationMessageMetadata | undefined) || {}),
            attachmentJobId: prepJob.id,
            attachmentPrepStatus: prepJob.status,
            attachmentPrepError: undefined,
          });
          const settledJob = prepJob.status === 'ready' || prepJob.status === 'failed'
            ? prepJob
            : await waitForAttachmentPrepJob(workspaceId, prepJob.id);
          if (settledJob.status === 'failed') {
            await persistUserMessageMetadata(conversationId, userMessageRecord, {
              ...((userMessageRecord.metadata as ConversationMessageMetadata | undefined) || {}),
              attachmentJobId: settledJob.id,
              attachmentPrepStatus: 'failed',
              attachmentPrepError: settledJob.error || 'Failed to prepare attachments.',
            });
            addLocalSystemMessage(settledJob.error || 'Failed to prepare attachments.');
            return;
          }
          const preparedFiles = Array.isArray(settledJob.result?.files) ? settledJob.result?.files : [];
          if (preparedFiles?.length && selectedWorkspaceIdRef.current === workspaceId) {
            await loadFilesForWorkspace(workspaceId);
          }
          resolvedFileContextRefs = settledJob.result?.fileContextRefs?.length
            ? settledJob.result.fileContextRefs
            : undefined;
          currentTurnFileIds = settledJob.result?.multimodalFileIds?.length
            ? settledJob.result.multimodalFileIds
            : undefined;
          taggedFiles = resolvedFileContextRefs?.map((ref) => ref.sourceName).filter(Boolean);
          userMessageRecord = await persistUserMessageMetadata(conversationId, userMessageRecord, {
            ...((userMessageRecord.metadata as ConversationMessageMetadata | undefined) || {}),
            attachmentJobId: settledJob.id,
            attachmentPrepStatus: 'ready',
            attachmentPrepError: undefined,
            fileContextRefs: resolvedFileContextRefs,
          });
        } catch (error) {
          console.error('Failed to prepare attachments', error);
          const message = error instanceof Error ? error.message : 'Failed to prepare attachments.';
          await persistUserMessageMetadata(conversationId, userMessageRecord, {
            ...((userMessageRecord.metadata as ConversationMessageMetadata | undefined) || {}),
            attachmentPrepStatus: 'failed',
            attachmentPrepError: message,
          }).catch((persistError) => {
            console.error('Failed to persist attachment prep failure', persistError);
          });
          addLocalSystemMessage(message);
          return;
        } finally {
          const jobId = (userMessageRecord?.metadata as ConversationMessageMetadata | undefined)?.attachmentJobId;
          if (jobId) {
            attachmentPrepResumeRef.current.delete(jobId);
          }
          setIsDriveImporting(false);
        }
      } else {
        const previousFileContextRefs = findLatestFileContextRefs(existingMessages);
        if (previousFileContextRefs?.length) {
          try {
            const refreshed = await resolveFileContextRefs(
              workspaceId,
              previousFileContextRefs
                .map((ref) => Number(ref.sourceFileId))
                .filter((value) => Number.isFinite(value) && value > 0),
            );
            resolvedFileContextRefs = Array.isArray(refreshed.fileContextRefs) && refreshed.fileContextRefs.length
              ? refreshed.fileContextRefs
              : previousFileContextRefs;
          } catch (error) {
            console.error('Failed to refresh file context refs', error);
            resolvedFileContextRefs = previousFileContextRefs;
          }
        }
      }

      if (mentionedFileIds.length) {
        try {
          const resolvedMentions = await resolveFileContextRefs(workspaceId, mentionedFileIds);
          resolvedFileContextRefs = hasAttachments
            ? mergeFileContextRefs(resolvedFileContextRefs, resolvedMentions.fileContextRefs)
            : mergeFileContextRefs(resolvedMentions.fileContextRefs, resolvedFileContextRefs);
        } catch (error) {
          console.error('Failed to resolve mentioned file context refs', error);
          resolvedFileContextRefs = mergeFileContextRefs(resolvedFileContextRefs);
        }
      }

      if (resolvedFileContextRefs?.length) {
        taggedFiles = resolvedFileContextRefs.map((ref) => ref.sourceName).filter(Boolean);
      } else if (mentionedFiles.length) {
        taggedFiles = mentionedFiles.map((file) => file.name).filter(Boolean);
      }

      if (mentionedFileIds.length && resolvedFileContextRefs?.length) {
        try {
          userMessageRecord = await persistUserMessageMetadata(conversationId, userMessageRecord, {
            ...((userMessageRecord.metadata as ConversationMessageMetadata | undefined) || {}),
            fileContextRefs: resolvedFileContextRefs,
          });
        } catch (error) {
          console.error('Failed to persist mentioned file context refs', error);
        }
      }

      const preparedMessages = getConversationMessagesSnapshot(conversationId);
      const historyPayload = mapMessagesToAgentHistory(preparedMessages);

      const continuationCtx = getImplicitContinuationContext(preparedMessages);
      let agentPromptBase2 = agentPromptBase;
      if (continuationCtx.shouldContinue && agentPromptBase2) {
        agentPromptBase2 = buildContinuationPrompt(
          agentPromptBase2,
          continuationCtx.skillId,
          continuationCtx.prompt,
        );
        for (let i = historyPayload.length - 1; i >= 0; i--) {
          if (historyPayload[i].role === 'user') {
            historyPayload[i] = { ...historyPayload[i], content: agentPromptBase2 };
            break;
          }
        }
      }

      const attachmentPrompt = resolvedFileContextRefs?.length
        ? `Use these attached files as primary context: ${resolvedFileContextRefs.map((ref) => ref.sourceName).join(', ')}`
        : '';
      const agentPrompt = attachmentPrompt
        ? `${agentPromptBase2}${agentPromptBase2 ? '\n\n' : ''}${attachmentPrompt}`
        : agentPromptBase2;
      const useInternetSearch = internetSearchEnabled;

      try {
        await launchPreparedAgentRun({
          workspaceId,
          persona,
          conversationId,
          turnId: resolvedTurnId,
          prompt: agentPrompt,
          historyPayload,
          fileContextRefs: resolvedFileContextRefs,
          currentTurnFileIds,
          taggedFiles,
          internetSearchEnabled: useInternetSearch,
        });
      } catch (error) {
        console.error('Failed to start agent run', error);
        addLocalSystemMessage('Failed to start agent run. Please try again.');
      }
    } finally {
      setIsDriveImporting(false);
      sendLockRef.current = false;
    }
  };

  const handleLandingSendMessage = async () => {
    const trimmed = chatMessage.trim();
    if (!trimmed && !chatAttachments.length) {
      return;
    }
    const workspace = selectedWorkspace || await handleCreateWorkspace({
      stayOnLanding: true,
      rename: false,
      name: deriveWorkspaceNameFromPrompt(trimmed),
    });
    if (!workspace) {
      addLocalSystemMessage('Unable to create a workspace right now. Please try again.');
      return;
    }
    setIsLandingPageVisible(false);
    setIsAgentPaneVisible(true);
    setIsAgentPaneFullScreen(false);
    await handleSendMessage(workspace);
  };

  const handleChatInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setChatMessage(value);
    updateAutocompleteState(value, event.target.selectionStart ?? value.length);
  };

  const handleChatInputSelectionChange = (
    event: React.SyntheticEvent<HTMLTextAreaElement>
  ) => {
    const target = event.currentTarget;
    updateAutocompleteState(target.value, target.selectionStart ?? target.value.length);
  };

  const handleChatInputKeyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      (isMentionOpen || isCommandOpen) &&
      (event.key === 'ArrowDown' || event.key === 'ArrowUp')
    ) {
      // Skip mention state recalculation when navigating suggestions
      return;
    }
    const target = event.currentTarget;
    updateAutocompleteState(target.value, target.selectionStart ?? target.value.length);
  };

  const handleChatInputKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    options?: { sendOnEnter?: boolean },
  ) => {
    const shouldSendOnEnter = options?.sendOnEnter ?? true;
    if (isCommandOpen) {
      if (event.key === 'ArrowDown' && commandSuggestions.length) {
        event.preventDefault();
        setCommandSelectedIndex((prev) => (prev + 1) % commandSuggestions.length);
        return;
      }
      if (event.key === 'ArrowUp' && commandSuggestions.length) {
        event.preventDefault();
        setCommandSelectedIndex((prev) =>
          (prev - 1 + commandSuggestions.length) % commandSuggestions.length
        );
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        if (commandSuggestions.length) {
          event.preventDefault();
          handleSelectCommand(commandSuggestions[commandSelectedIndex]);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCommand();
        return;
      }
    }

    if (isMentionOpen) {
      if (event.key === 'ArrowDown' && mentionSuggestions.length) {
        event.preventDefault();
        setMentionSelectedIndex((prev) => (prev + 1) % mentionSuggestions.length);
        return;
      }
      if (event.key === 'ArrowUp' && mentionSuggestions.length) {
        event.preventDefault();
        setMentionSelectedIndex((prev) =>
          (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length
        );
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        if (mentionSuggestions.length) {
          event.preventDefault();
          handleSelectMention(mentionSuggestions[mentionSelectedIndex]);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMention();
        return;
      }
    }

    if (shouldSendOnEnter && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSendMessage();
    }
  };

  const handleNewChat = async () => {
    cancelStreamForConversation(activeConversationId);
    if (!selectedWorkspace) {
      addLocalSystemMessage('Please select a workspace before starting a conversation.');
      return;
    }
    const workspaceId = selectedWorkspace.id;
    try {
      const persona = normalizePersonaName(selectedPersona || DEFAULT_PERSONA_NAME);
      const conversation = await createConversationApi(workspaceId, persona);
      setActiveConversationId(conversation.id);
      setActiveConversationPersona(normalizePersonaName(conversation.persona));
      setSelectedPersona(normalizePersonaName(conversation.persona));
      setConversationMessages((prev) => ({ ...prev, [conversation.id]: [] }));
      setStreamingForConversation(conversation.id, false);
      setChatMessage('');
      closeMention();
      closeCommand();
      await refreshConversationHistory(workspaceId);
    } catch (error) {
      console.error('Failed to start new conversation', error);
      addLocalSystemMessage('Unable to start a new conversation right now.');
    }
  };

  const handleDeleteWorkspace = async (id: string) => {
    try {
      await deleteWorkspace(id);
      setWorkspaces(workspaces.filter((workspace) => workspace.id !== id));
      setSelectedWorkspace(null);
      setFiles([]);
      setFolderPaths([]);
      setIsLandingPageVisible(true);
    } catch (error) {
      console.error('Failed to delete workspace:', error);
    }
  };

  const handleShareWorkspace = useCallback((ws: Workspace) => {
    setShareWorkspace(ws);
  }, []);

  const handleUpdateFile = useCallback(async (targetFile: WorkspaceFile | null, content: string) => {
    if (!selectedWorkspace || !targetFile) return;

    try {
      if (isDraftWorkspaceFile(targetFile)) {
        const createdFile = await createTextFile(selectedWorkspace.id, {
          name: targetFile.name,
          content,
          mimeType: targetFile.mimeType || 'text/markdown',
        });
        setFiles((prev) => {
          const withoutDraft = prev.filter((file) => String(file.id) !== String(targetFile.id));
          return [createdFile, ...withoutDraft];
        });
        const hydratedCreatedFile = {
          ...createdFile,
          content,
        };
        setSelectedFile(hydratedCreatedFile);
        setSelectedFileDetails(hydratedCreatedFile);
      } else {
        await updateFileContent(selectedWorkspace.id, Number(targetFile.id), content);
        setSelectedFileDetails((prev) => (prev ? { ...prev, content } : prev));
      }
      lastAutoSavedContentRef.current = content;
    } catch (error) {
      console.error('Failed to update file:', error);
    }
  }, [selectedWorkspace]);

  useEffect(() => {
    if (!isEditMode || !selectedWorkspace || !selectedFile || isDraftWorkspaceFile(selectedFile)) return;

    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(async () => {
      if (fileContent === lastAutoSavedContentRef.current) {
        return;
      }
      await handleUpdateFile(selectedFile, fileContent);
      lastAutoSavedContentRef.current = fileContent;
    }, 2000);

    return () => {
      if (autoSaveTimerRef.current) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [fileContent, isEditMode, selectedFile, selectedWorkspace, handleUpdateFile]);

  const handleBulkDelete = async () => {
    if (!selectedWorkspace) return;
    if (selectedFiles.size === 0) {
      return;
    }
    setWorkspaceFileDialog({
      kind: 'bulk-delete',
      fileIds: Array.from(selectedFiles),
      fileCount: selectedFiles.size,
      busy: false,
    });
  };

  const handleFileSelect = (fileId: string) => {
    const newSelectedFiles = new Set(selectedFiles);
    if (newSelectedFiles.has(fileId)) {
      newSelectedFiles.delete(fileId);
    } else {
      newSelectedFiles.add(fileId);
    }
    setSelectedFiles(newSelectedFiles);
  };

  const handleSelectAllFiles = () => {
    if (!visibleFiles.length) {
      setSelectedFiles(new Set());
      return;
    }
    if (allFilesSelected) {
      setSelectedFiles(new Set());
      return;
    }
    setSelectedFiles(new Set(visibleFiles.map((file) => file.id)));
  };

  const handleCreateFolder = async () => {
    if (!selectedWorkspace) {
      return;
    }
    setWorkspaceFileDialog({ kind: 'create-folder', value: '', busy: false });
  };

  const handleCloseWorkspaceFileDialog = () => {
    if (workspaceFileDialog?.busy) {
      return;
    }
    setWorkspaceFileDialog(null);
  };

  const handleWorkspaceFileDialogValueChange = (value: string) => {
    setWorkspaceFileDialog((current) =>
      current?.kind === 'create-folder' || current?.kind === 'rename-folder' || current?.kind === 'rename-file'
        ? { ...current, value, error: undefined }
        : current,
    );
  };

  const handleConfirmWorkspaceFileDialog = async () => {
    if (!selectedWorkspace || !workspaceFileDialog || workspaceFileDialog.busy) {
      return;
    }

    const currentDialog = workspaceFileDialog;
    setWorkspaceFileDialog({ ...currentDialog, busy: true, error: undefined });

    try {
      if (currentDialog.kind === 'create-folder') {
        const normalizedFolder = normalizeWorkspaceFolderPath(currentDialog.value.trim());
        if (!normalizedFolder) {
          setWorkspaceFileDialog({ ...currentDialog, busy: false, error: 'Enter a folder name.' });
          return;
        }

        const created = await createFolder(selectedWorkspace.id, normalizedFolder);
        const createdPath = typeof created?.path === 'string' ? created.path : normalizedFolder;
        setFolderPaths((prev) => addFolderPath(prev, createdPath));
        setWorkspaceFileDialog(null);
        return;
      }

      if (currentDialog.kind === 'rename-folder') {
        const proposedName = currentDialog.value.trim();
        const normalizedName = normalizeWorkspaceFolderPath(proposedName);
        if (!normalizedName) {
          setWorkspaceFileDialog({ ...currentDialog, busy: false, error: 'Enter a folder name.' });
          return;
        }
        if (normalizedName.split('/').length !== 1) {
          setWorkspaceFileDialog({ ...currentDialog, busy: false, error: 'Folder name cannot contain slashes.' });
          return;
        }
        if (normalizedName === currentDialog.folder.name) {
          setWorkspaceFileDialog(null);
          return;
        }

        const sourceFolder = currentDialog.folder.path;
        const parentFolder = getWorkspaceParentFolderPath(sourceFolder);
        const destinationFolder = parentFolder ? `${parentFolder}/${normalizedName}` : normalizedName;
        const renamed = await renameFolder(selectedWorkspace.id, sourceFolder, normalizedName);
        const updatedFiles = Array.isArray(renamed?.files) ? renamed.files as WorkspaceFile[] : [];
        const updatedFilesById = new Map(updatedFiles.map((file) => [String(file.id), file]));
        const renameFilePath = (file: WorkspaceFile): WorkspaceFile => {
          const serverFile = updatedFilesById.get(String(file.id));
          if (serverFile) {
            return { ...file, ...serverFile, content: serverFile.content ?? file.content };
          }
          const fileName = file.name || '';
          const nextName = replaceFolderPathPrefix(fileName, sourceFolder, destinationFolder);
          return nextName === fileName ? file : { ...file, name: nextName };
        };

        setFiles((prev) => prev.map(renameFilePath));
        setSelectedFile((prev) => (prev ? renameFilePath(prev) : prev));
        setSelectedFileDetails((prev) => (prev ? renameFilePath(prev) : prev));
        setFolderPaths((prev) => Array.from(new Set(
          prev.map((path) => replaceFolderPathPrefix(path, sourceFolder, destinationFolder)),
        )).sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })));
        setRagStatuses((prev) => {
          const next: typeof prev = {};
          Object.entries(prev).forEach(([fileName, status]) => {
            next[replaceFolderPathPrefix(fileName, sourceFolder, destinationFolder)] = status;
          });
          return next;
        });
        setSelectedDashboardPath((prev) => (prev ? replaceFolderPathPrefix(prev, sourceFolder, destinationFolder) : prev));
        setWorkspaceFileDialog(null);
        return;
      }

      if (currentDialog.kind === 'rename-file') {
        const proposedName = currentDialog.value.trim();
        if (!proposedName) {
          setWorkspaceFileDialog({ ...currentDialog, busy: false, error: 'Enter a file name.' });
          return;
        }
        if (proposedName === currentDialog.file.name) {
          setWorkspaceFileDialog(null);
          return;
        }

        const updated = await renameFile(selectedWorkspace.id, currentDialog.file.id, { name: proposedName });
        applyWorkspaceFileUpdate(currentDialog.file.name, updated);
        setWorkspaceFileDialog(null);
        return;
      }

      if (currentDialog.kind === 'delete-file') {
        const { file } = currentDialog;
        await deleteFile(selectedWorkspace.id, file.id);
        setFiles((prev) => prev.filter((item) => item.id !== file.id));
        setSelectedFiles((prev) => {
          const next = new Set(prev);
          next.delete(file.id);
          return next;
        });
        setRagStatuses((prev) => {
          if (!prev[file.name]) {
            return prev;
          }
          const next = { ...prev };
          delete next[file.name];
          return next;
        });
        if (selectedFile?.id === file.id) {
          setSelectedFile(null);
          setSelectedFileDetails(null);
          setFileContent('');
        }
        setWorkspaceFileDialog(null);
        return;
      }

      if (currentDialog.kind === 'delete-folder') {
        const { folder } = currentDialog;
        const prefix = `${folder.path}/`;
        const folderPrefix = `${folder.path}/`;
        const filesInFolder = files.filter((file) => {
          const name = file.name || '';
          return name === folder.path || name.startsWith(prefix);
        });

        await deleteFolder(selectedWorkspace.id, folder.path);

        const deletedIds = new Set(filesInFolder.map((file) => file.id));
        const deletedNames = new Set(filesInFolder.map((file) => file.name));

        setFiles((prev) =>
          prev.filter((file) => {
            const name = file.name || '';
            return name !== folder.path && !name.startsWith(prefix);
          }),
        );
        setFolderPaths((prev) => prev.filter((path) => path !== folder.path && !path.startsWith(folderPrefix)));
        setSelectedFiles((prev) => {
          const next = new Set(prev);
          for (const fileId of deletedIds) {
            next.delete(fileId);
          }
          return next;
        });
        setRagStatuses((prev) => {
          const next = { ...prev };
          for (const fileName of deletedNames) {
            delete next[fileName];
          }
          return next;
        });
        if (selectedFile) {
          const selectedName = selectedFile.name || '';
          if (selectedName === folder.path || selectedName.startsWith(prefix)) {
            setSelectedFile(null);
            setSelectedFileDetails(null);
            setFileContent('');
          }
        }
        setWorkspaceFileDialog(null);
        return;
      }

      const fileIdsToDelete = new Set(currentDialog.fileIds);
      for (const fileId of fileIdsToDelete) {
        if (String(fileId).startsWith('draft:')) {
          continue;
        }
        await deleteFile(selectedWorkspace.id, fileId);
      }
      setFiles((prevFiles) => prevFiles.filter((file) => !fileIdsToDelete.has(file.id)));
      setRagStatuses((prev) => {
        const next = { ...prev };
        for (const file of files) {
          if (fileIdsToDelete.has(file.id)) {
            delete next[file.name];
          }
        }
        return next;
      });
      setSelectedFiles(new Set());
      if (selectedFile && fileIdsToDelete.has(selectedFile.id)) {
        setSelectedFile(null);
        setSelectedFileDetails(null);
        setFileContent('');
      }
      setWorkspaceFileDialog(null);
    } catch (error) {
      console.error('Workspace file action failed:', error);
      setWorkspaceFileDialog({
        ...currentDialog,
        busy: false,
        error: error instanceof Error ? error.message : 'Action failed. Please try again.',
      });
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedWorkspace || !event.target.files || event.target.files.length === 0) {
      return;
    }

    const filesToUpload = event.target.files;

    try {
      for (const file of filesToUpload) {
        const newFileData = (await createFile(selectedWorkspace.id, file)) as WorkspaceFile;
        setFiles((prevFiles) => [...prevFiles, newFileData]);
      }
    } catch (error) {
      console.error('Failed to upload file:', error);
    } finally {
      event.target.value = '';
    }
  };

  const handleFolderUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedWorkspace || !event.target.files || event.target.files.length === 0) {
      return;
    }

    const filesToUpload = Array.from(event.target.files);

    try {
      for (const file of filesToUpload) {
        const relativePath = getUploadRelativePath(file);
        if (!relativePath) {
          continue;
        }
        const newFileData = (await createFile(selectedWorkspace.id, file, relativePath)) as WorkspaceFile;
        setFiles((prevFiles) => [...prevFiles, newFileData]);
        const folderPath = getWorkspaceParentFolderPath(relativePath);
        if (folderPath) {
          setFolderPaths((prev) => addFolderPath(prev, folderPath));
        }
      }
    } catch (error) {
      console.error('Failed to upload folder:', error);
    } finally {
      event.target.value = '';
    }
  };

  const handleOpenLocalAttachmentPicker = () => {
    attachmentInputRef.current?.click();
  };

  const handleChatAttachmentChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files) return;
    const selected = Array.from(event.target.files);
    setChatAttachments((prev) => [
      ...prev,
      ...selected.map(createLocalComposerAttachment),
    ]);
    event.target.value = '';
  };

  const handleChatInputPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageFiles = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!imageFiles.length) {
      return;
    }
    event.preventDefault();
    const timestamp = Date.now();
    setChatAttachments((prev) => [
      ...prev,
      ...imageFiles.map((file, index) => {
        const extension = file.type.split('/')[1] || 'png';
        const namedFile = file.name
          ? file
          : new File([file], `pasted-image-${timestamp}-${index + 1}.${extension}`, { type: file.type });
        return createLocalComposerAttachment(namedFile);
      }),
    ]);
  };

  const handleOpenDrivePicker = () => {
    if (!selectedWorkspace) {
      addLocalSystemMessage('Please select a workspace before importing Google Drive files.');
      return;
    }
    setIsDrivePickerOpen(true);
  };

  const handleDrivePickerConfirm = async (items: GoogleDrivePickerItem[]) => {
    if (!items.length) {
      setIsDrivePickerOpen(false);
      return;
    }
    const workspaceId = selectedWorkspace?.id;
    if (!workspaceId) {
      setIsDrivePickerOpen(false);
      addLocalSystemMessage('Please select a workspace before importing Google Drive files.');
      return;
    }

    const existingDriveIds = new Set(
      chatAttachmentsRef.current
        .filter((attachment): attachment is Extract<ChatComposerAttachment, { source: 'drive' }> => attachment.source === 'drive')
        .map((attachment) => attachment.driveItem.id),
    );
    const pendingAttachments = items
      .filter((item) => !existingDriveIds.has(item.id))
      .map(createDriveComposerAttachment);
    const pendingDriveIds = new Set(items.map((item) => item.id));

    if (pendingAttachments.length) {
      setChatAttachments((prev) => [...prev, ...pendingAttachments]);
    }
    setIsDrivePickerOpen(false);

    try {
      setIsDriveImporting(true);
      const imported = await importGoogleDriveFiles(workspaceId, items.map((item) => item.id));
      const importedFiles = Array.isArray(imported.files) ? imported.files : [];
      if (importedFiles.length && selectedWorkspaceIdRef.current === workspaceId) {
        await loadFilesForWorkspace(workspaceId);
      }
    } catch (error) {
      console.error('Failed to import Google Drive files:', error);
      setChatAttachments((prev) =>
        prev.filter(
          (attachment) => attachment.source !== 'drive' || !pendingDriveIds.has(attachment.driveItem.id),
        ),
      );
      addLocalSystemMessage(error instanceof Error ? error.message : 'Failed to import Google Drive files.');
    } finally {
      setIsDriveImporting(false);
    }
  };

  const handleRemoveChatAttachment = (index: number) => {
    setChatAttachments((prev) => {
      const removed = prev[index];
      if (removed) {
        revokeLocalAttachmentPreview(removed);
      }
      return prev.filter((_, idx) => idx !== index);
    });
  };

  const handleInsertSlashTrigger = () => {
    const input = chatInputRef.current;
    const cursorStart = input?.selectionStart ?? chatMessage.length;
    const cursorEnd = input?.selectionEnd ?? cursorStart;
    const before = chatMessage.slice(0, cursorStart);
    const after = chatMessage.slice(cursorEnd);
    const nextValue = `${before}/${after}`;
    setChatMessage(nextValue);
    closeMention();
    requestAnimationFrame(() => {
      const cursorPosition = before.length + 1;
      if (input) {
        input.focus();
        input.setSelectionRange(cursorPosition, cursorPosition);
      }
      updateCommandState(nextValue, cursorPosition);
    });
  };

  const handleLumoPrompt = useCallback((prompt: string) => {
    if (!isAgentPaneVisible) {
      setIsAgentPaneVisible(true);
    }
    setChatMessage(prompt);
    closeMention();
    closeCommand();
    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
      chatInputRef.current?.setSelectionRange(prompt.length, prompt.length);
      updateCommandState(prompt, prompt.length);
    });
  }, [closeCommand, closeMention, isAgentPaneVisible, updateCommandState]);

  return (
    <ThemeProvider theme={theme}>
      <Box
        sx={{
          display: 'flex',
          height: '100vh',
          maxHeight: '100vh',
          width: '100vw',
          maxWidth: '100vw',
          overflow: 'hidden',
        }}
      >
        <CssBaseline />
        <ExpandableSidebar
          handleDrawerToggle={handleDrawerToggle}
          isDrawerOpen={drawerOpen}
          onOpenSettings={handleOpenAgentSettings}
        />
        <CollapsibleDrawer
          open={drawerOpen}
          handleDrawerClose={handleDrawerToggle}
          workspaces={filteredWorkspaces}
          selectedWorkspace={selectedWorkspace}
          workspaceSearchQuery={workspaceSearchQuery}
          setWorkspaceSearchQuery={setWorkspaceSearchQuery}
          handleDeleteWorkspace={handleDeleteWorkspace}
          onShareWorkspace={handleShareWorkspace}
          onSelectWorkspace={handleSelectWorkspace}
          onOpenLandingPage={handleOpenLandingPage}
          onOpenSettings={handleOpenAgentSettings}
          colorMode={colorMode}
          onToggleColorMode={toggleColorMode}
          onSignOut={handleSignOut}
        />
        <Box
          component="main"
          sx={{
            flexGrow: 1,
            p: 2,
            height: '100%',
            maxHeight: '100%',
            minHeight: 0,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            transition: (theme) =>
              theme.transitions.create('margin', {
                easing: theme.transitions.easing.sharp,
                duration: theme.transitions.duration.leavingScreen,
              }),
            marginLeft: `-${drawerWidth}px`,
            ...(drawerOpen && {
              transition: (theme) =>
                theme.transitions.create('margin', {
                  easing: theme.transitions.easing.easeOut,
                  duration: theme.transitions.duration.enteringScreen,
                }),
              marginLeft: 0,
            }),
          }}
        >
          <div
            className={`flex font-sans h-full min-h-0 overflow-hidden ${
              isDarkMode ? 'bg-[#020817]' : 'bg-gray-100'
            }`}
            style={{ height: layoutHeight }}
          >
            {isLandingPageVisible ? (
              <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${
                isDarkMode ? 'bg-[#020817]' : 'bg-slate-50'
              }`}>
                <div className="flex flex-1 items-center justify-center px-6 py-8">
                  <div className="w-full max-w-4xl">
                    <h1 className={`mb-12 text-center text-4xl font-semibold tracking-normal md:text-5xl ${
                      isDarkMode ? 'text-slate-100' : 'text-slate-900'
                    }`}>
                      {landingUserName ? `Hi ${landingUserName}, What are we documenting today?` : 'What are we documenting today?'}
                    </h1>
                    <div className={`relative rounded-[2rem] border shadow-[0_28px_70px_-48px_rgba(15,23,42,0.7)] ${
                      isDarkMode ? 'border-slate-700/80 bg-slate-950/80' : 'border-slate-200 bg-white'
                    }`}>
                      <textarea
                        placeholder="Ask HelpUDoc anything..."
                        value={chatMessage}
                        ref={chatInputRef}
                        onChange={handleChatInputChange}
                        onKeyDown={(event) => {
                          handleChatInputKeyDown(event, { sendOnEnter: false });
                          if (event.defaultPrevented) {
                            return;
                          }
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            void handleLandingSendMessage();
                            return;
                          }
                        }}
                        onKeyUp={handleChatInputKeyUp}
                        onSelect={handleChatInputSelectionChange}
                        onPaste={handleChatInputPaste}
                        className={`block min-h-36 w-full resize-none bg-transparent px-6 py-6 text-lg leading-relaxed outline-none ${
                          isDarkMode ? 'text-slate-100 placeholder:text-slate-500' : 'text-slate-900 placeholder:text-slate-400'
                        }`}
                        rows={4}
                      />
                      {chatAttachments.length > 0 ? (
                        <div className="flex flex-wrap gap-2 px-5 pb-4">
                          {chatAttachments.map((attachment, index) => (
                            <div
                              key={attachment.id}
                              className={`group flex max-w-[15rem] items-center gap-2 rounded-xl border p-1.5 pr-2 text-sm font-medium ${
                                isDarkMode ? 'border-slate-700 bg-slate-900 text-slate-100' : 'border-slate-200 bg-slate-50 text-slate-700'
                              }`}
                            >
                              {attachment.source === 'drive' ? (
                                <GoogleDriveIcon className="h-8 w-8 shrink-0 rounded-lg p-1.5" />
                              ) : attachment.previewUrl ? (
                                <img
                                  src={attachment.previewUrl}
                                  alt=""
                                  className="h-8 w-8 shrink-0 rounded-lg object-cover"
                                />
                              ) : (
                                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                                  isDarkMode ? 'bg-slate-800 text-slate-400' : 'bg-white text-slate-500'
                                }`}>
                                  <FileIcon size={16} />
                                </span>
                              )}
                              <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
                              <button
                                type="button"
                                onClick={() => handleRemoveChatAttachment(index)}
                                className={`shrink-0 rounded-md p-1 transition ${
                                  isDarkMode ? 'text-slate-500 hover:bg-slate-800 hover:text-rose-300' : 'text-slate-400 hover:bg-slate-100 hover:text-rose-500'
                                }`}
                                aria-label={`Remove ${attachment.name}`}
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {(isMentionOpen || isCommandOpen) && (
                        <div className="absolute left-6 top-20 z-30 w-[30rem] max-w-[calc(100%-3rem)]">
                          {isMentionOpen ? (
                            <div className={`max-h-64 overflow-y-auto rounded-2xl border p-1 text-sm shadow-2xl backdrop-blur-md ${
                              isDarkMode ? 'border-slate-700/80 bg-slate-900/95' : 'border-slate-200 bg-white/95'
                            }`}>
                              {mentionSuggestions.length ? (
                                mentionSuggestions.map((file, index) => (
                                  <button
                                    key={file.id}
                                    type="button"
                                    onMouseDown={(event) => {
                                      event.preventDefault();
                                      handleSelectMention(file);
                                    }}
                                    className={`flex w-full items-center rounded-xl px-3 py-2 text-left transition ${
                                      index === mentionSelectedIndex
                                        ? isDarkMode
                                          ? 'bg-sky-500/15 text-sky-200'
                                          : 'bg-sky-50 text-sky-700'
                                        : isDarkMode
                                          ? 'text-slate-200 hover:bg-slate-800'
                                          : 'text-slate-700 hover:bg-slate-50'
                                    }`}
                                  >
                                    <FileIcon size={16} className={`mr-2 shrink-0 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`} />
                                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                                    <span className={`ml-3 shrink-0 text-[10px] uppercase ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                                      {file.mimeType?.split('/').pop() || file.name.split('.').pop() || 'file'}
                                    </span>
                                  </button>
                                ))
                              ) : (
                                <div className={`px-3 py-2 text-sm ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                                  No matching files
                                </div>
                              )}
                            </div>
                          ) : null}
                          {isCommandOpen ? (
                            <div className={`max-h-72 overflow-y-auto rounded-2xl border p-1 text-sm shadow-2xl backdrop-blur-md ${
                              isDarkMode ? 'border-slate-700/80 bg-slate-900/95' : 'border-slate-200 bg-white/95'
                            }`}>
                              {landingCommandGroups.length ? (
                                landingCommandGroups.map((group) => (
                                  <div key={group.category} className="py-0.5">
                                    <div className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-normal ${
                                      isDarkMode ? 'text-slate-500' : 'text-slate-400'
                                    }`}>
                                      {group.category}
                                    </div>
                                    {group.commands.map((command) => {
                                      const absoluteIndex = commandSuggestions.findIndex((item) => item.id === command.id);
                                      const isSelectedCommand = absoluteIndex === commandSelectedIndex;
                                      const Icon = command.command.startsWith('/skill')
                                        ? Wrench
                                        : command.command.startsWith('/mcp')
                                          ? Plug
                                          : Sparkles;
                                      return (
                                        <button
                                          key={command.id}
                                          type="button"
                                          onMouseDown={(event) => {
                                            event.preventDefault();
                                            handleSelectCommand(command);
                                          }}
                                          className={`group flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition ${
                                            isSelectedCommand
                                              ? isDarkMode
                                                ? 'bg-sky-500/15 text-sky-200'
                                                : 'bg-sky-50 text-sky-700'
                                              : isDarkMode
                                                ? 'text-slate-200 hover:bg-slate-800'
                                                : 'text-slate-700 hover:bg-slate-50'
                                          }`}
                                        >
                                          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                                            isDarkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-500'
                                          }`}>
                                            <Icon size={15} />
                                          </span>
                                          <span className="min-w-0 flex-1 truncate font-semibold">
                                            {command.command}
                                          </span>
                                          <span
                                            title={command.description}
                                            className={`shrink-0 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100 ${
                                              isDarkMode ? 'text-slate-500' : 'text-slate-400'
                                            }`}
                                          >
                                            <Info size={14} />
                                          </span>
                                          {isSelectedCommand ? (
                                            <span className={`hidden shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium sm:flex ${
                                              isDarkMode ? 'border-slate-700 text-slate-400' : 'border-slate-200 text-slate-500'
                                            }`}>
                                              Enter
                                              <span className={isDarkMode ? 'text-slate-600' : 'text-slate-300'}>/</span>
                                              Tab
                                            </span>
                                          ) : null}
                                        </button>
                                      );
                                    })}
                                  </div>
                                ))
                              ) : (
                                <div className={`px-3 py-2 text-sm ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                                  No matching commands, skills, or MCP servers
                                </div>
                              )}
                            </div>
                          ) : null}
                        </div>
                      )}
                      <div className={`flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 ${
                        isDarkMode ? 'border-slate-800' : 'border-slate-100'
                      }`}>
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() => setIsLandingAttachmentMenuOpen((prev) => !prev)}
                              disabled={isDriveImporting}
                              className={`inline-flex h-10 w-10 items-center justify-center rounded-full transition disabled:opacity-50 ${
                                isDarkMode ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
                              }`}
                              title="Attach files"
                              aria-label="Attach files"
                              aria-expanded={isLandingAttachmentMenuOpen}
                            >
                              <Plus size={22} />
                            </button>
                            {isLandingAttachmentMenuOpen ? (
                              <div className={`absolute bottom-full left-0 z-40 mb-2 w-56 rounded-2xl border p-1.5 text-sm shadow-2xl backdrop-blur-md ${
                                isDarkMode ? 'border-slate-700/80 bg-slate-900/95 text-slate-100' : 'border-slate-200 bg-white/95 text-slate-800'
                              }`}>
                                <button
                                  type="button"
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => {
                                    setIsLandingAttachmentMenuOpen(false);
                                    handleOpenLocalAttachmentPicker();
                                  }}
                                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition ${
                                    isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-50'
                                  }`}
                                >
                                  <Upload size={16} className={isDarkMode ? 'text-slate-400' : 'text-slate-500'} />
                                  <span>Upload files</span>
                                </button>
                                <button
                                  type="button"
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => {
                                    setIsLandingAttachmentMenuOpen(false);
                                    handleOpenDrivePicker();
                                  }}
                                  disabled={isDriveImporting}
                                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                                    isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-50'
                                  }`}
                                >
                                  {isDriveImporting ? (
                                    <Loader2 size={16} className={`animate-spin ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`} />
                                  ) : (
                                    <GoogleDriveIcon className="h-4 w-4 shrink-0" />
                                  )}
                                  <span>Google Drive</span>
                                </button>
                              </div>
                            ) : null}
                          </div>
                          <div ref={landingWorkspacePickerRef} className="relative">
                            <button
                              type="button"
                              onClick={() => {
                                setIsLandingWorkspacePickerOpen((value) => !value);
                                setLandingWorkspaceQuery('');
                              }}
                              className={`flex h-10 w-[18rem] max-w-[44vw] items-center justify-between gap-2 rounded-xl border px-3 text-left text-sm font-medium outline-none transition ${
                                isDarkMode
                                  ? 'border-slate-700 bg-slate-900 text-slate-100 hover:border-slate-600 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20'
                                  : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-100'
                              }`}
                              aria-label="Select workspace"
                              aria-expanded={isLandingWorkspacePickerOpen}
                            >
                              <span className="truncate">{selectedWorkspace?.name || 'New Workspace'}</span>
                              <ChevronDown size={16} className="shrink-0 opacity-70" />
                            </button>
                            {isLandingWorkspacePickerOpen ? (
                              <div className={`absolute bottom-full left-0 z-30 mb-2 w-[28rem] max-w-[min(28rem,calc(100vw-3rem))] overflow-hidden rounded-2xl border shadow-2xl ${
                                isDarkMode ? 'border-slate-700 bg-slate-950 text-slate-100' : 'border-slate-200 bg-white text-slate-900'
                              }`}>
                                <div className={`border-b p-2 ${isDarkMode ? 'border-slate-800' : 'border-slate-100'}`}>
                                  <label className={`flex h-9 items-center gap-2 rounded-xl px-3 ${
                                    isDarkMode ? 'bg-slate-900 text-slate-400' : 'bg-slate-50 text-slate-500'
                                  }`}>
                                    <Search size={15} className="shrink-0" />
                                    <input
                                      value={landingWorkspaceQuery}
                                      onChange={(event) => setLandingWorkspaceQuery(event.target.value)}
                                      placeholder="Search workspaces"
                                      className={`min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-current ${
                                        isDarkMode ? 'text-slate-100' : 'text-slate-900'
                                      }`}
                                    />
                                  </label>
                                </div>
                                <div className="max-h-72 overflow-y-auto p-1.5">
                                  <button
                                    type="button"
                                    onClick={handleCreateLandingWorkspace}
                                    className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                                      isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-50'
                                    }`}
                                  >
                                    <Plus size={15} className="shrink-0" />
                                    <span>New Workspace</span>
                                  </button>
                                  {landingFilteredWorkspaces.map((workspace) => (
                                    <button
                                      key={workspace.id}
                                      type="button"
                                      onClick={() => handleLandingWorkspaceSelect(workspace)}
                                      className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition ${
                                        selectedWorkspace?.id === workspace.id
                                          ? isDarkMode ? 'bg-sky-500/15 text-sky-200' : 'bg-blue-50 text-blue-700'
                                          : isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-50'
                                      }`}
                                    >
                                      <span className="truncate">{workspace.name}</span>
                                      {selectedWorkspace?.id === workspace.id ? <Check size={15} className="shrink-0" /> : null}
                                    </button>
                                  ))}
                                  {!landingFilteredWorkspaces.length ? (
                                    <div className={`px-3 py-4 text-sm ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                                      No workspaces found
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            ) : null}
                          </div>
                          <select
                            value={normalizePersonaName(activeConversationPersona || selectedPersona || DEFAULT_PERSONA_NAME)}
                            onChange={handleModeChange}
                            className={`h-10 rounded-xl border px-3 text-sm font-medium capitalize outline-none transition ${
                              isDarkMode
                                ? 'border-slate-700 bg-slate-900 text-slate-100 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20'
                                : 'border-slate-200 bg-slate-50 text-slate-700 focus:border-blue-400 focus:ring-2 focus:ring-blue-100'
                            }`}
                            aria-label="Select model mode"
                          >
                            {landingPersonas.map((persona) => (
                              <option key={persona.name} value={persona.name}>
                                {(persona.displayName || persona.name).toLowerCase()}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleLandingSendMessage()}
                          disabled={isDriveImporting || (!chatMessage.trim() && !chatAttachments.length)}
                          className={`inline-flex h-12 w-12 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
                            isDarkMode
                              ? 'bg-slate-100 text-slate-950 hover:bg-white'
                              : 'bg-slate-900 text-white hover:bg-slate-700'
                          }`}
                          title="Send message"
                          aria-label="Send message"
                        >
                          <ArrowUp size={22} />
                        </button>
                      </div>
                    </div>
                    <input
                      type="file"
                      ref={attachmentInputRef}
                      className="hidden"
                      multiple
                      accept="image/*,.pdf,.md,.txt,.doc,.docx"
                      onChange={handleChatAttachmentChange}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <>
            {/* Middle Pane: Files & Editor */}
            <div
              className="flex min-w-0 min-h-0 flex-col overflow-hidden"
              style={workspacePaneStyles}
            >
              {/* Workspace Header */}
              <div className={`px-4 py-3 flex items-center gap-3 ${
                isDarkMode ? 'border-b border-[#223047] bg-[#08111f]' : 'border-b border-gray-200'
              }`}>
                <button
                  type="button"
                  onClick={handleOpenLandingPage}
                  className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition ${
                    isDarkMode
                      ? 'border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                  title="Home"
                  aria-label="Go to landing page"
                >
                  <Home size={17} />
                </button>
                <div className="min-w-0 flex-1">
                {selectedWorkspace ? (
                  isWorkspaceRenameActive && selectedWorkspace.canEdit ? (
                    <input
                      ref={workspaceNameInputRef}
                      value={workspaceNameDraft}
                      onChange={(event) => setWorkspaceNameDraft(event.target.value)}
                      onBlur={() => {
                        void commitWorkspaceRename();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void commitWorkspaceRename();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelWorkspaceRename();
                        }
                      }}
                      disabled={workspaceRenameBusy}
                      aria-label="Workspace name"
                      className={`w-full max-w-[24rem] rounded-lg px-3 py-1.5 text-lg font-semibold outline-none ring-2 disabled:cursor-wait ${
                        isDarkMode
                          ? 'border border-sky-500/40 bg-slate-900 text-slate-100 ring-sky-500/20'
                          : 'border border-blue-200 bg-white text-gray-800 ring-blue-100'
                      }`}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        if (!selectedWorkspace.canEdit) return;
                        setWorkspaceNameDraft(selectedWorkspace.name);
                        setIsWorkspaceRenameActive(true);
                      }}
                      className={`flex items-center gap-2 text-left text-lg font-semibold ${
                        selectedWorkspace.canEdit
                          ? isDarkMode ? 'text-slate-100 hover:text-sky-300' : 'text-gray-800 hover:text-blue-700'
                          : isDarkMode ? 'cursor-default text-slate-100' : 'cursor-default text-gray-800'
                      }`}
                    >
                      <span>{selectedWorkspace.name}</span>
                      {selectedWorkspace.canEdit ? <Edit size={16} className={isDarkMode ? 'text-slate-500' : 'text-gray-400'} /> : null}
                    </button>
                  )
                ) : (
                  <h2 className={`text-lg font-semibold ${isDarkMode ? 'text-slate-100' : 'text-gray-800'}`}>No workspace selected</h2>
                )}
                </div>
              </div>
              <div className="flex-1 flex min-h-0">
                {/* File Explorer */}
                <div
                  className={`flex flex-col overflow-hidden min-h-0 ${
                    isDarkMode ? 'bg-[#08111f] border-r border-[#223047]' : 'bg-white border-r border-gray-200'
                  }`}
                  style={filePaneStyles}
                >
                  <div
                    className={`px-3 py-3 flex items-center ${isFilePaneVisible ? 'justify-between' : 'justify-center'
                      } ${isDarkMode ? 'border-b border-[#223047]' : 'border-b border-gray-200'
                      }`}
                  >
                    <div className={`flex items-center ${isFilePaneVisible ? 'gap-3' : ''}`}>
                      <button
                        onClick={() => setIsFilePaneVisible(!isFilePaneVisible)}
                        className={`h-8 w-8 inline-flex items-center justify-center shrink-0 border rounded-full ${
                          isDarkMode
                            ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                            : 'border-gray-200 hover:bg-gray-100'
                        }`}
                        title={isFilePaneVisible ? 'Collapse files' : 'Expand files'}
                      >
                        <ChevronLeft
                          size={16}
                          className={`transition-transform duration-300 ${
                            isDarkMode ? 'text-slate-300' : 'text-gray-600'
                          } ${isFilePaneVisible ? '' : 'rotate-180'
                            }`}
                        />
                      </button>
                      {isFilePaneVisible && <h3 className={`text-base font-semibold ${isDarkMode ? 'text-slate-100' : 'text-gray-800'}`}>Files</h3>}
                    </div>
                    {isFilePaneVisible && (
                      <div className="flex items-center space-x-1.5">
                        <input
                          type="file"
                          id="file-upload"
                          ref={fileUploadInputRef}
                          style={{ display: 'none' }}
                          onChange={handleFileUpload}
                          multiple
                        />
                        <input
                          type="file"
                          id="folder-upload"
                          ref={(element) => {
                            folderUploadInputRef.current = element;
                            element?.setAttribute('webkitdirectory', '');
                            element?.setAttribute('directory', '');
                          }}
                          style={{ display: 'none' }}
                          onChange={handleFolderUpload}
                          multiple
                        />
                        <div ref={fileActionMenuRef} className="relative">
                          <button
                            type="button"
                            onClick={() => setIsFileActionMenuOpen((prev) => !prev)}
                            disabled={!selectedWorkspace}
                            className={`h-8 w-8 inline-flex items-center justify-center rounded-lg disabled:opacity-50 ${
                              isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-gray-100'
                            }`}
                            title="Add files or folders"
                            aria-haspopup="menu"
                            aria-expanded={isFileActionMenuOpen}
                          >
                            <Plus size={16} className={isDarkMode ? 'text-slate-300' : 'text-gray-600'} />
                          </button>
                          {isFileActionMenuOpen && (
                            <div
                              role="menu"
                              className={`absolute left-0 top-full z-[1300] mt-2 min-w-[12rem] rounded-lg border py-1 text-sm shadow-xl ${
                                isDarkMode
                                  ? 'border-slate-700 bg-slate-950 text-slate-200'
                                  : 'border-slate-200 bg-white text-slate-700'
                              }`}
                            >
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setIsFileActionMenuOpen(false);
                                  fileUploadInputRef.current?.click();
                                }}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left ${
                                  isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
                                }`}
                              >
                                <Upload size={15} />
                                <span>Upload files</span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setIsFileActionMenuOpen(false);
                                  void handleCreateFolder();
                                }}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left ${
                                  isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
                                }`}
                              >
                                <FolderPlus size={15} />
                                <span>Create folder</span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setIsFileActionMenuOpen(false);
                                  folderUploadInputRef.current?.click();
                                }}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left ${
                                  isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
                                }`}
                              >
                                <FolderUp size={15} />
                                <span>Upload folder</span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setIsFileActionMenuOpen(false);
                                  handleOpenDrivePicker();
                                }}
                                disabled={!selectedWorkspace || isDriveImporting}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
                                  isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
                                }`}
                              >
                                {isDriveImporting ? (
                                  <Loader2 size={15} className={`shrink-0 animate-spin ${isDarkMode ? 'text-slate-300' : 'text-gray-600'}`} />
                                ) : (
                                  <GoogleDriveIcon className="h-4 w-4 shrink-0" />
                                )}
                                <span>Google Drive</span>
                              </button>
                            </div>
                          )}
                        </div>
                        <button
                          onClick={handleRefreshFiles}
                          disabled={!selectedWorkspace}
                          className={`h-8 w-8 inline-flex items-center justify-center rounded-lg disabled:opacity-50 ${
                            isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-gray-100'
                          }`}
                          title="Refresh files"
                        >
                          <RotateCcw size={16} className={isDarkMode ? 'text-slate-300' : 'text-gray-600'} />
                        </button>
                        <button
                          onClick={handleSelectAllFiles}
                          disabled={visibleFiles.length === 0}
                          className={`h-8 w-8 inline-flex items-center justify-center rounded-lg disabled:opacity-50 ${
                            isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-gray-100'
                          }`}
                          title={allFilesSelected ? 'Clear selection' : 'Select all files'}
                        >
                          <CheckSquare size={16} className={isDarkMode ? 'text-slate-300' : 'text-gray-600'} />
                        </button>
                        <button
                          onClick={handleBulkDelete}
                          disabled={selectedFiles.size === 0}
                          className={`h-8 w-8 inline-flex items-center justify-center rounded-lg disabled:opacity-50 ${
                            isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-gray-100'
                          }`}
                        >
                          <Trash size={16} className={isDarkMode ? 'text-slate-300' : 'text-gray-600'} />
                        </button>
                      </div>
                    )}
                  </div>
                  {isFilePaneVisible && hiddenFileCount > 0 && (
                    <div className={`px-4 pb-2 text-xs flex items-center justify-between ${
                      isDarkMode ? 'text-slate-500' : 'text-gray-500'
                    }`}>
                      <span>
                        {showSystemFiles
                          ? `Showing ${files.length} files`
                          : `Showing ${visibleFiles.length} of ${files.length}`}
                      </span>
                      <button
                        type="button"
                        className={isDarkMode ? 'text-sky-400 hover:text-sky-300' : 'text-blue-600 hover:text-blue-700'}
                        onClick={() => setShowSystemFiles((prev) => !prev)}
                      >
                        {showSystemFiles ? 'Hide system files' : `Show ${hiddenFileCount} hidden`}
                      </button>
                    </div>
                  )}
                  <div
                    className={`flex-1 overflow-hidden min-h-0 transition-opacity duration-200 ${isFilePaneVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                      }`}
                    aria-hidden={!isFilePaneVisible}
                  >
                    <div className="h-full min-h-0 px-3 py-2">
                      <WorkspaceFileTree
                        files={visibleFiles}
                        folderPaths={visibleFolderPaths}
                        colorMode={colorMode}
                        selectedFileId={selectedFile?.id || null}
                        selectedDashboardPath={selectedDashboardPath}
                        selectedFiles={selectedFiles}
                        copiedPublicUrlFileId={copiedPublicUrlFileId}
                        dashboardArtifactsByPath={dashboardArtifactsByPath}
                        ragStatuses={ragStatuses}
                        isDraftWorkspaceFile={isDraftWorkspaceFile}
                        onSelectFile={(file) => {
                          setSelectedFile(file);
                          setSelectedFileDetails(null);
                          setFileContent('');
                          setIsEditMode(shouldForceEditMode(file.name));
                        }}
                        onSelectFolder={handleDashboardFolderSelect}
                        onToggleFileSelection={handleFileSelect}
                        onCopyPublicUrl={handleCopyFilePublicUrl}
                        onRenameFile={handleRenameFile}
                        onRenameFolder={handleRenameFolder}
                        onDeleteFile={handleDeleteSingleFile}
                        onDeleteFolder={handleDeleteFolder}
                        onMoveFiles={handleMoveFiles}
                      />
                    </div>
                  </div>
                </div>

                <PaneResizeHandle
                  disabled={!isFilePaneVisible || isAgentPaneFullScreen}
                  isDarkMode={isDarkMode}
                  isResizing={filePaneResize.isResizing}
                  {...filePaneResize.createHandleProps('ltr')}
                />

                {/* Content Editor */}
                <div className={`flex-1 flex flex-col overflow-hidden min-w-0 min-h-0 ${
                  isDarkMode ? 'bg-[#0e1728]' : 'bg-gray-50'
                }`}>
                  <div className={`px-4 py-3 flex justify-between items-center ${
                    isDarkMode ? 'border-b border-[#223047]' : 'border-b border-gray-200'
                  }`}>
                    <div className="flex items-center gap-3">
                      <h3 className={`text-base font-semibold ${isDarkMode ? 'text-slate-100' : 'text-gray-800'}`}>{canvasTitle}</h3>
                    </div>
                    <div className="flex items-center space-x-2">
                      {canCopyImageUrl && (
                        <button
                          type="button"
                          className={`h-8 w-8 inline-flex items-center justify-center rounded-lg disabled:opacity-50 ${
                            isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-gray-200'
                          }`}
                          onClick={handleCopyImageUrl}
                          title={copiedImageUrl ? 'Copied!' : 'Copy public URL'}
                          aria-label={copiedImageUrl ? 'Copied to clipboard' : 'Copy image public URL'}
                        >
                          {copiedImageUrl ? (
                            <Check size={16} className={isDarkMode ? 'text-emerald-400' : 'text-emerald-600'} />
                          ) : (
                            <LinkIcon size={16} className={isDarkMode ? 'text-slate-300' : 'text-gray-600'} />
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        className={`h-8 w-8 inline-flex items-center justify-center rounded-lg disabled:opacity-50 ${
                          isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-gray-200'
                        }`}
                        onClick={handleCopyWorkspaceContent}
                        disabled={!selectedFile}
                        title={copiedWorkspaceContent ? 'Copied!' : 'Copy file content'}
                        aria-label={copiedWorkspaceContent ? 'Copied to clipboard' : 'Copy file content'}
                      >
                        {copiedWorkspaceContent ? (
                          <Check size={16} className={isDarkMode ? 'text-emerald-400' : 'text-emerald-600'} />
                        ) : (
                          <Copy size={16} className={isDarkMode ? 'text-slate-300' : 'text-gray-600'} />
                        )}
                      </button>
                      {canPrintOrDownloadFile && (
                        <>
                          <button
                            type="button"
                            className={`h-8 w-8 inline-flex items-center justify-center rounded-lg disabled:opacity-50 ${
                              isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-gray-200'
                            }`}
                            onClick={handlePrintActiveFile}
                            title="Print file"
                          >
                            <Printer size={16} className={isDarkMode ? 'text-slate-300' : 'text-gray-600'} />
                          </button>
                          <button
                            type="button"
                            className={`h-8 w-8 inline-flex items-center justify-center rounded-lg disabled:opacity-50 ${
                              isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-gray-200'
                            }`}
                            onClick={handleDownloadActiveFile}
                            title="Download file"
                          >
                            <Download size={16} className={isDarkMode ? 'text-slate-300' : 'text-gray-600'} />
                          </button>
                        </>
                      )}
                      {!shouldForceEditMode(selectedFile?.name || '') && (
                        <button
                          className={`h-8 w-8 inline-flex items-center justify-center rounded-lg disabled:opacity-50 ${
                            isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-gray-200'
                          }`}
                          onClick={() => {
                            if (!isAgentPaneVisible) {
                              setIsAgentPaneVisible(true);
                            }
                            setIsEditMode(!isEditMode);
                          }}
                          disabled={!selectedFile || !isFileEditable(selectedFile.name)}
                        >
                          <Edit size={16} className={isDarkMode ? 'text-slate-300' : 'text-gray-600'} />
                        </button>
                      )}
                      <button
                        className={`h-8 px-3 inline-flex items-center justify-center rounded-lg text-xs font-medium disabled:opacity-50 ${
                          isDarkMode ? 'text-slate-200 hover:bg-slate-800' : 'text-slate-700 hover:bg-gray-200'
                        }`}
                        onClick={() => selectedFile && handleUpdateFile(selectedFile, fileContent)}
                        disabled={!isEditMode}
                      >
                        Save
                      </button>
                      {!isEditMode && (
                        <>
                          <button
                            type="button"
                            className={`h-8 w-8 inline-flex items-center justify-center rounded-lg disabled:opacity-50 ${
                              isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-gray-200'
                            }`}
                            onClick={handleCanvasZoomOut}
                            disabled={!canZoomOutCanvas}
                            title="Zoom out canvas"
                          >
                            <Minus size={16} className={isDarkMode ? 'text-slate-300' : 'text-gray-600'} />
                          </button>
                          <button
                            type="button"
                            className={`h-8 px-2 inline-flex items-center justify-center rounded-lg text-[11px] font-semibold ${
                              isDarkMode ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-700 hover:bg-gray-200'
                            }`}
                            onClick={handleCanvasZoomReset}
                            title="Reset canvas zoom"
                          >
                            {Math.round(canvasZoom * 100)}%
                          </button>
                          <button
                            type="button"
                            className={`h-8 w-8 inline-flex items-center justify-center rounded-lg disabled:opacity-50 ${
                              isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-gray-200'
                            }`}
                            onClick={handleCanvasZoomIn}
                            disabled={!canZoomInCanvas}
                            title="Zoom in canvas"
                          >
                            <Plus size={16} className={isDarkMode ? 'text-slate-300' : 'text-gray-600'} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 overflow-hidden min-h-0">
                    {isEditMode && selectedWorkspace ? (
                      <Suspense fallback={editorLoadingFallback}>
                        <FileEditor
                          file={selectedFileDetails || selectedFile}
                          fileContent={fileContent}
                          onContentChange={setFileContent}
                          workspaceId={selectedWorkspace.id}
                          colorMode={colorMode}
                        />
                      </Suspense>
                    ) : (
                      <div className={isDashboardCanvas ? 'flex h-full w-full min-h-0 flex-col overflow-hidden' : 'h-full w-full overflow-y-auto overflow-x-hidden'}>
                        {isDashboardCanvas ? (
                          selectedWorkspace && resolvedDashboardFolder ? (
                            <DashboardCanvas
                              workspaceId={selectedWorkspace.id}
                              dashboardPath={resolvedDashboardFolder}
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center bg-white text-sm text-slate-500">
                              Opening dashboard…
                            </div>
                          )
                        ) : (
                          <div
                            className="h-full origin-top-left"
                            style={{
                              transform: `scale(${canvasZoom})`,
                              width: `${100 / canvasZoom}%`,
                              minHeight: `${100 / canvasZoom}%`,
                            }}
                          >
                            <Suspense fallback={canvasLoadingFallback}>
                              <UIBlockRenderer
                                blocks={canvasBlocks}
                                workspaceId={selectedWorkspace?.id}
                                className="h-full w-full"
                                emptyState={
                                  <div className={`text-center ${isDarkMode ? 'text-slate-500' : 'text-gray-400'}`}>
                                    <p>Select a file to view its content</p>
                                  </div>
                                }
                              />
                            </Suspense>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <PaneResizeHandle
              disabled={!isAgentPaneVisible || isAgentPaneFullScreen}
              isDarkMode={isDarkMode}
              isResizing={agentPaneResize.isResizing}
              {...agentPaneResize.createHandleProps('rtl')}
            />

            <AgentChatPane
              colorMode={colorMode}
              agentPaneStyles={agentPaneStyles}
              isAgentPaneVisible={isAgentPaneVisible}
              isAgentPaneFullScreen={isAgentPaneFullScreen}
              isEditMode={isEditMode}
              isHistoryOpen={isHistoryOpen}
              personas={personas}
              selectedPersona={normalizePersonaName(activeConversationPersona || selectedPersona || DEFAULT_PERSONA_NAME)}
              conversationHistory={conversationHistory}
              activeConversationId={activeConversationId}
              conversationStreaming={conversationStreaming}
              messages={messages}
              isStreaming={isStreaming}
              isPreparingAttachments={isDriveImporting}
              personaDisplayName={personaDisplayName}
              messageBubbleMaxWidth={messageBubbleMaxWidth}
              markdownComponents={markdownComponents}
              expandedToolMessages={expandedToolMessages}
              expandedThinkingMessages={expandedThinkingMessages}
              copiedMessageId={copiedMessageId}
              interruptInputByMessageId={interruptInputByMessageId}
              interruptStructuredAnswersByMessageId={interruptStructuredAnswersByMessageId}
              interruptSelectedChoicesByMessageId={interruptSelectedChoicesByMessageId}
              interruptSubmittingByMessageId={interruptSubmittingByMessageId}
              interruptErrorByMessageId={interruptErrorByMessageId}
              chatMessage={chatMessage}
              chatAttachments={chatAttachments}
              commandTags={commandTags}
              isMentionOpen={isMentionOpen}
              mentionSuggestions={mentionSuggestions}
              mentionSelectedIndex={mentionSelectedIndex}
              isCommandOpen={isCommandOpen}
              commandSuggestions={commandSuggestions}
              commandSelectedIndex={commandSelectedIndex}
              chatInputRef={chatInputRef}
              attachmentInputRef={attachmentInputRef}
              workspaceId={selectedWorkspace?.id}
              internetSearchEnabled={internetSearchEnabled}
              formatMessageTimestamp={formatMessageTimestamp}
              interruptFieldKey={interruptFieldKey}
              interruptActionFieldKey={interruptActionFieldKey}
              getInterruptKind={getInterruptKind}
              getInterruptActions={getInterruptActions}
              getPrimaryInterruptAction={getPrimaryInterruptAction}
              isPlanApprovalInterrupt={isPlanApprovalInterrupt}
              setInterruptInputByMessageId={setInterruptInputByMessageId}
              setInterruptStructuredAnswersByMessageId={setInterruptStructuredAnswersByMessageId}
              toggleInterruptSelectedChoice={toggleInterruptSelectedChoice}
              conversationAttentionById={conversationAttentionById}
              onToggleAgentPaneVisibility={() => setIsAgentPaneVisible((prev) => !prev)}
              onModeChange={handleModeChange}
              onToggleHistory={() => setIsHistoryOpen((prev) => !prev)}
              onNewChat={handleNewChat}
              onToggleFullScreen={toggleAgentPaneFullScreen}
              onCloseHistory={() => setIsHistoryOpen(false)}
              onSelectConversation={handleSelectConversationFromHistory}
              onDeleteConversation={handleDeleteConversation}
              onToggleThinkingVisibility={toggleThinkingVisibility}
              onToggleToolActivityVisibility={toggleToolActivityVisibility}
              onCopyMessageText={handleCopyMessageText}
              onRerunMessage={handleRerunMessage}
              onEditAndRerunMessage={handleEditAndRerunMessage}
              onPrepareInterruptAction={prepareInterruptAction}
              onInterruptAction={handleInterruptAction}
              onChatInputChange={handleChatInputChange}
              onChatInputKeyDown={handleChatInputKeyDown}
              onChatInputKeyUp={handleChatInputKeyUp}
              onChatInputSelectionChange={handleChatInputSelectionChange}
              onChatInputPaste={handleChatInputPaste}
              onOpenLocalAttachmentPicker={handleOpenLocalAttachmentPicker}
              onToggleInternetSearch={() => setInternetSearchEnabled((prev) => !prev)}
              onInsertSlashTrigger={handleInsertSlashTrigger}
              onStopStreaming={handleStopStreaming}
              onSendMessage={handleSendMessage}
              onChatAttachmentChange={handleChatAttachmentChange}
              onRemoveChatAttachment={handleRemoveChatAttachment}
              onRemoveCommandTag={handleRemoveCommandTag}
              onSelectMention={handleSelectMention}
              onSelectCommand={handleSelectCommand}
            />
              </>
            )}
            <LumoPet
              colorMode={colorMode}
              workspaceName={selectedWorkspace?.name}
              activeFileName={selectedFile?.name || selectedDashboardPath}
              aiBusy={isStreaming}
              hasSuggestion={hasPendingInterruptMessage}
              onPrompt={handleLumoPrompt}
            />
          </div>
        </Box>
      </Box>
      {workspaceFileDialog && (
        <div
          className="fixed inset-0 z-[1600] flex items-center justify-center bg-slate-950/50 p-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              handleCloseWorkspaceFileDialog();
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-file-dialog-title"
            className={`w-full max-w-md rounded-lg border p-5 shadow-2xl ${
              isDarkMode
                ? 'border-slate-700 bg-slate-950 text-slate-100'
                : 'border-slate-200 bg-white text-slate-950'
            }`}
          >
            <h2 id="workspace-file-dialog-title" className="text-lg font-semibold">
              {workspaceFileDialog.kind === 'create-folder'
                ? 'Create folder'
                : workspaceFileDialog.kind === 'rename-folder'
                  ? 'Rename folder'
                : workspaceFileDialog.kind === 'rename-file'
                  ? 'Rename file'
                : workspaceFileDialog.kind === 'delete-file'
                  ? 'Delete file'
                  : workspaceFileDialog.kind === 'delete-folder'
                    ? 'Delete folder'
                    : 'Delete selected files'}
            </h2>
            <div className={`mt-3 text-sm ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
              {workspaceFileDialog.kind === 'create-folder' || workspaceFileDialog.kind === 'rename-folder' || workspaceFileDialog.kind === 'rename-file' ? (
                <label className="block">
                  <span className="sr-only">
                    {workspaceFileDialog.kind === 'rename-file' ? 'File name' : 'Folder name'}
                  </span>
                  <input
                    type="text"
                    autoFocus
                    value={workspaceFileDialog.value}
                    onChange={(event) => handleWorkspaceFileDialogValueChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void handleConfirmWorkspaceFileDialog();
                      }
                    }}
                    disabled={workspaceFileDialog.busy}
                    className={`mt-1 h-10 w-full rounded-lg border px-3 text-sm outline-none transition focus:ring-2 ${
                      isDarkMode
                        ? 'border-slate-700 bg-slate-900 text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:ring-sky-500/30'
                        : 'border-slate-300 bg-white text-slate-950 placeholder:text-slate-400 focus:border-blue-500 focus:ring-blue-500/20'
                    }`}
                    placeholder={workspaceFileDialog.kind === 'rename-file' ? 'File name' : 'Folder name'}
                  />
                </label>
              ) : workspaceFileDialog.kind === 'delete-file' ? (
                <p>
                  Delete <span className="font-medium">{workspaceFileDialog.file.name}</span>?
                </p>
              ) : workspaceFileDialog.kind === 'delete-folder' ? (
                <p>
                  Delete folder <span className="font-medium">{workspaceFileDialog.folder.path}</span> and{' '}
                  {workspaceFileDialog.folder.fileCount} file{workspaceFileDialog.folder.fileCount === 1 ? '' : 's'} inside it?
                </p>
              ) : (
                <p>
                  Delete {workspaceFileDialog.fileCount} selected file{workspaceFileDialog.fileCount === 1 ? '' : 's'}?
                </p>
              )}
              {workspaceFileDialog.error && (
                <p className={`mt-3 text-sm ${isDarkMode ? 'text-rose-300' : 'text-rose-600'}`}>
                  {workspaceFileDialog.error}
                </p>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleCloseWorkspaceFileDialog}
                disabled={workspaceFileDialog.busy}
                className={`inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-medium disabled:opacity-50 ${
                  isDarkMode ? 'bg-slate-800 text-slate-100 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmWorkspaceFileDialog()}
                disabled={workspaceFileDialog.busy}
                className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium text-white disabled:opacity-50 ${
                  workspaceFileDialog.kind === 'create-folder'
                    ? 'bg-blue-600 hover:bg-blue-700'
                    : workspaceFileDialog.kind === 'rename-folder'
                      ? 'bg-blue-600 hover:bg-blue-700'
                    : workspaceFileDialog.kind === 'rename-file'
                      ? 'bg-blue-600 hover:bg-blue-700'
                    : 'bg-rose-600 hover:bg-rose-700'
                }`}
              >
                {workspaceFileDialog.busy && <Loader2 size={15} className="animate-spin" />}
                {workspaceFileDialog.kind === 'create-folder'
                  ? 'Create'
                  : workspaceFileDialog.kind === 'rename-folder'
                    ? 'Rename'
                  : workspaceFileDialog.kind === 'rename-file'
                    ? 'Rename'
                    : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
      <DrivePickerModal
        isOpen={isDrivePickerOpen}
        workspaceId={selectedWorkspace?.id}
        colorMode={colorMode}
        onClose={() => setIsDrivePickerOpen(false)}
        onConfirm={handleDrivePickerConfirm}
      />
      <WorkspaceShareDialog
        open={shareWorkspace !== null}
        workspace={shareWorkspace}
        onClose={() => setShareWorkspace(null)}
      />
    </ThemeProvider>
  );
}
