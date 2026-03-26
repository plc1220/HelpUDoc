import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { editor as MonacoEditorNamespace } from 'monaco-editor';
import { Eye, EyeOff } from 'lucide-react';
import type { File as WorkspaceFile } from '../types';
import { getAuthUser } from '../auth/authStore';
import { createFile } from '../services/fileApi';
import { createCollabSession } from '../services/collabClient';
import EditorLoadingState from './EditorLoadingState';
import type { MarkdownRichEditorHandle } from './MarkdownRichEditor';

const MonacoEditor = lazy(() => import('@monaco-editor/react'));
const MarkdownRichEditor = lazy(() => import('./MarkdownRichEditor'));

const COLLAB_COLORS = [
  '#0ea5e9',
  '#f97316',
  '#10b981',
  '#e11d48',
  '#a855f7',
  '#14b8a6',
  '#f59e0b',
  '#6366f1',
];

const hashToColor = (seed: string) => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % COLLAB_COLORS.length;
  return COLLAB_COLORS[index];
};

const formatPresenceName = (name: string) => name.trim() || 'Anonymous';

const getLanguage = (fileName: string) => {
  const extension = fileName.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'py':
      return 'python';
    case 'java':
      return 'java';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'hpp':
    case 'cc':
      return 'cpp';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'php':
      return 'php';
    case 'rb':
      return 'ruby';
    case 'sh':
    case 'bash':
      return 'shell';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'xml':
      return 'xml';
    case 'sql':
      return 'sql';
    default:
      return 'plaintext';
  }
};

interface FileEditorProps {
  file: WorkspaceFile | null;
  fileContent: string;
  onContentChange: (content: string) => void;
  workspaceId: string;
  colorMode: 'light' | 'dark';
}

