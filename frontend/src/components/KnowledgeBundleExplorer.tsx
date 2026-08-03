import { useEffect, useMemo, useState } from 'react';
import { Markdown } from '@astryxdesign/core/Markdown';
import { PowerSearch } from '@astryxdesign/core/PowerSearch';
import type {
  PowerSearchConfig,
  PowerSearchFilter,
} from '@astryxdesign/core/PowerSearch';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import {
  BookOpen,
  Braces,
  Columns3,
  FileClock,
  Files,
  FileText,
  Grid2X2,
  List,
  Loader2,
  X,
} from 'lucide-react';
import {
  getGlobalKnowledgeBundle,
  getGlobalKnowledgeBundleFile,
  type KnowledgeBundleFile,
  type KnowledgeBundleFileContent,
  type KnowledgeBundleFileKind,
  type KnowledgeBundleManifest,
} from '../services/knowledgeApi';

type BundleView = 'grid' | 'columns' | 'list';
type PreviewView = 'rendered' | 'markdown';

type KnowledgeBundleExplorerProps = {
  knowledgeId: number;
  title: string;
  onClose: () => void;
};

const kindValues = [
  { value: 'index', label: 'Index' },
  { value: 'source', label: 'Source' },
  { value: 'concept', label: 'Concept' },
  { value: 'log', label: 'Log' },
  { value: 'other', label: 'Other' },
];

const searchConfig: PowerSearchConfig = {
  name: 'KnowledgeBundleSearch',
  contentSearchFieldKey: 'name',
  fields: [
    {
      key: 'name',
      label: 'Name',
      defaultOperator: 'contains',
      operators: [
        { key: 'contains', label: 'contains', value: { type: 'string' } },
        { key: 'not_contains', label: 'does not contain', value: { type: 'string' } },
      ],
    },
    {
      key: 'kind',
      label: 'Kind',
      defaultOperator: 'any_of',
      operators: [
        { key: 'any_of', label: 'is any of', value: { type: 'enum_list', values: kindValues } },
        { key: 'none_of', label: 'is none of', value: { type: 'enum_list', values: kindValues } },
      ],
    },
    {
      key: 'path',
      label: 'Path',
      defaultOperator: 'contains',
      operators: [
        { key: 'contains', label: 'contains', value: { type: 'string' } },
      ],
    },
  ],
};

const kindLabel: Record<KnowledgeBundleFileKind, string> = {
  index: 'Index',
  source: 'Source',
  concept: 'Concept',
  log: 'Log',
  other: 'File',
};

const fileIcon = (kind: KnowledgeBundleFileKind, size = 17) => {
  if (kind === 'index') return <BookOpen size={size} />;
  if (kind === 'source') return <FileText size={size} />;
  if (kind === 'concept') return <Files size={size} />;
  if (kind === 'log') return <FileClock size={size} />;
  return <Braces size={size} />;
};

const stringFilterValue = (filter: PowerSearchFilter): string => (
  filter.value.type === 'string' ? filter.value.value.trim().toLowerCase() : ''
);

const enumFilterValues = (filter: PowerSearchFilter): string[] => (
  filter.value.type === 'enum_list' ? [...filter.value.value] : []
);

const matchesFilters = (file: KnowledgeBundleFile, filters: ReadonlyArray<PowerSearchFilter>) => (
  filters.every((filter) => {
    if (filter.field === 'name' || filter.field === 'path') {
      const query = stringFilterValue(filter);
      if (!query) return true;
      const candidate = (filter.field === 'name' ? file.name : file.path).toLowerCase();
      return filter.operator === 'not_contains' ? !candidate.includes(query) : candidate.includes(query);
    }
    if (filter.field === 'kind') {
      const values = enumFilterValues(filter);
      if (!values.length) return true;
      return filter.operator === 'none_of' ? !values.includes(file.kind) : values.includes(file.kind);
    }
    return true;
  })
);

