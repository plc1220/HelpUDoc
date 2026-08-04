import { useCallback, useEffect, useRef, useState } from 'react';
import { FileIcon, FolderOpen, Loader2, NotebookPen, Plus, RotateCcw, Trash, X } from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';
import KnowledgeBundleExplorer from '../components/KnowledgeBundleExplorer';
import { KnowledgeJobsTable } from '../app/table-grouped/page';
import {
  SettingsEmptyState,
  SettingsLoadingState,
  SettingsNotice,
  SettingsSectionHeader,
  SettingsSurface,
} from '../components/settings/SettingsScaffold';
import {
  deleteGlobalKnowledge,
  cancelGlobalKnowledgeUpload,
  completeGlobalKnowledgeUpload,
  createGlobalKnowledgeUploadSession,
  listGlobalKnowledge,
  listGlobalKnowledgeIngestionJobs,
  putGlobalKnowledgeUpload,
  rebuildGlobalKnowledge,
  streamGlobalKnowledgeIngestionEvents,
  type KnowledgeIngestionJob,
} from '../services/knowledgeApi';

type KnowledgeType = 'text' | 'table' | 'image' | 'presentation' | 'infographic';

type KnowledgeSource = {
  id: number;
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

type KnowledgeUploadItem = {
  id: string;
  file: File;
  sessionId?: string;
  status: 'preparing' | 'uploading' | 'finalizing' | 'queued' | 'failed' | 'cancelled';
  uploadedBytes: number;
  totalBytes: number;
  error?: string;
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
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
  extracting: { label: 'Extracting', className: 'bg-amber-50 text-amber-700 border border-amber-100' },
  structuring: { label: 'Structuring', className: 'bg-amber-50 text-amber-700 border border-amber-100' },
  chunking: { label: 'Planning windows', className: 'bg-amber-50 text-amber-700 border border-amber-100' },
  enriching: { label: 'Enriching', className: 'bg-amber-50 text-amber-700 border border-amber-100' },
  reducing: { label: 'Reducing', className: 'bg-amber-50 text-amber-700 border border-amber-100' },
  validating: { label: 'Validating', className: 'bg-amber-50 text-amber-700 border border-amber-100' },
  indexing: { label: 'Indexing', className: 'bg-amber-50 text-amber-700 border border-amber-100' },
  publishing: { label: 'Publishing', className: 'bg-amber-50 text-amber-700 border border-amber-100' },
  partial: { label: 'Partial', className: 'bg-orange-50 text-orange-700 border border-orange-100' },
  cancelled: { label: 'Cancelled', className: 'bg-slate-100 text-slate-600 border border-slate-200' },
  superseded: { label: 'Superseded', className: 'bg-slate-100 text-slate-600 border border-slate-200' },
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
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSource[]>([]);
  const [ingestionJobs, setIngestionJobs] = useState<KnowledgeIngestionJob[]>([]);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadItems, setUploadItems] = useState<KnowledgeUploadItem[]>([]);
  const [selectedKnowledge, setSelectedKnowledge] = useState<KnowledgeSource | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const uploadControllersRef = useRef(new Map<string, AbortController>());

  const loadKnowledgeSources = useCallback(
    async () => {
      setLoadingKnowledge(true);
      setErrorMessage(null);
      try {
        const items = await listGlobalKnowledge();
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

  const loadIngestionJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const jobs = await listGlobalKnowledgeIngestionJobs();
      setIngestionJobs(jobs || []);
    } catch (error) {
      console.error('Failed to load knowledge ingestion jobs', error);
      setIngestionJobs([]);
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  const handleUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const updateUploadItem = (id: string, patch: Partial<KnowledgeUploadItem>) => {
    setUploadItems((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const runDirectUpload = async (itemId: string, file: File) => {
    const controller = new AbortController();
    uploadControllersRef.current.set(itemId, controller);
    let sessionId: string | undefined;
    updateUploadItem(itemId, {
      status: 'preparing',
      sessionId: undefined,
      uploadedBytes: 0,
      totalBytes: file.size,
      error: undefined,
    });
    try {
      const session = await createGlobalKnowledgeUploadSession(file, {
        title: file.name,
        type: guessKnowledgeType(file),
        description: `Uploaded file ${file.name}`,
        metadata: { source: 'upload', uploadMode: 'direct' },
      }, controller.signal);
      sessionId = session.id;
      updateUploadItem(itemId, { status: 'uploading', sessionId });
      await putGlobalKnowledgeUpload(
        session,
        file,
        (uploadedBytes, totalBytes) => updateUploadItem(itemId, { uploadedBytes, totalBytes }),
        controller.signal,
      );
      updateUploadItem(itemId, {
        status: 'finalizing',
        uploadedBytes: file.size,
        totalBytes: file.size,
      });
      await completeGlobalKnowledgeUpload(session.id);
      updateUploadItem(itemId, { status: 'queued' });
      await Promise.all([loadKnowledgeSources(), loadIngestionJobs()]);
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      updateUploadItem(itemId, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? undefined : error instanceof Error ? error.message : 'Upload failed',
      });
      if (!cancelled) throw error;
    } finally {
      uploadControllersRef.current.delete(itemId);
    }
  };

  const handleCancelUpload = async (item: KnowledgeUploadItem) => {
    uploadControllersRef.current.get(item.id)?.abort();
    updateUploadItem(item.id, { status: 'cancelled', error: undefined });
    if (item.sessionId) {
      await cancelGlobalKnowledgeUpload(item.sessionId).catch((error) => {
        console.warn('Failed to cancel knowledge upload session', error);
      });
    }
  };

  const handleRetryUpload = async (item: KnowledgeUploadItem) => {
    setUploading(true);
    setUploadError(null);
    try {
      await runDirectUpload(item.id, item.file);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Failed to upload file.');
    } finally {
      setUploading(false);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (!files.length) return;
    setUploading(true);
    setUploadError(null);
    const pendingItems = files.map((file, index) => ({
      id: `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
      file,
      status: 'preparing' as const,
      uploadedBytes: 0,
      totalBytes: file.size,
    }));
    setUploadItems((items) => [...pendingItems, ...items]);
    try {
      let firstError: unknown = null;
      for (const item of pendingItems) {
        try {
          await runDirectUpload(item.id, item.file);
        } catch (error) {
          firstError ||= error;
        }
      }
      if (firstError) throw firstError;
    } catch (error) {
      console.error('Failed to upload knowledge files', error);
      setUploadError(error instanceof Error ? error.message : 'Failed to upload files.');
    } finally {
      setUploading(false);
    }
  };

  const handleRebuildKnowledge = async (item: KnowledgeSource) => {
    try {
      await rebuildGlobalKnowledge(item.id);
      await Promise.all([loadKnowledgeSources(), loadIngestionJobs()]);
    } catch (error) {
      console.error('Failed to rebuild knowledge source', error);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to rebuild knowledge source.');
    }
  };

  const handleDeleteKnowledge = async (item: KnowledgeSource) => {
    const confirmed = window.confirm(`Delete knowledge source "${item.title}"?`);
    if (!confirmed) return;
    try {
      await deleteGlobalKnowledge(item.id);
      await loadKnowledgeSources();
    } catch (error) {
      console.error('Failed to delete knowledge source', error);
      setErrorMessage('Failed to delete knowledge source.');
    }
  };

  const handleRefresh = async () => {
    await Promise.all([loadKnowledgeSources(), loadIngestionJobs()]);
  };

  const handleRetryJob = async (job: KnowledgeIngestionJob) => {
    try {
      await rebuildGlobalKnowledge(job.knowledgeId);
      await Promise.all([loadKnowledgeSources(), loadIngestionJobs()]);
    } catch (error) {
      console.error('Failed to retry knowledge ingestion job', error);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to retry knowledge ingestion job.');
    }
  };

  useEffect(() => {
    void loadKnowledgeSources();
    void loadIngestionJobs();
  }, [loadIngestionJobs, loadKnowledgeSources]);

  useEffect(() => () => {
    for (const controller of uploadControllersRef.current.values()) controller.abort();
    uploadControllersRef.current.clear();
  }, []);

  useEffect(() => {
    const hasPending = ingestionJobs.some((job) => [
      'queued', 'processing', 'extracting', 'structuring', 'chunking', 'enriching',
      'reducing', 'validating', 'indexing', 'publishing',
    ].includes(normalizeStatus(job.status)));
    if (!hasPending) return;
    const interval = window.setInterval(() => {
      void Promise.all([loadKnowledgeSources(), loadIngestionJobs()]);
    }, 7000);
    return () => window.clearInterval(interval);
  }, [ingestionJobs, loadIngestionJobs, loadKnowledgeSources]);

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: number | null = null;
    let stopped = false;
    const connect = async () => {
      try {
        await streamGlobalKnowledgeIngestionEvents(() => {
          void Promise.all([loadKnowledgeSources(), loadIngestionJobs()]);
        }, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn('Knowledge ingestion event stream unavailable; polling remains active.', error);
        }
      }
      if (!stopped && !controller.signal.aborted) {
        retryTimer = window.setTimeout(() => void connect(), 3000);
      }
    };
    void connect();
    return () => {
      stopped = true;
      controller.abort();
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [loadIngestionJobs, loadKnowledgeSources]);

  const actions = (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={handleRefresh}
        disabled={loadingKnowledge || loadingJobs}
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
          relationshipCount?: number;
          structureNodeCount?: number;
          processingWindowCount?: number;
          discoveredSourceUnits?: number;
          processedSourceUnits?: number;
          failedSourceUnits?: number;
          coveragePercent?: number;
          warnings?: Array<{ sourceUnit: string; code: string; message: string }>;
          snapshotHash?: string;
          enrichmentMode?: string;
          modelCalls?: number;
          inputTokens?: number;
          outputTokens?: number;
          estimatedCost?: number;
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
    const hasCoverage = typeof ingestion.discoveredSourceUnits === 'number';
    return (
      <div className="space-y-1 text-xs text-slate-500">
        <p>
          {publishedAt
            ? `OKF ${ingestion.okfVersion || '0.2'} • ${ingestion.conceptCount || 0} concepts • ${ingestion.relationshipCount || 0} relationships • published ${publishedAt}`
            : 'Preparing a versioned OKF knowledge bundle in the background.'}
        </p>
        {hasCoverage ? (
          <p>
            Coverage: {ingestion.processedSourceUnits || 0}/{ingestion.discoveredSourceUnits || 0} source units
            {typeof ingestion.coveragePercent === 'number' ? ` (${ingestion.coveragePercent}%)` : ''}
            {ingestion.failedSourceUnits ? ` • ${ingestion.failedSourceUnits} failed` : ''}
            {ingestion.processingWindowCount ? ` • ${ingestion.processingWindowCount} windows` : ''}
          </p>
        ) : null}
        {ingestion.snapshotHash ? <p className="truncate">Snapshot: {ingestion.snapshotHash}</p> : null}
        {ingestion.modelCalls ? (
          <p>
            Gemini Lite: {ingestion.modelCalls} calls • {(ingestion.inputTokens || 0) + (ingestion.outputTokens || 0)} tokens
            {' • '}estimated ${Number(ingestion.estimatedCost || 0).toFixed(4)}
          </p>
        ) : null}
        {ingestion.warnings?.length ? <p className="text-orange-700">{ingestion.warnings.length} extraction warning(s) require review.</p> : null}
      </div>
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
                disabled={uploading}
                className="settings-button-primary inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-medium transition disabled:opacity-60"
              >
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus size={16} />}
                Upload files
              </button>
              <p className="mt-3 text-xs text-slate-500">
                Each upload creates a build job. Track its high-level progress below while the source is prepared.
              </p>
              {uploadError ? (
                <p className="mt-3 text-xs text-rose-600">{uploadError}</p>
              ) : null}
              {uploadItems.length ? (
                <div className="mt-4 space-y-3 text-left">
                  {uploadItems.map((item) => {
                    const percent = item.totalBytes > 0
                      ? Math.min(100, Math.round((item.uploadedBytes / item.totalBytes) * 100))
                      : 0;
                    const statusLabel = item.status === 'preparing'
                      ? 'Preparing secure upload…'
                      : item.status === 'uploading'
                        ? `${percent}% · ${formatBytes(item.uploadedBytes)} of ${formatBytes(item.totalBytes)}`
                        : item.status === 'finalizing'
                          ? 'Upload complete · creating build job…'
                          : item.status === 'queued'
                            ? 'Build queued'
                            : item.status === 'cancelled'
                              ? 'Upload cancelled'
                              : item.error || 'Upload failed';
                    return (
                      <div key={item.id} className="rounded-xl border border-slate-200 bg-white/70 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium text-slate-700">{item.file.name}</p>
                            <p className={`mt-1 text-[11px] ${item.status === 'failed' ? 'text-rose-600' : 'text-slate-500'}`}>
                              {statusLabel}
                            </p>
                          </div>
                          {item.status === 'preparing' || item.status === 'uploading' ? (
                            <button
                              type="button"
                              className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                              onClick={() => void handleCancelUpload(item)}
                              aria-label={`Cancel upload ${item.file.name}`}
                            >
                              <X size={14} />
                            </button>
                          ) : item.status === 'failed' || item.status === 'cancelled' ? (
                            <button
                              type="button"
                              className="settings-portal-button-secondary rounded-lg px-2 py-1 text-[11px]"
                              onClick={() => void handleRetryUpload(item)}
                            >
                              Retry
                            </button>
                          ) : null}
                        </div>
                        {item.status === 'uploading' || item.status === 'finalizing' ? (
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={`h-full rounded-full transition-[width] ${item.status === 'finalizing' ? 'animate-pulse bg-amber-500' : 'bg-blue-600'}`}
                              style={{ width: `${item.status === 'finalizing' ? 100 : percent}%` }}
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="settings-portal-card mt-6 rounded-[24px] p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tips</p>
              <ul className="mt-2 space-y-2 text-sm text-slate-600">
                <li>Sources are converted into human-readable OKF v0.2 Markdown concepts.</li>
                <li>Every source unit is accounted for; extraction gaps are reported explicitly.</li>
                <li>Bundles are content-addressed and switched atomically after validation.</li>
                <li>Large documents may take a few minutes to publish.</li>
                <li>These sources are managed from one shared admin catalog.</li>
              </ul>
            </div>
          </SettingsSurface>

          <SettingsSurface>
            <SettingsSectionHeader
              title="Knowledge sources"
              description="Shared across all workspaces"
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
                  description="Upload files to start building the shared knowledge library."
                  icon={NotebookPen}
                />
              ) : null}

              {knowledgeSources.map((item) => (
                <div
                  key={item.id}
                  role={['published', 'partial'].includes(normalizeStatus(getIngestion(item)?.status)) ? 'button' : undefined}
                  tabIndex={['published', 'partial'].includes(normalizeStatus(getIngestion(item)?.status)) ? 0 : undefined}
                  onClick={() => {
                    if (['published', 'partial'].includes(normalizeStatus(getIngestion(item)?.status))) setSelectedKnowledge(item);
                  }}
                  onKeyDown={(event) => {
                    if (
                      ['published', 'partial'].includes(normalizeStatus(getIngestion(item)?.status))
                      && (event.key === 'Enter' || event.key === ' ')
                    ) {
                      event.preventDefault();
                      setSelectedKnowledge(item);
                    }
                  }}
                  className={`settings-portal-card rounded-[24px] p-4 transition-[border-color,box-shadow,transform] duration-150 ease-out ${
                    ['published', 'partial'].includes(normalizeStatus(getIngestion(item)?.status))
                      ? 'cursor-pointer hover:border-amber-200 hover:shadow-md active:scale-[0.995]'
                      : ''
                  }`}
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
                        <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                          {renderStatusBadge(item)}
                          {['published', 'partial'].includes(normalizeStatus(getIngestion(item)?.status)) ? (
                            <button
                              type="button"
                              className="settings-portal-button-secondary inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs transition-transform duration-150 ease-out active:scale-95"
                              onClick={() => setSelectedKnowledge(item)}
                            >
                              <FolderOpen size={12} />
                              Explore
                            </button>
                          ) : null}
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
            eyebrow="Jobs"
            title="Knowledge build jobs"
            description="A lightweight view of the background work that turns uploads into searchable knowledge."
            actions={(
              <span className="text-xs text-slate-500">
                {loadingJobs ? 'Updating jobs...' : `${ingestionJobs.length} jobs`}
              </span>
            )}
          />
          <div className="mt-6">
            <KnowledgeJobsTable jobs={ingestionJobs} onRetry={handleRetryJob} />
          </div>
        </SettingsSurface>

      </div>
      {selectedKnowledge ? (
        <KnowledgeBundleExplorer
          knowledgeId={selectedKnowledge.id}
          title={selectedKnowledge.title}
          onClose={() => setSelectedKnowledge(null)}
        />
      ) : null}
    </SettingsShell>
  );
};

export default KnowledgePage;
