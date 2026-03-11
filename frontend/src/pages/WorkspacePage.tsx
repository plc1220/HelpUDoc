import { useState, useEffect, useRef, useCallback, useMemo, Children, isValidElement, type ChangeEvent } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  CssBaseline,
  ThemeProvider,
  createTheme,
  type PaletteMode,
} from '@mui/material';
import { CheckSquare, Copy, Edit, Trash, Plus, Minus, ChevronLeft, RotateCcw, X, Printer, Download, Link as LinkIcon, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getWorkspaces, createWorkspace, deleteWorkspace } from '../services/workspaceApi';
import {
  getFiles,
  createFile,
  updateFileContent,
  deleteFile,
  getFileContent,
  renameFile,
  getRagStatuses,
} from '../services/fileApi';
import { startPaper2SlidesJob, getPaper2SlidesJob, exportPaper2SlidesPptx } from '../services/paper2SlidesJobApi';
import {
  cancelRun,
  getRunStatus,
  startAgentRun,
  streamAgentRun,
  submitRunDecision,
  submitRunResponse,
  type AgentRunStatus,
  type AgentStreamChunk,
} from '../services/agentApi';
import {
  fetchRecentConversations,
  createConversation as createConversationApi,
  fetchConversationDetail,
  appendMessage as appendConversationMessage,
  deleteConversation as deleteConversationApi,
  truncateConversationMessages,
} from '../services/conversationApi';
import type {
  Workspace,
  File as WorkspaceFile,
  AgentPersona,
  ConversationSummary,
  ConversationMessage,
  ToolEvent,
  ToolOutputFile,
  ConversationMessageMetadata,
} from '../types';
import CollapsibleDrawer from '../components/CollapsibleDrawer';
import FileEditor from '../components/FileEditor';
import UIBlockRenderer, { type UIBlock } from '../components/UIBlockRenderer';
import ExpandableSidebar from '../components/ExpandableSidebar';
import AgentChatPane from '../components/chat/AgentChatPane';
import ToolOutputFilePreview from '../components/chat/ToolOutputFilePreview';
import { useAuth } from '../auth/AuthProvider';
import {
  CANVAS_ZOOM_STEP,
  MAX_CANVAS_ZOOM,
  MIN_CANVAS_ZOOM,
  PAPER2SLIDES_STAGE_ORDER,
  PAPER2SLIDES_STYLE_PRESETS,
  SLASH_COMMANDS,
} from '../constants/workspace';
import { getFileDisplayName, getFileTypeIcon, isSystemFile, normalizeFilePath } from '../utils/files';
import { buildMessageMetadata, mapMessagesToAgentHistory, mergeMessageMetadata, sanitizeRunPolicy } from '../utils/messages';

const drawerWidth = 280;

const buildTheme = (mode: PaletteMode) =>
  createTheme({
    palette: {
      mode,
      primary: {
        main: mode === 'light' ? '#2563eb' : '#60a5fa',
      },
      background: {
        default: mode === 'light' ? '#f8fafc' : '#0b1220',
        paper: mode === 'light' ? '#ffffff' : '#0f172a',
      },
      text: {
        primary: mode === 'light' ? '#0f172a' : '#e2e8f0',
        secondary: mode === 'light' ? '#475569' : '#cbd5e1',
      },
      divider: mode === 'light' ? '#e2e8f0' : '#1f2937',
    },
    shape: {
      borderRadius: 12,
    },
    components: {
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundColor: mode === 'light' ? '#f8fafc' : '#0f172a',
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
          },
        },
      },
    },
  });

const sanitizePresentationLabel = (value: string, fallback: string) => {
  const normalized = normalizeFilePath(value);
  const baseName = normalized.split('/').pop() || '';
  const trimmed = baseName.includes('.') ? baseName.slice(0, baseName.lastIndexOf('.')) : baseName;
  const cleaned = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+/, '');
  return cleaned || fallback;
};

const DEFAULT_PERSONA_NAME = 'fast';
const DEFAULT_PERSONAS: AgentPersona[] = [
  {
    name: 'fast',
    displayName: 'Fast',
    description: 'Gemini 3 Flash (Preview)',
  },
  {
    name: 'pro',
    displayName: 'Pro',
    description: 'Gemini 3 Pro (Preview)',
  },
];
const normalizePersonaName = (name: string): string => {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized || normalized === 'general-assistant') {
    return DEFAULT_PERSONA_NAME;
  }
  return normalized === 'pro' ? 'pro' : 'fast';
};
const STREAM_DEBUG_ENABLED =
  typeof import.meta !== 'undefined' &&
  typeof import.meta.env !== 'undefined' &&
  (import.meta.env.VITE_DEBUG_STREAM === '1' || import.meta.env.VITE_DEBUG_STREAM === 'true');

type Paper2SlidesStage = (typeof PAPER2SLIDES_STAGE_ORDER)[number];
type Paper2SlidesStylePreset = (typeof PAPER2SLIDES_STYLE_PRESETS)[number];
type SlashCommand = (typeof SLASH_COMMANDS)[number];

type PresentationOptionsState = {
  output: 'slides' | 'poster';
  content: 'paper' | 'general';
  stylePreset: Paper2SlidesStylePreset;
  customStyle: string;
  length: 'short' | 'medium' | 'long';
  mode: 'fast' | 'normal';
  parallel: number;
  fromStage?: Paper2SlidesStage;
  exportPptx: boolean;
};

type ActiveRunInfo = {
  runId: string;
  conversationId: string;
  workspaceId: string;
  persona: string;
  turnId: string;
  placeholderId: ConversationMessage['id'];
  lastStreamId?: string;
  status: AgentRunStatus;
};

const ACTIVE_RUNS_STORAGE_KEY = 'helpudoc-active-runs';
const BLOCK_LEVEL_TAGS = ['div', 'pre', 'table', 'ol', 'ul', 'li', 'blockquote', 'section', 'article'];
const MARKDOWN_FILE_EXTENSIONS = ['.md'];
const HTML_FILE_EXTENSIONS = ['.html', '.htm'];
const IMAGE_FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];

