import { useState, useEffect, useRef, useCallback, useMemo, Children, isValidElement } from 'react';
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
import { Copy, Edit, Trash, Star, Send, Plus, ChevronRight, ChevronLeft, RotateCcw, Maximize2, Minimize2, X, FileIcon, Printer, Download, Link as LinkIcon, MonitorPlay, StopCircle } from 'lucide-react';
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
  getWorkspaceFilePreview,
} from '../services/fileApi';
import { fetchPersonas, runAgentStream, type AgentStreamChunk } from '../services/agentApi';
import { fetchRecentConversations, createConversation as createConversationApi, fetchConversationDetail, appendMessage as appendConversationMessage, deleteConversation as deleteConversationApi } from '../services/conversationApi';
import { createPresentation } from '../services/presentationApi';
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
import FileRenderer from '../components/FileRenderer';
import ExpandableSidebar from '../components/ExpandableSidebar';
import PersonaSelector from '../components/PersonaSelector';
import { useAuth } from '../auth/AuthProvider';

const drawerWidth = 280;
const DEFAULT_PERSONA_NAME = 'general-assistant';

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

const THOUGHT_PREVIEW_LIMIT = 320;

type FilePreviewPayload = {
  path: string;
  mimeType?: string | null;
  encoding: 'text' | 'base64';
  content: string;
};

