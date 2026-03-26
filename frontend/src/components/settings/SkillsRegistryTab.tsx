import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  RefreshCw,
  Loader2,
  Save,
  FolderOpen,
  AlertCircle,
  Search,
  ChevronRight,
  MessageSquare,
  Paperclip,
  Upload,
  X,
  Wand2,
  Github,
  Play,
  CheckCircle2,
  Minimize2,
  Maximize2,
} from 'lucide-react';
import Editor from '@monaco-editor/react';
import {
  applyGithubSkillImport,
  applySkillBuilderActions,
  cancelSkillBuilderRun,
  createSkill,
  createSkillBuilderSession,
  deleteSkillBuilderContextFile,
  fetchSkillContent,
  fetchSkillFiles,
  fetchSkills,
  inspectGithubSkillImport,
  listSkillBuilderContextFiles,
  parseSkillBuilderActions,
  saveSkillContent,
  startSkillBuilderRun,
  streamSkillBuilderRun,
  submitSkillBuilderDecision,
  uploadSkillBuilderContextFile,
  type GithubImportInspectResult,
  type SkillBuilderAction,
  type SkillBuilderContextFile,
} from '../../services/settingsApi';
import type { SkillDefinition } from '../../types';

const BUILDER_COLLAPSED_KEY = 'settings.skillBuilder.collapsed';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  runId?: string;
  createdAt: string;
};

const ACCEPT_UPLOADS = '.py,.md,.txt,.pdf,.csv,.json,.yaml,.yml,.png,.jpg,.jpeg,.webp,.gif,.svg';

const makeId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const primaryButtonClass = 'settings-button-primary inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-60';
const secondaryButtonClass = 'settings-portal-button-secondary inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs transition disabled:opacity-60';
const workbenchColumnClass = 'settings-workbench-column flex flex-col overflow-hidden rounded-xl';

