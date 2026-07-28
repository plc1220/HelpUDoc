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
import { createKnowledge, deleteKnowledge, listKnowledge, rebuildKnowledge } from '../services/knowledgeApi';
import { createFile } from '../services/fileApi';
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
  published: {
    label: 'Published',
    className: 'bg-emerald-50 text-emerald-700 border border-emerald-100',
  },
  processing: {
    label: 'Building OKF',
    className: 'bg-amber-50 text-amber-700 border border-amber-100',
  },
  queued: {
    label: 'Queued',
    className: 'bg-amber-50 text-amber-700 border border-amber-100',
  },
  failed: {
    label: 'Failed',
    className: 'bg-rose-50 text-rose-700 border border-rose-100',
  },
  not_started: {
    label: 'Not published',
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
    mime.includes('spreadsheet') ||
    mime.includes('csv') ||
    ['csv', 'tsv', 'xls', 'xlsx', 'xlsm'].includes(extension)
  ) {
    return 'table';
  }
  return 'text';
};

const KnowledgePage = () => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSource[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) || null,
    [workspaces, selectedWorkspaceId],
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
    } catch (error) {
      console.error('Failed to upload knowledge files', error);
      setUploadError(error instanceof Error ? error.message : 'Failed to upload files.');
    } finally {
      setUploading(false);
    }
  };

  const handleRebuildKnowledge = async (item: KnowledgeSource) => {
    if (!selectedWorkspaceId) return;
    try {
      await rebuildKnowledge(selectedWorkspaceId, item.id);
      await loadKnowledgeSources(selectedWorkspaceId);
    } catch (error) {
      console.error('Failed to rebuild knowledge source', error);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to rebuild knowledge source.');
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
      return;
    }
    void loadKnowledgeSources(selectedWorkspaceId);
  }, [loadKnowledgeSources, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const hasPending = knowledgeSources.some((item) => {
      const ingestion = item.metadata?.ingestion;
      if (!ingestion || typeof ingestion !== 'object') return false;
      const status = normalizeStatus((ingestion as { status?: string }).status);
      return status === 'queued' || status === 'processing';
    });
    if (!hasPending) return;
    const interval = window.setInterval(() => {
      void loadKnowledgeSources(selectedWorkspaceId);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [knowledgeSources, loadKnowledgeSources, selectedWorkspaceId]);

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
        disabled={!selectedWorkspaceId || loadingKnowledge}
        className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition disabled:opacity-60"
      >
        {loadingKnowledge ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw size={16} />}
        Refresh
      </button>
    </div>
  );

  const getIngestion = (item: KnowledgeSource) => (
    item.metadata?.ingestion && typeof item.metadata.ingestion === 'object'
      ? item.metadata.ingestion as {
          status?: string;
          error?: string | null;
          publishedAt?: string;
          bundlePath?: string;
          conceptCount?: number;
          okfVersion?: string;
        }
      : null
  );

  const renderStatusBadge = (item: KnowledgeSource) => {
    const normalized = normalizeStatus(getIngestion(item)?.status) || 'not_started';
    const style = statusStyles[normalized] || statusStyles.not_started;
    return (
      <span className={`rounded-full px-2.5 py-1 text-xs ${style.className}`}>
        {style.label}
      </span>
    );
  };

  const renderIngestionDetail = (item: KnowledgeSource) => {
    const ingestion = getIngestion(item);
    if (!ingestion) {
      return <p className="text-xs text-slate-500">This source has not been published to OKF.</p>;
    }
    if (ingestion.error) {
      return (
        <p className="text-xs text-rose-600">
          {ingestion.error}
        </p>
      );
    }
    const publishedAt = ingestion.publishedAt
      ? new Date(ingestion.publishedAt).toLocaleString()
      : null;
    return (
      <p className="text-xs text-slate-500">
        {publishedAt
          ? `OKF ${ingestion.okfVersion || '0.2'} • ${ingestion.conceptCount || 0} concepts • published ${publishedAt}`
          : 'Preparing a versioned OKF knowledge bundle in the background.'}
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
              description="Upload curated sources to publish as versioned OKF knowledge."
            />

            <div className="settings-soft-panel mt-6 rounded-2xl border border-dashed p-6 text-center">
              <input
                ref={uploadInputRef}
                type="file"
                multiple
                accept=".pdf,.docx,.xlsx,.xlsm,.csv,.tsv,.txt,.md"
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
                Knowledge ingestion is separate from workspace upload and runs asynchronously.
              </p>
              {uploadError ? (
                <p className="mt-3 text-xs text-rose-600">{uploadError}</p>
              ) : null}
            </div>

            <div className="settings-portal-card mt-6 rounded-[24px] p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tips</p>
              <ul className="mt-2 space-y-2 text-sm text-slate-600">
                <li>Sources are converted into human-readable OKF v0.2 Markdown concepts.</li>
                <li>No embeddings or vector index are created.</li>
                <li>Large documents may take a few minutes to publish.</li>
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
                          {renderStatusBadge(item)}
                          {normalizeStatus(getIngestion(item)?.status) === 'failed' ? (
                            <button
                              type="button"
                              className="settings-portal-button-secondary inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs transition"
                              onClick={() => handleRebuildKnowledge(item)}
                            >
                              <RotateCcw size={12} />
                              Retry
                            </button>
                          ) : null}
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
                      {renderIngestionDetail(item)}
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