const FileEditor: React.FC<FileEditorProps> = ({
  file,
  fileContent,
  onContentChange,
  workspaceId,
  colorMode,
}) => {
  const fileId = file?.id ? String(file.id) : null;
  const fileName = file?.name ?? '';
  const isDraftFile = Boolean(fileId && fileId.startsWith('draft:'));
  const editorRef = useRef<MonacoEditorNamespace.IStandaloneCodeEditor | null>(null);
  const mdxEditorRef = useRef<MarkdownRichEditorHandle | null>(null);
  const collabSessionRef = useRef<ReturnType<typeof createCollabSession> | null>(null);
  const monacoBindingRef = useRef<{ destroy: () => void } | null>(null);
  const presenceStyleRef = useRef<HTMLStyleElement | null>(null);
  const lastContentRef = useRef<string>(fileContent);
  const isApplyingRemoteRef = useRef(false);
  const mdxOriginRef = useRef({ source: 'mdx-editor' });
  const syncOriginRef = useRef({ source: 'collab-sync' });
  const hasSeededRef = useRef(false);
  const [collabReady, setCollabReady] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [presenceUsers, setPresenceUsers] = useState<Array<{ clientId: number; name: string; color: string }>>([]);
  const [isRawView, setIsRawView] = useState(false);
  const [mdxError, setMdxError] = useState<string | null>(null);
  const isDarkMode = colorMode === 'dark';
  const monacoTheme = isDarkMode ? 'helpudoc-nord' : 'vs';

  const handleImageUpload = useCallback(async (image: File) => {
    const created = await createFile(workspaceId, image);
    if (!created?.publicUrl) {
      throw new Error('Image upload did not return a public URL.');
    }
    return created.publicUrl;
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;

    if (!fileName || getLanguage(fileName) === 'markdown') {
      return undefined;
    }

    void import('monaco-editor').then(({ editor }) => {
      if (cancelled) return;

      if (isDarkMode) {
        editor.defineTheme('helpudoc-nord', {
          base: 'vs-dark',
          inherit: true,
          rules: [
            { token: 'comment', foreground: '4c566a' },
            { token: 'string', foreground: 'a3be8c' },
            { token: 'number', foreground: 'b48ead' },
            { token: 'keyword', foreground: '81a1c1' },
            { token: 'type.identifier', foreground: '8fbcbb' },
            { token: 'delimiter', foreground: 'd8dee9' },
            { token: 'tag', foreground: '81a1c1' },
            { token: 'attribute.name', foreground: '88c0d0' },
            { token: 'attribute.value', foreground: 'a3be8c' },
          ],
          colors: {
            'editor.background': '#2e3440',
            'editor.foreground': '#d8dee9',
            'editorLineNumber.foreground': '#4c566a',
            'editorLineNumber.activeForeground': '#eceff4',
            'editorCursor.foreground': '#d8dee9',
            'editor.selectionBackground': '#434c5e',
            'editor.inactiveSelectionBackground': '#3b4252',
            'editorIndentGuide.background': '#3b4252',
            'editorIndentGuide.activeBackground': '#4c566a',
          },
        });
        editor.setTheme('helpudoc-nord');
        return;
      }

      editor.setTheme('vs');
    });

    return () => {
      cancelled = true;
    };
  }, [fileName, isDarkMode]);

  const handleEditorDidMount = (editorInstance: MonacoEditorNamespace.IStandaloneCodeEditor) => {
    editorRef.current = editorInstance;
    void bindMonaco();
  };

  const applyFormat = (format: 'bold' | 'italic' | 'heading') => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;

    const selection = editorInstance.getSelection();
    if (!selection) return;

    const model = editorInstance.getModel();
    if (!model) return;

    const text = model.getValueInRange(selection);
    let formattedText = '';

    switch (format) {
      case 'bold':
        formattedText = `**${text}**`;
        break;
      case 'italic':
        formattedText = `*${text}*`;
        break;
      case 'heading':
        formattedText = `# ${text}`;
        break;
    }

    editorInstance.executeEdits('toolbar', [
      {
        range: selection,
        text: formattedText,
        forceMoveMarkers: true,
      },
    ]);
  };

  const handleUndo = () => {
    editorRef.current?.trigger('toolbar', 'undo', null);
  };

  const handleRedo = () => {
    editorRef.current?.trigger('toolbar', 'redo', null);
  };

  const applyTextUpdate = (nextValue: string) => {
    const session = collabSessionRef.current;
    if (!session) {
      onContentChange(nextValue);
      return;
    }

    const yText = session.yText;
    const current = yText.toString();
    if (current === nextValue) {
      return;
    }

    let start = 0;
    const currentLength = current.length;
    const nextLength = nextValue.length;
    while (start < currentLength && start < nextLength && current[start] === nextValue[start]) {
      start += 1;
    }

    let endCurrent = currentLength - 1;
    let endNext = nextLength - 1;
    while (endCurrent >= start && endNext >= start && current[endCurrent] === nextValue[endNext]) {
      endCurrent -= 1;
      endNext -= 1;
    }

    const deleteCount = endCurrent - start + 1;
    const insertText = nextValue.slice(start, endNext + 1);

    session.doc.transact(() => {
      if (deleteCount > 0) {
        yText.delete(start, deleteCount);
      }
      if (insertText) {
        yText.insert(start, insertText);
      }
    }, mdxOriginRef.current);
  };

  const ensurePresenceStyles = useCallback((users: Array<{ clientId: number; color: string }>) => {
    if (typeof document === 'undefined') return;
    if (!presenceStyleRef.current) {
      const styleEl = document.createElement('style');
      styleEl.setAttribute('data-collab-presence', 'true');
      document.head.appendChild(styleEl);
      presenceStyleRef.current = styleEl;
    }
    const rules = users
      .map((user) => (
        `.yRemoteSelection-${user.clientId} { background-color: ${user.color}33; }`
        + `.yRemoteSelectionHead-${user.clientId} { border-left: 2px solid ${user.color}; border-right: 2px solid ${user.color}; }`
      ))
      .join('\n');
    presenceStyleRef.current.textContent = rules;
  }, []);

  const bindMonaco = useCallback(async () => {
    if (!fileName || getLanguage(fileName) === 'markdown') return;
    const session = collabSessionRef.current;
    if (!session) return;
    const editorInstance = editorRef.current;
    if (!editorInstance) return;
    const model = editorInstance.getModel();
    if (!model) return;

    try {
      const { MonacoBinding } = await import('y-monaco');
      if (collabSessionRef.current !== session || editorRef.current !== editorInstance) {
        return;
      }

      monacoBindingRef.current?.destroy();
      monacoBindingRef.current = new MonacoBinding(
        session.yText,
        model,
        new Set([editorInstance]),
        session.provider.awareness ?? undefined,
      );
      setCollabReady(true);
    } catch (error) {
      console.error('Failed to initialize Monaco collaboration binding', error);
    }
  }, [fileName]);

  useEffect(() => {
    lastContentRef.current = fileContent;
  }, [fileContent]);

  useEffect(() => {
    setMdxError(null);
  }, [fileId, isRawView]);

  useEffect(() => {
    if (!fileId || isDraftFile) {
      setCollabReady(false);
      setPresenceUsers([]);
      setConnectionStatus('disconnected');
      return;
    }

    const session = createCollabSession(workspaceId, fileId);
    collabSessionRef.current = session;
    setCollabReady(false);
    setConnectionStatus('connecting');
    hasSeededRef.current = false;

    const authUser = getAuthUser();
    const localName = formatPresenceName(authUser?.name ?? 'Local User');
    const localColor = hashToColor(authUser?.id ?? localName);
    if (session.provider.awareness) {
      session.provider.awareness.setLocalStateField('user', {
        name: localName,
        color: localColor,
      });
    }

    const yText = session.yText;
    const handleTextChange = (_event: unknown, transaction: { origin?: unknown }) => {
      const nextValue = yText.toString();
      if (nextValue === lastContentRef.current) {
        return;
      }
      lastContentRef.current = nextValue;
      onContentChange(nextValue);

      const isMarkdownFile = fileName ? getLanguage(fileName) === 'markdown' : false;
      if (isMarkdownFile && transaction.origin !== mdxOriginRef.current) {
        const editorInstance = mdxEditorRef.current;
        if (editorInstance) {
          isApplyingRemoteRef.current = true;
          editorInstance.setMarkdown(nextValue);
          isApplyingRemoteRef.current = false;
        }
      }
    };

    const updatePresence = () => {
      const awareness = session.provider.awareness;
      if (!awareness) {
        setPresenceUsers([]);
        return;
      }
      const states = Array.from(awareness.getStates().entries()).map(([clientId, state]) => {
        const user = (state as { user?: { name?: string; color?: string } }).user;
        const name = formatPresenceName(user?.name ?? `User ${clientId}`);
        const color = user?.color ?? hashToColor(String(clientId));
        return { clientId, name, color };
      });
      const others = states.filter((entry) => entry.clientId !== session.doc.clientID);
      setPresenceUsers(others);
      ensurePresenceStyles(states);
    };

    const handleStatus = (event: { status: string }) => {
      setConnectionStatus(event.status);
    };

    const handleAwarenessChange = () => {
      updatePresence();
    };

    yText.observe(handleTextChange);
    void bindMonaco();
    updatePresence();
    session.provider.on('status', handleStatus);
    session.provider.on('awarenessChange', handleAwarenessChange);

    return () => {
      yText.unobserve(handleTextChange);
      session.provider.off('status', handleStatus);
      session.provider.off('awarenessChange', handleAwarenessChange);
      monacoBindingRef.current?.destroy();
      monacoBindingRef.current = null;
      session.provider.destroy();
      session.doc.destroy();
      collabSessionRef.current = null;
      setPresenceUsers([]);
      setConnectionStatus('disconnected');
    };
  }, [fileId, fileName, isDraftFile, workspaceId, onContentChange, bindMonaco, ensurePresenceStyles]);

  useEffect(() => {
    const session = collabSessionRef.current;
    if (!session || !fileId || isDraftFile || hasSeededRef.current) return;

    if (session.yText.length > 0) {
      hasSeededRef.current = true;
      return;
    }

    if (!fileContent) return;

    session.doc.transact(() => {
      session.yText.insert(0, fileContent);
    }, syncOriginRef.current);
    hasSeededRef.current = true;
  }, [fileContent, fileId, isDraftFile]);

  if (!file) {
    return null;
  }

  const isMarkdown = getLanguage(file.name) === 'markdown';
  const statusLabel = connectionStatus === 'connected'
    ? 'Live'
    : connectionStatus === 'connecting'
      ? 'Connecting'
      : 'Offline';
  const statusColor = connectionStatus === 'connected'
    ? 'bg-emerald-500'
    : connectionStatus === 'connecting'
      ? 'bg-amber-500'
      : 'bg-gray-400';
  const visibleUsers = presenceUsers.slice(0, 3);
  const overflowCount = presenceUsers.length - visibleUsers.length;

  return (
    <div className="h-full flex flex-col">
      <div className="bg-gray-100 px-2 py-1 border-b flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 text-gray-600">
          <span className={`inline-block h-2 w-2 rounded-full ${statusColor}`} />
          <span>{statusLabel}</span>
        </div>
        <div className="flex items-center gap-1">
          {visibleUsers.map((user) => (
            <div
              key={user.clientId}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-gray-200 bg-white text-gray-700"
            >
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: user.color }} />
              <span className="max-w-[120px] truncate">{user.name}</span>
            </div>
          ))}
          {overflowCount > 0 && (
            <span className="text-gray-500">+{overflowCount}</span>
          )}
          {presenceUsers.length === 0 && (
            <span className="text-gray-400">No collaborators</span>
          )}
        </div>
      </div>
      {!isMarkdown && (
        <div className="bg-white/95 p-1 border-b border-slate-200 backdrop-blur">
          <button
            onClick={handleUndo}
            className="px-2 py-1 mr-1 border border-slate-200 rounded text-slate-700 hover:bg-slate-100"
          >
            Undo
          </button>
          <button
            onClick={handleRedo}
            className="px-2 py-1 mr-1 border border-slate-200 rounded text-slate-700 hover:bg-slate-100"
          >
            Redo
          </button>
          <button
            onClick={() => applyFormat('bold')}
            className="px-2 py-1 mr-1 border border-slate-200 rounded text-slate-700 hover:bg-slate-100 font-bold"
          >
            B
          </button>
          <button
            onClick={() => applyFormat('italic')}
            className="px-2 py-1 mr-1 border border-slate-200 rounded text-slate-700 hover:bg-slate-100 italic"
          >
            I
          </button>
          <button
            onClick={() => applyFormat('heading')}
            className="px-2 py-1 mr-1 border border-slate-200 rounded text-slate-700 hover:bg-slate-100"
          >
            H
          </button>
        </div>
      )}
      <div className="flex-grow overflow-auto">
        {isMarkdown ? (
          <div className="helpudoc-mdxeditor-shell h-full overflow-y-auto flex flex-col" style={{ maxHeight: 'calc(100vh - 200px)' }}>
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50">
              <span className="text-xs font-medium text-gray-500">
                {isRawView ? 'Raw Markdown' : 'Rich Editor'}
              </span>
              <button
                type="button"
                onClick={() => {
                  setIsRawView(!isRawView);
                }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-600 hover:bg-gray-200 transition-colors"
                title={isRawView ? 'Switch to Rich Editor' : 'View Raw Markdown'}
              >
                {isRawView ? (
                  <>
                    <Eye size={14} />
                    <span>Rich View</span>
                  </>
                ) : (
                  <>
                    <EyeOff size={14} />
                    <span>Raw View</span>
                  </>
                )}
              </button>
            </div>
            {isRawView ? (
              <textarea
                className="flex-1 w-full h-full p-4 font-mono text-sm border-none resize-none focus:outline-none focus:ring-0 bg-white"
                value={fileContent}
                onChange={(event) => {
                  applyTextUpdate(event.target.value);
                }}
                placeholder="Enter markdown content..."
                spellCheck={false}
              />
            ) : (
              <>
                {mdxError && (
                  <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
                    {mdxError}
                  </div>
                )}
                <Suspense fallback={<EditorLoadingState className="min-h-[320px] flex-1" label="Loading rich editor..." />}>
                  <MarkdownRichEditor
                    ref={mdxEditorRef}
                    markdown={fileContent}
                    onChange={(value) => {
                      if (isApplyingRemoteRef.current) return;
                      setMdxError(null);
                      applyTextUpdate(value);
                    }}
                    onError={setMdxError}
                    onImageUpload={handleImageUpload}
                  />
                </Suspense>
              </>
            )}
          </div>
        ) : (
          <Suspense fallback={<EditorLoadingState />}>
          <MonacoEditor
              height="100%"
              language={getLanguage(file.name)}
              defaultValue={fileContent}
              value={collabReady ? undefined : fileContent}
              onMount={handleEditorDidMount}
              onChange={(value) => {
                if (collabReady) return;
                onContentChange(value || '');
              }}
              theme={monacoTheme}
              options={{
                readOnly: !collabReady,
                wordWrap: 'on',
                wrappingIndent: 'indent',
                minimap: { enabled: false },
                lineHeight: 22,
                fontSize: 14,
              }}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
};

export default FileEditor;