const formatUpdatedAt = (value?: string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

export default function KnowledgeBundleExplorer({
  knowledgeId,
  title,
  onClose,
}: KnowledgeBundleExplorerProps) {
  const [manifest, setManifest] = useState<KnowledgeBundleManifest | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [selectedFile, setSelectedFile] = useState<KnowledgeBundleFileContent | null>(null);
  const [filters, setFilters] = useState<PowerSearchFilter[]>([]);
  const [view, setView] = useState<BundleView>('list');
  const [previewView, setPreviewView] = useState<PreviewView>('rendered');
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getGlobalKnowledgeBundle(knowledgeId)
      .then((bundle) => {
        if (!active) return;
        setManifest(bundle);
        const initial = bundle.files.find((file) => file.kind === 'index') || bundle.files[0];
        setSelectedPath(initial?.path || '');
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Failed to load OKF bundle');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [knowledgeId]);

  useEffect(() => {
    if (!selectedPath) {
      setSelectedFile(null);
      return;
    }
    let active = true;
    setFileLoading(true);
    setError(null);
    void getGlobalKnowledgeBundleFile(knowledgeId, selectedPath)
      .then((file) => {
        if (active) setSelectedFile(file);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Failed to load bundle file');
      })
      .finally(() => {
        if (active) setFileLoading(false);
      });
    return () => {
      active = false;
    };
  }, [knowledgeId, selectedPath]);

  const visibleFiles = useMemo(
    () => (manifest?.files || []).filter((file) => matchesFilters(file, filters)),
    [filters, manifest],
  );

  const rootFiles = visibleFiles.filter((file) => !file.path.includes('/'));
  const conceptFiles = visibleFiles.filter((file) => file.path.startsWith('concepts/'));

  const renderFileButton = (file: KnowledgeBundleFile, density: 'card' | 'compact' | 'row') => {
    const selected = selectedPath === file.path;
    const shared = `group text-left transition-[border-color,background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] ${
      selected
        ? 'border-amber-300 bg-amber-50/80 text-slate-950 shadow-sm'
        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
    }`;
    if (density === 'card') {
      return (
        <button key={file.path} type="button" onClick={() => setSelectedPath(file.path)} className={`${shared} min-h-28 rounded-2xl border p-4`}>
          <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${selected ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
            {fileIcon(file.kind, 18)}
          </span>
          <span className="mt-3 block truncate text-sm font-semibold">{file.name}</span>
          <span className="mt-1 block truncate text-xs text-slate-500">{file.path}</span>
        </button>
      );
    }
    if (density === 'compact') {
      return (
        <button key={file.path} type="button" onClick={() => setSelectedPath(file.path)} className={`${shared} flex w-full items-center gap-2 rounded-xl border px-3 py-2`}>
          <span className={selected ? 'text-amber-700' : 'text-slate-400'}>{fileIcon(file.kind, 15)}</span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{file.name}</span>
        </button>
      );
    }
    return (
      <button key={file.path} type="button" onClick={() => setSelectedPath(file.path)} className={`${shared} grid w-full grid-cols-[minmax(0,1fr)_90px_170px] items-center gap-3 border-x-0 border-b border-t-0 px-3 py-2.5`}>
        <span className="flex min-w-0 items-center gap-3">
          <span className={selected ? 'text-amber-700' : 'text-slate-400'}>{fileIcon(file.kind)}</span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{file.name}</span>
            <span className="block truncate text-xs text-slate-500">{file.path}</span>
          </span>
        </span>
        <span className="text-xs text-slate-500">{kindLabel[file.kind]}</span>
        <span className="truncate text-xs text-slate-500">{formatUpdatedAt(file.updatedAt)}</span>
      </button>
    );
  };

  return (
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div className="settings-modal-panel flex h-[min(92vh,940px)] w-full max-w-7xl flex-col overflow-hidden rounded-[28px]" role="dialog" aria-modal="true" aria-label={`OKF bundle for ${title}`}>
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">Published OKF</span>
              {manifest ? <span className="text-xs text-slate-500">v{manifest.okfVersion} · {manifest.files.length} files</span> : null}
            </div>
            <h2 className="mt-2 truncate text-xl font-semibold text-slate-950">{title}</h2>
            <p className="mt-1 truncate text-sm text-slate-500">{manifest?.bundlePath || 'Loading bundle…'}</p>
          </div>
          <button type="button" onClick={onClose} className="settings-portal-button-secondary rounded-xl p-2 transition-transform duration-150 ease-out active:scale-95" aria-label="Close OKF bundle explorer">
            <X size={18} />
          </button>
        </header>

        <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50/70 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <PowerSearch
            style={{ width: 'min(100%, 560px)' }}
            config={searchConfig}
            filters={filters}
            onChange={(nextFilters) => setFilters([...nextFilters])}
            placeholder="Search bundle files…"
            resultCount={`${visibleFiles.length} files`}
            size="sm"
          />
          <SegmentedControl value={view} onChange={(value) => setView(value as BundleView)} label="Bundle view" size="sm">
            <SegmentedControlItem value="grid" label="Grid" isLabelHidden icon={<Grid2X2 size={15} />} />
            <SegmentedControlItem value="columns" label="Columns" isLabelHidden icon={<Columns3 size={15} />} />
            <SegmentedControlItem value="list" label="List" isLabelHidden icon={<List size={15} />} />
          </SegmentedControl>
        </div>

        <div className="grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[minmax(340px,0.8fr)_minmax(0,1.4fr)]">
          <section className="min-h-0 overflow-y-auto border-b border-slate-200 bg-white p-3 lg:border-b-0 lg:border-r">
            {loading ? (
              <div className="flex h-full min-h-52 items-center justify-center gap-2 text-sm text-slate-500"><Loader2 size={17} className="animate-spin" /> Loading bundle…</div>
            ) : visibleFiles.length === 0 ? (
              <div className="flex h-full min-h-52 items-center justify-center text-center text-sm text-slate-500">No bundle files match these filters.</div>
            ) : view === 'grid' ? (
              <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">{visibleFiles.map((file) => renderFileButton(file, 'card'))}</div>
            ) : view === 'columns' ? (
              <div className="grid min-h-full grid-cols-2 gap-3">
                <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-2">
                  <p className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Bundle</p>
                  <div className="space-y-1">{rootFiles.map((file) => renderFileButton(file, 'compact'))}</div>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-2">
                  <p className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Concepts</p>
                  <div className="space-y-1">{conceptFiles.map((file) => renderFileButton(file, 'compact'))}</div>
                </div>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-slate-200">
                <div className="grid grid-cols-[minmax(0,1fr)_90px_170px] gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">
                  <span>Name</span><span>Kind</span><span>Updated</span>
                </div>
                {visibleFiles.map((file) => renderFileButton(file, 'row'))}
              </div>
            )}
          </section>

          <section className="flex min-h-0 flex-col bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">{selectedFile?.name || selectedPath || 'Select a file'}</p>
                <p className="mt-0.5 truncate text-xs text-slate-500">{selectedFile?.path || 'Choose a bundle file to inspect its content.'}</p>
              </div>
              <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-0.5 text-xs font-medium">
                <button type="button" onClick={() => setPreviewView('rendered')} className={`rounded-lg px-2.5 py-1.5 transition-colors ${previewView === 'rendered' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>Rendered</button>
                <button type="button" onClick={() => setPreviewView('markdown')} className={`rounded-lg px-2.5 py-1.5 transition-colors ${previewView === 'markdown' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>Markdown</button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {fileLoading ? (
                <div className="flex h-full min-h-52 items-center justify-center gap-2 text-sm text-slate-500"><Loader2 size={17} className="animate-spin" /> Loading file…</div>
              ) : error ? (
                <div className="m-5 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
              ) : !selectedFile ? (
                <div className="flex h-full min-h-52 items-center justify-center text-sm text-slate-500">Select a file to preview it.</div>
              ) : previewView === 'markdown' ? (
                <pre className="min-h-full overflow-auto whitespace-pre-wrap bg-slate-950 p-5 font-mono text-xs leading-6 text-slate-100">{selectedFile.content}</pre>
              ) : (
                <div className="mx-auto max-w-3xl p-5 sm:p-7">
                  <Markdown density="compact" headingLevelStart={2} contentWidth="48rem" autolink="gfm">{selectedFile.content}</Markdown>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