const SkillsRegistryTab: React.FC = () => {
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isAdding, setIsAdding] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);

  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);

  const [searchTerm, setSearchTerm] = useState('');

  const [builderCollapsed, setBuilderCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(BUILDER_COLLAPSED_KEY) === '1';
  });
  const [builderReady, setBuilderReady] = useState(false);
  const [builderWorkspaceId, setBuilderWorkspaceId] = useState<string>('');
  const [builderMessages, setBuilderMessages] = useState<ChatMessage[]>([]);
  const [builderPrompt, setBuilderPrompt] = useState('');
  const [builderRunning, setBuilderRunning] = useState(false);
  const [builderRunId, setBuilderRunId] = useState<string | null>(null);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [contextFiles, setContextFiles] = useState<SkillBuilderContextFile[]>([]);
  const [contextUploading, setContextUploading] = useState(false);
  const [selectedContextIds, setSelectedContextIds] = useState<string[]>([]);
  const [proposedActions, setProposedActions] = useState<SkillBuilderAction[]>([]);
  const [actionsError, setActionsError] = useState<string | null>(null);
  const [applyingActionIndex, setApplyingActionIndex] = useState<number | null>(null);
  const [applyingAll, setApplyingAll] = useState(false);

  const [githubModalOpen, setGithubModalOpen] = useState(false);
  const [githubUrl, setGithubUrl] = useState('');
  const [githubRef, setGithubRef] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [githubInspectLoading, setGithubInspectLoading] = useState(false);
  const [githubApplyLoading, setGithubApplyLoading] = useState(false);
  const [githubInspectResult, setGithubInspectResult] = useState<GithubImportInspectResult | null>(null);
  const [githubImportError, setGithubImportError] = useState<string | null>(null);

  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === selectedSkillId) || null,
    [skills, selectedSkillId],
  );

  const filteredSkills = useMemo(() => {
    if (!searchTerm) return skills;
    const lower = searchTerm.toLowerCase();
    return skills.filter(
      (s) =>
        s.id.toLowerCase().includes(lower)
        || (s.name && s.name.toLowerCase().includes(lower))
        || (s.description && s.description.toLowerCase().includes(lower)),
    );
  }, [skills, searchTerm]);

  const loadSkills = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchSkills();
      setSkills(data);
      setError(null);
    } catch (err) {
      console.error('Failed to load skills', err);
      setError('Failed to load skills');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadContextFiles = useCallback(async () => {
    try {
      const filesList = await listSkillBuilderContextFiles();
      setContextFiles(filesList);
      setSelectedContextIds((prev) => prev.filter((id) => filesList.some((f) => f.fileId === id)));
    } catch (err) {
      console.error('Failed to load context files', err);
    }
  }, []);

  const setupBuilderSession = useCallback(async () => {
    try {
      const session = await createSkillBuilderSession();
      setBuilderWorkspaceId(session.workspaceId);
      setBuilderReady(true);
      setBuilderError(null);
      await loadContextFiles();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to initialize Skill Builder';
      setBuilderError(message);
    }
  }, [loadContextFiles]);

  useEffect(() => {
    loadSkills();
    setupBuilderSession();
  }, [loadSkills, setupBuilderSession]);

  useEffect(() => {
    if (!selectedSkillId && skills.length > 0) {
      setSelectedSkillId(skills[0].id);
    }
  }, [skills, selectedSkillId]);

  useEffect(() => {
    const loadFiles = async () => {
      if (!selectedSkillId) {
        setFiles([]);
        setSelectedFile(null);
        return;
      }
      try {
        setFilesLoading(true);
        const data = await fetchSkillFiles(selectedSkillId);
        setFiles(data);
        if (data.length > 0) {
          const preferred = data.find((f) => f === 'SKILL.md') || data[0];
          setSelectedFile(preferred);
        } else {
          setSelectedFile(null);
        }
      } catch (err) {
        console.error('Failed to load skill files', err);
        setFiles([]);
      } finally {
        setFilesLoading(false);
      }
    };
    void loadFiles();
  }, [selectedSkillId]);

  useEffect(() => {
    const loadContent = async () => {
      if (!selectedSkillId || !selectedFile) {
        setFileContent('');
        return;
      }
      try {
        setFileLoading(true);
        const content = await fetchSkillContent(selectedSkillId, selectedFile);
        setFileContent(content);
      } catch (err) {
        console.error('Failed to load skill file content', err);
        setFileContent('');
      } finally {
        setFileLoading(false);
      }
    };
    void loadContent();
  }, [selectedSkillId, selectedFile]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(BUILDER_COLLAPSED_KEY, builderCollapsed ? '1' : '0');
  }, [builderCollapsed]);

  useEffect(() => () => {
    streamAbortRef.current?.abort();
  }, []);

  const handleCreateSkill = async () => {
    if (!newId) {
      setCreateError('Skill ID is required');
      return;
    }

    try {
      setCreateLoading(true);
      setCreateError(null);
      await createSkill({ id: newId, name: newName || undefined, description: newDesc || undefined });
      await loadSkills();
      setSelectedSkillId(newId);
      setIsAdding(false);
      setNewId('');
      setNewName('');
      setNewDesc('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create skill';
      setCreateError(message);
    } finally {
      setCreateLoading(false);
    }
  };

  const handleSaveFile = async () => {
    if (!selectedSkillId || !selectedFile) return;
    try {
      setFileSaving(true);
      await saveSkillContent(selectedSkillId, selectedFile, fileContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save skill file';
      alert(message);
    } finally {
      setFileSaving(false);
    }
  };

  const getLanguage = (fileName: string) => {
    if (fileName.endsWith('.json')) return 'json';
    if (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) return 'typescript';
    if (fileName.endsWith('.js') || fileName.endsWith('.jsx')) return 'javascript';
    if (fileName.endsWith('.py')) return 'python';
    if (fileName.endsWith('.md')) return 'markdown';
    if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) return 'yaml';
    if (fileName.endsWith('.css')) return 'css';
    if (fileName.endsWith('.html')) return 'html';
    return 'plaintext';
  };

  const appendMessage = (message: ChatMessage) => {
    setBuilderMessages((prev) => [...prev, message]);
  };

  const updateAssistantMessage = (runId: string, content: string) => {
    setBuilderMessages((prev) => {
      const idx = prev.findIndex((m) => m.runId === runId && m.role === 'assistant');
      if (idx < 0) {
        return [...prev, { id: makeId(), role: 'assistant', text: content, runId, createdAt: new Date().toISOString() }];
      }
      const updated = [...prev];
      updated[idx] = { ...updated[idx], text: content };
      return updated;
    });
  };

  const parseActionsFromMessages = useCallback(async () => {
    const assistantText = [...builderMessages]
      .reverse()
      .find((msg) => msg.role === 'assistant' && msg.text.trim())
      ?.text;

    if (!assistantText) {
      setActionsError('No assistant output to parse actions from.');
      return;
    }

    try {
      setActionsError(null);
      const actions = await parseSkillBuilderActions(assistantText);
      setProposedActions(actions);
      if (!actions.length) {
        setActionsError('No actions found in assistant output.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to parse actions';
      setActionsError(message);
    }
  }, [builderMessages]);

  const handleSendPrompt = async () => {
    if (!builderPrompt.trim() || !builderReady || builderRunning) return;

    const prompt = builderPrompt.trim();
    setBuilderPrompt('');
    setBuilderError(null);
    setActionsError(null);

    appendMessage({ id: makeId(), role: 'user', text: prompt, createdAt: new Date().toISOString() });

    try {
      setBuilderRunning(true);
      const run = await startSkillBuilderRun({
        prompt,
        selectedSkillId: selectedSkillId || undefined,
        contextFileIds: selectedContextIds,
        history: builderMessages.map((msg) => ({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.text,
        })),
      });

      setBuilderRunId(run.runId);

      const controller = new AbortController();
      streamAbortRef.current = controller;
      let assistantBuffer = '';

      await streamSkillBuilderRun(
        run.runId,
        async (chunk) => {
          if (chunk.type === 'token' || chunk.type === 'chunk' || chunk.type === 'thought' || chunk.type === 'tool_end' || chunk.type === 'tool_start' || chunk.type === 'tool_error') {
            const text = (chunk as { content?: string }).content || '';
            if (text) {
              assistantBuffer += text;
              updateAssistantMessage(run.runId, assistantBuffer);
            }
          } else if (chunk.type === 'interrupt') {
            appendMessage({
              id: makeId(),
              role: 'system',
              runId: run.runId,
              text: 'Approval required. Use Approve / Reject below to continue.',
              createdAt: new Date().toISOString(),
            });
          } else if (chunk.type === 'error') {
            appendMessage({
              id: makeId(),
              role: 'system',
              runId: run.runId,
              text: chunk.message || 'Run failed',
              createdAt: new Date().toISOString(),
            });
          } else if (chunk.type === 'done') {
            if (!assistantBuffer.trim()) {
              appendMessage({
                id: makeId(),
                role: 'assistant',
                runId: run.runId,
                text: '(Done)',
                createdAt: new Date().toISOString(),
              });
            } else {
              try {
                setActionsError(null);
                const actions = await parseSkillBuilderActions(assistantBuffer);
                setProposedActions(actions);
              } catch {
                // Best-effort parse from current stream payload; fallback to full message parse below.
              }
            }
            await parseActionsFromMessages();
          }
        },
        controller.signal,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to run Skill Builder';
      setBuilderError(message);
      appendMessage({ id: makeId(), role: 'system', text: message, createdAt: new Date().toISOString() });
    } finally {
      setBuilderRunning(false);
      setBuilderRunId(null);
      streamAbortRef.current = null;
    }
  };

  const handleRunDecision = async (decision: 'approve' | 'reject') => {
    if (!builderRunId) return;
    try {
      await submitSkillBuilderDecision(builderRunId, decision);
      appendMessage({
        id: makeId(),
        role: 'system',
        text: decision === 'approve' ? 'Approval submitted.' : 'Rejection submitted.',
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to submit decision';
      setBuilderError(message);
    }
  };

  const handleCancelRun = async () => {
    if (!builderRunId) return;
    try {
      await cancelSkillBuilderRun(builderRunId);
      streamAbortRef.current?.abort();
      setBuilderRunning(false);
      setBuilderRunId(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to cancel run';
      setBuilderError(message);
    }
  };

  const handleContextUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const filesList = event.target.files;
    if (!filesList || filesList.length === 0) return;

    const file = filesList[0];
    try {
      setContextUploading(true);
      const uploaded = await uploadSkillBuilderContextFile(file);
      setContextFiles((prev) => [...prev, uploaded]);
      setSelectedContextIds((prev) => [...prev, uploaded.fileId]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload context file';
      setBuilderError(message);
    } finally {
      setContextUploading(false);
      event.target.value = '';
    }
  };

  const handleDeleteContextFile = async (fileId: string) => {
    try {
      await deleteSkillBuilderContextFile(fileId);
      setContextFiles((prev) => prev.filter((f) => f.fileId !== fileId));
      setSelectedContextIds((prev) => prev.filter((id) => id !== fileId));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete context file';
      setBuilderError(message);
    }
  };

  const toggleContextSelection = (fileId: string) => {
    setSelectedContextIds((prev) => (prev.includes(fileId)
      ? prev.filter((id) => id !== fileId)
      : [...prev, fileId]));
  };

  const applyAction = async (action: SkillBuilderAction, index: number) => {
    setApplyingActionIndex(index);
    setActionsError(null);
    try {
      const result = await applySkillBuilderActions([action]);
      if (!result.success) {
        throw new Error(result.error || 'Failed to apply action');
      }
      await loadSkills();
      if (action.skillId) {
        setSelectedSkillId(action.skillId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to apply action';
      setActionsError(message);
    } finally {
      setApplyingActionIndex(null);
    }
  };

  const applyAllActions = async () => {
    if (!proposedActions.length) return;
    setApplyingAll(true);
    setActionsError(null);
    try {
      const result = await applySkillBuilderActions(proposedActions);
      if (!result.success) {
        throw new Error(result.error || 'Failed to apply actions');
      }
      await loadSkills();
      const createAction = proposedActions.find((a) => a.type === 'create_skill');
      if (createAction?.skillId) {
        setSelectedSkillId(createAction.skillId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to apply actions';
      setActionsError(message);
    } finally {
      setApplyingAll(false);
    }
  };

  const handleGithubInspect = async () => {
    if (!githubUrl.trim()) {
      setGithubImportError('GitHub URL is required');
      return;
    }

    try {
      setGithubInspectLoading(true);
      setGithubImportError(null);
      const result = await inspectGithubSkillImport({
        url: githubUrl.trim(),
        ref: githubRef.trim() || undefined,
        githubToken: githubToken.trim() || undefined,
      });
      setGithubInspectResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to inspect GitHub source';
      setGithubImportError(message);
      setGithubInspectResult(null);
    } finally {
      setGithubInspectLoading(false);
    }
  };

  const handleGithubApply = async () => {
    if (!githubInspectResult) return;
    try {
      setGithubApplyLoading(true);
      setGithubImportError(null);
      const result = await applyGithubSkillImport({
        importSessionId: githubInspectResult.importSessionId,
        onCollision: 'copy',
      });
      await loadSkills();
      setSelectedSkillId(result.importedSkillId);
      setGithubModalOpen(false);
      setGithubInspectResult(null);
      setGithubUrl('');
      setGithubRef('');
      setGithubToken('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to import skill';
      setGithubImportError(message);
    } finally {
      setGithubApplyLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="animate-spin text-slate-400" size={32} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-rose-100 text-rose-600 mb-4">
          <AlertCircle size={24} />
        </div>
        <p className="text-rose-600 mb-4">{error}</p>
        <button
          onClick={loadSkills}
          className="settings-button-primary rounded-lg px-4 py-2 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ height: 'calc(100vh - 260px)', minHeight: '620px' }} className="settings-workbench flex gap-4">
      <div className={`${builderCollapsed ? 'w-12' : 'w-[390px]'} ${workbenchColumnClass} flex-shrink-0`}>
        <div className="px-3 py-2 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          {!builderCollapsed && (
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              <MessageSquare size={16} />
              Skill Builder
            </div>
          )}
          <button
            onClick={() => setBuilderCollapsed((prev) => !prev)}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded"
            title={builderCollapsed ? 'Expand Skill Builder' : 'Collapse Skill Builder'}
          >
            {builderCollapsed ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
          </button>
        </div>

        {!builderCollapsed && (
          <>
            <div className="px-3 py-2 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-2">
              <div className="text-xs text-slate-500 truncate">
                {builderReady ? `Workspace: ${builderWorkspaceId}` : 'Initializing session...'}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setGithubModalOpen(true)}
                  className={secondaryButtonClass}
                >
                  <Github size={13} />
                  Import
                </button>
                <button
                  type="button"
                  onClick={parseActionsFromMessages}
                  className={secondaryButtonClass}
                >
                  <Wand2 size={13} />
                  Parse Actions
                </button>
              </div>
            </div>

            <div className="px-3 py-2 border-b border-slate-200">
              <div className="flex items-center gap-2 mb-2 text-xs text-slate-600">
                <Paperclip size={13} />
                Context Files
              </div>
              <div className="flex items-center gap-2 mb-2">
                <button
                  type="button"
                  disabled={contextUploading}
                  onClick={() => attachmentInputRef.current?.click()}
                  className={secondaryButtonClass}
                >
                  {contextUploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                  Upload
                </button>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  className="hidden"
                  accept={ACCEPT_UPLOADS}
                  onChange={handleContextUpload}
                />
              </div>
              <div className="space-y-1 max-h-24 overflow-y-auto">
                {contextFiles.map((file) => (
                  <div key={file.fileId} className="flex items-center justify-between gap-2 text-xs border border-slate-200 rounded px-2 py-1">
                    <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedContextIds.includes(file.fileId)}
                        onChange={() => toggleContextSelection(file.fileId)}
                      />
                      <span className="truncate" title={file.name}>{file.name}</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => void handleDeleteContextFile(file.fileId)}
                      className="text-slate-400 hover:text-rose-600"
                      title="Remove"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-slate-50">
              {builderMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${msg.role === 'user'
                    ? 'bg-blue-600 text-white ml-6'
                    : msg.role === 'assistant'
                      ? 'bg-white border border-slate-200 mr-2'
                      : 'bg-amber-50 border border-amber-200 text-amber-800'
                    }`}
                >
                  {msg.text}
                </div>
              ))}
              {builderRunning && (
                <div className="rounded-lg px-3 py-2 text-sm bg-white border border-slate-200 text-slate-500 flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  Running...
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 p-3 bg-white space-y-2">
              {builderError && <p className="text-xs text-rose-600">{builderError}</p>}
              {builderRunId && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleRunDecision('approve')}
                  className="rounded px-2 py-1 text-xs bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRunDecision('reject')}
                  className="rounded px-2 py-1 text-xs bg-rose-600 text-white hover:bg-rose-700"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCancelRun()}
                    className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
                  >
                    Cancel Run
                  </button>
                </div>
              )}
              <textarea
                value={builderPrompt}
                onChange={(e) => setBuilderPrompt(e.target.value)}
                placeholder="Ask Skill Builder to create/update skills. It can propose actions for Apply."
                rows={3}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-slate-500"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={!builderReady || builderRunning || !builderPrompt.trim()}
                  onClick={() => void handleSendPrompt()}
                  className={primaryButtonClass}
                >
                  <Play size={14} />
                  Send
                </button>
              </div>
            </div>

            <div className="border-t border-slate-200 p-3 bg-white">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Proposed Actions</div>
                <button
                  type="button"
                  disabled={!proposedActions.length || applyingAll}
                  onClick={() => void applyAllActions()}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  {applyingAll ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                  Apply All
                </button>
              </div>
              {actionsError && <p className="text-xs text-rose-600 mb-2">{actionsError}</p>}
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {proposedActions.map((action, index) => (
                  <div key={`${action.type}-${index}`} className="border border-slate-200 rounded p-2 bg-slate-50">
                    <div className="text-xs font-medium text-slate-700 mb-1">{action.type}</div>
                    <pre className="text-[11px] text-slate-600 whitespace-pre-wrap max-h-20 overflow-y-auto">{JSON.stringify(action, null, 2)}</pre>
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        disabled={applyingActionIndex === index}
                        onClick={() => void applyAction(action, index)}
                        className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-white disabled:opacity-60"
                      >
                        {applyingActionIndex === index ? 'Applying...' : 'Apply'}
                      </button>
                    </div>
                  </div>
                ))}
                {!proposedActions.length && (
                  <p className="text-xs text-slate-500">No actions parsed yet.</p>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="flex-1 min-w-0 flex gap-4">
        <div className={`w-72 flex-shrink-0 ${workbenchColumnClass}`}>
          <div className="p-3 border-b border-slate-200 bg-slate-50">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Skills</span>
              <button
                onClick={() => void loadSkills()}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-colors"
                title="Refresh"
              >
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="relative mb-2">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-slate-400 transition-all"
              />
            </div>
            <button
              onClick={() => {
                setIsAdding(true);
                setCreateError(null);
                setNewId('');
                setNewName('');
                setNewDesc('');
              }}
              className={primaryButtonClass}
            >
              <Plus size={16} />
              Add Skill
            </button>
          </div>

          {isAdding && (
            <div className="p-3 border-b border-slate-200 bg-amber-50">
              <div className="space-y-2">
                <input
                  type="text"
                  value={newId}
                  onChange={(e) => setNewId(e.target.value)}
                  placeholder="skill-id *"
                  className="w-full px-2.5 py-1.5 rounded-md border border-slate-300 text-sm font-mono bg-white focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Display Name"
                  className="w-full px-2.5 py-1.5 rounded-md border border-slate-300 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
                <input
                  type="text"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Description"
                  className="w-full px-2.5 py-1.5 rounded-md border border-slate-300 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
                {createError && <p className="text-xs text-rose-600">{createError}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={() => setIsAdding(false)}
                    className="flex-1 px-2 py-1.5 text-slate-600 text-sm hover:bg-slate-100 rounded-md transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void handleCreateSkill()}
                    disabled={createLoading}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-emerald-600 text-white text-sm rounded-md hover:bg-emerald-700 transition-colors disabled:opacity-50"
                  >
                    {createLoading ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                    Create
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {filteredSkills.map((skill) => (
              <button
                key={skill.id}
                onClick={() => setSelectedSkillId(skill.id)}
                className={`w-full text-left p-2.5 rounded-lg border transition-all ${selectedSkillId === skill.id
                  ? 'border-slate-400 bg-slate-100'
                  : 'border-transparent hover:bg-slate-50'
                  }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${skill.valid ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                  <span className="font-medium text-slate-900 truncate text-sm">{skill.name || skill.id}</span>
                </div>
                <p className="text-xs font-mono text-slate-400 mt-0.5 ml-4">{skill.id}</p>
                {skill.description && <p className="text-xs text-slate-500 mt-1 ml-4 line-clamp-2">{skill.description}</p>}
              </button>
            ))}
            {filteredSkills.length === 0 && (
              <div className="text-center py-8 text-slate-400 text-sm">
                {searchTerm ? 'No skills match your search.' : 'No skills yet.'}
              </div>
            )}
          </div>
        </div>

        <div className={`flex-1 ${workbenchColumnClass}`}>
          {selectedSkill ? (
            <>
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-slate-50">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium text-slate-700 truncate">{selectedSkill.name || selectedSkill.id}</span>
                  {selectedFile && (
                    <>
                      <ChevronRight size={14} className="text-slate-400 flex-shrink-0" />
                      <span className="text-sm font-mono text-slate-500 truncate">{selectedFile}</span>
                    </>
                  )}
                </div>
                <button
                  onClick={() => void handleSaveFile()}
                  disabled={!selectedFile || fileSaving}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 transition-colors font-medium"
                >
                  {fileSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Save
                </button>
              </div>

              <div className="flex-1 flex min-h-0">
                <div className="w-40 flex-shrink-0 border-r border-slate-200 bg-slate-50 flex flex-col">
                  <div className="p-2 border-b border-slate-100">
                    <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                      <FolderOpen size={12} />
                      Files
                    </div>
                  </div>
                  {filesLoading ? (
                    <div className="flex-1 flex items-center justify-center">
                      <Loader2 size={16} className="animate-spin text-slate-400" />
                    </div>
                  ) : (
                    <div className="flex-1 overflow-y-auto py-1">
                      {files.map((file) => (
                        <button
                          key={file}
                          onClick={() => setSelectedFile(file)}
                          className={`w-full text-left px-3 py-1.5 text-xs transition-colors truncate ${selectedFile === file
                            ? 'bg-white text-emerald-700 font-medium border-l-2 border-emerald-500'
                            : 'text-slate-600 hover:bg-slate-100 border-l-2 border-transparent'
                            }`}
                          title={file}
                        >
                          {file}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="settings-workbench-editor flex-1 relative">
                  {fileLoading ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-[#1e1e1e]">
                      <Loader2 size={24} className="animate-spin text-slate-500" />
                    </div>
                  ) : selectedFile ? (
                    <Editor
                      height="100%"
                      theme="vs-dark"
                      language={getLanguage(selectedFile)}
                      value={fileContent}
                      onChange={(value) => setFileContent(value || '')}
                      options={{
                        minimap: { enabled: false },
                        fontSize: 13,
                        lineHeight: 20,
                        wordWrap: 'on',
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        padding: { top: 12, bottom: 12 },
                      }}
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-slate-500 bg-slate-100">
                      <p className="text-sm">Select a file to edit</p>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 bg-slate-50">
              <FolderOpen size={40} className="mb-3 opacity-20" />
              <p className="font-medium text-slate-500">No skill selected</p>
            </div>
          )}
        </div>
      </div>

      {githubModalOpen && (
        <div className="settings-modal-overlay fixed inset-0 z-40 flex items-center justify-center p-4">
          <div className="settings-modal-panel w-full max-w-2xl rounded-xl">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Import Skill From GitHub</h3>
              <button onClick={() => setGithubModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X size={16} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <input
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                placeholder="https://github.com/<owner>/<repo>/tree/<ref>/<skill-path>"
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={githubRef}
                  onChange={(e) => setGithubRef(e.target.value)}
                  placeholder="ref (optional)"
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                />
                <input
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="GitHub token (optional/private repos)"
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                />
              </div>
              {githubImportError && <p className="text-xs text-rose-600">{githubImportError}</p>}

              {githubInspectResult && (
                <div className="border border-slate-200 rounded p-3 bg-slate-50">
                  <p className="text-sm text-slate-700 mb-1">Detected skill id: <span className="font-mono">{githubInspectResult.detectedSkillId}</span></p>
                  <p className="text-xs text-slate-500 mb-2">{githubInspectResult.filesPreview.length} files</p>
                  <div className="max-h-32 overflow-y-auto border border-slate-200 rounded bg-white p-2 text-xs font-mono text-slate-600">
                    {githubInspectResult.filesPreview.map((file) => (
                      <div key={file.path}>{file.path} ({file.size} bytes)</div>
                    ))}
                  </div>
                  {githubInspectResult.warnings.length > 0 && (
                    <div className="mt-2 text-xs text-amber-700">
                      {githubInspectResult.warnings.map((w) => <div key={w}>- {w}</div>)}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-slate-200 flex justify-between">
              <button
                onClick={() => void handleGithubInspect()}
                disabled={githubInspectLoading}
                className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-60"
              >
                {githubInspectLoading ? 'Inspecting...' : 'Inspect'}
              </button>
              <button
                onClick={() => void handleGithubApply()}
                disabled={!githubInspectResult || githubApplyLoading}
                className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-60"
              >
                {githubApplyLoading ? 'Importing...' : 'Import (Copy on Collision)'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SkillsRegistryTab;
