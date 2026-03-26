import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileIcon, Loader2, NotebookPen, Plus, RotateCcw, Trash } from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';
import {
  SettingsEmptyState,
  SettingsLoadingState,
  SettingsNotice,
  SettingsSectionHeader,
  SettingsSurface,
} from '../components/settings/SettingsScaffold';
import { getWorkspaces } from '../services/workspaceApi';
import { createKnowledge, deleteKnowledge, listKnowledge } from '../services/knowledgeApi';
import { createFile, getRagStatuses } from '../services/fileApi';
import type { Workspace } from '../types';

type KnowledgeType = 'text' | 'table' | 'image' | 'presentation' | 'infographic';

type KnowledgeSource = {
  id: number;
  workspaceId: string;
  title: string;
  type: KnowledgeType;
  description?: string | null;
  content?: string | null;
  fileId?: number | null;
  sourceUrl?: string | null;
  tags?: unknown;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  file?: {
    id: number;
    name: string;
    mimeType?: string | null;
    publicUrl?: string | null;
    storageType?: string | null;
    path?: string | null;
  } | null;
};

const statusStyles: Record<string, { label: string; className: string }> = {
  processed: {
    label: 'Indexed',
    className: 'bg-emerald-50 text-emerald-700 border border-emerald-100',
  },
  processing: {
    label: 'Processing',
    className: 'bg-amber-50 text-amber-700 border border-amber-100',
  },
  pending: {
    label: 'Queued',
    className: 'bg-amber-50 text-amber-700 border border-amber-100',
  },
  preprocessed: {
    label: 'Preprocessing',
    className: 'bg-amber-50 text-amber-700 border border-amber-100',
  },
  error: {
    label: 'Error',
    className: 'bg-rose-50 text-rose-700 border border-rose-100',
  },
  not_indexed: {
    label: 'Not indexed',
    className: 'bg-slate-100 text-slate-600 border border-slate-200',
  },
};

const normalizeStatus = (value?: string | null) => (value ? value.toLowerCase() : '');

const toNumericId = (value: number | string | null | undefined): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const guessKnowledgeType = (file: File): KnowledgeType => {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const mime = file.type.toLowerCase();
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'].includes(extension)) {
    return 'image';
  }
  if (
    mime.includes('presentation') ||
    ['ppt', 'pptx', 'key'].includes(extension)
  ) {
    return 'presentation';
  }
  if (
    mime.includes('spreadsheet') ||
    mime.includes('csv') ||
    ['csv', 'tsv', 'xls', 'xlsx'].includes(extension)
  ) {
    return 'table';
  }
  return 'text';
};

