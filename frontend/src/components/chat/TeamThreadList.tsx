import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup';
import { Bot, MessageCircle, Plus } from 'lucide-react';
import type { TeamThreadRunStatus, TeamThreadStatus, TeamThreadSummary } from '../../types';
import {
  listWorkspaceTeamThreads,
  TeamThreadApiError,
} from '../../services/workspaceCollaborationApi';

type ListFilter = TeamThreadStatus | 'all';

const RUN_LABEL: Record<TeamThreadRunStatus, string> = {
  queued: 'Lumo queued',
  running: 'Lumo running',
  awaiting_input: 'Lumo needs input',
  completed: 'Lumo done',
  failed: 'Lumo failed',
  cancelled: 'Lumo cancelled',
};

const formatActivity = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
};

/**
 * Dedupe by thread id while preserving the given order. The server returns a
 * deterministic activity+id ordering with full timestamp precision; the client
 * Date type truncates to milliseconds, so re-sorting here would incorrectly
 * reorder sub-millisecond ties (review #2). We therefore trust server order and
 * only remove duplicate ids (keeping the FIRST/most-authoritative occurrence).
 */
const dedupePreserveOrder = (threads: TeamThreadSummary[]): TeamThreadSummary[] => {
  const seen = new Set<string>();
  const out: TeamThreadSummary[] = [];
  for (const thread of threads) {
    if (seen.has(thread.id)) continue;
    seen.add(thread.id);
    out.push(thread);
  }
  return out;
};

