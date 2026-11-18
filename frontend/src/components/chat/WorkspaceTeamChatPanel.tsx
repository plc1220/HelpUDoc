import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@astryxdesign/core/Button';
import { ArrowLeft, Users } from 'lucide-react';
import type { Components } from 'react-markdown';
import type { TeamChatReference, TeamThreadSummary, Workspace } from '../../types';
import { getFiles } from '../../services/fileApi';
import { fetchSlashMetadata } from '../../services/agentApi';
import { getPublishedVersionSnapshot } from '../../services/workspaceApi';
import {
  createWorkspaceTeamThread,
  getWorkspaceTeamThread,
  getWorkspaceTeamThreadReadiness,
  resolveWorkspaceTeamThreadForMessage,
  TeamThreadApiError,
  type TeamThreadReadiness,
} from '../../services/workspaceCollaborationApi';
import { listWorkspaceCollaborators, type WorkspaceCollaborator } from '../../services/workspaceApi';
import { getAuthUser } from '../../auth/authStore';
import TeamChatComposer from './TeamChatComposer';
import TeamThreadList from './TeamThreadList';
import TeamThreadDetail from './TeamThreadDetail';
import LegacyWorkspaceTeamChatPanel from './LegacyWorkspaceTeamChatPanel';
import {
  clearWorkspaceThreadDrafts,
  NEW_THREAD_DRAFT_ID,
  getThreadDraft,
  setThreadDraft,
  subscribeThreadDrafts,
} from './teamThreadDrafts';

const COMMENT_ROLES = new Set(['commenter', 'contributor', 'editor', 'owner']);