const KnowledgePage = () => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSource[]>([]);
  const [ragStatuses, setRagStatuses] = useState<Record<string, { status?: string; updatedAt?: string; error?: string }>>({});
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const [loadingStatuses, setLoadingStatuses] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) || null,
    [workspaces, selectedWorkspaceId],
  );

  const knowledgeFileNames = useMemo(
    () =>
      knowledgeSources
        .map((item) => item.file?.name)
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0),
    [knowledgeSources],
  );

  const loadWorkspaces = useCallback(async () => {
    setLoadingWorkspaces(true);
    setErrorMessage(null);
    try {
      const response = await getWorkspaces();
      const mapped = (response || []).map((workspace: Omit<Workspace, 'lastUsed'>) => ({
        ...workspace,
        lastUsed: 'Recently',
      }));
      setWorkspaces(mapped);
    } catch (error) {
      console.error('Failed to load workspaces', error);
      setErrorMessage('Failed to load workspaces.');
      setWorkspaces([]);
    } finally {
      setLoadingWorkspaces(false);
    }
  }, []);

  const loadKnowledgeSources = useCallback(
    async (workspaceId: string) => {
      setLoadingKnowledge(true);
      setErrorMessage(null);
      try {
        const items = await listKnowledge(workspaceId);
        setKnowledgeSources(items || []);
      } catch (error) {
        console.error('Failed to load knowledge sources', error);
        setErrorMessage('Failed to load knowledge sources.');
        setKnowledgeSources([]);
      } finally {
        setLoadingKnowledge(false);
      }
    },
    [],
  );

  const refreshRagStatuses = useCallback(async () => {
    if (!selectedWorkspaceId) {
      setRagStatuses({});
      return;
    }
    if (!knowledgeFileNames.length) {
      setRagStatuses({});
      return;
    }
    setLoadingStatuses(true);
    try {
      const response = await getRagStatuses(selectedWorkspaceId, knowledgeFileNames);
      setRagStatuses(response?.statuses || {});
    } catch (error) {
      console.error('Failed to fetch RAG status', error);
    } finally {
      setLoadingStatuses(false);
    }
  }, [knowledgeFileNames, selectedWorkspaceId]);

  const handleUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedWorkspaceId) {
      setUploadError('Select a workspace before uploading files.');
      return;
    }
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (!files.length) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of files) {
        const createdFile = await createFile(selectedWorkspaceId, file);
        const fileId = toNumericId(createdFile?.id);
        if (!fileId) {
          throw new Error('Unable to resolve file id for knowledge entry.');
        }
        await createKnowledge(selectedWorkspaceId, {
          title: file.name,
          type: guessKnowledgeType(file),
          fileId,
          description: `Uploaded file ${file.name}`,
          metadata: {
            source: 'upload',
          },
        });
      }
      await loadKnowledgeSources(selectedWorkspaceId);
      await refreshRagStatuses();
    } catch (error) {
      console.error('Failed to upload knowledge files', error);
      setUploadError(error instanceof Error ? error.message : 'Failed to upload files.');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteKnowledge = async (item: KnowledgeSource) => {
    if (!selectedWorkspaceId) return;
    const confirmed = window.confirm(`Delete knowledge source "${item.title}"?`);
    if (!confirmed) return;
    try {
      await deleteKnowledge(selectedWorkspaceId, item.id);
      await loadKnowledgeSources(selectedWorkspaceId);
    } catch (error) {
      console.error('Failed to delete knowledge source', error);
      setErrorMessage('Failed to delete knowledge source.');
    }
  };

  const handleRefresh = async () => {
    if (!selectedWorkspaceId) return;
    await loadKnowledgeSources(selectedWorkspaceId);
    await refreshRagStatuses();
  };

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    if (!workspaces.length) {
      if (selectedWorkspaceId) {
        setSelectedWorkspaceId('');
      }
      return;
    }
    const exists = workspaces.some((workspace) => workspace.id === selectedWorkspaceId);
    if (!selectedWorkspaceId || !exists) {
      setSelectedWorkspaceId(workspaces[0].id);
    }
  }, [selectedWorkspaceId, workspaces]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setKnowledgeSources([]);
      setRagStatuses({});
      return;
    }
    void loadKnowledgeSources(selectedWorkspaceId);
  }, [loadKnowledgeSources, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    void refreshRagStatuses();
  }, [refreshRagStatuses, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const hasPending = Object.values(ragStatuses).some((status) => {
      const normalized = normalizeStatus(status?.status);
      return ['pending', 'processing', 'preprocessed'].includes(normalized);
    });
    if (!hasPending) return;
    const interval = window.setInterval(() => {
      void refreshRagStatuses();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [ragStatuses, refreshRagStatuses, selectedWorkspaceId]);

  const actions = (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative">
        <select
          className="settings-control rounded-xl px-3 py-2 text-sm"
          value={selectedWorkspaceId}
          onChange={(event) => setSelectedWorkspaceId(event.target.value)}
          disabled={loadingWorkspaces}
        >
          <option value="" disabled>
            {loadingWorkspaces ? 'Loading workspaces...' : 'Select workspace'}
          </option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        onClick={handleRefresh}
        disabled={!selectedWorkspaceId || loadingKnowledge || loadingStatuses}
        className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition disabled:opacity-60"
      >
        {loadingKnowledge || loadingStatuses ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw size={16} />}
        Refresh
      </button>
    </div>
  );

  const renderStatusBadge = (fileName?: string | null) => {
    if (!fileName) {
      return (
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-500">
          Manual
        </span>
      );
    }
    const statusInfo = ragStatuses[fileName];
    const normalized = normalizeStatus(statusInfo?.status);
    const style = statusStyles[normalized] || statusStyles.not_indexed;
    return (
      <span className={`rounded-full px-2.5 py-1 text-xs ${style.className}`}>
        {style.label}
      </span>
    );
  };

  const renderRagDetail = (fileName?: string | null) => {
    if (!fileName) return null;
    const statusInfo = ragStatuses[fileName];
    if (!statusInfo?.status) {
      return <p className="text-xs text-slate-500">RAG status pending.</p>;
    }
    const updatedAt = statusInfo.updatedAt ? new Date(statusInfo.updatedAt).toLocaleString() : null;
    if (statusInfo.error) {
      return (
        <p className="text-xs text-rose-600">
          {statusInfo.error}
        </p>
      );
    }
    return (
      <p className="text-xs text-slate-500">
        {updatedAt ? `Last updated ${updatedAt}` : 'RAG status updated recently.'}
      </p>
    );
  };

  return (
    <SettingsShell
      eyebrow="Knowledge"
      title="Knowledge"
      description="Manage the documents and context that power your assistants."
      actions={actions}
    >
      <div className="space-y-6">
        {!selectedWorkspace && !loadingWorkspaces ? (
          <SettingsNotice variant="warning">Create or select a workspace to manage knowledge sources.</SettingsNotice>
        ) : null}

        {errorMessage ? (
          <SettingsNotice variant="error">{errorMessage}</SettingsNotice>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[1.05fr_1.95fr]">
          <SettingsSurface>
            <SettingsSectionHeader
              eyebrow="Ingest"
              title="Add knowledge"
              description="Upload files and we’ll index supported documents automatically."
            />

            <div className="settings-soft-panel mt-6 rounded-2xl border border-dashed p-6 text-center">
              <input
                ref={uploadInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileUpload}
              />
              <button
                type="button"
                onClick={handleUploadClick}
                disabled={!selectedWorkspaceId || uploading}
                className="settings-button-primary inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-medium transition disabled:opacity-60"
              >
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus size={16} />}
                Upload files
              </button>
              <p className="mt-3 text-xs text-slate-500">
                PDF, DOC/DOCX, and Markdown files are indexed for RAG as soon as they land in your workspace.
              </p>
              {uploadError ? (
                <p className="mt-3 text-xs text-rose-600">{uploadError}</p>
              ) : null}
            </div>

            <div className="settings-portal-card mt-6 rounded-[24px] p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tips</p>
              <ul className="mt-2 space-y-2 text-sm text-slate-600">
                <li>RAG indexing runs for PDF, DOC/DOCX, and Markdown files.</li>
                <li>CSVs and slides are stored but not indexed.</li>
                <li>Large documents may take a few minutes to finish indexing.</li>
                <li>Use the workspace selector above to target a different knowledge base.</li>
              </ul>
            </div>
          </SettingsSurface>

          <SettingsSurface>
            <SettingsSectionHeader
              title="Knowledge sources"
              description={selectedWorkspace ? `Workspace: ${selectedWorkspace.name}` : 'No workspace selected'}
              actions={(
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  {loadingKnowledge ? 'Loading sources...' : `${knowledgeSources.length} sources`}
                </div>
              )}
            />

            <div className="mt-6 space-y-3">
              {loadingKnowledge ? (
                <SettingsLoadingState label="Loading knowledge sources..." />
              ) : null}

              {!loadingKnowledge && knowledgeSources.length === 0 ? (
                <SettingsEmptyState
                  title="No knowledge sources yet"
                  description="Upload files to start building your workspace knowledge library."
                  icon={NotebookPen}
                />
              ) : null}

              {knowledgeSources.map((item) => (
                <div
                  key={item.id}
                  className="settings-portal-card rounded-[24px] p-4"
                >
                  <div className="flex items-start gap-4">
                    <span className="settings-portal-icon-muted flex h-10 w-10 items-center justify-center rounded-2xl ring-1 ring-slate-200">
                      <FileIcon size={18} />
                    </span>
                    <div className="flex-1 space-y-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                          <p className="text-xs text-slate-500">
                            Type: {item.type}
                            {item.file?.name ? ` • File: ${item.file.name}` : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {renderStatusBadge(item.file?.name)}
                          <button
                            type="button"
                            className="settings-portal-button-secondary inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs transition"
                            onClick={() => handleDeleteKnowledge(item)}
                          >
                            <Trash size={12} />
                            Delete
                          </button>
                        </div>
                      </div>
                      {item.description ? <p className="text-sm text-slate-600">{item.description}</p> : null}
                      {renderRagDetail(item.file?.name)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </SettingsSurface>
        </div>

        <SettingsSurface>
          <SettingsSectionHeader
            title="Need to tune skills?"
            description="Keep skills and tools aligned for best results."
            actions={(
              <Link
                to="/settings/agents"
                className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition"
              >
                Configure skills
              </Link>
            )}
          />
        </SettingsSurface>
      </div>
    </SettingsShell>
  );
};

export default KnowledgePage;
