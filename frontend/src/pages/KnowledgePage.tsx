import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileIcon, FolderOpen, Loader2, NotebookPen, Plus, RotateCcw, Trash } from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';
import KnowledgeBundleExplorer from '../components/KnowledgeBundleExplorer';
import {
  SettingsEmptyState,
  SettingsLoadingState,
  SettingsNotice,
  SettingsSectionHeader,
  SettingsSurface,
} from '../components/settings/SettingsScaffold';
import {
  deleteGlobalKnowledge,
  listGlobalKnowledge,
  rebuildGlobalKnowledge,
  uploadGlobalKnowledge,
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
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedKnowledge, setSelectedKnowledge] = useState<KnowledgeSource | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

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

  const handleUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (!files.length) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of files) {
        await uploadGlobalKnowledge(file, {
          title: file.name,
          type: guessKnowledgeType(file),
          description: `Uploaded file ${file.name}`,
          metadata: { source: 'upload' },
        });
      }
      await loadKnowledgeSources();
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
      await loadKnowledgeSources();
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
    await loadKnowledgeSources();
  };

  useEffect(() => {
    void loadKnowledgeSources();
  }, [loadKnowledgeSources]);

  useEffect(() => {
    const hasPending = knowledgeSources.some((item) => {
      const ingestion = item.metadata?.ingestion;
      if (!ingestion || typeof ingestion !== 'object') return false;
      const status = normalizeStatus((ingestion as { status?: string }).status);
      return [
        'queued', 'processing', 'extracting', 'structuring', 'chunking', 'enriching',
        'reducing', 'validating', 'indexing', 'publishing',
      ].includes(status);
    });
    if (!hasPending) return;
    const interval = window.setInterval(() => {
      void loadKnowledgeSources();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [knowledgeSources, loadKnowledgeSources]);

  const actions = (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={handleRefresh}
        disabled={loadingKnowledge}
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
                Knowledge is shared across the account and runs asynchronously after upload.
              </p>
              {uploadError ? (
                <p className="mt-3 text-xs text-rose-600">{uploadError}</p>
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
