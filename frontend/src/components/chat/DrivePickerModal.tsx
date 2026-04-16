import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Search, X } from 'lucide-react';

import { searchGoogleDriveFiles } from '../../services/fileApi';
import type {
  GoogleDrivePickerItem,
  GoogleDrivePickerScope,
} from '../../types';
import GoogleDriveIcon from './GoogleDriveIcon';

type Props = {
  isOpen: boolean;
  workspaceId?: string;
  colorMode: 'light' | 'dark';
  onClose: () => void;
  onConfirm: (items: GoogleDrivePickerItem[]) => void;
};

const DRIVE_SCOPE_TABS: Array<{ id: GoogleDrivePickerScope; label: string }> = [
  { id: 'recent', label: 'Recent' },
  { id: 'my-drive', label: 'My Drive' },
  { id: 'shared', label: 'Shared with me' },
];

const badgeClassByHint: Record<string, string> = {
  docs: 'bg-blue-50 text-blue-700 border-blue-200',
  sheets: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  slides: 'bg-amber-50 text-amber-700 border-amber-200',
  pdf: 'bg-rose-50 text-rose-700 border-rose-200',
  image: 'bg-violet-50 text-violet-700 border-violet-200',
  file: 'bg-slate-100 text-slate-700 border-slate-200',
};

const badgeLabelByHint: Record<string, string> = {
  docs: 'Doc',
  sheets: 'Sheet',
  slides: 'Slide',
  pdf: 'PDF',
  image: 'Image',
  file: 'File',
};