const ToolOutputFilePreview = ({
  workspaceId,
  file,
}: {
  workspaceId?: string;
  file: ToolOutputFile;
}) => {
  const [preview, setPreview] = useState<FilePreviewPayload | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    getWorkspaceFilePreview(workspaceId, file.path)
      .then((data) => {
        if (!cancelled) {
          setPreview(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Unable to load preview for this artifact.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, file.path]);

  if (!workspaceId) {
    return <p className="text-xs text-gray-500">Select a workspace to preview this file.</p>;
  }
  if (isLoading) {
    return <p className="text-xs text-gray-500">Loading preview…</p>;
  }
  if (error) {
    return <p className="text-xs text-red-500">{error}</p>;
  }
  if (!preview) {
    return null;
  }

  const { mimeType, encoding, content } = preview;
  const normalizedMime = mimeType || '';

  if (normalizedMime.startsWith('image/')) {
    const dataUrl = encoding === 'base64' ? `data:${normalizedMime};base64,${content}` : content;
    return <img src={dataUrl} alt={file.path} className="mt-2 max-w-full rounded border border-gray-200" />;
  }

  if (normalizedMime.includes('html')) {
    return (
      <iframe
        title={file.path}
        className="mt-2 w-full h-64 rounded border border-gray-200"
        srcDoc={content}
        sandbox="allow-scripts allow-same-origin"
      />
    );
  }

  if (normalizedMime.includes('markdown')) {
    return (
      <div className="mt-2 prose prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }

  if (normalizedMime.includes('json')) {
    let formatted = content;
    try {
      formatted = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // leave as-is
    }
    return (
      <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
        {formatted}
      </pre>
    );
  }

  return (
    <pre className="mt-2 max-h-64 overflow-auto rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-800">
      {encoding === 'base64' ? 'Binary file preview not available.' : content}
    </pre>
  );
};
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

const mapMessagesToAgentHistory = (messages: ConversationMessage[]) => {
  return messages
    .filter((message) => typeof message.text === 'string' && message.text.trim().length > 0)
    .map((message) => ({
      role: message.sender === 'agent' ? 'assistant' : 'user',
      content: message.text.trim(),
    }));
};

const mergeMessageMetadata = (message: ConversationMessage): ConversationMessage => {
  const metadata = message.metadata as ConversationMessageMetadata | null | undefined;
  if (!metadata) {
    return message;
  }
  const thinkingText = message.thinkingText ?? metadata.thinkingText;
  const toolEvents = message.toolEvents ?? metadata.toolEvents;
  if (thinkingText === message.thinkingText && toolEvents === message.toolEvents) {
    return message;
  }
  return {
    ...message,
    thinkingText,
    toolEvents,
  };
};

const buildMessageMetadata = (message?: ConversationMessage | null): ConversationMessageMetadata | undefined => {
  if (!message) {
    return undefined;
  }
  const metadata: ConversationMessageMetadata = {};
  if (message.thinkingText) {
    metadata.thinkingText = message.thinkingText;
  }
  if (message.toolEvents?.length) {
    metadata.toolEvents = message.toolEvents;
  }
  return Object.keys(metadata).length ? metadata : undefined;
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
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [chatMessage, setChatMessage] = useState('');
  const [chatAttachments, setChatAttachments] = useState<File[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hoveredFileId, setHoveredFileId] = useState<string | null>(null);
  const [personas, setPersonas] = useState<AgentPersona[]>([]);
  const [selectedPersona, setSelectedPersona] = useState('');
  const [isEditMode, setIsEditMode] = useState(false);
  const [isAgentPaneVisible, setIsAgentPaneVisible] = useState(true);
  const [isFilePaneVisible, setIsFilePaneVisible] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isAgentPaneFullScreen, setIsAgentPaneFullScreen] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeConversationPersona, setActiveConversationPersona] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ConversationMessage[]>([]);
  const agentMessageBufferRef = useRef<Map<ConversationMessage['id'], string>>(new Map());
  const stopRequestedRef = useRef(false);
  const lastUserMessageRef = useRef<string>('');
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [isMentionOpen, setIsMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionTriggerIndex, setMentionTriggerIndex] = useState<number | null>(null);
  const [mentionCursorPosition, setMentionCursorPosition] = useState<number | null>(null);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [expandedToolMessages, setExpandedToolMessages] = useState<Set<ConversationMessage['id']>>(new Set());
  const [expandedThinkingMessages, setExpandedThinkingMessages] = useState<Set<ConversationMessage['id']>>(new Set());
  const [copiedCodeBlockId, setCopiedCodeBlockId] = useState<string | null>(null);
  const [copiedImageUrl, setCopiedImageUrl] = useState(false);
  const [copiedFileUrlId, setCopiedFileUrlId] = useState<string | null>(null);
  const [copiedWorkspaceContent, setCopiedWorkspaceContent] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<ConversationMessage['id'] | null>(null);
  const theme = useMemo(() => buildTheme(colorMode), [colorMode]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', colorMode);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('helpudoc-color-mode', colorMode);
    }
  }, [colorMode]);

  const toggleColorMode = useCallback(
    () => setColorMode((prev) => (prev === 'light' ? 'dark' : 'light')),
    []
  );
  const mentionSuggestions = useMemo(() => {
    if (!isMentionOpen) {
      return [] as WorkspaceFile[];
    }
    const normalized = mentionQuery.trim().toLowerCase();
    const filtered = files.filter((file) =>
      !normalized || file.name.toLowerCase().includes(normalized)
    );
    return filtered.slice(0, 8);
  }, [files, isMentionOpen, mentionQuery]);

  const personaDisplayName = useMemo(() => {
    const personaId = activeConversationPersona || selectedPersona;
    if (!personaId) {
      return 'Agent';
    }
    const persona = personas.find((item) => item.name === personaId);
    return persona?.displayName || personaId;
  }, [activeConversationPersona, selectedPersona, personas]);

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

  const markdownComponents = useMemo(
    () => ({
      p({ children }: { children?: ReactNode }) {
        const childArray = Children.toArray(children);
        const containsBlockChild = childArray.some(
          (child) => isValidElement(child) && typeof child.type === 'string' && BLOCK_LEVEL_TAGS.includes(child.type)
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
      code({ inline, className, children, ...props }: any) {
        if (inline) {
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
        const codeContent = (Array.isArray(children) ? children.join('') : String(children ?? '')).replace(/\n$/, '');
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
    [classifyCodeBlockLabel, copiedCodeBlockId, handleCopyCodeBlock]
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

  const buildThinkingPreview = useCallback((text: string, expanded: boolean) => {
    if (!text) {
      return '';
    }
    if (expanded || text.length <= THOUGHT_PREVIEW_LIMIT) {
      return text;
    }
    return `${text.slice(0, THOUGHT_PREVIEW_LIMIT).trimEnd()}…`;
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

  const filePaneWidth = isFilePaneVisible ? 320 : 56;

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
    transition: 'flex-basis 0.35s ease, flex-grow 0.35s ease, width 0.35s ease',
  };

  const activeFile = selectedFileDetails || selectedFile;
  const activeFileName = activeFile?.name ?? '';
  const normalizedFileName = activeFileName.toLowerCase();
  const isMarkdownFile = !!activeFile && MARKDOWN_FILE_EXTENSIONS.some((ext) => normalizedFileName.endsWith(ext));
  const isHtmlFile = !!activeFile && HTML_FILE_EXTENSIONS.some((ext) => normalizedFileName.endsWith(ext));
  const isImageFile = !!activeFile && IMAGE_FILE_EXTENSIONS.some((ext) => normalizedFileName.endsWith(ext));
  const canPrintOrDownloadFile = Boolean(activeFile && (isMarkdownFile || isHtmlFile));
  const canCopyImageUrl = Boolean(isImageFile && activeFile?.publicUrl);

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

  const cancelStream = () => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
    setIsStreaming(false);
  };

  const handleStopStreaming = () => {
    stopRequestedRef.current = true;
    cancelStream();
  };

  const loadFilesForWorkspace = useCallback(async (workspaceId: string | null) => {
    if (!workspaceId) return;
    try {
      const files = await getFiles(workspaceId);
      setFiles(files);
    } catch (error) {
      console.error('Failed to load files for workspace', error);
    }
  }, []);

  useEffect(() => {
    return () => cancelStream();
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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
    if (!selectedWorkspace || !isStreaming) {
      return;
    }
    const interval = setInterval(() => {
      loadFilesForWorkspace(selectedWorkspace.id);
    }, 3000);
    return () => clearInterval(interval);
  }, [isStreaming, selectedWorkspace, loadFilesForWorkspace]);

  useEffect(() => {
    if (!mentionSuggestions.length) {
      setMentionSelectedIndex(0);
    } else {
      setMentionSelectedIndex((current) =>
        Math.min(current, mentionSuggestions.length - 1)
      );
    }
  }, [mentionSuggestions.length]);

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

  useEffect(() => {
    closeMention();
  }, [closeMention, selectedWorkspace]);

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

  const findMentionedFiles = useCallback(
    (value: string): WorkspaceFile[] => {
      if (!value) {
        return [];
      }
      return files.filter((file) => value.includes(`@${file.name}`));
    },
    [files],
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
      const buffer = agentMessageBufferRef.current;
      buffer.clear();
      hydratedMessages.forEach((message) => {
        if (message.sender === 'agent') {
          buffer.set(message.id, message.text || '');
        }
      });
      setMessages(hydratedMessages);
      setActiveConversationPersona(detail.conversation.persona);
    } catch (error) {
      console.error('Failed to load conversation messages', error);
      agentMessageBufferRef.current.clear();
      setMessages([]);
      setActiveConversationPersona(null);
    }
  }, []);

  const addLocalSystemMessage = useCallback((text: string) => {
    const systemMessage: ConversationMessage = {
      id: `local-${Date.now()}`,
      conversationId: activeConversationId || 'local',
      sender: 'agent',
      text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, systemMessage]);
    agentMessageBufferRef.current.set(systemMessage.id, systemMessage.text || '');
  }, [activeConversationId]);

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
      setActiveConversationPersona(conversation.persona);
      agentMessageBufferRef.current.clear();
      setMessages([]);
      await refreshConversationHistory(selectedWorkspace.id);
      return conversation.id;
    } catch (error) {
      console.error('Failed to create conversation', error);
      return null;
    }
  }, [activeConversationId, selectedWorkspace, selectedPersona, refreshConversationHistory]);

  useEffect(() => {
    const loadConversations = async () => {
      if (!selectedWorkspace) {
        setConversationHistory([]);
        setActiveConversationId(null);
        agentMessageBufferRef.current.clear();
        setMessages([]);
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
        agentMessageBufferRef.current.clear();
        setMessages([]);
        setActiveConversationPersona(null);
      }
    };

    loadConversations();
  }, [selectedWorkspace, refreshConversationHistory, loadConversationMessages]);

  useEffect(() => {
    const loadPersonas = async () => {
      try {
        const personaList = await fetchPersonas();
        setPersonas(personaList);
        if (personaList.length) {
          const defaultPersona =
            personaList.find((persona) => persona.name === DEFAULT_PERSONA_NAME) || personaList[0];
          setSelectedPersona((current) => current || defaultPersona.name);
        }
      } catch (error) {
        console.error('Failed to load personas', error);
      }
    };
    loadPersonas();
  }, []);

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
        setFileContent(fileWithContent.content || '');
      } catch (error) {
        console.error('Failed to fetch file content:', error);
        setFileContent('Failed to load file content.');
        setSelectedFileDetails(null);
      }
    } else {
      setFileContent('');
      setSelectedFileDetails(null);
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
    cancelStream();
    setActiveConversationId(conversationId);
    await loadConversationMessages(conversationId);
    setChatMessage('');
    closeMention();
  };

  const handleDeleteConversation = useCallback(
    async (conversationId: string) => {
      try {
        await deleteConversationApi(conversationId);
        setConversationHistory((prev) => prev.filter((conversation) => conversation.id !== conversationId));
        if (activeConversationId === conversationId) {
          setActiveConversationId(null);
          agentMessageBufferRef.current.clear();
          setMessages([]);
          setActiveConversationPersona(null);
        }
      } catch (error) {
        console.error('Failed to delete conversation', error);
      }
    },
    [activeConversationId],
  );

  const updateToolEvents = (index: number, updater: (events: ToolEvent[]) => ToolEvent[]) => {
    setMessages((prev) => {
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

  const createToolEvent = (name: string, status: ToolEvent['status'] = 'running'): ToolEvent => ({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    status,
    startedAt: new Date().toISOString(),
  });

  const appendAgentThought = (index: number, chunk: string) => {
    if (!chunk || index < 0) {
      return;
    }
    setMessages((prevMessages) => {
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

  const appendToolStart = (index: number, chunk: AgentStreamChunk & { type: 'tool_start' }) => {
    const label = chunk.name || chunk.content || 'tool';
    updateToolEvents(index, (events) => [...events, createToolEvent(label)]);
  };

  const appendToolEnd = (
    index: number,
    chunk: (AgentStreamChunk & { type: 'tool_end' | 'tool_error' }),
    status: ToolEvent['status'] = 'completed',
  ) => {
    const label = chunk.name || 'tool';
    const summary = chunk.content ? truncateToolOutput(chunk.content) : '';
    const outputFiles = 'outputFiles' in chunk ? chunk.outputFiles : undefined;
    updateToolEvents(index, (events) => {
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

  const handleStreamChunk = (agentMessageIndex: number, chunk: AgentStreamChunk) => {
    if (chunk.type === 'thought') {
      appendAgentThought(agentMessageIndex, chunk.content || '');
      return;
    }

    if (chunk.type === 'tool_start') {
      appendToolStart(agentMessageIndex, chunk);
      return;
    }

    if (chunk.type === 'tool_end') {
      appendToolEnd(agentMessageIndex, chunk);
      return;
    }

    if (chunk.type === 'tool_error') {
      appendToolEnd(agentMessageIndex, chunk, 'error');
      return;
    }

    if (chunk.type === 'token' || chunk.type === 'chunk') {
      if (chunk.role && chunk.role !== 'assistant') {
        return;
      }
      appendAgentChunk(agentMessageIndex, chunk.content || '');
      return;
    }

    if (chunk.type === 'error') {
      appendAgentChunk(agentMessageIndex, `\n${chunk.message || 'Agent stream failed.'}`);
    }
  };

  const appendAgentChunk = (index: number, chunk: string) => {
    if (!chunk || index < 0) {
      return;
    }
    setMessages((prevMessages) => {
      const updated = [...prevMessages];
      const target = updated[index];
      if (!target) {
        return updated;
      }
      let nextChunk = chunk;
      const userPrompt = lastUserMessageRef.current.trim();
      if (!target.text && userPrompt) {
        const chunkNoLeading = nextChunk.replace(/^\s+/, '');
        if (chunkNoLeading.startsWith(userPrompt)) {
          const remainder = chunkNoLeading.slice(userPrompt.length).replace(/^\s+/, '');
          if (!remainder) {
            return updated;
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
      return updated;
    });
  };

  const handleRerunMessage = async (messageId: ConversationMessage['id']) => {
    if (!selectedWorkspace || !activeConversationId) {
      addLocalSystemMessage('Please select a workspace and conversation before rerunning messages.');
      return;
    }

    if (!activeConversationPersona && !selectedPersona) {
      addLocalSystemMessage('No persona selected. Please pick an agent persona.');
      return;
    }

    const persona = activeConversationPersona || selectedPersona;
    if (!persona) {
      addLocalSystemMessage('Unable to determine which persona to use for this conversation.');
      return;
    }

    stopRequestedRef.current = false;
    const currentMessages = [...messagesRef.current];
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

    const targetTurnId = targetMessage.turnId || generateTurnId();

    lastUserMessageRef.current = trimmed;
    cancelStream();

    const historyMessages = currentMessages.slice(0, targetIndex + 1);
    const historyPayload = mapMessagesToAgentHistory(historyMessages);

    const agentIdsToRemove = currentMessages
      .filter((message) => message.sender === 'agent' && message.turnId === targetTurnId)
      .map((message) => message.id);
    agentIdsToRemove.forEach((id) => {
      if (id !== null && id !== undefined) {
        agentMessageBufferRef.current.delete(id);
      }
    });

    let agentMessageIndex = -1;
    let rerunPlaceholderId: ConversationMessage['id'] | null = null;
    setMessages((prevMessages) => {
      const placeholderId = `agent-${Date.now()}-rerun`;
      rerunPlaceholderId = placeholderId;
      const withoutPreviousAgent = prevMessages.filter(
        (message) => !(message.sender === 'agent' && message.turnId === targetTurnId)
      );
      const placeholder: ConversationMessage = {
        id: placeholderId,
        conversationId: activeConversationId,
        sender: 'agent',
        text: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        turnId: targetTurnId,
      };
      const updated = [...withoutPreviousAgent, placeholder];
      agentMessageIndex = updated.length - 1;
      return updated;
    });
    if (rerunPlaceholderId) {
      agentMessageBufferRef.current.set(rerunPlaceholderId, '');
    }

    const controller = new AbortController();
    streamAbortRef.current = controller;
    setIsStreaming(true);

    try {
      await runAgentStream(
        selectedWorkspace.id,
        persona,
        trimmed,
        historyPayload.length ? historyPayload : undefined,
        (chunk) => handleStreamChunk(agentMessageIndex, chunk),
        controller.signal,
        { forceReset: true }
      );
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') {
        const stopLabel = stopRequestedRef.current ? '\n[Stopped by user]' : '\n[Stream cancelled]';
        appendAgentChunk(agentMessageIndex, stopLabel);
      } else {
        console.error('Failed to rerun agent response', error);
        appendAgentChunk(agentMessageIndex, '\nSorry, rerun failed.');
      }
    } finally {
      setIsStreaming(false);
      streamAbortRef.current = null;
      stopRequestedRef.current = false;
      loadFilesForWorkspace(selectedWorkspace.id);
    }

    if (agentMessageIndex >= 0) {
      const agentMessage = messagesRef.current[agentMessageIndex];
      const placeholderId = agentMessage?.id ?? null;
      const metadata = buildMessageMetadata(agentMessage);
      const bufferedText =
        placeholderId !== null && placeholderId !== undefined
          ? agentMessageBufferRef.current.get(placeholderId) ?? agentMessage?.text
          : agentMessage?.text;
      const placeholderTurnId = agentMessage?.turnId || targetTurnId;
      if (bufferedText) {
        try {
          const persisted = await appendConversationMessage(activeConversationId, 'agent', bufferedText, {
            turnId: placeholderTurnId,
            replaceExisting: true,
            metadata,
          });
          const hydratedPersisted = mergeMessageMetadata(persisted);
          setMessages((prev) => {
            const updated = [...prev];
            const existing = updated[agentMessageIndex];
            updated[agentMessageIndex] = {
              ...hydratedPersisted,
              thinkingText: hydratedPersisted.thinkingText ?? existing?.thinkingText,
              toolEvents: hydratedPersisted.toolEvents ?? existing?.toolEvents,
            };
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
    }: {
      workspaceId: string;
      conversationId: string;
      turnId: string;
      brief: string;
      fileIds: number[];
      fileNames: string[];
    }) => {
      if (!fileIds.length) {
        addLocalSystemMessage('Tag at least one file using @filename before running /presentation.');
        return;
      }
      let agentMessageIndex = -1;
      let placeholderId: ConversationMessage['id'] | null = null;
      setMessages((prevMessages) => {
        const placeholder: ConversationMessage = {
          id: `agent-${Date.now()}-presentation`,
          conversationId,
          sender: 'agent',
          text: 'Generating presentation slides…',
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
        agentMessageBufferRef.current.set(placeholderId, 'Generating presentation slides…');
      }
      setIsStreaming(true);
      try {
        const response = await createPresentation({
          workspaceId,
          brief,
          fileIds,
        });
        const targetLabel =
          brief ||
          (fileNames.length === 1
            ? fileNames[0]
            : fileNames.length > 1
              ? `${fileNames.length} files`
              : 'selected files');
        const summaryText = `Generated HTML presentation for ${targetLabel}.`;
        const toolEvent: ToolEvent = {
          id: `presentation-${Date.now()}`,
          name: 'presentation',
          status: 'completed',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          summary: summaryText,
          outputFiles: [
            { path: response.htmlPath, mimeType: 'text/html' },
          ],
        };
        let persisted: ConversationMessage | null = null;
        try {
          persisted = await appendConversationMessage(conversationId, 'agent', summaryText, {
            turnId,
            metadata: {
              toolEvents: [toolEvent],
            },
          });
        } catch (error) {
          console.error('Failed to persist presentation summary', error);
        }
        const hydratedPersisted = persisted ? mergeMessageMetadata(persisted) : null;
        setMessages((prev) => {
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
        await refreshConversationHistory(workspaceId);
        await loadFilesForWorkspace(workspaceId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to generate presentation.';
        console.error('Presentation generation failed', error);
        setMessages((prev) => {
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
        if (placeholderId) {
          agentMessageBufferRef.current.delete(placeholderId);
        }
      } finally {
        setIsStreaming(false);
        stopRequestedRef.current = false;
      }
    },
    [addLocalSystemMessage, appendConversationMessage, createPresentation, loadFilesForWorkspace, refreshConversationHistory],
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

    if (!selectedWorkspace) {
      addLocalSystemMessage('Please select a workspace before chatting with an agent.');
      return;
    }

    if (!selectedPersona && !activeConversationPersona) {
      addLocalSystemMessage('No persona selected. Please pick an agent persona.');
      return;
    }

    const workspaceId = selectedWorkspace.id;
    const persona = activeConversationPersona || selectedPersona;
    if (!persona) {
      addLocalSystemMessage('Unable to determine which persona to use for this conversation.');
      return;
    }

    const conversationId = await ensureConversation();
    if (!conversationId) {
      addLocalSystemMessage('Unable to start a conversation right now.');
      return;
    }

    lastUserMessageRef.current = messageContent;
    cancelStream();
    setChatMessage('');
    setChatAttachments([]);
    closeMention();

    const pendingTurnId = generateTurnId();
    let resolvedTurnId = pendingTurnId;
    let userMessageRecord: ConversationMessage | null = null;
    let historyPayload: Array<{ role: string; content: string }> = [];
    try {
      const createdMessage = await appendConversationMessage(conversationId, 'user', messageContent, {
        turnId: pendingTurnId,
      });
      const normalizedMessage = mergeMessageMetadata(createdMessage);
      userMessageRecord = normalizedMessage;
      resolvedTurnId = normalizedMessage.turnId || pendingTurnId;
      setMessages((prev) => [...prev, normalizedMessage]);
      await refreshConversationHistory(workspaceId);
      const pendingMessages = [...messagesRef.current, normalizedMessage];
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
      });
      return;
    }

    let agentMessageIndex = -1;
    let agentPlaceholderId: ConversationMessage['id'] | null = null;
    setMessages((prevMessages) => {
      const placeholderId = `agent-${Date.now()}`;
      agentPlaceholderId = placeholderId;
      const placeholder: ConversationMessage = {
        id: placeholderId,
        conversationId,
        sender: 'agent',
        text: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        turnId: resolvedTurnId,
      };
      const updated = [...prevMessages, placeholder];
      agentMessageIndex = updated.length - 1;
      return updated;
    });
    if (agentPlaceholderId) {
      agentMessageBufferRef.current.set(agentPlaceholderId, '');
    }

    const controller = new AbortController();
    streamAbortRef.current = controller;
    setIsStreaming(true);

    try {
      await runAgentStream(
        workspaceId,
        persona,
        messageContent,
        historyPayload.length ? historyPayload : undefined,
        (chunk) => handleStreamChunk(agentMessageIndex, chunk),
        controller.signal
      );
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') {
        const stopLabel = stopRequestedRef.current ? '\n[Stopped by user]' : '\n[Stream cancelled]';
        appendAgentChunk(agentMessageIndex, stopLabel);
      } else {
        console.error('Failed to get agent response:', error);
        appendAgentChunk(agentMessageIndex, '\nSorry, something went wrong.');
      }
    } finally {
      setIsStreaming(false);
      streamAbortRef.current = null;
      stopRequestedRef.current = false;
      loadFilesForWorkspace(workspaceId);
    }

    if (agentMessageIndex >= 0) {
      const agentMessage = messagesRef.current[agentMessageIndex];
      const placeholderId = agentMessage?.id ?? null;
      const metadata = buildMessageMetadata(agentMessage);
      const bufferedText =
        placeholderId !== null && placeholderId !== undefined
          ? agentMessageBufferRef.current.get(placeholderId) ?? agentMessage?.text
          : agentMessage?.text;
      const placeholderTurnId = agentMessage?.turnId || resolvedTurnId;
      if (bufferedText) {
        try {
        const persisted = await appendConversationMessage(conversationId, 'agent', bufferedText, {
          turnId: placeholderTurnId,
          metadata,
        });
        const hydratedPersisted = mergeMessageMetadata(persisted);
        setMessages((prev) => {
          const updated = [...prev];
          const existing = updated[agentMessageIndex];
          updated[agentMessageIndex] = {
            ...hydratedPersisted,
            thinkingText: hydratedPersisted.thinkingText ?? existing?.thinkingText,
            toolEvents: hydratedPersisted.toolEvents ?? existing?.toolEvents,
          };
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
    }
  };

  const handleChatInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setChatMessage(value);
    updateMentionState(value, event.target.selectionStart ?? value.length);
  };

  const handleChatInputSelectionChange = (
    event: React.SyntheticEvent<HTMLTextAreaElement>
  ) => {
    const target = event.currentTarget;
    updateMentionState(target.value, target.selectionStart ?? target.value.length);
  };

  const handleChatInputKeyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      isMentionOpen &&
      (event.key === 'ArrowDown' || event.key === 'ArrowUp')
    ) {
      // Skip mention state recalculation when navigating suggestions
      return;
    }
    const target = event.currentTarget;
    updateMentionState(target.value, target.selectionStart ?? target.value.length);
  };

  const handleChatInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    cancelStream();
    if (!selectedWorkspace) {
      addLocalSystemMessage('Please select a workspace before starting a conversation.');
      return;
    }
    if (!selectedPersona) {
      addLocalSystemMessage('No persona selected. Please pick an agent persona.');
      return;
    }
    const workspaceId = selectedWorkspace.id;
    try {
      const conversation = await createConversationApi(workspaceId, selectedPersona);
      setActiveConversationId(conversation.id);
      setActiveConversationPersona(conversation.persona);
      agentMessageBufferRef.current.clear();
      setMessages([]);
      setChatMessage('');
      closeMention();
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

  const handleUpdateFile = async (id: number, content: string) => {
    if (!selectedWorkspace) return;

    try {
      await updateFileContent(selectedWorkspace.id, id, content);
      // Optionally, you can refetch the file or update it in the state
    } catch (error) {
      console.error('Failed to update file:', error);
    }
  };

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

  const handleInsertPresentationShortcut = () => {
    setChatMessage((prev) => {
      const trimmedStart = prev.trimStart();
      if (trimmedStart.toLowerCase().startsWith('/presentation')) {
        return prev;
      }
      const suffix = trimmedStart.length ? ` ${trimmedStart}` : '';
      return `/presentation${suffix} `;
    });
    closeMention();
    requestAnimationFrame(() => {
      if (chatInputRef.current) {
        const { value } = chatInputRef.current;
        chatInputRef.current.focus();
        chatInputRef.current.setSelectionRange(value.length, value.length);
      }
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
                          onClick={handleBulkDelete}
                          disabled={selectedFiles.size === 0}
                          className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50"
                        >
                          <Trash size={18} className="text-gray-600" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div
                    className={`flex-1 px-4 py-3 overflow-y-auto min-h-0 transition-opacity duration-200 ${isFilePaneVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                      }`}
                    aria-hidden={!isFilePaneVisible}
                  >
                    {files.map((file) => (
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
                          onChange={() => handleFileSelect(file.id)}
                          className="mr-3"
                        />
                        <div
                          onClick={() => {
                            setSelectedFile(file);
                            setSelectedFileDetails(null);
                            setFileContent('');
                            setIsEditMode(shouldForceEditMode(file.name));
                          }}
                          className="flex-1 flex items-start justify-between gap-2 min-w-0"
                        >
                          <span className="text-gray-800 break-all whitespace-normal leading-snug">
                            {file.name}
                          </span>
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
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Content Editor */}
                <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden min-w-0 min-h-0">
                  <div className="p-4 border-b border-gray-200 flex justify-between items-center">
                    <h3 className="text-lg font-semibold text-gray-800">
                      {selectedFile ? selectedFile.name : 'Editor'}
                    </h3>
                    <div className="flex items-center space-x-2">
                      {canCopyImageUrl && (
                        <button
                          type="button"
                          className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                          onClick={handleCopyImageUrl}
                          title={copiedImageUrl ? 'Copied!' : 'Copy public URL'}
                        >
                          <LinkIcon size={18} className="text-gray-600" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"
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
                            className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                            onClick={handlePrintActiveFile}
                            title="Print file"
                          >
                            <Printer size={18} className="text-gray-600" />
                          </button>
                          <button
                            type="button"
                            className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                            onClick={handleDownloadActiveFile}
                            title="Download file"
                          >
                            <Download size={18} className="text-gray-600" />
                          </button>
                        </>
                      )}
                      {!shouldForceEditMode(selectedFile?.name || '') && (
                        <button
                          className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"
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
                        className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                        onClick={() => selectedFile && handleUpdateFile(Number(selectedFile.id), fileContent)}
                        disabled={!isEditMode}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
                    {isEditMode ? (
                      <FileEditor
                        file={selectedFileDetails || selectedFile}
                        fileContent={fileContent}
                        onContentChange={setFileContent}
                      />
                    ) : (
                      <div className="h-full w-full">
                        <FileRenderer file={selectedFileDetails || selectedFile} fileContent={fileContent} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Right Pane: Agent Chat */}
            <div
              className="bg-white flex flex-col overflow-hidden min-h-0"
              style={agentPaneStyles}
            >
              <div className="p-4 border-b border-gray-200 flex justify-between items-center">
                <div className="flex items-center">
                  <button
                    onClick={() => setIsAgentPaneVisible(!isAgentPaneVisible)}
                    className="p-2 rounded-lg hover:bg-gray-200"
                    disabled={isEditMode}
                  >
                    <ChevronRight size={18} className={`text-gray-600 transition-transform duration-300 ${isAgentPaneVisible ? '' : 'rotate-180'}`} />
                  </button>
                  {isAgentPaneVisible && <h2 className="text-lg font-semibold text-gray-800 ml-2">Agent Chat</h2>}
                </div>
                {isAgentPaneVisible && (
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={handleNewChat}
                      className="p-2 rounded-lg hover:bg-gray-200"
                    >
                      <Plus size={18} className="text-gray-600" />
                    </button>
                    <button
                      onClick={toggleAgentPaneFullScreen}
                      className="p-2 rounded-lg hover:bg-gray-200"
                    >
                      {isAgentPaneFullScreen ? (
                        <Minimize2 size={18} className="text-gray-600" />
                      ) : (
                        <Maximize2 size={18} className="text-gray-600" />
                      )}
                    </button>
                  </div>
                )}
              </div>
              <div className={`flex-1 flex flex-col overflow-hidden min-h-0 ${isAgentPaneFullScreen || isAgentPaneVisible ? 'block' : 'hidden'
                }`}>
                <div className="p-4 border-b border-gray-200">
                  <PersonaSelector
                    personas={personas}
                    selectedPersona={selectedPersona}
                    onPersonaChange={setSelectedPersona}
                  />
                </div>
                <div className="p-4 border-b border-gray-200">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-700">Recent Conversations</p>
                  </div>
                  <div className="mt-3 space-y-2 max-h-40 overflow-y-auto">
                    {conversationHistory.length === 0 ? (
                      <p className="text-xs text-gray-500">No past conversations yet.</p>
                    ) : (
                      conversationHistory.map((conversation) => {
                        const isActive = conversation.id === activeConversationId;
                        return (
                          <div key={conversation.id} className="relative group">
                            <button
                              type="button"
                              onClick={() => handleSelectConversationFromHistory(conversation.id)}
                              className={`w-full text-left p-2 pr-9 rounded-lg border transition ${isActive
                                ? 'border-blue-500 bg-blue-50'
                                : 'border-gray-200 hover:border-blue-400 hover:bg-blue-50'
                                }`}
                            >
                              <p className="text-sm font-medium text-gray-800 truncate">{conversation.title}</p>
                              <p className="text-xs text-gray-500">
                                Persona: {conversation.persona} · {new Date(conversation.updatedAt).toLocaleString()}
                              </p>
                            </button>
                            <button
                              type="button"
                              aria-label="Delete conversation"
                              className="absolute top-1 right-1 p-1 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 focus:opacity-100 transition"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleDeleteConversation(conversation.id);
                              }}
                            >
                              <Trash size={14} />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
                <div className="flex-1 p-4 overflow-y-auto space-y-4 min-h-0">
                  {messages.map((message) => {
                    const isAgentMessage = message.sender === 'agent';
                    const timestampLabel = formatMessageTimestamp(message.updatedAt || message.createdAt);
                    const toolEvents = message.toolEvents || [];
                    const hasToolEvents = toolEvents.length > 0;
                    const isToolActivityExpanded = expandedToolMessages.has(message.id);
                    const isThinkingExpanded = expandedThinkingMessages.has(message.id);
                    const thinkingPreview = buildThinkingPreview(message.thinkingText || '', isThinkingExpanded);
                    const showThinkingToggle =
                      Boolean(message.thinkingText) && (message.thinkingText?.length || 0) > THOUGHT_PREVIEW_LIMIT;
                    const canCopyMessage =
                      Boolean((message.text && message.text.trim()) || (message.thinkingText && message.thinkingText.trim()));
                    const copyTitle = copiedMessageId === message.id ? 'Copied!' : 'Copy message';
                    const copyButtonPositionClass = message.sender === 'user' ? 'right-10' : 'right-2';
                    return (
                      <div
                        key={message.id}
                        className={`flex items-start gap-3 group ${isAgentMessage ? '' : 'justify-end'
                          }`}
                      >
                        {isAgentMessage && (
                          <div className="mr-1 flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-500 shadow-inner">
                            <Star size={18} className="text-white" />
                          </div>
                        )}
                        <div
                          style={{ width: '100%', maxWidth: '720px' }}
                          className="relative flex-1 md:flex-initial"
                        >
                          {isAgentMessage ? (
                            <div className="w-full rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 px-4 py-4 text-slate-800 shadow-lg">
                              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                                <span className="text-slate-600">{personaDisplayName}</span>
                                {timestampLabel && <span>{timestampLabel}</span>}
                              </div>
                              {message.thinkingText && (
                                <div className="mt-3 rounded-2xl border border-blue-100 bg-blue-50/80 px-3 py-3 text-[13px] text-slate-600 shadow-inner">
                                  <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-blue-500">
                                    <span>Thinking</span>
                                    {showThinkingToggle && (
                                      <button
                                        type="button"
                                        onClick={() => toggleThinkingVisibility(message.id)}
                                        className="text-blue-600 hover:text-blue-500"
                                      >
                                        {isThinkingExpanded ? 'Show less' : 'Expand'}
                                      </button>
                                    )}
                                  </div>
                                  <div className="mt-2 whitespace-pre-line leading-relaxed">{thinkingPreview}</div>
                                </div>
                              )}
                              {message.text ? (
                                <div className="agent-markdown mt-3 text-sm">
                                  <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={markdownComponents}
                                  >
                                    {message.text}
                                  </ReactMarkdown>
                                </div>
                              ) : (
                                <span className="mt-3 block text-sm text-slate-500">
                                  {message.thinkingText ? 'Finalizing response…' : 'Thinking…'}
                                </span>
                              )}
                              {hasToolEvents && (
                                <div className="mt-3">
                                  <button
                                    type="button"
                                    onClick={() => toggleToolActivityVisibility(message.id)}
                                    className="text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700"
                                  >
                                    {isToolActivityExpanded
                                      ? 'Hide tool activity'
                                      : `Show tool activity (${toolEvents.length})`}
                                  </button>
                                  {isToolActivityExpanded && (
                                    <div className="mt-2 rounded-2xl border border-slate-200 bg-white/80 px-3 py-3 text-xs text-slate-600 shadow-inner">
                                      {toolEvents.map((event, index) => {
                                        const isLast = index === toolEvents.length - 1;
                                        return (
                                          <div key={event.id || `${event.name}-${index}`} className="flex gap-3 pb-3 last:pb-0">
                                            <div className="flex flex-col items-center">
                                              <span
                                                className={`h-2.5 w-2.5 rounded-full ${event.status === 'completed' ? 'bg-emerald-500' : 'bg-amber-400'
                                                  }`}
                                              />
                                              {!isLast && <span className="flex-1 w-px bg-slate-200" />}
                                            </div>
                                            <div className="flex-1">
                                              <p
                                                className={`text-[11px] font-semibold uppercase tracking-wide ${event.status === 'error' ? 'text-red-500' : 'text-slate-500'
                                                  }`}
                                              >
                                                {event.name}
                                              </p>
                                              <p
                                                className={`text-sm ${event.status === 'error' ? 'text-red-600' : 'text-slate-700'
                                                  }`}
                                              >
                                                {event.summary ||
                                                  (event.status === 'completed'
                                                    ? 'Completed'
                                                    : event.status === 'error'
                                                      ? 'Failed'
                                                      : 'In progress…')}
                                              </p>
                                              <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-400">
                                                {formatMessageTimestamp(event.startedAt)}
                                                {event.finishedAt ? ` • ${formatMessageTimestamp(event.finishedAt)}` : ''}
                                              </p>
                                              {event.outputFiles?.length ? (
                                                <div className="mt-2 space-y-3">
                                                  {event.outputFiles.map((file) => (
                                                    <div
                                                      key={`${event.id}-${file.path}`}
                                                      className="rounded-lg border border-gray-200 bg-white p-2"
                                                    >
                                                      <p className="text-xs font-semibold text-gray-700">{file.path}</p>
                                                      <ToolOutputFilePreview
                                                        workspaceId={selectedWorkspace?.id}
                                                        file={file}
                                                      />
                                                    </div>
                                                  ))}
                                                </div>
                                              ) : null}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="rounded-2xl bg-gradient-to-br from-blue-600 to-blue-500 px-4 py-3 text-sm text-white shadow-lg">
                              <p className="whitespace-pre-line leading-relaxed">{message.text}</p>
                              {timestampLabel && (
                                <span className="mt-2 block text-[11px] uppercase tracking-wide text-white/70">
                                  {timestampLabel}
                                </span>
                              )}
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => handleCopyMessageText(message)}
                            disabled={!canCopyMessage}
                            title={copyTitle}
                            aria-label="Copy message text"
                            className={`absolute -top-2 ${copyButtonPositionClass} rounded-full bg-white p-1.5 text-gray-600 shadow ring-1 ring-slate-200 transition opacity-0 group-hover:opacity-100 hover:bg-gray-50 focus-visible:opacity-100 disabled:opacity-40 disabled:cursor-not-allowed`}
                          >
                            <Copy size={14} />
                          </button>
                          {message.sender === 'user' && (
                            <button
                              type="button"
                              onClick={() => handleRerunMessage(message.id)}
                              disabled={isStreaming}
                              title="Rerun this message"
                              className={`absolute -top-2 -right-2 rounded-full bg-blue-500 p-1.5 text-white shadow transition-opacity opacity-0 ${isStreaming
                                ? 'cursor-not-allowed group-hover:opacity-60 hover:opacity-60'
                                : 'group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100'
                                }`}
                            >
                              <RotateCcw size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="border-t border-gray-200 bg-white p-4">
                  <div className="space-y-3">
                    {chatAttachments.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {chatAttachments.map((file, index) => (
                          <span
                            key={`${file.name}-${index}`}
                            className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700"
                          >
                            {file.name}
                            <button
                              type="button"
                              className="text-blue-600 hover:text-blue-800"
                              onClick={() => handleRemoveChatAttachment(index)}
                              aria-label={`Remove ${file.name}`}
                            >
                              <X size={14} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="relative rounded-2xl border border-gray-200 bg-gray-50 p-3 shadow-sm focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-100">
                      <div className="flex items-end gap-3">
                        <button
                          type="button"
                          onClick={handleChatAttachmentButtonClick}
                          className="w-11 h-11 rounded-full border border-dashed border-blue-400 text-blue-600 bg-white flex items-center justify-center hover:bg-blue-50 shrink-0"
                          title="Attach files or images"
                        >
                          <Plus size={18} />
                        </button>
                        <div className="flex-1 flex flex-col gap-2 min-w-0">
                          <textarea
                            placeholder="Interact with the agent..."
                            value={chatMessage}
                            ref={chatInputRef}
                            onChange={handleChatInputChange}
                            onKeyDown={handleChatInputKeyDown}
                            onKeyUp={handleChatInputKeyUp}
                            onSelect={handleChatInputSelectionChange}
                            className="w-full bg-transparent resize-none text-sm leading-relaxed focus:outline-none placeholder:text-gray-500 text-gray-900"
                            rows={3}
                            style={{ overflowY: 'auto' }}
                          />
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={handleInsertPresentationShortcut}
                              className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 shadow-sm transition hover:bg-blue-50"
                              title="Generate presentation slides"
                            >
                              <MonitorPlay size={14} />
                              the presentation
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={isStreaming ? handleStopStreaming : handleSendMessage}
                            disabled={false}
                            className={`w-11 h-11 rounded-full flex items-center justify-center text-white shadow-sm transition ${isStreaming ? 'bg-red-500 hover:bg-red-400' : 'bg-blue-600 hover:bg-blue-700'}`}
                            title={isStreaming ? 'Stop current agent response' : 'Send message'}
                          >
                            {isStreaming ? <StopCircle size={18} /> : <Send size={18} />}
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
                      {isMentionOpen && (
                        <div className="absolute bottom-full mb-2 left-0 right-0 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto z-10">
                          {mentionSuggestions.length ? (
                            mentionSuggestions.map((file, index) => (
                              <button
                                key={file.id}
                                type="button"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  handleSelectMention(file);
                                }}
                                className={`w-full flex items-center text-left px-3 py-2 text-sm hover:bg-blue-50 ${index === mentionSelectedIndex ? 'bg-blue-50 text-blue-700' : 'text-gray-800'
                                  }`}
                              >
                                <FileIcon size={16} className="mr-2 text-gray-500" />
                                <span className="truncate">{file.name}</span>
                              </button>
                            ))
                          ) : (
                            <div className="px-3 py-2 text-sm text-gray-500">No matching files</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Box>
      </Box>
    </ThemeProvider>
  );
}