export default function TeamThreadList({
  workspaceId,
  isDarkMode,
  canCreate,
  activeThreadId,
  onOpenThread,
  onNewThread,
  onAccessLost,
  registerRefresh,
}: {
  workspaceId: string;
  isDarkMode: boolean;
  canCreate: boolean;
  activeThreadId: string | null;
  onOpenThread: (thread: TeamThreadSummary) => void;
  onNewThread: () => void;
  onAccessLost: () => void;
  /** Lets the parent trigger a first-page refresh after a local mutation. */
  registerRefresh?: (refresh: () => void) => void;
}) {
  const [filter, setFilter] = useState<ListFilter>('all');
  const [threads, setThreads] = useState<TeamThreadSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const savedScroll = useRef(0);
  const mounted = useRef(true);
  // CONTEXT generation: bumped ONLY when the workspace or filter changes. All
  // requests validate against this, NOT a per-request counter, so a periodic
  // refresh in the same context cannot invalidate an in-flight loadMore and
  // strand its loading flag (review #2). A changed context invalidates all
  // outstanding requests coherently.
  const contextGen = useRef(0);
  // Number of pages the user has expanded into. Refresh re-fetches this whole
  // window so remote membership changes in ANY loaded page are revealed and the
  // pagination chain stays valid (review #1/#3).
  const loadedPages = useRef(1);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      contextGen.current += 1;
    };
  }, []);

  const sameContext = (gen: number) => mounted.current && gen === contextGen.current;

  // Re-fetch the full loaded window (page 1..N) as ONE coherent snapshot,
  // following server cursors with full-precision ordering. Preserves scroll.
  const refreshWindow = useCallback(
    async (showLoading: boolean) => {
      const gen = contextGen.current;
      if (showLoading) setLoading(true);
      const el = scrollRef.current;
      const prevScroll = el ? el.scrollTop : 0;
      try {
        const pagesToLoad = Math.max(1, loadedPages.current);
        const collected: TeamThreadSummary[] = [];
        let cursor: string | undefined;
        let lastCursor: string | null = null;
        for (let pageIndex = 0; pageIndex < pagesToLoad; pageIndex += 1) {
          const result = await listWorkspaceTeamThreads(workspaceId, { status: filter, cursor, limit: 30 });
          if (!sameContext(gen)) return; // context changed mid-chain — abandon
          collected.push(...result.threads);
          lastCursor = result.nextCursor;
          if (!result.nextCursor) break; // fewer pages exist now than before
          cursor = result.nextCursor;
        }
        if (!sameContext(gen)) return;
        setThreads(dedupePreserveOrder(collected));
        setNextCursor(lastCursor);
        setError('');
        // Restore scroll after the coherent replacement.
        requestAnimationFrame(() => {
          if (el && sameContext(gen)) el.scrollTop = Math.min(prevScroll, el.scrollHeight);
        });
      } catch (loadError) {
        if (!sameContext(gen)) return;
        if (loadError instanceof TeamThreadApiError && loadError.isAccessLoss) {
          onAccessLost();
          return;
        }
        setError(loadError instanceof Error ? loadError.message : 'Failed to load threads');
      } finally {
        if (sameContext(gen) && showLoading) setLoading(false);
      }
    },
    [workspaceId, filter, onAccessLost],
  );

  useEffect(() => {
    // New context: reset window depth and state, then load page 1.
    contextGen.current += 1;
    loadedPages.current = 1;
    setThreads([]);
    setNextCursor(null);
    setLoadingMore(false);
    void refreshWindow(true);
    const timer = window.setInterval(() => void refreshWindow(false), 6000);
    return () => window.clearInterval(timer);
  }, [refreshWindow]);

  useEffect(() => {
    registerRefresh?.(() => void refreshWindow(false));
  }, [registerRefresh, refreshWindow]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const gen = contextGen.current;
    const cursor = nextCursor;
    setLoadingMore(true);
    if (scrollRef.current) savedScroll.current = scrollRef.current.scrollTop;
    try {
      const result = await listWorkspaceTeamThreads(workspaceId, { status: filter, cursor, limit: 30 });
      // Only apply/clear if the CONTEXT is unchanged; a same-context refresh
      // running concurrently does NOT invalidate this request (review #2).
      if (!sameContext(gen)) return;
      loadedPages.current += 1;
      setThreads((current) => dedupePreserveOrder([...current, ...result.threads]));
      setNextCursor(result.nextCursor);
    } catch (loadError) {
      if (!sameContext(gen)) return;
      if (loadError instanceof TeamThreadApiError && loadError.isAccessLoss) {
        onAccessLost();
        return;
      }
      setError(loadError instanceof Error ? loadError.message : 'Failed to load more threads');
    } finally {
      // Clear the flag whenever we're still in the same context, so a
      // concurrent refresh can never strand it (review #2).
      if (sameContext(gen)) setLoadingMore(false);
    }
  }, [workspaceId, filter, nextCursor, loadingMore, onAccessLost]);

  useEffect(() => {
    if (scrollRef.current && savedScroll.current) {
      scrollRef.current.scrollTop = savedScroll.current;
    }
  }, [threads]);

  const filters: Array<{ id: ListFilter; label: string }> = useMemo(
    () => [
      { id: 'open', label: 'Open' },
      { id: 'resolved', label: 'Resolved' },
      { id: 'all', label: 'All' },
    ],
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="team-thread-list">
      <div
        className={`flex items-center justify-between gap-2 border-b px-3 py-2 ${
          isDarkMode ? 'border-slate-800' : 'border-slate-200'
        }`}
      >
        <ButtonGroup label="Filter threads" size="sm">
          {filters.map((item) => (
            <Button
              key={item.id}
              label={item.label}
              variant={filter === item.id ? 'primary' : 'secondary'}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            />
          ))}
        </ButtonGroup>
        {canCreate ? (
          <Button
            label="New thread"
            size="sm"
            variant="primary"
            icon={<Plus size={14} />}
            onClick={onNewThread}
          />
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className={`mx-3 mt-3 rounded-xl border px-3 py-2 text-xs ${
            isDarkMode
              ? 'border-rose-400/30 bg-rose-400/10 text-rose-200'
              : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}
        >
          {error}
        </div>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-testid="team-thread-scroll">
        {loading ? (
          <div className={`grid h-full place-items-center text-sm ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
            Loading threads…
          </div>
        ) : !threads.length ? (
          <div className="grid h-full place-items-center px-8 text-center">
            <div>
              <div
                className={`mx-auto grid h-12 w-12 place-items-center rounded-2xl ${
                  isDarkMode ? 'bg-slate-800 text-slate-300' : 'bg-white text-slate-500 shadow-sm'
                }`}
              >
                <MessageCircle size={22} />
              </div>
              <p className={`mt-3 text-sm font-semibold ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>
                {filter === 'resolved' ? 'No resolved threads' : 'Start the workspace conversation'}
              </p>
              <p className={`mt-1 text-xs leading-5 ${isDarkMode ? 'text-slate-500' : 'text-slate-500'}`}>
                Open a thread to keep one discussion, its replies, and its Lumo work together.
              </p>
            </div>
          </div>
        ) : (
          <ul className="space-y-2" aria-label="Team threads">
            {threads.map((thread) => {
              const isActive = thread.id === activeThreadId;
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    data-testid={`thread-item-${thread.id}`}
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => onOpenThread(thread)}
                    className={`w-full rounded-2xl border px-3 py-2.5 text-left transition ${
                      isActive
                        ? isDarkMode
                          ? 'border-violet-400/60 bg-violet-400/10'
                          : 'border-violet-300 bg-violet-50'
                        : isDarkMode
                          ? 'border-slate-800 bg-slate-900/55 hover:border-slate-700'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`min-w-0 flex-1 truncate text-sm font-semibold ${
                          isDarkMode ? 'text-slate-100' : 'text-slate-900'
                        }`}
                      >
                        {thread.title}
                      </span>
                      {thread.unread ? (
                        <span
                          data-testid={`thread-unread-${thread.id}`}
                          aria-label={`${thread.unreadCount} unread`}
                          className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-violet-500 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                        >
                          {thread.unreadCount}
                        </span>
                      ) : null}
                    </div>
                    <p className={`mt-0.5 truncate text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                      {thread.rootPreview || 'No preview'}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                      <span className={isDarkMode ? 'text-slate-500' : 'text-slate-400'}>
                        {formatActivity(thread.lastActivityAt)}
                      </span>
                      <span className={`inline-flex items-center gap-1 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                        <MessageCircle size={11} /> {thread.replyCount}
                      </span>
                      {thread.participants.length ? (
                        <span
                          className="inline-flex items-center"
                          role="group"
                          aria-label={`Participants: ${thread.participants.map((p) => p.displayName).join(', ')}`}
                        >
                          {thread.participants.slice(0, 4).map((participant, index) => (
                            <span
                              key={participant.userId}
                              title={participant.displayName}
                              aria-label={participant.displayName}
                              className={`grid h-5 w-5 place-items-center rounded-full border text-[9px] font-semibold ${
                                isDarkMode ? 'border-slate-900 bg-slate-700 text-slate-100' : 'border-white bg-slate-200 text-slate-700'
                              } ${index > 0 ? '-ml-1.5' : ''}`}
                            >
                              {participant.displayName.slice(0, 1).toUpperCase()}
                            </span>
                          ))}
                          {thread.participants.length > 4 ? (
                            <span className={`ml-1 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>+{thread.participants.length - 4}</span>
                          ) : null}
                        </span>
                      ) : null}
                      {thread.status === 'resolved' ? (
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-semibold text-emerald-500">
                          Resolved
                        </span>
                      ) : null}
                      {thread.following ? (
                        <span className={isDarkMode ? 'text-violet-300' : 'text-violet-600'}>Following</span>
                      ) : null}
                      {thread.runStatus ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 font-semibold text-blue-500">
                          <Bot size={11} /> {RUN_LABEL[thread.runStatus]}
                        </span>
                      ) : null}
                    </div>
                  </button>
                </li>
              );
            })}
            {nextCursor ? (
              <li>
                <Button
                  label={loadingMore ? 'Loading…' : 'Load older threads'}
                  size="sm"
                  variant="ghost"
                  onClick={() => void loadMore()}
                  isDisabled={loadingMore}
                />
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </div>
  );
}