const newClientMessageId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `cmid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

/** Width at/above which the list and detail render side by side (spec F1). */
const SPLIT_MIN_WIDTH = 640;

type PanelProps = {
  viewedVersion?: { versionId: string; versionNumber: number };
  onFilesChanged?: () => void;
  workspace: Workspace;
  filePath?: string;
  colorMode: 'light' | 'dark';
  markdownComponents: Components;
  onOpenPrivateWorkingCopy?: () => Promise<void>;
};

export default function WorkspaceTeamChatPanel(props: PanelProps) {
  const { workspace, colorMode } = props;
  const isDarkMode = colorMode === 'dark';
  const [readiness, setReadiness] = useState<TeamThreadReadiness | null>(null);
  const [readinessResolved, setReadinessResolved] = useState(false);
  const [readinessAccessLost, setReadinessAccessLost] = useState(false);
  const workspaceRef = useRef(workspace.id);
  workspaceRef.current = workspace.id;

  // Readiness gate (spec §7). New thread UI renders ONLY when enabled && ready;
  // otherwise the legacy panel remains, and its backend context isolation is
  // unaffected. A 403 is treated as ACCESS LOSS (no legacy fallback bypass —
  // lifecycle review #5); any OTHER failure fails safe to legacy.
  useEffect(() => {
    let cancelled = false;
    setReadiness(null);
    setReadinessResolved(false);
    setReadinessAccessLost(false);
    getWorkspaceTeamThreadReadiness(workspace.id)
      .then((value) => {
        if (!cancelled && workspaceRef.current === workspace.id) setReadiness(value);
      })
      .catch((readinessError) => {
        if (cancelled || workspaceRef.current !== workspace.id) return;
        if (readinessError instanceof TeamThreadApiError && readinessError.isAccessLoss) {
          setReadinessAccessLost(true);
          return;
        }
        setReadiness({ enabled: false, ready: false, unmappedMessageCount: 0, releaseBEnabled: false });
      })
      .finally(() => {
        if (!cancelled && workspaceRef.current === workspace.id) setReadinessResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  if (!readinessResolved) {
    return (
      <div className={`grid min-h-0 flex-1 place-items-center text-sm ${isDarkMode ? 'bg-[#0d1524] text-slate-500' : 'bg-slate-50 text-slate-400'}`}>
        Loading Workspace Chat…
      </div>
    );
  }

  if (readinessAccessLost) {
    return (
      <div
        role="alert"
        data-testid="team-chat-access-lost"
        className={`grid min-h-0 flex-1 place-items-center px-8 text-center text-sm ${isDarkMode ? 'bg-[#0d1524] text-slate-400' : 'bg-slate-50 text-slate-500'}`}
      >
        <div>
          <p className="font-semibold">You no longer have access to this workspace’s chat.</p>
          <p className="mt-1 text-xs">Reopen the workspace to continue.</p>
        </div>
      </div>
    );
  }

  if (!readiness || !readiness.enabled || !readiness.ready) {
    return <LegacyWorkspaceTeamChatPanel {...props} />;
  }

  return <ThreadsPanel {...props} releaseBReady={Boolean(readiness.releaseBEnabled)} />;
}

function ThreadsPanel({
  workspace,
  filePath,
  colorMode,
  markdownComponents,
  onOpenPrivateWorkingCopy,
  viewedVersion,
  onFilesChanged,
  releaseBReady,
}: PanelProps & { releaseBReady: boolean }) {
  const isDarkMode = colorMode === 'dark';
  const location = useLocation();
  const navigate = useNavigate();
  const userId = getAuthUser()?.id || 'anonymous';
  const workspaceRef = useRef(workspace.id);
  workspaceRef.current = workspace.id;

  const role = workspace.role || 'viewer';
  const canComment = COMMENT_ROLES.has(role);
  const canLumoWrite = workspace.canEdit === true;
  const viewedVersionId = viewedVersion?.versionId;

  const [collaborators, setCollaborators] = useState<WorkspaceCollaborator[]>([]);
  const [accessLost, setAccessLost] = useState(false);
  const [referenceOptions, setReferenceOptions] = useState<Array<TeamChatReference & { description?: string }>>([]);
  const [composingNew, setComposingNew] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [panelWidth, setPanelWidth] = useState<number>(SPLIT_MIN_WIDTH);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRefresh = useRef<() => void>(() => {});

  // Responsiveness is measured against the PANEL width, not the viewport.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setPanelWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const isSplit = panelWidth >= SPLIT_MIN_WIDTH;

  // Navigation is URL-driven so browser Back/Forward works natively (spec F1/
  // A13). The `threadId` query param is the single source of truth for which
  // thread is open; `messageId` is a deep-link that resolves to a thread.
  const query = new URLSearchParams(location.search);
  const matchesWorkspace = query.get('workspaceId') === workspace.id;
  const channel = query.get('channel');
  // Only engage thread navigation for this workspace and the team channel (or
  // when no channel is specified, preserving existing links). Foreign-workspace
  // params are ignored (review #14).
  const channelOk = !channel || channel === 'team';
  const urlThreadId = matchesWorkspace && channelOk ? query.get('threadId') : null;
  const targetMessageId = matchesWorkspace && channelOk ? query.get('messageId') : null;

  // Real thread metadata cache so the detail never renders fabricated summary
  // fields (review #12). Populated from the list (onOpenThread), deep-link
  // resolution, and detail's own load callback.
  const [threadCache, setThreadCache] = useState<Record<string, TeamThreadSummary>>({});
  const cacheThread = useCallback((thread: TeamThreadSummary) => {
    setThreadCache((current) => ({ ...current, [thread.id]: thread }));
  }, []);

  const handleAccessLost = useCallback(() => {
    // Access loss (403 from readiness/list/detail/mutation, or a lost workspace)
    // must: clear this user's drafts + thread association for this workspace,
    // drop cached thread data, and UNMOUNT the list/detail/composers so ALL
    // polling stops and no stale content remains visible (lifecycle review
    // #4/#5). We render an explicit inaccessible state instead of the list.
    clearWorkspaceThreadDrafts(userId, workspace.id);
    // Coordinate the B-owned association clear without editing it.
    void import('../../services/teamThreadAssociation')
      .then((mod) => mod.clearThreadAssociation?.())
      .catch(() => undefined);
    // Also clear any private-work return origins on access loss.
    void import('../../services/privateWorkOrigin')
      .then((mod) => mod.clearAllPrivateWorkOrigins?.())
      .catch(() => undefined);
    setThreadCache({});
    setComposingNew(false);
    setReferenceOptions([]);
    setAccessLost(true);
    setError('');
    navigate(`${location.pathname}`, { replace: true });
  }, [userId, workspace.id, navigate, location.pathname]);

  // Resolve a deep-link messageId to its owning thread id, then rewrite the URL
  // to a canonical threadId link (so Back returns to the list, not the raw
  // message link). Guarded so it runs once per distinct link.
  const resolvedDeepLink = useRef<string | null>(null);
  useEffect(() => {
    if (!targetMessageId || urlThreadId) return;
    const linkKey = location.search;
    if (resolvedDeepLink.current === linkKey) return;
    resolvedDeepLink.current = linkKey;
    void (async () => {
      try {
        const resolved = await resolveWorkspaceTeamThreadForMessage(workspace.id, targetMessageId);
        if (workspaceRef.current !== workspace.id) return;
        navigate(`${location.pathname}?workspaceId=${workspace.id}&channel=team&threadId=${resolved.threadId}&messageId=${targetMessageId}`, { replace: true });
      } catch (linkError) {
        if (linkError instanceof TeamThreadApiError && linkError.isAccessLoss) {
          handleAccessLost();
          return;
        }
        setError(linkError instanceof Error ? linkError.message : 'Failed to open the linked message');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, targetMessageId, urlThreadId, workspace.id]);

  const activeThread: TeamThreadSummary | null = urlThreadId
    ? threadCache[urlThreadId] || ({ id: urlThreadId, title: '', workspaceId: workspace.id, status: 'open', rootMessageId: null, rootPreview: '', createdBy: null, replyCount: 0, lastActivityAt: '', lastMessageSeq: 0, participants: [], unread: false, unreadCount: 0, following: false, runStatus: null, createdAt: '', updatedAt: '' } as TeamThreadSummary)
    : null;

  // Fetch real metadata for a deep-linked/uncached thread (review #12).
  useEffect(() => {
    if (!urlThreadId || threadCache[urlThreadId]) return;
    let cancelled = false;
    void getWorkspaceTeamThread(workspace.id, urlThreadId)
      .then((thread) => {
        if (!cancelled && workspaceRef.current === workspace.id) cacheThread(thread);
      })
      .catch((thErr) => {
        if (thErr instanceof TeamThreadApiError && thErr.isAccessLoss) handleAccessLost();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlThreadId, workspace.id]);

  // Reset per-workspace state when the workspace changes.
  useEffect(() => {
    setComposingNew(false);
    setError('');
    setCollaborators([]);
    setThreadCache({});
    setAccessLost(false);
    resolvedDeepLink.current = null;
    void listWorkspaceCollaborators(workspace.id)
      .then((access) => {
        if (workspaceRef.current === workspace.id) setCollaborators(access.collaborators ?? []);
      })
      .catch(() => {
        if (workspaceRef.current === workspace.id) setCollaborators([]);
      });
  }, [workspace.id]);

  // Reference options (Lumo/people/files/skills), shared by every composer so
  // Lumo references, skills, and file selections are preserved (task brief).
  useEffect(() => {
    let cancelled = false;
    setReferenceOptions([]);
    void Promise.allSettled([
      viewedVersionId ? getPublishedVersionSnapshot(workspace.id, viewedVersionId).then((value) => value.files) : getFiles(workspace.id),
      fetchSlashMetadata(workspace.id),
    ])
      .then(([fileResult, metadataResult]) => {
        const files = fileResult.status === 'fulfilled' ? fileResult.value : [];
        const metadata = metadataResult.status === 'fulfilled' ? metadataResult.value : { skills: [] };
        if (cancelled) return;
        setReferenceOptions([
          { kind: 'agent', id: 'lumo', label: 'Lumo', description: canLumoWrite ? 'Agent · can edit Working' : 'Agent · read-only' },
          ...collaborators.map((person): TeamChatReference & { description: string } => ({ kind: 'person', id: person.userId, label: person.displayName, description: person.role })),
          ...(Array.isArray(files) ? files : []).map((file): TeamChatReference => ({ kind: 'file', id: String(file.id), label: file.name, version: Number(file.version) || undefined, publishedVersionId: viewedVersionId })),
          ...metadata.skills.filter((skill) => skill.valid).map((skill): TeamChatReference & { description?: string } => ({ kind: 'skill', id: skill.id, label: skill.name, description: skill.description })),
        ]);
      })
      .catch((refError) => {
        if (!cancelled) setError(refError instanceof Error ? refError.message : 'Unable to load references');
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id, collaborators, canLumoWrite, viewedVersionId]);

  const openThread = useCallback(
    (thread: TeamThreadSummary) => {
      setComposingNew(false);
      cacheThread(thread);
      // Push a history entry so browser Back returns to the list (spec F1/A13).
      navigate(`${location.pathname}?workspaceId=${workspace.id}&channel=team&threadId=${thread.id}`, { replace: false });
    },
    [navigate, location.pathname, workspace.id, cacheThread],
  );

  const backToList = useCallback(() => {
    setComposingNew(false);
    navigate(`${location.pathname}?workspaceId=${workspace.id}&channel=team`, { replace: false });
  }, [navigate, location.pathname, workspace.id]);

  // Subscribe to the new-thread draft so title/body edits re-render this
  // component (review #13: the title input was previously unsubscribed).
  const newThreadDraft =
    useSyncExternalStore(
      subscribeThreadDrafts,
      () => getThreadDraft(userId, workspace.id, NEW_THREAD_DRAFT_ID),
    ) || { text: '', tokens: [] };

  const handleCreateThread = async (body: string, references: TeamChatReference[]) => {
    if (!body.trim() || creating || !canComment) return;
    setCreating(true);
    setError('');
    const existing = getThreadDraft(userId, workspace.id, NEW_THREAD_DRAFT_ID);
    const title = existing?.title;
    // Reuse the client id only when retrying the SAME failed payload (review #4).
    const reuseKey =
      existing?.failed && existing.clientMessageId && existing.text === body && existing.title === title;
    const clientMessageId = reuseKey ? (existing!.clientMessageId as string) : newClientMessageId();
    // Preserve the full draft (incl. title + tokens) before the request.
    setThreadDraft(userId, workspace.id, NEW_THREAD_DRAFT_ID, {
      text: body,
      tokens: existing?.tokens ?? [],
      title,
      clientMessageId,
      failed: false,
    });
    try {
      const result = await createWorkspaceTeamThread(workspace.id, {
        title,
        body,
        references,
        mentionedUserIds: references.filter((ref) => ref.kind === 'person').map((ref) => ref.id),
        clientMessageId,
      });
      if (workspaceRef.current !== workspace.id) return;
      // Success: clear the new-thread draft and open the created thread.
      setThreadDraft(userId, workspace.id, NEW_THREAD_DRAFT_ID, undefined);
      listRefresh.current();
      openThread(result.thread);
      setComposingNew(false);
    } catch (createError) {
      // Preserve the draft + destination for retry (spec F2/A02).
      setThreadDraft(userId, workspace.id, NEW_THREAD_DRAFT_ID, {
        text: body,
        tokens: existing?.tokens ?? [],
        title,
        clientMessageId,
        failed: true,
      });
      if (createError instanceof TeamThreadApiError && createError.isAccessLoss) {
        handleAccessLost();
        return;
      }
      setError(createError instanceof Error ? createError.message : 'Failed to create thread');
      throw createError;
    } finally {
      setCreating(false);
    }
  };

  const header = (
    <div className={`border-b px-4 py-2.5 ${isDarkMode ? 'border-slate-800 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
      <div className={`flex items-center gap-2 text-sm font-semibold ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>
        <Users size={15} />
        <span># team-chat</span>
      </div>
      <p className={`mt-0.5 text-[11px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
        Threads keep each discussion, its replies, and its Lumo work together.
      </p>
    </div>
  );

  const newThreadComposer = (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="team-new-thread">
      <div className={`flex items-center gap-2 border-b px-3 py-2 ${isDarkMode ? 'border-slate-800' : 'border-slate-200'}`}>
        <Button label="Back" size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={backToList} />
        <span className={`text-sm font-semibold ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>New thread</span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <label className="block text-xs font-semibold opacity-70" htmlFor="new-thread-title">
          Title (optional)
        </label>
        <input
          id="new-thread-title"
          aria-label="New thread title"
          value={newThreadDraft.title || ''}
          onChange={(e) => {
            const current = getThreadDraft(userId, workspace.id, NEW_THREAD_DRAFT_ID) || { text: '', tokens: [] };
            setThreadDraft(userId, workspace.id, NEW_THREAD_DRAFT_ID, { ...current, title: e.target.value });
          }}
          placeholder="Defaults to the first line of your message"
          className="mt-1 w-full rounded-lg border border-slate-500/50 bg-transparent p-2 text-sm"
        />
        <p className="mt-2 text-xs opacity-70">Your first message starts the thread. An empty message won’t create one.</p>
      </div>
      <div className={`border-t p-3 ${isDarkMode ? 'border-slate-800 bg-[#0d1524]' : 'border-slate-200 bg-white'}`}>
        {getThreadDraft(userId, workspace.id, NEW_THREAD_DRAFT_ID)?.failed ? (
          <div role="alert" data-testid="new-thread-failed" className={`mb-2 rounded-xl px-3 py-2 text-xs ${isDarkMode ? 'bg-amber-400/10 text-amber-200' : 'bg-amber-50 text-amber-700'}`}>
            The thread wasn’t created. Your draft is kept — press Send to retry.
          </div>
        ) : null}
        <TeamChatComposer
          key={`new-${workspace.id}`}
          draftKey={`new-${workspace.id}`}
          options={referenceOptions}
          disabled={!canComment}
          sending={creating}
          reply={false}
          value={{ text: newThreadDraft.text, tokens: newThreadDraft.tokens }}
          onDraftChange={(next) => {
            const current = getThreadDraft(userId, workspace.id, NEW_THREAD_DRAFT_ID) || { text: '', tokens: [] };
            setThreadDraft(userId, workspace.id, NEW_THREAD_DRAFT_ID, { ...current, text: next.text, tokens: next.tokens, failed: false });
          }}
          placeholder="Start a new discussion…"
          sendLabel="Start thread"
          onSend={handleCreateThread}
        />
      </div>
    </div>
  );

  const list = (
    <TeamThreadList
      workspaceId={workspace.id}
      isDarkMode={isDarkMode}
      canCreate={canComment}
      activeThreadId={activeThread?.id ?? null}
      onOpenThread={openThread}
      onNewThread={() => {
        setComposingNew(true);
        navigate(`${location.pathname}?workspaceId=${workspace.id}&channel=team`, { replace: false });
      }}
      onAccessLost={handleAccessLost}
      registerRefresh={(refresh) => {
        listRefresh.current = refresh;
      }}
    />
  );

  const detail = activeThread ? (
    <TeamThreadDetail
      key={activeThread.id}
      workspaceId={workspace.id}
      userId={userId}
      thread={activeThread}
      isDarkMode={isDarkMode}
      role={role}
      releaseBReady={releaseBReady}
      markdownComponents={markdownComponents}
      referenceOptions={referenceOptions}
      filePath={filePath}
      showBack={!isSplit}
      onBack={backToList}
      onThreadUpdated={(updated) => {
        cacheThread(updated);
        listRefresh.current();
      }}
      onAccessLost={handleAccessLost}
      onOpenPrivateWorkingCopy={onOpenPrivateWorkingCopy}
      onFilesChanged={onFilesChanged}
      focusMessageId={targetMessageId}
    />
  ) : null;

  if (accessLost) {
    // Explicit inaccessible state. list/detail/composers are NOT rendered, so
    // their polling and cached data are gone (lifecycle review #4/#5).
    return (
      <div ref={rootRef} className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden ${isDarkMode ? 'bg-[#0d1524]' : 'bg-slate-50'}`} data-testid="team-chat-threads-panel">
        {header}
        <div role="alert" data-testid="team-chat-access-lost" className={`grid h-full place-items-center px-8 text-center text-sm ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
          <div>
            <p className="font-semibold">You no longer have access to this workspace’s chat.</p>
            <p className="mt-1 text-xs">Your unsent drafts were cleared. Reopen the workspace to continue.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden ${isDarkMode ? 'bg-[#0d1524]' : 'bg-slate-50'}`} data-testid="team-chat-threads-panel">
      {header}
      {error ? (
        <div role="alert" className={`mx-3 mt-3 rounded-xl border px-3 py-2 text-xs ${isDarkMode ? 'border-rose-400/30 bg-rose-400/10 text-rose-200' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>
          {error}
        </div>
      ) : null}
      {isSplit ? (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(240px,320px)_1fr]">
          <div className={`min-h-0 border-r ${isDarkMode ? 'border-slate-800' : 'border-slate-200'}`}>{list}</div>
          <div className="min-h-0">
            {composingNew ? newThreadComposer : detail || (
              <div className={`grid h-full place-items-center px-8 text-center text-sm ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                Select a thread or start a new one.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          {composingNew ? newThreadComposer : activeThread ? detail : list}
        </div>
      )}
    </div>
  );
}