const generateTurnId = () => {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const mergePersistedAgentMessage = (
  persisted: ConversationMessage,
  existing?: ConversationMessage | null,
): ConversationMessage => {
  const hydrated = mergeMessageMetadata(persisted);
  const persistedMetadata = (hydrated.metadata as ConversationMessageMetadata | null | undefined) || {};
  const existingMetadata = (existing?.metadata as ConversationMessageMetadata | null | undefined) || {};
  const persistedStatus = persistedMetadata.status;
  const existingStatus = existingMetadata.status;
  const effectiveStatus =
    (persistedStatus === 'running' || persistedStatus === 'queued') && existingStatus === 'awaiting_approval'
      ? 'awaiting_approval'
      : persistedStatus ?? existingStatus;

  const mergedMetadata: ConversationMessageMetadata = {
    ...existingMetadata,
    ...persistedMetadata,
    status: effectiveStatus,
    runPolicy: persistedMetadata.runPolicy ?? existingMetadata.runPolicy,
    pendingInterrupt:
      persistedMetadata.pendingInterrupt !== undefined
        ? persistedMetadata.pendingInterrupt
        : effectiveStatus === 'awaiting_approval'
          ? existingMetadata.pendingInterrupt
          : undefined,
  };

  return {
    ...hydrated,
    thinkingText: hydrated.thinkingText ?? existing?.thinkingText,
    toolEvents: hydrated.toolEvents ?? existing?.toolEvents,
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

export default function WorkspacePage() {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const [colorMode, setColorMode] = useState<PaletteMode>(() => {
    if (typeof window === 'undefined') return 'light';
    const stored = window.localStorage.getItem('helpudoc-color-mode');
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFile | null>(null);
  const [selectedFileDetails, setSelectedFileDetails] = useState<WorkspaceFile | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [fileContent, setFileContent] = useState('');
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [conversationMessages, setConversationMessages] = useState<Record<string, ConversationMessage[]>>({});
  const [chatMessage, setChatMessage] = useState('');
  const [chatAttachments, setChatAttachments] = useState<File[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hoveredFileId, setHoveredFileId] = useState<string | null>(null);
  const personas = DEFAULT_PERSONAS;
  const [selectedPersona, setSelectedPersona] = useState(DEFAULT_PERSONA_NAME);
  const [isEditMode, setIsEditMode] = useState(false);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [isAgentPaneVisible, setIsAgentPaneVisible] = useState(true);
  const [isFilePaneVisible, setIsFilePaneVisible] = useState(true);
  const [showSystemFiles, setShowSystemFiles] = useState(false);
  const [conversationStreaming, setConversationStreaming] = useState<Record<string, boolean>>({});
  const [isAgentPaneFullScreen, setIsAgentPaneFullScreen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeConversationPersona, setActiveConversationPersona] = useState<string | null>(null);
  const [presentationOptions, setPresentationOptions] = useState<PresentationOptionsState>({
    output: 'slides',
    content: 'paper',
    stylePreset: 'academic',
    customStyle: '',
    length: 'medium',
    mode: 'fast',
    parallel: 2,
    exportPptx: false,
  });
  const [presentationStatus, setPresentationStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [isPresentationModalOpen, setIsPresentationModalOpen] = useState(false);
  const [draftPresentationOptions, setDraftPresentationOptions] = useState<PresentationOptionsState | null>(null);
  const [isPptxExporting, setIsPptxExporting] = useState(false);
  const streamAbortMapRef = useRef<Map<string, AbortController>>(new Map());
  const presentationJobPollsRef = useRef<Map<string, number>>(new Map());
  const pendingPresentationJobsRef = useRef<Map<string, Array<{ jobId: string; label: string }>>>(new Map());
  const conversationMessagesRef = useRef<Record<string, ConversationMessage[]>>({});
  const agentMessageBufferRef = useRef<Map<ConversationMessage['id'], string>>(new Map());
  const agentChunkBufferRef = useRef<Map<string, Map<number, string>>>(new Map());
  const agentChunkFlushTimerRef = useRef<number | null>(null);
  const lastUserMessageMapRef = useRef<Record<string, string>>({});
  const activeRunsRef = useRef<Record<string, ActiveRunInfo>>({});
  const lastPersistedAgentTextRef = useRef<Record<string, string>>({});
  const lastPersistedStatusRef = useRef<Record<string, AgentRunStatus | undefined>>({});
  const lastPersistedMetadataRef = useRef<Record<string, string | undefined>>({});
  const persistInFlightRef = useRef<Set<string>>(new Set());
  const stopRequestedRef = useRef(false);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const lastAutoSavedContentRef = useRef<string>('');
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
  const [copiedImageUrl, setCopiedImageUrl] = useState(false);
  const [copiedFileUrlId, setCopiedFileUrlId] = useState<string | null>(null);
  const [ragStatuses, setRagStatuses] = useState<Record<string, { status?: string; updatedAt?: string; error?: string }>>({});
  const [copiedWorkspaceContent, setCopiedWorkspaceContent] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<ConversationMessage['id'] | null>(null);
  const [interruptInputByMessageId, setInterruptInputByMessageId] = useState<Record<string, string>>({});
  const [interruptSelectedChoicesByMessageId, setInterruptSelectedChoicesByMessageId] = useState<Record<string, string[]>>({});
  const [interruptSubmittingByMessageId, setInterruptSubmittingByMessageId] = useState<Record<string, boolean>>({});
  const ragStatusFetchedRef = useRef<Record<string, boolean>>({});
  const resumeInFlightRef = useRef<Set<string>>(new Set());
  const resumeAttemptedRef = useRef<Set<string>>(new Set());
  const theme = useMemo(() => buildTheme(colorMode), [colorMode]);
  const messages = useMemo(
    () => (activeConversationId ? conversationMessages[activeConversationId] || [] : []),
    [activeConversationId, conversationMessages],
  );
  const isStreaming = useMemo(
    () => (activeConversationId ? conversationStreaming[activeConversationId] || false : false),
    [activeConversationId, conversationStreaming],
  );
  const systemFiles = useMemo(() => files.filter(isSystemFile), [files]);
  const visibleFiles = useMemo(
    () => (showSystemFiles ? files : files.filter((file) => !isSystemFile(file))),
    [files, showSystemFiles],
  );
  const visibleFileIds = useMemo(() => new Set(visibleFiles.map((file) => file.id)), [visibleFiles]);
  const allFilesSelected = useMemo(() => {
    if (!visibleFiles.length) {
      return false;
    }
    return visibleFiles.every((file) => selectedFiles.has(file.id));
  }, [visibleFiles, selectedFiles]);
  const hiddenFileCount = systemFiles.length;
  const showPaper2SlidesControls = Boolean(
    selectedFile || chatAttachments.length || chatMessage.trim().length || presentationStatus !== 'idle',
  );

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

  const registerActiveRun = useCallback((runInfo: ActiveRunInfo) => {
    const next = { ...activeRunsRef.current, [runInfo.runId]: runInfo };
    persistActiveRuns(next);
  }, [persistActiveRuns]);

  const removeActiveRun = useCallback((runId: string) => {
    if (!activeRunsRef.current[runId]) return;
    const next = { ...activeRunsRef.current };
    delete next[runId];
    persistActiveRuns(next);
    delete lastPersistedAgentTextRef.current[runId];
    delete lastPersistedStatusRef.current[runId];
    delete lastPersistedMetadataRef.current[runId];
    resumeInFlightRef.current.delete(runId);
    resumeAttemptedRef.current.delete(runId);
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

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', colorMode);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('helpudoc-color-mode', colorMode);
    }
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

  const commandSuggestions = useMemo(() => {
    if (!isCommandOpen) {
      return [] as SlashCommand[];
    }
    const normalized = commandQuery.trim().toLowerCase();
    return SLASH_COMMANDS.filter((command) => {
      if (!normalized) {
        return true;
      }
      const commandValue = command.command.slice(1).toLowerCase();
      return commandValue.startsWith(normalized) || command.command.toLowerCase().includes(normalized);
    });
  }, [commandQuery, isCommandOpen]);

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

  const presentationOptionSummary = useMemo(() => {
    const parts = [
      presentationOptions.output === 'slides' ? 'Slides' : 'Poster',
      presentationOptions.length.charAt(0).toUpperCase() + presentationOptions.length.slice(1),
      presentationOptions.mode === 'fast' ? 'Fast' : 'Normal',
      presentationOptions.stylePreset === 'custom'
        ? presentationOptions.customStyle.trim() || 'Custom'
        : presentationOptions.stylePreset.charAt(0).toUpperCase() + presentationOptions.stylePreset.slice(1),
      presentationOptions.content === 'paper' ? 'Paper' : 'General',
      presentationOptions.exportPptx ? 'PPTX' : '',
    ];
    return parts.filter(Boolean).join(' · ');
  }, [presentationOptions]);

  const resolvePresentationStyle = useCallback(() => {
    if (presentationOptions.stylePreset === 'custom') {
      return presentationOptions.customStyle.trim();
    }
    return presentationOptions.stylePreset;
  }, [presentationOptions]);

  const handleDraftPresentationOptionChange = useCallback(
    <K extends keyof PresentationOptionsState>(key: K, value: PresentationOptionsState[K]) => {
      setDraftPresentationOptions((prev) => {
        const base = prev || presentationOptions;
        return { ...base, [key]: value };
      });
    },
    [presentationOptions],
  );

  const handleOpenPresentationModal = useCallback(() => {
    setDraftPresentationOptions(presentationOptions);
    setIsPresentationModalOpen(true);
  }, [presentationOptions]);

  const handleClosePresentationModal = useCallback(() => {
    setIsPresentationModalOpen(false);
    setDraftPresentationOptions(null);
  }, []);

  const handleSavePresentationOptions = useCallback(() => {
    if (draftPresentationOptions) {
      setPresentationOptions(draftPresentationOptions);
    }
    setIsPresentationModalOpen(false);
  }, [draftPresentationOptions]);

  const startPresentationProgress = useCallback(() => {
    setPresentationStatus('running');
  }, []);

  const stopPresentationProgress = useCallback(
    (status: 'success' | 'error' = 'success') => {
      setPresentationStatus(status);
      window.setTimeout(() => {
        setPresentationStatus('idle');
      }, 1500);
    },
    [],
  );

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

  const classifyCodeBlockLabel = useCallback((languageMatch: RegExpExecArray | null, content: string) => {
    if (languageMatch?.[1]) {
      return languageMatch[1].toUpperCase();
    }
    const trimmed = content.trim();
    const isSingleLine = !trimmed.includes('\n');
    if (isSingleLine && /^[\w-]+\.[\w.-]+$/.test(trimmed)) {
      return 'FILE';
    }
    if (isSingleLine && /^[a-z0-9_-]+$/i.test(trimmed)) {
      return 'TOOL';
    }
    return 'CODE';
  }, []);

  const extractCodeText = useCallback((value: ReactNode): string => {
    if (value === null || value === undefined) {
      return '';
    }
    if (Array.isArray(value)) {
      return value.map((child) => extractCodeText(child)).join('');
    }
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
    return '';
  }, []);

  const inferInlineCode = useCallback(
    (inline: boolean | undefined, className: string | undefined, content: string, node?: any) => {
      if (typeof inline === 'boolean') {
        return inline;
      }
      const startLine = node?.position?.start?.line;
      const endLine = node?.position?.end?.line;
      if (typeof startLine === 'number' && typeof endLine === 'number' && endLine > startLine) {
        return false;
      }
      if (className && /language-\w+/i.test(className)) {
        return false;
      }
      if (content.includes('\n')) {
        return false;
      }
      return true;
    },
    []
  );

  const markdownComponents = useMemo(
    () => ({
      p({ children }: { children?: ReactNode }) {
        const childArray = Children.toArray(children);
        const containsBlockChild = childArray.some(
          (child) => {
            if (!isValidElement(child)) {
              return false;
            }
            const childProps = child.props as {
              inline?: boolean;
              node?: { tagName?: string };
              className?: string;
              children?: ReactNode;
            };
            if (typeof child.type === 'string') {
              return BLOCK_LEVEL_TAGS.includes(child.type);
            }
            if (childProps.inline === false) {
              return true;
            }
            if (childProps.node?.tagName && BLOCK_LEVEL_TAGS.includes(childProps.node.tagName)) {
              return true;
            }
            if (childProps.node?.tagName === 'code') {
              const content = extractCodeText(childProps.children);
              const isInline = inferInlineCode(
                childProps.inline,
                childProps.className,
                content,
                childProps.node
              );
              return !isInline;
            }
            return false;
          }
        );
        const Element: 'p' | 'div' = containsBlockChild ? 'div' : 'p';
        return <Element className="mb-4 leading-relaxed text-slate-700">{children}</Element>;
      },
      a({ ...props }: any) {
        return (
          <a
            {...props}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-blue-600 underline decoration-2 underline-offset-2 hover:text-blue-500"
          />
        );
      },
      img({ src, alt }: { src?: string; alt?: string }) {
        const resolvedSrc = typeof src === 'string' ? src.trim() : '';
        if (!resolvedSrc) {
          return null;
        }
        if (/^(https?:|data:|blob:)/i.test(resolvedSrc)) {
          return (
            <img
              src={resolvedSrc}
              alt={alt || 'Image'}
              className="my-3 max-w-full rounded border border-gray-200"
            />
          );
        }
        if (!selectedWorkspace?.id) {
          return (
            <span className="text-xs text-slate-500">
              Image path: <code>{resolvedSrc}</code>
            </span>
          );
        }
        return (
          <div className="my-3">
            <ToolOutputFilePreview
              workspaceId={selectedWorkspace.id}
              file={{ path: resolvedSrc, mimeType: 'image/*' }}
            />
          </div>
        );
      },
      code({ inline, className, children, node, ...props }: any) {
        const rawCodeContent = extractCodeText(children);
        const isInline = inferInlineCode(inline, className, rawCodeContent, node);
        if (isInline) {
          return (
            <code
              className={`rounded-md bg-slate-200 px-1.5 py-0.5 font-mono text-xs text-slate-800 ${className || ''}`}
              {...props}
            >
              {children}
            </code>
          );
        }

        const languageMatch = /language-(\w+)/.exec(className || '');
        const codeContent = rawCodeContent.replace(/\n$/, '');
        const languageLabel = classifyCodeBlockLabel(languageMatch, codeContent);
        const blockId = `${languageLabel}-${codeContent.length}-${codeContent.charCodeAt(0) || 0}`;
        const copyLabel = copiedCodeBlockId === blockId ? 'Copied' : 'Copy';

        return (
          <div className="mb-4 mt-2 overflow-hidden rounded-2xl border border-slate-200 bg-slate-950/90 text-slate-100 shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/60 px-4 py-2 text-[11px] font-semibold tracking-wide uppercase text-slate-300">
              <span>{languageLabel}</span>
              <button
                type="button"
                onClick={() => handleCopyCodeBlock(blockId, codeContent)}
                className="flex items-center gap-1 rounded-full border border-slate-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-slate-200 hover:border-slate-400"
              >
                {copyLabel}
              </button>
            </div>
            <pre className="overflow-x-auto px-4 py-3 text-xs leading-relaxed whitespace-pre-wrap break-words sm:text-sm">
              <code {...props} className={`font-mono ${className || ''}`}>
                {children}
              </code>
            </pre>
          </div>
        );
      },
    }),
    [classifyCodeBlockLabel, copiedCodeBlockId, extractCodeText, handleCopyCodeBlock, inferInlineCode, selectedWorkspace?.id]
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

  const agentPaneWidth = isAgentPaneFullScreen
    ? '100%'
    : isAgentPaneVisible
      ? '24rem'
      : '3rem';

  const filePaneWidth = isFilePaneVisible ? 360 : 56;

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

  useEffect(() => {
    return () => {
      presentationJobPollsRef.current.forEach((timerId) => window.clearInterval(timerId));
      presentationJobPollsRef.current.clear();
    };
  }, []);

  const agentPaneStyles: CSSProperties = {
    flexBasis: agentPaneWidth,
    width: agentPaneWidth,
    flexGrow: isAgentPaneFullScreen ? 1 : 0,
    flexShrink: isAgentPaneFullScreen ? 1 : 0,
    transition: 'flex-basis 0.35s ease, flex-grow 0.35s ease, width 0.35s ease',
  };
  const messageBubbleMaxWidth = isAgentPaneFullScreen ? '100%' : '720px';

  const activeFile = selectedFileDetails || selectedFile;
  const activeFileName = activeFile?.name ?? '';
  const normalizedFileName = activeFileName.toLowerCase();
  const isMarkdownFile = !!activeFile && MARKDOWN_FILE_EXTENSIONS.some((ext) => normalizedFileName.endsWith(ext));
  const isHtmlFile = !!activeFile && HTML_FILE_EXTENSIONS.some((ext) => normalizedFileName.endsWith(ext));
  const isImageFile = !!activeFile && IMAGE_FILE_EXTENSIONS.some((ext) => normalizedFileName.endsWith(ext));
  const isPdfFile = !!activeFile && (normalizedFileName.endsWith('.pdf') || activeFile?.mimeType === 'application/pdf');
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
  const canvasTitle = selectedFile ? selectedFile.name : 'Editor';
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

  const addPendingPresentationPlaceholder = useCallback(
    (jobId: string, workspaceId: string, label: string) => {
      const existing = pendingPresentationJobsRef.current.get(workspaceId) || [];
      if (!existing.some((entry) => entry.jobId === jobId)) {
        pendingPresentationJobsRef.current.set(workspaceId, [...existing, { jobId, label }]);
      }
      const placeholder: WorkspaceFile = {
        id: `paperjob-${jobId}`,
        name: `presentations/${label}/ (pending)`,
        workspaceId,
        path: `presentations/${label}/`,
        mimeType: 'application/vnd.helpudoc.paper2slides-job',
        publicUrl: null,
        content: undefined,
      };
      setFiles((prev) => [...prev, placeholder]);
    },
    [],
  );

  const removePendingPresentationPlaceholder = useCallback((jobId: string) => {
    setFiles((prev) => prev.filter((file) => file.id !== `paperjob-${jobId}`));
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      next.delete(`paperjob-${jobId}`);
      return next;
    });
    pendingPresentationJobsRef.current.forEach((entries, workspaceId) => {
      const filtered = entries.filter((entry) => entry.jobId !== jobId);
      if (filtered.length) {
        pendingPresentationJobsRef.current.set(workspaceId, filtered);
      } else {
        pendingPresentationJobsRef.current.delete(workspaceId);
      }
    });
  }, []);

  const handleCopyFilePublicUrl = useCallback(async (file: WorkspaceFile) => {
    if (!file.publicUrl || !navigator?.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(file.publicUrl);
      setCopiedFileUrlId(file.id);
      window.setTimeout(() => setCopiedFileUrlId((current) => (current === file.id ? null : current)), 1500);
    } catch (error) {
      console.error('Failed to copy file public URL', error);
    }
  }, []);

  const handleRenameFile = async (file: WorkspaceFile) => {
    if (!selectedWorkspace) return;
    const proposedName = window.prompt('Rename file', file.name)?.trim();
    if (!proposedName || proposedName === file.name) {
      return;
    }

    try {
      const updated = await renameFile(selectedWorkspace.id, file.id, proposedName);
      setFiles((prev) =>
        prev.map((item) => (item.id === file.id ? { ...item, name: updated.name } : item))
      );
      if (selectedFile?.id === file.id) {
        setSelectedFile((prev) => (prev ? { ...prev, name: updated.name } : prev));
      }
    } catch (error) {
      console.error('Failed to rename file:', error);
    }
  };

  const handleDeleteSingleFile = async (file: WorkspaceFile) => {
    if (!selectedWorkspace) return;
    const confirmed = window.confirm(`Delete ${file.name}?`);
    if (!confirmed) return;

    try {
      await deleteFile(selectedWorkspace.id, file.id);
      setFiles((prev) => prev.filter((item) => item.id !== file.id));
      setSelectedFiles((prev) => {
        const next = new Set(prev);
        next.delete(file.id);
        return next;
      });
      if (selectedFile?.id === file.id) {
        setSelectedFile(null);
        setSelectedFileDetails(null);
        setFileContent('');
      }
    } catch (error) {
      console.error('Failed to delete file:', error);
    }
  };

  const filePaneStyles: CSSProperties = {
    width: filePaneWidth,
    minWidth: filePaneWidth,
    transition: 'width 0.35s ease',
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

  const handleStopStreaming = () => {
    stopRequestedRef.current = true;
    const activeRun = getActiveRunForConversation(activeConversationId);
    if (activeRun) {
      cancelRun(activeRun.runId).catch((error) => {
        console.error('Failed to cancel run', error);
      });
    }
    cancelStreamForConversation(activeConversationId);
  };

  const loadFilesForWorkspace = useCallback(async (workspaceId: string | null) => {
    if (!workspaceId) return;
    try {
      const files = await getFiles(workspaceId);
      const pending = pendingPresentationJobsRef.current.get(workspaceId) || [];
      if (pending.length) {
        const placeholders: WorkspaceFile[] = pending.map((entry) => ({
          id: `paperjob-${entry.jobId}`,
          name: `presentations/${entry.label}/ (pending)`,
          workspaceId,
          path: `presentations/${entry.label}/`,
          mimeType: 'application/vnd.helpudoc.paper2slides-job',
          publicUrl: null,
          content: undefined,
        }));
        setFiles([...files, ...placeholders]);
      } else {
        setFiles(files);
      }
    } catch (error) {
      console.error('Failed to load files for workspace', error);
    }
  }, []);

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

  const isFileEditable = (fileName: string): boolean => {
    const editableExtensions = [
      '.md', '.mermaid', '.txt', '.json', '.html', '.css', '.js', '.ts', '.tsx', '.jsx',
      '.py', '.java', '.c', '.cpp', '.go', '.rs', '.php', '.rb', '.sh', '.yaml', '.yml', '.xml', '.sql', '.csv'
    ];
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    return editableExtensions.includes(ext);
  };

  const shouldForceEditMode = (fileName: string): boolean => {
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
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

  const handleSignOut = useCallback(() => {
    setDrawerOpen(false);
    signOut();
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
      if (!selectedWorkspace || cursor === null || cursor === undefined) {
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
      const commandMatch = textBeforeCursor.match(/(^|[\s([{])\/([^\s/]*)$/);
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
    [closeCommand, closeMention],
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
    (command: SlashCommand) => {
      if (commandTriggerIndex === null || commandCursorPosition === null) {
        closeCommand();
        return;
      }
      const before = chatMessage.slice(0, commandTriggerIndex);
      const after = chatMessage.slice(commandCursorPosition);
      const needsSpace = after.length === 0 || after.startsWith(' ') ? '' : ' ';
      const nextValue = `${before}${command.command}${needsSpace}${after}`;
      setChatMessage(nextValue);
      closeCommand();
      requestAnimationFrame(() => {
        if (chatInputRef.current) {
          const cursorPosition = before.length + command.command.length + (needsSpace ? 1 : 0);
          chatInputRef.current.focus();
          chatInputRef.current.setSelectionRange(cursorPosition, cursorPosition);
        }
      });
    },
    [chatMessage, closeCommand, commandCursorPosition, commandTriggerIndex],
  );

  const findMentionedFiles = useCallback(
    (value: string): WorkspaceFile[] => {
      if (!value) {
        return [];
      }
      return visibleFiles.filter((file) => value.includes(`@${file.name}`));
    },
    [visibleFiles],
  );

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
      const hydratedMessages = detail.messages.map(mergeMessageMetadata);
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

  const handleExportPptxFromPdf = useCallback(async () => {
    if (!selectedWorkspace || !activeFile) {
      addLocalSystemMessage('Select a PDF file to export.');
      return;
    }
    if (!isPdfFile) {
      addLocalSystemMessage('Select a PDF file to export.');
      return;
    }
    const fileId = toNumericFileId(activeFile.id);
    if (!fileId) {
      addLocalSystemMessage('Unable to export this file.');
      return;
    }
    if (isPptxExporting) {
      return;
    }
    setIsPptxExporting(true);
    addLocalSystemMessage('Exporting PPTX from PDF...');
    try {
      const response = await exportPaper2SlidesPptx({
        workspaceId: selectedWorkspace.id,
        fileId,
      });
      await loadFilesForWorkspace(selectedWorkspace.id);
      addLocalSystemMessage(`PPTX export complete: ${response.pptxPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to export PPTX.';
      addLocalSystemMessage(message);
    } finally {
      setIsPptxExporting(false);
    }
  }, [
    activeFile,
    addLocalSystemMessage,
    isPdfFile,
    isPptxExporting,
    loadFilesForWorkspace,
    selectedWorkspace,
    toNumericFileId,
  ]);

  const ensureConversation = useCallback(async () => {
    if (activeConversationId) {
      return activeConversationId;
    }
    if (!selectedWorkspace || !selectedPersona) {
      return null;
    }
    try {
      const conversation = await createConversationApi(selectedWorkspace.id, selectedPersona);
      setActiveConversationId(conversation.id);
      setActiveConversationPersona(normalizePersonaName(conversation.persona));
      setSelectedPersona(normalizePersonaName(conversation.persona));
      setConversationMessages((prev) => ({ ...prev, [conversation.id]: [] }));
      setStreamingForConversation(conversation.id, false);
      await refreshConversationHistory(selectedWorkspace.id);
      return conversation.id;
    } catch (error) {
      console.error('Failed to create conversation', error);
      return null;
    }
  }, [activeConversationId, selectedWorkspace, selectedPersona, refreshConversationHistory, setStreamingForConversation]);

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
      const workspaces = await getWorkspaces();
      const workspacesWithMockData = workspaces.map((ws: Omit<Workspace, 'lastUsed'>) => ({
        ...ws,
        lastUsed: 'Yesterday',
      }));
      setWorkspaces(workspacesWithMockData);
    };
    fetchWorkspaces();
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

  const fetchFileContent = async () => {
    if (selectedFile && selectedWorkspace) {
      try {
        const fileWithContent = await getFileContent(selectedWorkspace.id, selectedFile.id);
        setSelectedFileDetails(fileWithContent);
        const content = fileWithContent.content || '';
        setFileContent(content);
        lastAutoSavedContentRef.current = content;
      } catch (error) {
        console.error('Failed to fetch file content:', error);
        setFileContent('Failed to load file content.');
        setSelectedFileDetails(null);
      }
    } else {
      setFileContent('');
      setSelectedFileDetails(null);
      lastAutoSavedContentRef.current = '';
    }
  };

  useEffect(() => {
    fetchFileContent();
  }, [selectedFile, selectedWorkspace]);

  const handleCreateWorkspace = async () => {
    if (newWorkspaceName.trim()) {
      const newWorkspaceData = await createWorkspace(newWorkspaceName);
      const newWorkspace: Workspace = {
        ...newWorkspaceData,
        lastUsed: 'Just now',
      };
      setWorkspaces([...workspaces, newWorkspace]);
      setNewWorkspaceName('');
    }
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

  const updateToolEvents = (
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
  };

  const updateMessageMetadataAtIndex = (
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
  };

  const createToolEvent = (name: string, status: ToolEvent['status'] = 'running'): ToolEvent => ({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    status,
    startedAt: new Date().toISOString(),
  });

  const appendAgentThought = (conversationId: string, index: number, chunk: string) => {
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
  };

  const truncateToolOutput = (text: string, maxLength = 200) => {
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength)}…`;
  };

  const appendToolStart = (conversationId: string, index: number, chunk: AgentStreamChunk & { type: 'tool_start' }) => {
    const label = chunk.name || chunk.content || 'tool';
    updateToolEvents(conversationId, index, (events) => [...events, createToolEvent(label)]);
  };

  const appendToolEnd = (
    conversationId: string,
    index: number,
    chunk: (AgentStreamChunk & { type: 'tool_end' | 'tool_error' }),
    status: ToolEvent['status'] = 'completed',
  ) => {
    const label = chunk.name || 'tool';
    const summary = chunk.content ? truncateToolOutput(chunk.content) : '';
    const outputFiles = 'outputFiles' in chunk ? chunk.outputFiles : undefined;
    updateToolEvents(conversationId, index, (events) => {
      if (!events.length) {
        return [
          {
            ...createToolEvent(label, status),
            finishedAt: new Date().toISOString(),
            summary,
            outputFiles,
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
        });
        return next;
      }
      const targetIndex = next.length - 1 - lastRunningOffset;
      next[targetIndex] = {
        ...next[targetIndex],
        status,
        finishedAt: new Date().toISOString(),
        summary: summary || next[targetIndex].summary,
        outputFiles: outputFiles || next[targetIndex].outputFiles,
      };
      return next;
    });
  };

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
          let nextChunk = chunkText;
          const userPrompt = (lastUserMessageMapRef.current[conversationId] || '').trim();
          if (!target.text && userPrompt) {
            const chunkNoLeading = nextChunk.replace(/^\s+/, '');
            if (chunkNoLeading.startsWith(userPrompt)) {
              const remainder = chunkNoLeading.slice(userPrompt.length).replace(/^\s+/, '');
              if (!remainder) {
                return;
              }
              nextChunk = remainder;
            }
          }
          const combinedText = `${target.text || ''}${nextChunk}`;
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
  }, [updateMessagesForConversation]);

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

  const getBufferedAgentText = useCallback(
    (runInfo: ActiveRunInfo) => {
      const { placeholderId, conversationId, turnId } = runInfo;
      const buffered = agentMessageBufferRef.current.get(placeholderId);
      if (buffered !== undefined) {
        return buffered;
      }
      const message = findAgentMessageForRun(conversationId, placeholderId, turnId);
      return message?.text || '';
    },
    [findAgentMessageForRun],
  );

  const persistAgentProgress = useCallback(
    async (runInfo: ActiveRunInfo, statusOverride?: AgentRunStatus) => {
      const { runId, conversationId, turnId, placeholderId } = runInfo;
      if (persistInFlightRef.current.has(runId)) {
        return;
      }
      const message = findAgentMessageForRun(conversationId, placeholderId, turnId);
      const text = getBufferedAgentText(runInfo);
      const lastText = lastPersistedAgentTextRef.current[runId];
      const nextStatus = statusOverride || message?.metadata?.status || runInfo.status || 'running';
      const lastStatus = lastPersistedStatusRef.current[runId];
      const metadata = { ...(buildMessageMetadata(message) || {}), runId, status: nextStatus };
      const metadataSignature = JSON.stringify(metadata);
      const lastMetadataSignature = lastPersistedMetadataRef.current[runId];
      if (text === lastText && nextStatus === lastStatus && metadataSignature === lastMetadataSignature) {
        return;
      }
      if (!text && !message?.thinkingText && !message?.toolEvents?.length && !message?.metadata?.pendingInterrupt) {
        return;
      }
      persistInFlightRef.current.add(runId);
      try {
        const persisted = await appendConversationMessage(conversationId, 'agent', text, {
          turnId,
          replaceExisting: true,
          metadata,
        });
        updateMessagesForConversation(conversationId, (prev) => {
          const updated = [...prev];
          const existingIndex = updated.findIndex(
            (m) => m.id === persisted.id || (m.sender === 'agent' && m.turnId === persisted.turnId)
          );
          const existing = existingIndex !== -1 ? updated[existingIndex] : undefined;
          const merged = mergePersistedAgentMessage(persisted, existing);
          if (existingIndex !== -1) {
            updated[existingIndex] = merged;
          } else {
            updated.push(merged);
          }
          return updated;
        });
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
      }
    },
    [getBufferedAgentText, findAgentMessageForRun, updateMessagesForConversation],
  );

  const bufferAgentChunk = (conversationId: string, index: number, chunk: string) => {
    if (!conversationId || !chunk || index < 0) {
      return;
    }
    const conversationBuffer = agentChunkBufferRef.current.get(conversationId) ?? new Map();
    conversationBuffer.set(index, `${conversationBuffer.get(index) || ''}${chunk}`);
    agentChunkBufferRef.current.set(conversationId, conversationBuffer);
  };

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
        void persistAgentProgress(run);
      });
    }, 450);
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
  ): 'approval' | 'clarification' => (
    pendingInterrupt?.kind === 'clarification' ? 'clarification' : 'approval'
  ), []);

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
  }, [getInterruptKind, getPrimaryInterruptAction]);

  const interruptFieldKey = useCallback((
    messageKey: string,
    field: 'feedback' | 'edit-json' | 'reject-note' | 'clarification-text',
  ): string => `${messageKey}:${field}`, []);

  const getAllowedDecisions = useCallback((
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ): Array<'approve' | 'edit' | 'reject'> => {
    const defaults: Array<'approve' | 'edit' | 'reject'> = ['approve', 'edit', 'reject'];
    const actionRequests = Array.isArray(pendingInterrupt?.actionRequests) ? pendingInterrupt.actionRequests : [];
    const reviewConfigs = Array.isArray(pendingInterrupt?.reviewConfigs) ? pendingInterrupt.reviewConfigs : [];
    if (!actionRequests.length || !reviewConfigs.length) {
      return defaults;
    }
    const firstActionName = typeof actionRequests[0]?.name === 'string' ? actionRequests[0]?.name : undefined;
    if (!firstActionName) {
      return defaults;
    }
    const matchingConfig = reviewConfigs.find((config) => config?.action_name === firstActionName);
    const allowedRaw = Array.isArray(matchingConfig?.allowed_decisions) ? matchingConfig?.allowed_decisions : [];
    const allowed = allowedRaw.filter(
      (value): value is 'approve' | 'edit' | 'reject' => value === 'approve' || value === 'edit' || value === 'reject',
    );
    return allowed.length ? allowed : defaults;
  }, []);

  const handleStreamChunk = (
    conversationId: string,
    agentMessageIndex: number,
    chunk: AgentStreamChunk,
    runId?: string,
  ) => {
    if (chunk.type === 'keepalive') {
      setStreamingForConversation(conversationId, true);
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
        ...metadata,
        ...(runId ? { runId } : {}),
        runPolicy: nextRunPolicy,
      }));
      return;
    }

    if (chunk.type === 'thought') {
      appendAgentThought(conversationId, agentMessageIndex, chunk.content || '');
      return;
    }

    if (chunk.type === 'tool_start') {
      updateMessageMetadataAtIndex(conversationId, agentMessageIndex, (metadata) => ({
        ...metadata,
        ...(runId ? { runId } : {}),
        pendingInterrupt: undefined,
      }));
      appendToolStart(conversationId, agentMessageIndex, chunk);
      return;
    }

    if (chunk.type === 'tool_end') {
      appendToolEnd(conversationId, agentMessageIndex, chunk);
      return;
    }

    if (chunk.type === 'tool_error') {
      appendToolEnd(conversationId, agentMessageIndex, chunk, 'error');
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
          actionRequests: chunk.actionRequests,
          reviewConfigs: chunk.reviewConfigs,
          responseSpec: chunk.responseSpec,
          displayPayload: chunk.displayPayload,
        },
      }));
      return;
    }

    if (chunk.type === 'token' || chunk.type === 'chunk') {
      updateMessageMetadataAtIndex(conversationId, agentMessageIndex, (metadata) => ({
        ...metadata,
        ...(runId ? { runId } : {}),
        pendingInterrupt: undefined,
      }));
      if (chunk.role && chunk.role !== 'assistant') {
        return;
      }
      appendAgentChunk(conversationId, agentMessageIndex, chunk.content || '');
      return;
    }

    if (chunk.type === 'contract_error') {
      appendAgentChunk(conversationId, agentMessageIndex, `\\n${chunk.message || 'Artifact contract failed.'}`);
      if (Array.isArray(chunk.missing) && chunk.missing.length) {
        appendAgentChunk(conversationId, agentMessageIndex, `\\nMissing: ${chunk.missing.join(', ')}`);
      }
      return;
    }

    if (chunk.type === 'error') {
      appendAgentChunk(conversationId, agentMessageIndex, `\n${chunk.message || 'Agent stream failed.'}`);
    }
  };

  const streamRunForConversation = useCallback(
    async (runInfo: ActiveRunInfo, replayFromStart = false) => {
      const { conversationId, runId, turnId, placeholderId } = runInfo;
      // Mark the run as actively handled before any state updates land so the
      // resume effect does not start a second stream for the same run.
      resumeAttemptedRef.current.add(runId);
      resumeInFlightRef.current.add(runId);
      cancelStreamForConversation(conversationId);
      const agentMessageIndex = ensureAgentPlaceholder(conversationId, placeholderId, turnId, replayFromStart);
      if (agentMessageIndex < 0) {
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
      let finalStatus: AgentRunStatus = 'completed';
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
            if (chunk.type === 'interrupt') {
              latestInterrupt = {
                kind: chunk.kind,
                interruptId: chunk.interruptId,
                title: chunk.title,
                description: chunk.description,
                stepIndex: chunk.stepIndex,
                stepCount: chunk.stepCount,
                actionRequests: chunk.actionRequests,
                reviewConfigs: chunk.reviewConfigs,
                responseSpec: chunk.responseSpec,
                displayPayload: chunk.displayPayload,
              };
            }
            handleStreamChunk(conversationId, agentMessageIndex, chunk, runId);
          },
          controller.signal,
          replayFromStart ? undefined : undefined
        );
      } catch (error) {
        if ((error as DOMException)?.name === 'AbortError') {
          const stopLabel = stopRequestedRef.current ? '\n[Stopped by user]' : '\n[Stream cancelled]';
          appendAgentChunk(conversationId, agentMessageIndex, stopLabel);
          finalStatus = 'cancelled';
        } else {
          console.error('Failed to stream agent run', error);
          appendAgentChunk(conversationId, agentMessageIndex, '\nSorry, something went wrong.');
          finalStatus = 'failed';
        }
      } finally {
        let latestRunMeta:
          | Awaited<ReturnType<typeof getRunStatus>>
          | null = null;
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
        } catch (statusError) {
          console.error('Failed to fetch final run status', statusError);
        }
        const effectivePendingInterrupt = latestRunMeta?.pendingInterrupt ?? latestInterrupt;
        if (effectivePendingInterrupt) {
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
        await persistAgentProgress({ ...runInfo, status: finalStatus }, finalStatus);
        setStreamingForConversation(conversationId, false);
        streamAbortMapRef.current.delete(conversationId);
        stopRequestedRef.current = false;
        resumeInFlightRef.current.delete(runId);
        if (finalStatus === 'awaiting_approval') {
          registerActiveRun({ ...runInfo, status: finalStatus });
        } else {
          removeActiveRun(runId);
          const workspaceId = selectedWorkspace?.id;
          if (workspaceId) {
            loadFilesForWorkspace(workspaceId);
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
      getBufferedAgentText,
      getRunStatus,
      addLocalSystemMessage,
      removeActiveRun,
      selectedWorkspace?.id,
      loadFilesForWorkspace,
    ],
  );

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
      const feedbackKey = isPlanApproval
        ? interruptFieldKey(messageKey, 'feedback')
        : interruptFieldKey(messageKey, 'reject-note');
      const rawFeedback = (interruptInputByMessageId[feedbackKey] || '').trim();
      setInterruptSubmittingByMessageId((prev) => ({ ...prev, [messageKey]: true }));
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
        await submitRunDecision(runId, decision, options);
        updateMessagesForConversation(message.conversationId, (prev) => {
          const next = [...prev];
          const idx = next.findIndex((item) => item.id === message.id);
          if (idx === -1) return next;
          const current = next[idx];
          const metadata = { ...((current.metadata as ConversationMessageMetadata | undefined) || {}) };
          metadata.pendingInterrupt = undefined;
          next[idx] = { ...current, metadata };
          return next;
        });
        const runInfo = activeRunsRef.current[runId];
        if (runInfo) {
          await streamRunForConversation(runInfo, false);
        } else {
          addLocalSystemMessage('Approval saved. Refreshing stream state...');
        }
      } catch (error) {
        console.error('Failed to submit approval decision', error);
        addLocalSystemMessage(error instanceof Error ? error.message : 'Failed to submit approval decision.');
      } finally {
        setInterruptSubmittingByMessageId((prev) => ({ ...prev, [messageKey]: false }));
      }
    },
    [
      addLocalSystemMessage,
      interruptInputByMessageId,
      interruptFieldKey,
      findRunIdForMessage,
      getPrimaryInterruptAction,
      getAllowedDecisions,
      isPlanApprovalInterrupt,
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
      const selectedChoiceIds = interruptSelectedChoicesByMessageId[messageKey] || [];
      const choices = pendingInterrupt?.responseSpec?.choices || [];
      const selectedValues = selectedChoiceIds
        .map((choiceId) => choices.find((choice) => choice.id === choiceId)?.value)
        .filter((value): value is string => typeof value === 'string');

      if (!rawMessage && !selectedChoiceIds.length && !selectedValues.length) {
        addLocalSystemMessage('Choose an option or enter a clarification response before continuing.');
        return;
      }

      setInterruptSubmittingByMessageId((prev) => ({ ...prev, [messageKey]: true }));
      try {
        await submitRunResponse(runId, {
          message: rawMessage || undefined,
          selectedChoiceIds: selectedChoiceIds.length ? selectedChoiceIds : undefined,
          selectedValues: selectedValues.length ? selectedValues : undefined,
        });
        updateMessagesForConversation(message.conversationId, (prev) => {
          const next = [...prev];
          const idx = next.findIndex((item) => item.id === message.id);
          if (idx === -1) return next;
          const current = next[idx];
          const metadata = { ...((current.metadata as ConversationMessageMetadata | undefined) || {}) };
          metadata.pendingInterrupt = undefined;
          next[idx] = { ...current, metadata };
          return next;
        });
        setInterruptInputByMessageId((prev) => {
          const next = { ...prev };
          delete next[textKey];
          return next;
        });
        setInterruptSelectedChoicesByMessageId((prev) => {
          const next = { ...prev };
          delete next[messageKey];
          return next;
        });
        const runInfo = activeRunsRef.current[runId];
        if (runInfo) {
          await streamRunForConversation(runInfo, false);
        } else {
          addLocalSystemMessage('Response saved. Refreshing stream state...');
        }
      } catch (error) {
        console.error('Failed to submit clarification response', error);
        addLocalSystemMessage(error instanceof Error ? error.message : 'Failed to submit clarification response.');
      } finally {
        setInterruptSubmittingByMessageId((prev) => ({ ...prev, [messageKey]: false }));
      }
    },
    [
      addLocalSystemMessage,
      findRunIdForMessage,
      getInterruptKind,
      interruptFieldKey,
      interruptInputByMessageId,
      interruptSelectedChoicesByMessageId,
      streamRunForConversation,
      updateMessagesForConversation,
    ],
  );

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
          if (status.status === 'running' || status.status === 'queued') {
            if (STREAM_DEBUG_ENABLED) {
              console.debug('[WorkspacePage] resume stream', { runId: activeRun.runId });
            }
            streamRunForConversation(activeRun, true)
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
            if (targetMessage?.metadata?.runId || status.pendingInterrupt) {
              updateMessagesForConversation(activeRun.conversationId, (prev) => {
                const updated = [...prev];
                const idx = updated.findIndex((message) => message.id === targetMessage?.id);
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
            resumeInFlightRef.current.delete(activeRun.runId);
          } else {
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
            }
            removeActiveRun(activeRun.runId);
          }
        })
        .catch((error) => {
          console.error('Failed to resume run status', error);
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
          }
          removeActiveRun(activeRun.runId);
        });
    }
  }, [
    activeConversationId,
    conversationStreaming,
    findAgentMessageForRun,
    getActiveRunForConversation,
    removeActiveRun,
    streamRunForConversation,
    updateMessagesForConversation,
  ]);

  const appendAgentChunk = (conversationId: string, index: number, chunk: string) => {
    bufferAgentChunk(conversationId, index, chunk);
  };

  const handleRerunMessage = async (messageId: ConversationMessage['id']) => {
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
    const trimmed = targetMessage.text?.trim();
    if (!trimmed) {
      addLocalSystemMessage('Cannot rerun an empty message.');
      return;
    }
    const isPresentationCommand = /^\/presentation\b/i.test(trimmed);
    const mentionedFiles = isPresentationCommand ? findMentionedFiles(trimmed) : [];
    const presentationFileIds = isPresentationCommand
      ? Array.from(
        new Set(
          mentionedFiles
            .map((file) => toNumericFileId(file.id))
            .filter((id): id is number => typeof id === 'number' && Number.isFinite(id)),
        ),
      )
      : [];
    const presentationBrief = isPresentationCommand ? trimmed.replace(/^\/presentation\b/i, '').trim() : '';
    if (isPresentationCommand && !presentationFileIds.length) {
      addLocalSystemMessage('Tag at least one file using @filename before rerunning /presentation.');
      return;
    }

    const confirmed = window.confirm(
      'Redo from this message? This will remove all messages below it.'
    );
    if (!confirmed) {
      return;
    }

    const targetMessageId = Number(targetMessage.id);
    if (!Number.isFinite(targetMessageId)) {
      addLocalSystemMessage('This message is not saved yet, so it cannot be redone.');
      return;
    }

    stopRequestedRef.current = false;
    const targetTurnId = targetMessage.turnId || generateTurnId();

    cancelStreamForConversation(conversationId);

    try {
      await truncateConversationMessages(conversationId, targetMessageId);
    } catch (error) {
      console.error('Failed to truncate conversation messages', error);
      addLocalSystemMessage('Failed to clear messages for redo. Please try again.');
      return;
    }

    const removedMessages = currentMessages.slice(targetIndex + 1);
    const historyMessages = currentMessages.slice(0, targetIndex + 1);
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

    if (isPresentationCommand) {
      await runPresentationCommand({
        workspaceId: selectedWorkspace.id,
        conversationId,
        turnId: targetTurnId,
        brief: presentationBrief,
        fileIds: presentationFileIds,
        fileNames: mentionedFiles.map((file) => file.name),
        persona,
        replaceExisting: true,
      });
      return;
    }

    try {
      const agentPrompt = trimmed;
      const { runId } = await startAgentRun(
        selectedWorkspace.id,
        persona,
        agentPrompt,
        historyPayload.length ? historyPayload : undefined,
        targetTurnId,
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
      registerActiveRun(runInfo);
      await persistAgentProgress(runInfo, 'running');
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
          updateMessagesForConversation(conversationId, (prev) => {
            const updated = [...prev];
            if (targetIndex >= 0) {
              updated[targetIndex] = mergePersistedAgentMessage(persisted, updated[targetIndex]);
            } else {
              updated.push(mergePersistedAgentMessage(persisted));
            }
            return updated;
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

  const runPresentationCommand = useCallback(
    async ({
      workspaceId,
      conversationId,
      turnId,
      brief,
      fileIds,
      fileNames,
      persona,
      replaceExisting = false,
    }: {
      workspaceId: string;
      conversationId: string;
      turnId: string;
      brief: string;
      fileIds: number[];
      fileNames: string[];
      persona: string;
      replaceExisting?: boolean;
    }) => {
      if (!fileIds.length) {
        addLocalSystemMessage('Tag at least one file using @filename before running /presentation.');
        return;
      }
      const resolvedStyle = resolvePresentationStyle();
      let agentMessageIndex = -1;
      let placeholderId: ConversationMessage['id'] | null = null;
      const startedAt = new Date().toISOString();
      updateMessagesForConversation(conversationId, (prevMessages) => {
        const placeholder: ConversationMessage = {
          id: `agent-${Date.now()}-presentation`,
          conversationId,
          sender: 'agent',
          text: 'Queued Paper2Slides job…',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          turnId,
        };
        placeholderId = placeholder.id;
        const updated = [...prevMessages, placeholder];
        agentMessageIndex = updated.length - 1;
        return updated;
      });
      if (placeholderId) {
        agentMessageBufferRef.current.set(placeholderId, 'Queued Paper2Slides job…');
      }
      setStreamingForConversation(conversationId, true);
      startPresentationProgress();
      try {
        const presentationLabel = sanitizePresentationLabel(fileNames[0] || 'paper2slides', 'paper2slides');
        const startResponse = await startPaper2SlidesJob({
          workspaceId,
          brief,
          fileIds,
          persona,
          output: presentationOptions.output,
          content: presentationOptions.content,
          style: resolvedStyle || undefined,
          length: presentationOptions.length,
          mode: presentationOptions.mode,
          parallel: presentationOptions.parallel,
          fromStage: presentationOptions.fromStage,
          exportPptx: presentationOptions.exportPptx,
        });
        addPendingPresentationPlaceholder(startResponse.jobId, workspaceId, presentationLabel);
        const jobLabel = `Paper2Slides job ${startResponse.jobId.slice(0, 8)}`;
        updateMessagesForConversation(conversationId, (prev) => {
          const updated = [...prev];
          if (agentMessageIndex >= 0 && updated[agentMessageIndex]) {
            updated[agentMessageIndex] = {
              ...updated[agentMessageIndex],
              text: `${jobLabel} started…`,
            };
          }
          return updated;
        });

        const targetLabel =
          brief ||
          (fileNames.length === 1
            ? fileNames[0]
            : fileNames.length > 1
              ? `${fileNames.length} files`
              : 'selected files');

        const finalizeMessage = async (
          status: 'completed' | 'failed',
          payload?: { pdfPath?: string; pptxPath?: string; slideImages?: string[]; htmlPath?: string; error?: string },
          finishedAt?: string,
        ) => {
          const outputFiles: ToolOutputFile[] = [];
          if (payload?.pdfPath) {
            outputFiles.push({ path: payload.pdfPath, mimeType: 'application/pdf' });
          }
          if (payload?.pptxPath) {
            outputFiles.push({
              path: payload.pptxPath,
              mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            });
          }
          if (payload?.slideImages?.length) {
            payload.slideImages.forEach((path) => outputFiles.push({ path, mimeType: 'image/png' }));
          }
          if (payload?.htmlPath) {
            outputFiles.push({ path: payload.htmlPath, mimeType: 'text/html' });
          }

          const summaryText =
            status === 'completed'
              ? `Generated ${presentationOptions.output} with Paper2Slides (${presentationOptions.mode}, ${presentationOptions.length})${resolvedStyle ? ` · style: ${resolvedStyle}` : ''} for ${targetLabel}.`
              : `Paper2Slides job failed: ${payload?.error || 'Unknown error'}`;

          const toolEvent: ToolEvent = {
            id: `presentation-${startResponse.jobId}`,
            name: 'paper2slides',
            status: status === 'completed' ? 'completed' : 'error',
            startedAt: startedAt,
            finishedAt: finishedAt || new Date().toISOString(),
            summary: summaryText,
            outputFiles,
          };

          let persisted: ConversationMessage | null = null;
          try {
            persisted = await appendConversationMessage(conversationId, 'agent', summaryText, {
              turnId,
              metadata: { toolEvents: [toolEvent] },
              replaceExisting,
            });
          } catch (error) {
            console.error('Failed to persist presentation summary', error);
          }
          const hydratedPersisted = persisted ? mergeMessageMetadata(persisted) : null;

          updateMessagesForConversation(conversationId, (prev) => {
            const updated = [...prev];
            const target = updated[agentMessageIndex];
            if (!target) {
              return updated;
            }
            const baseMessage = hydratedPersisted || target;
            const mergedToolEvents =
              (baseMessage.toolEvents && baseMessage.toolEvents.length
                ? baseMessage.toolEvents
                : [...(target.toolEvents || []), toolEvent]);
            updated[agentMessageIndex] = {
              ...baseMessage,
              text: summaryText,
              thinkingText: target.thinkingText,
              toolEvents: mergedToolEvents,
            };
            return updated;
          });

          if (placeholderId) {
            agentMessageBufferRef.current.delete(placeholderId);
          }
          if (persisted?.id) {
            agentMessageBufferRef.current.set(persisted.id, persisted.text || summaryText);
          }
        };

        const poll = async () => {
          try {
            const status = await getPaper2SlidesJob(startResponse.jobId);
            if (status.status === 'completed') {
              await finalizeMessage('completed', status.result, status.updatedAt);
              stopPresentationProgress('success');
              removePendingPresentationPlaceholder(startResponse.jobId);
              if (selectedWorkspace?.id === workspaceId) {
                await loadFilesForWorkspace(workspaceId);
                await refreshConversationHistory(workspaceId);
              }
              return true;
            }
            if (status.status === 'failed') {
              await finalizeMessage('failed', { error: status.error });
              stopPresentationProgress('error');
              removePendingPresentationPlaceholder(startResponse.jobId);
              return true;
            }
            return false;
          } catch (error) {
            console.error('Failed to poll Paper2Slides job', error);
            return false;
          }
        };

        // kick off poll loop
        const finishedImmediately = await poll();
        if (!finishedImmediately) {
          const timerId = window.setInterval(async () => {
            const done = await poll();
            if (done) {
              window.clearInterval(timerId);
              presentationJobPollsRef.current.delete(startResponse.jobId);
            }
          }, 2500);
          presentationJobPollsRef.current.set(startResponse.jobId, timerId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to generate presentation.';
        console.error('Presentation generation failed', error);
        updateMessagesForConversation(conversationId, (prev) => {
          const updated = [...prev];
          if (agentMessageIndex >= 0 && updated[agentMessageIndex]) {
            updated[agentMessageIndex] = {
              ...updated[agentMessageIndex],
              text: `Presentation generation failed: ${message}`,
            };
          }
          return updated;
        });
        addLocalSystemMessage(`Presentation request failed: ${message}`);
        stopPresentationProgress('error');
        if (placeholderId) {
          agentMessageBufferRef.current.delete(placeholderId);
        }
      } finally {
        setStreamingForConversation(conversationId, false);
        stopRequestedRef.current = false;
      }
    },
    [
      addLocalSystemMessage,
      appendConversationMessage,
      loadFilesForWorkspace,
      presentationOptions.content,
      presentationOptions.length,
      presentationOptions.mode,
      presentationOptions.output,
      presentationOptions.parallel,
      presentationOptions.exportPptx,
      presentationOptions.stylePreset,
      presentationOptions.customStyle,
      presentationOptions.fromStage,
      refreshConversationHistory,
      resolvePresentationStyle,
      startPresentationProgress,
      stopPresentationProgress,
      startPaper2SlidesJob,
      getPaper2SlidesJob,
      removePendingPresentationPlaceholder,
      addPendingPresentationPlaceholder,
      selectedWorkspace?.id,
      setStreamingForConversation,
      updateMessagesForConversation,
    ],
  );

  const handleSendMessage = async () => {
    const trimmed = chatMessage.trim();
    const hasAttachments = chatAttachments.length > 0;
    if (!trimmed && !hasAttachments) return;

    stopRequestedRef.current = false;
    const isPresentationCommand = /^\/presentation\b/i.test(trimmed);
    const mentionedFiles = isPresentationCommand ? findMentionedFiles(trimmed) : [];
    const presentationFileIds = isPresentationCommand
      ? Array.from(
        new Set(
          mentionedFiles
            .map((file) => toNumericFileId(file.id))
            .filter((id): id is number => typeof id === 'number' && Number.isFinite(id)),
        ),
      )
      : [];
    const presentationBrief = isPresentationCommand ? trimmed.replace(/^\/presentation\b/i, '').trim() : '';

    if (isPresentationCommand && hasAttachments) {
      addLocalSystemMessage('Attachments are not supported for /presentation. Please tag files using @filename instead.');
      return;
    }
    if (isPresentationCommand && !presentationFileIds.length) {
      addLocalSystemMessage('Tag at least one file using @filename before requesting a presentation.');
      return;
    }
    const attachmentSummary = hasAttachments
      ? `Attachments: ${chatAttachments.map((file) => file.name).join(', ')}`
      : '';
    const messageContent = hasAttachments
      ? `${trimmed}${trimmed ? '\n\n' : ''}[${attachmentSummary}]`
      : trimmed;
    const agentPrompt = messageContent;

    if (!selectedWorkspace) {
      addLocalSystemMessage('Please select a workspace before chatting with an agent.');
      return;
    }

    const workspaceId = selectedWorkspace.id;
    const persona = normalizePersonaName(activeConversationPersona || selectedPersona || DEFAULT_PERSONA_NAME);

    const conversationId = await ensureConversation();
    if (!conversationId) {
      addLocalSystemMessage('Unable to start a conversation right now.');
      return;
    }

    cancelStreamForConversation(conversationId);
    lastUserMessageMapRef.current[conversationId] = messageContent;
    setChatMessage('');
    setChatAttachments([]);
    closeMention();
    closeCommand();

    const pendingTurnId = generateTurnId();
    let resolvedTurnId = pendingTurnId;
    let userMessageRecord: ConversationMessage | null = null;
    let historyPayload: Array<{ role: string; content: string }> = [];
    const existingMessages = getConversationMessagesSnapshot(conversationId);
    try {
      const createdMessage = await appendConversationMessage(conversationId, 'user', messageContent, {
        turnId: pendingTurnId,
      });
      const normalizedMessage = mergeMessageMetadata(createdMessage);
      userMessageRecord = normalizedMessage;
      resolvedTurnId = normalizedMessage.turnId || pendingTurnId;
      updateMessagesForConversation(conversationId, (prev) => [...prev, normalizedMessage]);
      await refreshConversationHistory(workspaceId);
      const pendingMessages = [...existingMessages, normalizedMessage];
      historyPayload = mapMessagesToAgentHistory(pendingMessages);
    } catch (error) {
      console.error('Failed to send user message', error);
      addLocalSystemMessage('Failed to send your message. Please try again.');
      return;
    }
    if (!userMessageRecord) {
      addLocalSystemMessage('Failed to record your message. Please try again.');
      return;
    }

    if (isPresentationCommand) {
      await runPresentationCommand({
        workspaceId,
        conversationId,
        turnId: resolvedTurnId,
        brief: presentationBrief,
        fileIds: presentationFileIds,
        fileNames: mentionedFiles.map((file) => file.name),
        persona,
      });
      return;
    }

    try {
      const { runId } = await startAgentRun(
        workspaceId,
        persona,
        agentPrompt,
        historyPayload.length ? historyPayload : undefined,
        resolvedTurnId,
        { forceReset: true }
      );
      if (STREAM_DEBUG_ENABLED) {
        console.debug('[WorkspacePage] run started', { runId, conversationId });
      }
      const placeholderId = `agent-${runId}`;
      ensureAgentPlaceholder(conversationId, placeholderId, resolvedTurnId, true);
      agentMessageBufferRef.current.set(placeholderId, '');
      const runInfo: ActiveRunInfo = {
        runId,
        conversationId,
        workspaceId,
        persona,
        turnId: resolvedTurnId,
        placeholderId,
        status: 'running',
      };
      registerActiveRun(runInfo);
      await persistAgentProgress(runInfo, 'running');
      await streamRunForConversation(runInfo, true);

      const messagesSnapshot = getConversationMessagesSnapshot(conversationId);
      const targetIndex = messagesSnapshot.findIndex((message) => message.id === placeholderId);
      const agentMessage = targetIndex >= 0 ? messagesSnapshot[targetIndex] : null;
      const metadata = buildMessageMetadata(agentMessage) || {};
      const bufferedText =
        placeholderId !== null && placeholderId !== undefined
          ? agentMessageBufferRef.current.get(placeholderId) ?? agentMessage?.text
          : agentMessage?.text;
      const placeholderTurnId = agentMessage?.turnId || resolvedTurnId;
      if (bufferedText) {
        try {
          const persisted = await appendConversationMessage(conversationId, 'agent', bufferedText, {
            turnId: placeholderTurnId,
            metadata: { ...metadata, runId },
            replaceExisting: true,
          });
          updateMessagesForConversation(conversationId, (prev) => {
            const updated = [...prev];
            if (targetIndex >= 0) {
              updated[targetIndex] = mergePersistedAgentMessage(persisted, updated[targetIndex]);
            } else {
              updated.push(mergePersistedAgentMessage(persisted));
            }
            return updated;
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
    } catch (error) {
      console.error('Failed to start agent run', error);
      addLocalSystemMessage('Failed to start agent run. Please try again.');
    }
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

  const handleChatInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

    if (event.key === 'Enter' && !event.shiftKey) {
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
    } catch (error) {
      console.error('Failed to delete workspace:', error);
    }
  };

  const handleUpdateFile = useCallback(async (id: number, content: string) => {
    if (!selectedWorkspace) return;

    try {
      await updateFileContent(selectedWorkspace.id, id, content);
      lastAutoSavedContentRef.current = content;
      // Optionally, you can refetch the file or update it in the state
    } catch (error) {
      console.error('Failed to update file:', error);
    }
  }, [selectedWorkspace]);

  useEffect(() => {
    if (!isEditMode || !selectedWorkspace || !selectedFile) return;

    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(async () => {
      if (fileContent === lastAutoSavedContentRef.current) {
        return;
      }
      await handleUpdateFile(Number(selectedFile.id), fileContent);
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

    const confirmed = window.confirm(
      `Are you sure you want to delete ${selectedFiles.size} files?`
    );
    if (!confirmed) {
      return;
    }

    try {
      for (const fileId of selectedFiles) {
        await deleteFile(selectedWorkspace.id, fileId);
      }
      setFiles((prevFiles) =>
        prevFiles.filter((file) => !selectedFiles.has(file.id))
      );
      setSelectedFiles(new Set());
      setSelectedFile(null);
      setSelectedFileDetails(null);
      setFileContent('');
    } catch (error) {
      console.error('Failed to delete files:', error);
    }
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

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedWorkspace || !event.target.files || event.target.files.length === 0) {
      return;
    }

    const filesToUpload = event.target.files;

    try {
      for (const file of filesToUpload) {
        const newFileData = (await createFile(selectedWorkspace.id, file)) as WorkspaceFile;
        setFiles((prevFiles) => [...prevFiles, newFileData]);
        if (newFileData?.name) {
          setRagStatuses((prev) => ({
            ...prev,
            [newFileData.name]: { status: 'pending' },
          }));
        }
      }
    } catch (error) {
      console.error('Failed to upload file:', error);
    }
  };

  const handleChatAttachmentButtonClick = () => {
    attachmentInputRef.current?.click();
  };

  const handleChatAttachmentChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files) return;
    const selected = Array.from(event.target.files);
    setChatAttachments((prev) => [...prev, ...selected]);
    event.target.value = '';
  };

  const handleRemoveChatAttachment = (index: number) => {
    setChatAttachments((prev) => prev.filter((_, idx) => idx !== index));
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
          workspaces={workspaces}
          selectedWorkspace={selectedWorkspace}
          newWorkspaceName={newWorkspaceName}
          setNewWorkspaceName={setNewWorkspaceName}
          handleCreateWorkspace={handleCreateWorkspace}
          handleDeleteWorkspace={handleDeleteWorkspace}
          onSelectWorkspace={setSelectedWorkspace}
          onOpenSettings={handleOpenAgentSettings}
          colorMode={colorMode}
          onToggleColorMode={toggleColorMode}
          onSignOut={handleSignOut}
        />
        <Box
          component="main"
          sx={{
            flexGrow: 1,
            p: 3,
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
            className="flex bg-gray-100 font-sans h-full min-h-0 overflow-hidden"
            style={{ height: layoutHeight }}
          >
            {/* Middle Pane: Files & Editor */}
            <div
              className="flex flex-col border-r border-gray-200 min-w-0 min-h-0 overflow-hidden"
              style={workspacePaneStyles}
            >
              {/* Workspace Header */}
              <div className="p-4 border-b border-gray-200 flex justify-between items-center">
                <h2 className="text-xl font-semibold text-gray-800">
                  {selectedWorkspace ? selectedWorkspace.name : 'No workspace selected'}
                </h2>
              </div>
              <div className="flex-1 flex min-h-0">
                {/* File Explorer */}
                <div
                  className="bg-white border-r border-gray-200 flex flex-col overflow-hidden min-h-0"
                  style={filePaneStyles}
                >
                  <div
                    className={`p-4 border-b border-gray-200 flex items-center ${isFilePaneVisible ? 'justify-between' : 'justify-center'
                      }`}
                  >
                    <div className={`flex items-center ${isFilePaneVisible ? 'gap-3' : ''}`}>
                      <button
                        onClick={() => setIsFilePaneVisible(!isFilePaneVisible)}
                        className="p-1.5 border rounded-full hover:bg-gray-100"
                        title={isFilePaneVisible ? 'Collapse files' : 'Expand files'}
                      >
                        <ChevronLeft
                          size={16}
                          className={`text-gray-600 transition-transform duration-300 ${isFilePaneVisible ? '' : 'rotate-180'
                            }`}
                        />
                      </button>
                      {isFilePaneVisible && <h3 className="text-lg font-semibold text-gray-800">Files</h3>}
                    </div>
                    {isFilePaneVisible && (
                      <div className="flex items-center space-x-1.5">
                        <input
                          type="file"
                          id="file-upload"
                          style={{ display: 'none' }}
                          onChange={handleFileUpload}
                          multiple
                        />
                        <button
                          onClick={() => document.getElementById('file-upload')?.click()}
                          disabled={!selectedWorkspace}
                          className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50"
                        >
                          <Plus size={18} className="text-gray-600" />
                        </button>
                        <button
                          onClick={handleRefreshFiles}
                          disabled={!selectedWorkspace}
                          className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50"
                          title="Refresh files"
                        >
                          <RotateCcw size={18} className="text-gray-600" />
                        </button>
                        <button
                          onClick={handleSelectAllFiles}
                          disabled={visibleFiles.length === 0}
                          className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50"
                          title={allFilesSelected ? 'Clear selection' : 'Select all files'}
                        >
                          <CheckSquare size={18} className="text-gray-600" />
                        </button>
                        <button
                          onClick={handleBulkDelete}
                          disabled={selectedFiles.size === 0}
                          className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50"
                        >
                          <Trash size={18} className="text-gray-600" />
                        </button>
                      </div>
                    )}
                  </div>
                  {isFilePaneVisible && hiddenFileCount > 0 && (
                    <div className="px-4 pb-2 text-xs text-gray-500 flex items-center justify-between">
                      <span>
                        {showSystemFiles
                          ? `Showing ${files.length} files`
                          : `Showing ${visibleFiles.length} of ${files.length}`}
                      </span>
                      <button
                        type="button"
                        className="text-blue-600 hover:text-blue-700"
                        onClick={() => setShowSystemFiles((prev) => !prev)}
                      >
                        {showSystemFiles ? 'Hide system files' : `Show ${hiddenFileCount} hidden`}
                      </button>
                    </div>
                  )}
                  <div
                    className={`flex-1 px-4 py-3 overflow-y-auto min-h-0 transition-opacity duration-200 ${isFilePaneVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                      }`}
                    aria-hidden={!isFilePaneVisible}
                  >
                    {visibleFiles.map((file) => {
                      const isPendingJob = file.mimeType === 'application/vnd.helpudoc.paper2slides-job';
                      const ragStatus = typeof file.name === 'string' ? ragStatuses[file.name] : undefined;
                      const ragState = ragStatus?.status ? String(ragStatus.status).toLowerCase() : '';
                      const isIndexing =
                        !isPendingJob &&
                        ['pending', 'processing', 'preprocessed'].includes(ragState);
                      const displayName = getFileDisplayName(file.name || '');
                      const fileIcon = getFileTypeIcon(file.name || '');
                      return (
                        <div
                          key={file.id}
                          className={`group flex items-center p-2 rounded-lg cursor-pointer transition-colors ${selectedFile?.id === file.id ? 'bg-blue-50' : 'hover:bg-gray-100'
                            }`}
                          onMouseEnter={() => setHoveredFileId(file.id)}
                          onMouseLeave={() => setHoveredFileId((current) => (current === file.id ? null : current))}
                        >
                          <input
                            type="checkbox"
                            checked={selectedFiles.has(file.id)}
                            disabled={isPendingJob}
                            onChange={() => handleFileSelect(file.id)}
                            className="mr-3"
                          />
                          <div
                            onClick={() => {
                            if (isPendingJob) {
                              return;
                            }
                            setSelectedFile(file);
                            setSelectedFileDetails(null);
                            setFileContent('');
                            setIsEditMode(shouldForceEditMode(file.name));
                          }}
                            className="flex-1 flex items-start justify-between gap-2 min-w-0"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              {(isPendingJob || isIndexing) && (
                                <Loader2 size={14} className="text-blue-500 animate-spin shrink-0" />
                              )}
                              <span className="shrink-0" aria-hidden="true">
                                {fileIcon}
                              </span>
                              <span
                                className="text-sm text-gray-800 break-words leading-snug"
                                title={file.name}
                              >
                                {displayName}
                              </span>
                            </div>
                            {!isPendingJob && (
                              <div className={`shrink-0 items-center gap-1 ml-1 ${hoveredFileId === file.id ? 'flex' : 'hidden group-hover:flex'}`}>
                                {file.publicUrl && (
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      handleCopyFilePublicUrl(file);
                                    }}
                                    className="p-1 rounded hover:bg-gray-200"
                                    title={copiedFileUrlId === file.id ? 'Copied!' : file.publicUrl}
                                  >
                                    <LinkIcon size={14} className="text-gray-600" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleRenameFile(file);
                                  }}
                                  className="p-1 rounded hover:bg-gray-200"
                                  title="Rename"
                                >
                                  <Edit size={14} className="text-gray-600" />
                                </button>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleDeleteSingleFile(file);
                                  }}
                                  className="p-1 rounded hover:bg-gray-200"
                                  title="Delete"
                                >
                                  <Trash size={14} className="text-gray-600" />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Content Editor */}
                <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden min-w-0 min-h-0">
                  <div className="px-4 pt-4 pb-6 border-b border-gray-200 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      <h3 className="text-lg font-semibold text-gray-800">{canvasTitle}</h3>
                    </div>
                    <div className="flex items-center space-x-2">
                      {canCopyImageUrl && (
                        <button
                          type="button"
                          className="h-9 w-9 inline-flex items-center justify-center rounded-lg hover:bg-gray-200 disabled:opacity-50"
                          onClick={handleCopyImageUrl}
                          title={copiedImageUrl ? 'Copied!' : 'Copy public URL'}
                        >
                          <LinkIcon size={18} className="text-gray-600" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="h-9 w-9 inline-flex items-center justify-center rounded-lg hover:bg-gray-200 disabled:opacity-50"
                        onClick={handleCopyWorkspaceContent}
                        disabled={!selectedFile}
                        title={copiedWorkspaceContent ? 'Copied!' : 'Copy file content'}
                      >
                        <Copy size={18} className="text-gray-600" />
                      </button>
                      {canPrintOrDownloadFile && (
                        <>
                          <button
                            type="button"
                            className="h-9 w-9 inline-flex items-center justify-center rounded-lg hover:bg-gray-200 disabled:opacity-50"
                            onClick={handlePrintActiveFile}
                            title="Print file"
                          >
                            <Printer size={18} className="text-gray-600" />
                          </button>
                          <button
                            type="button"
                            className="h-9 w-9 inline-flex items-center justify-center rounded-lg hover:bg-gray-200 disabled:opacity-50"
                            onClick={handleDownloadActiveFile}
                            title="Download file"
                          >
                            <Download size={18} className="text-gray-600" />
                          </button>
                        </>
                      )}
                      {isPdfFile && (
                        <button
                          type="button"
                          className="h-9 px-3 inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium text-slate-700 hover:bg-gray-200 disabled:opacity-50"
                          onClick={handleExportPptxFromPdf}
                          disabled={!activeFile || isPptxExporting}
                          title="Export PPTX from PDF"
                        >
                          {isPptxExporting ? <Loader2 size={14} className="animate-spin" /> : null}
                          {isPptxExporting ? 'Exporting PPTX' : 'Export PPTX'}
                        </button>
                      )}
                      {!shouldForceEditMode(selectedFile?.name || '') && (
                        <button
                          className="h-9 w-9 inline-flex items-center justify-center rounded-lg hover:bg-gray-200 disabled:opacity-50"
                          onClick={() => {
                            if (!isAgentPaneVisible) {
                              setIsAgentPaneVisible(true);
                            }
                            setIsEditMode(!isEditMode);
                          }}
                          disabled={!selectedFile || !isFileEditable(selectedFile.name)}
                        >
                          <Edit size={18} className="text-gray-600" />
                        </button>
                      )}
                      <button
                        className="h-9 px-3 inline-flex items-center justify-center rounded-lg text-sm font-medium text-slate-700 hover:bg-gray-200 disabled:opacity-50"
                        onClick={() => selectedFile && handleUpdateFile(Number(selectedFile.id), fileContent)}
                        disabled={!isEditMode}
                      >
                        Save
                      </button>
                      {!isEditMode && (
                        <>
                          <button
                            type="button"
                            className="h-9 w-9 inline-flex items-center justify-center rounded-lg hover:bg-gray-200 disabled:opacity-50"
                            onClick={handleCanvasZoomOut}
                            disabled={!canZoomOutCanvas}
                            title="Zoom out canvas"
                          >
                            <Minus size={18} className="text-gray-600" />
                          </button>
                          <button
                            type="button"
                            className="h-9 px-2 inline-flex items-center justify-center rounded-lg text-xs font-semibold text-slate-700 hover:bg-gray-200"
                            onClick={handleCanvasZoomReset}
                            title="Reset canvas zoom"
                          >
                            {Math.round(canvasZoom * 100)}%
                          </button>
                          <button
                            type="button"
                            className="h-9 w-9 inline-flex items-center justify-center rounded-lg hover:bg-gray-200 disabled:opacity-50"
                            onClick={handleCanvasZoomIn}
                            disabled={!canZoomInCanvas}
                            title="Zoom in canvas"
                          >
                            <Plus size={18} className="text-gray-600" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 overflow-hidden min-h-0">
                    {isEditMode && selectedWorkspace ? (
                      <FileEditor
                        file={selectedFileDetails || selectedFile}
                        fileContent={fileContent}
                        onContentChange={setFileContent}
                        workspaceId={selectedWorkspace.id}
                        colorMode={colorMode}
                      />
                    ) : (
                      <div className="h-full w-full overflow-y-auto overflow-x-hidden">
                        <div
                          className="h-full origin-top-left"
                          style={{
                            transform: `scale(${canvasZoom})`,
                            width: `${100 / canvasZoom}%`,
                            minHeight: `${100 / canvasZoom}%`,
                          }}
                        >
                          <UIBlockRenderer
                            blocks={canvasBlocks}
                            className="h-full w-full"
                            emptyState={
                              <div className="text-center text-gray-400">
                                <p>Select a file to view its content</p>
                              </div>
                            }
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <AgentChatPane
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
              personaDisplayName={personaDisplayName}
              messageBubbleMaxWidth={messageBubbleMaxWidth}
              markdownComponents={markdownComponents}
              expandedToolMessages={expandedToolMessages}
              expandedThinkingMessages={expandedThinkingMessages}
              copiedMessageId={copiedMessageId}
              interruptInputByMessageId={interruptInputByMessageId}
              interruptSelectedChoicesByMessageId={interruptSelectedChoicesByMessageId}
              interruptSubmittingByMessageId={interruptSubmittingByMessageId}
              chatMessage={chatMessage}
              chatAttachments={chatAttachments}
              showPaper2SlidesControls={showPaper2SlidesControls}
              presentationStatus={presentationStatus}
              presentationOptionSummary={presentationOptionSummary}
              isMentionOpen={isMentionOpen}
              mentionSuggestions={mentionSuggestions}
              mentionSelectedIndex={mentionSelectedIndex}
              isCommandOpen={isCommandOpen}
              commandSuggestions={commandSuggestions}
              commandSelectedIndex={commandSelectedIndex}
              chatInputRef={chatInputRef}
              attachmentInputRef={attachmentInputRef}
              workspaceId={selectedWorkspace?.id}
              formatMessageTimestamp={formatMessageTimestamp}
              interruptFieldKey={interruptFieldKey}
              getInterruptKind={getInterruptKind}
              getAllowedDecisions={getAllowedDecisions}
              getPrimaryInterruptAction={getPrimaryInterruptAction}
              isPlanApprovalInterrupt={isPlanApprovalInterrupt}
              setInterruptInputByMessageId={setInterruptInputByMessageId}
              setInterruptSelectedChoicesByMessageId={setInterruptSelectedChoicesByMessageId}
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
              onInterruptDecision={handleInterruptDecision}
              onClarificationResponse={handleClarificationResponse}
              onChatInputChange={handleChatInputChange}
              onChatInputKeyDown={handleChatInputKeyDown}
              onChatInputKeyUp={handleChatInputKeyUp}
              onChatInputSelectionChange={handleChatInputSelectionChange}
              onChatAttachmentButtonClick={handleChatAttachmentButtonClick}
              onInsertSlashTrigger={handleInsertSlashTrigger}
              onOpenPresentationModal={handleOpenPresentationModal}
              onStopStreaming={handleStopStreaming}
              onSendMessage={handleSendMessage}
              onChatAttachmentChange={handleChatAttachmentChange}
              onRemoveChatAttachment={handleRemoveChatAttachment}
              onSelectMention={handleSelectMention}
              onSelectCommand={(command) => handleSelectCommand(command as SlashCommand)}
            />
          </div>
        </Box>
      </Box>
      <PresentationModal
        isOpen={isPresentationModalOpen}
        draft={draftPresentationOptions}
        onChange={handleDraftPresentationOptionChange}
        onClose={handleClosePresentationModal}
        onSave={handleSavePresentationOptions}
      />
    </ThemeProvider>
  );
}

function PresentationModal({
  isOpen,
  draft,
  onChange,
  onClose,
  onSave,
}: {
  isOpen: boolean;
  draft: PresentationOptionsState | null;
  onChange: <K extends keyof PresentationOptionsState>(key: K, value: PresentationOptionsState[K]) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  if (!isOpen || !draft) {
    return null;
  }
  const showCustomStyle = draft.stylePreset === 'custom';

  const selectClass =
    'w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800';
  const labelClass = 'flex flex-col gap-1 text-xs font-semibold text-slate-600';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Configure Paper2Slides</p>
            <p className="text-xs text-slate-500">Choose output, style, and pipeline controls.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-500 hover:bg-slate-100"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <label className={labelClass}>
            <span>Output</span>
            <select
              className={selectClass}
              value={draft.output}
              onChange={(event) => onChange('output', event.target.value as PresentationOptionsState['output'])}
            >
              <option value="slides">Slides</option>
              <option value="poster">Poster</option>
            </select>
          </label>
          <label className={labelClass}>
            <span>Length</span>
            <select
              className={selectClass}
              value={draft.length}
              onChange={(event) => onChange('length', event.target.value as PresentationOptionsState['length'])}
            >
              <option value="short">Short</option>
              <option value="medium">Medium</option>
              <option value="long">Long</option>
            </select>
          </label>
          <label className={labelClass}>
            <span>Mode</span>
            <select
              className={selectClass}
              value={draft.mode}
              onChange={(event) => onChange('mode', event.target.value as PresentationOptionsState['mode'])}
            >
              <option value="fast">Fast</option>
              <option value="normal">Normal</option>
            </select>
          </label>
          <label className={labelClass}>
            <span>Style</span>
            <select
              className={selectClass}
              value={draft.stylePreset}
              onChange={(event) =>
                onChange('stylePreset', event.target.value as PresentationOptionsState['stylePreset'])
              }
            >
              {PAPER2SLIDES_STYLE_PRESETS.map((style) => (
                <option key={style} value={style}>
                  {style === 'custom' ? 'Custom prompt' : style.charAt(0).toUpperCase() + style.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            <span>Content</span>
            <select
              className={selectClass}
              value={draft.content}
              onChange={(event) => onChange('content', event.target.value as PresentationOptionsState['content'])}
            >
              <option value="paper">Paper</option>
              <option value="general">General</option>
            </select>
          </label>
          <label className={labelClass}>
            <span>Parallel</span>
            <input
              type="number"
              min={1}
              className={selectClass}
              value={draft.parallel}
              onChange={(event) => onChange('parallel', Math.max(1, Number(event.target.value) || 1))}
            />
          </label>
          <label className={labelClass}>
            <span>Restart from</span>
            <select
              className={selectClass}
              value={draft.fromStage || ''}
              onChange={(event) =>
                onChange('fromStage', event.target.value ? (event.target.value as PresentationOptionsState['fromStage']) : undefined)
              }
            >
              <option value="">Auto</option>
              {PAPER2SLIDES_STAGE_ORDER.map((stage) => (
                <option key={stage} value={stage}>
                  {stage === 'rag' ? 'RAG' : stage.charAt(0).toUpperCase() + stage.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs font-semibold text-slate-600">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-blue-600"
              checked={draft.exportPptx}
              onChange={(event) => onChange('exportPptx', event.target.checked)}
            />
            <span>Export PPTX (slow)</span>
          </label>
          <span className="text-[11px] text-slate-500">Run after slide render. You can also export later from a PDF.</span>
        </div>
        {showCustomStyle && (
          <div className="mt-3">
            <label className="text-xs font-semibold text-slate-600">Style prompt</label>
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800"
              placeholder="e.g., Studio Ghibli watercolor with warm tones"
              value={draft.customStyle}
              onChange={(event) => onChange('customStyle', event.target.value)}
            />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