export default function DrivePickerModal({
  isOpen,
  workspaceId,
  colorMode,
  onClose,
  onConfirm,
}: Props) {
  const isDarkMode = colorMode === 'dark';
  const [scope, setScope] = useState<GoogleDrivePickerScope>('recent');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GoogleDrivePickerItem[]>([]);
  const [selectedById, setSelectedById] = useState<Record<string, GoogleDrivePickerItem>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const resultsPaneRef = useRef<HTMLDivElement | null>(null);
  const requestKeyRef = useRef('');

  useEffect(() => {
    if (!isOpen) {
      setScope('recent');
      setQuery('');
      setResults([]);
      setSelectedById({});
      setIsLoading(false);
      setIsLoadingMore(false);
      setError(null);
      setNextPageToken(null);
      requestKeyRef.current = '';
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !workspaceId) {
      return;
    }

    const timer = window.setTimeout(async () => {
      const requestKey = `${scope}::${query.trim()}`;
      requestKeyRef.current = requestKey;
      setIsLoading(true);
      setError(null);
      try {
        const payload = await searchGoogleDriveFiles(workspaceId, { query, scope });
        if (requestKeyRef.current !== requestKey) {
          return;
        }
        setResults(payload.files);
        setNextPageToken(payload.nextPageToken ?? null);
        resultsPaneRef.current?.scrollTo({ top: 0 });
      } catch (fetchError) {
        const message = fetchError instanceof Error ? fetchError.message : 'Failed to search Google Drive.';
        setError(message);
        setResults([]);
        setNextPageToken(null);
      } finally {
        if (requestKeyRef.current === requestKey) {
          setIsLoading(false);
        }
      }
    }, query.trim() ? 250 : 0);

    return () => window.clearTimeout(timer);
  }, [isOpen, query, scope, workspaceId]);

  const selectedItems = useMemo(
    () => Object.values(selectedById).sort((a, b) => a.name.localeCompare(b.name)),
    [selectedById],
  );

  const toggleItem = (item: GoogleDrivePickerItem) => {
    setSelectedById((prev) => {
      if (prev[item.id]) {
        const next = { ...prev };
        delete next[item.id];
        return next;
      }
      return { ...prev, [item.id]: item };
    });
  };

  const loadMore = useCallback(async () => {
    if (!workspaceId || !nextPageToken || isLoading || isLoadingMore) {
      return;
    }

    const requestKey = `${scope}::${query.trim()}`;
    setIsLoadingMore(true);
    try {
      const payload = await searchGoogleDriveFiles(workspaceId, {
        query,
        scope,
        pageToken: nextPageToken,
      });
      if (requestKeyRef.current !== requestKey) {
        return;
      }
      setResults((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const nextItems = payload.files.filter((item) => !seen.has(item.id));
        return [...prev, ...nextItems];
      });
      setNextPageToken(payload.nextPageToken ?? null);
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : 'Failed to load more Google Drive files.';
      setError(message);
    } finally {
      if (requestKeyRef.current === requestKey) {
        setIsLoadingMore(false);
      }
    }
  }, [workspaceId, nextPageToken, isLoading, isLoadingMore, scope, query]);

  const handleResultsScroll = useCallback(() => {
    const container = resultsPaneRef.current;
    if (!container || !nextPageToken || isLoading || isLoadingMore) {
      return;
    }
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (remaining < 280) {
      void loadMore();
    }
  }, [nextPageToken, isLoading, isLoadingMore, loadMore]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <div className={`flex max-h-[min(92vh,860px)] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border shadow-2xl ${
        isDarkMode ? 'border-slate-700 bg-slate-900 text-slate-100' : 'border-slate-200 bg-white text-slate-900'
      }`}>
        <div className={`flex items-center justify-between border-b px-5 py-4 ${
          isDarkMode ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <div className="flex items-center gap-3">
            <div className={`flex h-11 w-11 items-center justify-center rounded-2xl ${
              isDarkMode ? 'bg-slate-800' : 'bg-slate-100'
            }`}>
              <GoogleDriveIcon className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-semibold">Select files from Google Drive</p>
              <p className={`text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                Search Drive or paste a file URL, then add the selections to this message.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`rounded-full p-2 transition ${
              isDarkMode ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-100' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'
            }`}
            aria-label="Close Google Drive picker"
          >
            <X size={18} />
          </button>
        </div>

        <div className={`border-b px-5 py-4 ${isDarkMode ? 'border-slate-800' : 'border-slate-200'}`}>
          <div className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${
            isDarkMode ? 'border-slate-700 bg-slate-950' : 'border-slate-200 bg-slate-50'
          }`}>
            <Search size={18} className={isDarkMode ? 'text-slate-500' : 'text-slate-400'} />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search in Drive or paste URL"
              className={`w-full bg-transparent text-sm outline-none ${
                isDarkMode ? 'placeholder:text-slate-500' : 'placeholder:text-slate-400'
              }`}
            />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {DRIVE_SCOPE_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setScope(tab.id)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                  scope === tab.id
                    ? isDarkMode
                      ? 'bg-sky-400/15 text-sky-100 ring-1 ring-sky-400/25'
                      : 'bg-sky-50 text-sky-700 ring-1 ring-sky-200'
                    : isDarkMode
                      ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div
            ref={resultsPaneRef}
            onScroll={handleResultsScroll}
            className="min-h-0 overflow-y-auto p-5"
          >
            {isLoading ? (
              <div className={`flex min-h-[320px] items-center justify-center gap-3 text-sm ${
                isDarkMode ? 'text-slate-400' : 'text-slate-500'
              }`}>
                <Loader2 size={18} className="animate-spin" />
                <span>Loading Drive files…</span>
              </div>
            ) : error ? (
              <div className={`rounded-2xl border px-4 py-3 text-sm ${
                isDarkMode ? 'border-rose-500/20 bg-rose-500/10 text-rose-200' : 'border-rose-200 bg-rose-50 text-rose-700'
              }`}>
                {error}
              </div>
            ) : !results.length ? (
              <div className={`flex min-h-[320px] items-center justify-center rounded-2xl border border-dashed text-sm ${
                isDarkMode ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-500'
              }`}>
                No matching Google Drive files
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {results.map((item) => {
                    const isSelected = Boolean(selectedById[item.id]);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => toggleItem(item)}
                        className={`rounded-2xl border p-4 text-left transition ${
                          isSelected
                            ? isDarkMode
                              ? 'border-sky-400/40 bg-sky-400/10'
                              : 'border-sky-300 bg-sky-50'
                            : isDarkMode
                              ? 'border-slate-800 bg-slate-950 hover:border-slate-700'
                              : 'border-slate-200 bg-white hover:border-slate-300'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-semibold ${
                            badgeClassByHint[item.iconHint]
                          }`}>
                            {badgeLabelByHint[item.iconHint]}
                          </span>
                          {isSelected && (
                            <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full ${
                              isDarkMode ? 'bg-sky-400/15 text-sky-100' : 'bg-sky-100 text-sky-700'
                            }`}>
                              <Check size={14} />
                            </span>
                          )}
                        </div>
                        <p className="mt-4 line-clamp-2 text-sm font-semibold">{item.name}</p>
                        <div className={`mt-3 space-y-1 text-xs ${
                          isDarkMode ? 'text-slate-400' : 'text-slate-500'
                        }`}>
                          {item.ownerNames?.length ? <p>{item.ownerNames.join(', ')}</p> : null}
                          {item.modifiedTime ? <p>Updated {new Date(item.modifiedTime).toLocaleString()}</p> : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {(isLoadingMore || nextPageToken) ? (
                  <div className={`flex items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-3 text-sm ${
                    isDarkMode ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-500'
                  }`}>
                    {isLoadingMore ? <Loader2 size={16} className="animate-spin" /> : null}
                    <span>{isLoadingMore ? 'Loading more files…' : 'Scroll down to load more Drive files'}</span>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <aside className={`flex min-h-0 flex-col border-l p-5 ${isDarkMode ? 'border-slate-800 bg-slate-950/60' : 'border-slate-200 bg-slate-50/80'}`}>
            <p className="text-sm font-semibold">Selected</p>
            <p className={`mt-1 text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              {selectedItems.length ? `${selectedItems.length} file${selectedItems.length === 1 ? '' : 's'} ready to attach` : 'Pick one or more Drive files'}
            </p>
            <div className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {selectedItems.length ? selectedItems.map((item) => (
                <div
                  key={item.id}
                  className={`rounded-2xl border px-3 py-2 text-sm ${
                    isDarkMode ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white'
                  }`}
                >
                  <p className="truncate font-medium">{item.name}</p>
                  <p className={`mt-1 text-[11px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    {badgeLabelByHint[item.iconHint]}
                  </p>
                </div>
              )) : (
                <div className={`rounded-2xl border border-dashed px-3 py-4 text-xs ${
                  isDarkMode ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-500'
                }`}>
                  Your selections will appear here.
                </div>
              )}
            </div>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className={`flex-1 rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                  isDarkMode ? 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onConfirm(selectedItems)}
                disabled={!selectedItems.length}
                className={`flex-1 rounded-xl px-3 py-2 text-sm font-semibold text-white transition ${
                  selectedItems.length
                    ? 'bg-[linear-gradient(135deg,rgba(66,133,244,0.95),rgba(15,157,88,0.92))] shadow-[0_12px_30px_-18px_rgba(66,133,244,0.85)]'
                    : 'cursor-not-allowed bg-slate-300 text-slate-100 shadow-none'
                }`}
              >
                Add to message
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
