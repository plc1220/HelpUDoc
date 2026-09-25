import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { ArrowDown, ArrowLeft, Check, Link2, RotateCcw } from 'lucide-react';
import type { Components } from 'react-markdown';
import type { TeamChatReference, TeamThreadSummary } from '../../types';
import TeamChatComposer from './TeamChatComposer';
import TeamMessageArticle from './TeamMessageArticle';
import TeamThreadWorkHistory from './TeamThreadWorkHistory';
import TeamThreadLinkedItems from './TeamThreadLinkedItems';
import { DEFAULT_CONVERSIONS, type CollaborationConversion } from './teamConversions';
import {
  createWorkspaceCollaborationObject,
  convertWorkspaceCollaborationObjectToProposal,
  listWorkspaceCollaborationObjects,
  listWorkspaceTeamThreadMessages,
  patchWorkspaceTeamThread,
  postWorkspaceTeamThreadMessage,
  resolveWorkspaceTeamThreadForMessage,
  respondToTeamInteraction,
  setWorkspaceTeamThreadFollowState,
  setWorkspaceTeamThreadReadState,
  TeamThreadApiError,
  type WorkspaceTeamMessage,
} from '../../services/workspaceCollaborationApi';
import { buildAnnotationLumoReference, getProposalPrivateNavigation, type ThreadLinkedItem } from '../../services/teamThreadWorkApi';
import { setPrivateWorkOrigin } from '../../services/privateWorkOrigin';
import {
  getThreadAssociationSnapshot,
  setThreadAssociation,
  clearThreadAssociation,
  subscribeThreadAssociation,
} from '../../services/teamThreadAssociation';
import {
  clearThreadDraftIfAttemptOwned,
  getThreadDraft,
  markThreadDraftFailedIfOwned,
  setThreadDraft,
  type TeamThreadDraft,
} from './teamThreadDrafts';

const MESSAGE_PAGE = 50;

const titleFromMessage = (message: WorkspaceTeamMessage, label: string) => {
  const compact = message.body.replace(/\s+/g, ' ').replace(/@lumo\b[:,]?/gi, '').trim();
  return `${label}: ${compact.slice(0, 72)}${compact.length > 72 ? '…' : ''}`;
};

const seqOf = (message: WorkspaceTeamMessage): number =>
  message.sequence != null ? Number(message.sequence) : 0;

const mergeMessages = (
  current: WorkspaceTeamMessage[],
  incoming: WorkspaceTeamMessage[],
): WorkspaceTeamMessage[] => {
  const byId = new Map(current.map((message) => [message.id, message]));
  // Incoming wins for a given id so streaming bodies / run metadata update in
  // place without duplicates (spec F4).
  incoming.forEach((message) => byId.set(message.id, message));
  return Array.from(byId.values()).sort((a, b) => {
    const sa = seqOf(a);
    const sb = seqOf(b);
    if (sa !== sb) return sa - sb;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
};

const COMMENT_ROLES = new Set(['commenter', 'contributor', 'editor', 'owner']);
const CONTRIBUTOR_ROLES = new Set(['contributor', 'editor', 'owner']);

const newClientMessageId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `cmid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const emptyDraft = (): TeamThreadDraft => ({ text: '', tokens: [] });

export default function TeamThreadDetail({
  workspaceId,
  userId,
  thread: initialThread,
  isDarkMode,
  role,
  releaseBReady,
  markdownComponents,
  referenceOptions,
  filePath,
  showBack,
  onBack,
  onThreadUpdated,
  onAccessLost,
  onOpenPrivateWorkingCopy,
  onFilesChanged,
  focusMessageId,
}: {
  workspaceId: string;
  userId: string;
  thread: TeamThreadSummary;
  isDarkMode: boolean;
  role: string;
  releaseBReady?: boolean;
  markdownComponents: Components;
  referenceOptions: Array<TeamChatReference & { description?: string }>;
  filePath?: string;
  showBack: boolean;
  onBack: () => void;
  onThreadUpdated: (thread: TeamThreadSummary) => void;
  onAccessLost: () => void;
  onOpenPrivateWorkingCopy?: () => Promise<void>;
  onFilesChanged?: () => void;
  /** Deep-link: scroll to and reveal this message via around-pagination. */
  focusMessageId?: string | null;
}) {
  const threadId = initialThread.id;
  const [thread, setThread] = useState<TeamThreadSummary>(initialThread);
  const [messages, setMessages] = useState<WorkspaceTeamMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [hasOlder, setHasOlder] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [replyTo, setReplyTo] = useState<WorkspaceTeamMessage | null>(null);
  const [actionMessageId, setActionMessageId] = useState<string | null>(null);
  const [interactionText, setInteractionText] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(initialThread.title);
  const [newMessagesWaiting, setNewMessagesWaiting] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  // Release B: which tab is active. Conversation is always available; Changes /
  // Linked items appear only when Release B is ready for this workspace.
  const [activeTab, setActiveTab] = useState<'conversation' | 'changes' | 'linked'>('conversation');
  const [workingPrivately, setWorkingPrivately] = useState(false);
  // Bumped to force the composer to re-read the persisted draft after we stage
  // an annotation reference into it (the composer only restores on key change).
  const [composerNonce, setComposerNonce] = useState(0);

  // Stable external-store snapshot of THIS user's future-edit association for
  // this workspace. Referentially stable (getThreadAssociationSnapshot) so
  // useSyncExternalStore never loops. Opening a thread does NOT attribute; only
  // the explicit toggle below does.
  const association = useSyncExternalStore(
    subscribeThreadAssociation,
    () => getThreadAssociationSnapshot(workspaceId),
  );
  const isAssociatedToThisThread = association?.threadId === initialThread.id;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Monotonically increasing token; every async response checks it and every
  // context change (thread switch / unmount) bumps it, invalidating in-flight
  // requests so a stale response can never mutate the wrong thread (review #7).
  const requestToken = useRef(0);
  const mounted = useRef(true);
  const isFocusedRef = useRef(true);
  const highestDisplayedSeq = useRef(0);
  const lastReportedReadSeq = useRef(0);
  const knownArtifacts = useRef(new Set<string>());
  const filesChangedRef = useRef(onFilesChanged);
  filesChangedRef.current = onFilesChanged;
  const newerCursorRef = useRef<number | null>(null);
  // Live mirror of messages so the polling closure can read the CURRENT loaded
  // window (its sequence range) without being recreated every render.
  const messagesRef = useRef<WorkspaceTeamMessage[]>([]);
  messagesRef.current = messages;

  const [draft, setDraftState] = useState<TeamThreadDraft>(
    () => getThreadDraft(userId, workspaceId, threadId) || emptyDraft(),
  );

  const canComment = COMMENT_ROLES.has(role);
  const canPropose = CONTRIBUTOR_ROLES.has(role);
  const canModerate = role === 'owner' || role === 'editor';
  const canManageThread = canModerate || thread.createdBy === userId;

  useEffect(() => {
    mounted.current = true;
    return () => {
      // Invalidate everything in flight on unmount (review #7).
      mounted.current = false;
      requestToken.current += 1;
    };
  }, []);

  const alive = (token: number) => mounted.current && token === requestToken.current;

  // Re-sync local state when the active thread id changes; a new token here
  // cancels the previous thread's in-flight requests.
  useEffect(() => {
    requestToken.current += 1;
    setThread(initialThread);
    setRenameValue(initialThread.title);
    setRenaming(false);
    setActionMessageId(null);
    setMessages([]);
    setHasOlder(false);
    setHasNewer(false);
    setOlderCursor(null);
    newerCursorRef.current = null;
    const restored = getThreadDraft(userId, workspaceId, threadId) || emptyDraft();
    setDraftState(restored);
    // Restore the quoted reply target from the preserved draft (review #6).
    setReplyTo(null);
    highestDisplayedSeq.current = 0;
    lastReportedReadSeq.current = 0;
    knownArtifacts.current.clear();
    setNewMessagesWaiting(false);
    setActiveTab('conversation');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const isNearBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const setCursorsFromPage = useCallback(
    (
      cursors: { olderCursor: string | null; newerCursor: string | null; hasOlder: boolean; hasNewer: boolean },
      mode: 'replace' | 'append-older' | 'append-newer',
    ) => {
      if (mode !== 'append-newer') {
        setOlderCursor(cursors.olderCursor ? Number(cursors.olderCursor) : null);
        setHasOlder(cursors.hasOlder);
      }
      if (mode !== 'append-older') {
        const next = cursors.newerCursor ? Number(cursors.newerCursor) : null;
        newerCursorRef.current = next;
        setHasNewer(cursors.hasNewer);
      }
    },
    [],
  );

  const noteArtifacts = (incoming: WorkspaceTeamMessage[]) => {
    for (const message of incoming) {
      const artifacts = message.metadata?.artifacts as unknown[] | undefined;
      if (artifacts?.length && !knownArtifacts.current.has(message.id)) {
        knownArtifacts.current.add(message.id);
        filesChangedRef.current?.();
      }
    }
  };

  const loadLatest = useCallback(
    async (showLoading: boolean) => {
      const token = requestToken.current;
      if (showLoading) setLoading(true);
      try {
        const page = await listWorkspaceTeamThreadMessages(workspaceId, threadId, { limit: MESSAGE_PAGE });
        if (!alive(token)) return;
        setMessages(mergeMessages([], page.messages));
        setCursorsFromPage(page, 'replace');
        setThread(page.thread);
        onThreadUpdated(page.thread);
        noteArtifacts(page.messages);
        setError('');
      } catch (loadError) {
        if (!alive(token)) return;
        if (loadError instanceof TeamThreadApiError && loadError.isAccessLoss) return onAccessLost();
        setError(loadError instanceof Error ? loadError.message : 'Failed to load thread');
      } finally {
        if (alive(token) && showLoading) setLoading(false);
      }
    },
    [workspaceId, threadId, setCursorsFromPage, onThreadUpdated, onAccessLost],
  );

  const loadAround = useCallback(
    async (messageId: string) => {
      const token = requestToken.current;
      setLoading(true);
      try {
        const page = await listWorkspaceTeamThreadMessages(workspaceId, threadId, {
          aroundMessageId: messageId,
          limit: MESSAGE_PAGE,
        });
        if (!alive(token)) return;
        setMessages(mergeMessages([], page.messages));
        setCursorsFromPage(page, 'replace');
        setThread(page.thread);
        onThreadUpdated(page.thread);
        noteArtifacts(page.messages);
        setError('');
        requestAnimationFrame(() => {
          document.getElementById(`thread-message-${messageId}`)?.scrollIntoView({ block: 'center' });
        });
      } catch (loadError) {
        if (!alive(token)) return;
        if (loadError instanceof TeamThreadApiError && loadError.isAccessLoss) return onAccessLost();
        setError(loadError instanceof Error ? loadError.message : 'Failed to load message');
      } finally {
        if (alive(token)) setLoading(false);
      }
    },
    [workspaceId, threadId, setCursorsFromPage, onThreadUpdated, onAccessLost],
  );

  useEffect(() => {
    if (focusMessageId) void loadAround(focusMessageId);
    else void loadLatest(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, focusMessageId]);

  // Restore the quoted reply target from the preserved draft (review #6).
  // The target may be outside the loaded page; resolve it via around/resolve so
  // returning to the thread never silently drops the quote.
  const draftReplyId = draft.replyToMessageId;
  useEffect(() => {
    if (!draftReplyId) return;
    if (replyTo?.id === draftReplyId) return;
    const loaded = messages.find((m) => m.id === draftReplyId);
    if (loaded) {
      setReplyTo(loaded);
      return;
    }
    // Not loaded yet — fetch just enough context to describe the target.
    let cancelled = false;
    void (async () => {
      try {
        const resolved = await resolveWorkspaceTeamThreadForMessage(workspaceId, draftReplyId);
        if (cancelled || !mounted.current) return;
        if (resolved.message) setReplyTo(resolved.message);
      } catch {
        /* leave replyTo unset; the draft still preserves the id for send */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftReplyId, messages]);

  // Background poll. Refreshes loaded bodies/run metadata AND advances newer
  // pages. Never advances read state (spec F4). Cancels on navigation/unmount.
  useEffect(() => {
    const timer = window.setInterval(async () => {
      const token = requestToken.current;
      const cursor = newerCursorRef.current;
      try {
        // Refresh the ACTUAL currently-loaded window (by its sequence range),
        // not latest-50, so an awaiting-input SOURCE older than the latest page
        // still updates when it is on screen around an old target (review #4/#9).
        const shown = messagesRef.current;
        if (shown.length) {
          const seqs = shown.map(seqOf).filter((s) => s > 0);
          if (seqs.length) {
            const minSeq = Math.min(...seqs);
            const maxSeq = Math.max(...seqs);
            const shownIds = new Set(shown.map((m) => m.id));
            // Page through the loaded span in bounded chunks and update only the
            // ids we already display (mutable bodies/run metadata) in place.
            let fromSeq = minSeq - 1;
            for (let guard = 0; guard < 40 && fromSeq < maxSeq; guard += 1) {
              const windowPage = await listWorkspaceTeamThreadMessages(workspaceId, threadId, { afterSeq: fromSeq, limit: MESSAGE_PAGE });
              if (!alive(token)) return;
              if (!windowPage.messages.length) break;
              const updates = windowPage.messages.filter((m) => shownIds.has(m.id));
              if (updates.length) setMessages((current) => mergeMessages(current, updates));
              const pageMax = Math.max(...windowPage.messages.map(seqOf));
              if (pageMax <= fromSeq) break;
              fromSeq = pageMax;
              // Keep thread metadata fresh from the page envelope.
              if (alive(token)) {
                setThread(windowPage.thread);
                onThreadUpdated(windowPage.thread);
              }
            }
          }
        }
        if (!alive(token)) return;

        // Fetch strictly newer messages beyond our newest cursor.
        if (cursor != null) {
          const page = await listWorkspaceTeamThreadMessages(workspaceId, threadId, { afterSeq: cursor });
          if (!alive(token)) return;
          if (page.messages.length) {
            const nearBottom = isNearBottom();
            setMessages((current) => mergeMessages(current, page.messages));
            setCursorsFromPage(page, 'append-newer');
            noteArtifacts(page.messages);
            if (nearBottom && isFocusedRef.current) {
              requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
            } else {
              setNewMessagesWaiting(true);
            }
          }
        } else {
          // At latest already: a fresh latest page may include new tail messages.
          const refresh = await listWorkspaceTeamThreadMessages(workspaceId, threadId, { limit: MESSAGE_PAGE });
          if (!alive(token)) return;
          const nearBottom = isNearBottom();
          setMessages((current) => {
            const before = current.length;
            const merged = mergeMessages(current, refresh.messages);
            if (merged.length !== before && !(nearBottom && isFocusedRef.current)) setNewMessagesWaiting(true);
            return merged;
          });
          setCursorsFromPage(refresh, 'replace');
          setThread(refresh.thread);
          onThreadUpdated(refresh.thread);
          noteArtifacts(refresh.messages);
        }
      } catch (pollError) {
        if (pollError instanceof TeamThreadApiError && pollError.isAccessLoss) onAccessLost();
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [workspaceId, threadId, setCursorsFromPage, onThreadUpdated, onAccessLost]);

  // Track panel/tab focus. Only a focused panel may advance read state.
  useEffect(() => {
    const onVisibility = () => {
      isFocusedRef.current = document.visibilityState === 'visible' && document.hasFocus();
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    window.addEventListener('blur', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
      window.removeEventListener('blur', onVisibility);
    };
  }, []);

  const reportReadState = useCallback(
    async (seq: number) => {
      if (seq <= lastReportedReadSeq.current) return; // monotonic
      const token = requestToken.current;
      lastReportedReadSeq.current = seq;
      try {
        const result = await setWorkspaceTeamThreadReadState(workspaceId, threadId, seq);
        if (!alive(token)) return;
        setThread((current) => ({
          ...current,
          unread: current.lastMessageSeq > result.lastReadSeq,
          unreadCount: Math.max(current.lastMessageSeq - result.lastReadSeq, 0),
        }));
      } catch (readError) {
        if (readError instanceof TeamThreadApiError && readError.isAccessLoss) return onAccessLost();
        // Transient failure: roll BOTH the reported and displayed watermarks
        // back so a still-visible marker can be retried (review #5). Schedule a
        // re-scan of the currently-visible nodes rather than waiting for a new,
        // higher sequence to scroll into view.
        lastReportedReadSeq.current = Math.min(lastReportedReadSeq.current, seq - 1);
        highestDisplayedSeq.current = Math.min(highestDisplayedSeq.current, seq - 1);
        window.setTimeout(() => {
          if (mounted.current) scanVisibleRef.current();
        }, 1500);
      }
    },
    [workspaceId, threadId, onAccessLost],
  );

  // Advance read state to the highest ACTUALLY-DISPLAYED sequence while focused,
  // monotonically (spec F4/A10). A message taller than the viewport can never
  // reach a 0.6 ratio, so we treat "any meaningful portion visible" as read for
  // tall messages (review #10): a low threshold plus an explicit tall-node
  // check keeps read state honest without inferring unseen messages.
  const scanVisibleRef = useRef<() => void>(() => {});
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const isDisplayed = (el: HTMLElement) => {
      const cr = container.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const visibleTop = Math.max(cr.top, er.top);
      const visibleBottom = Math.min(cr.bottom, er.bottom);
      const visible = Math.max(0, visibleBottom - visibleTop);
      if (visible <= 0) return false;
      const tallerThanViewport = el.clientHeight > container.clientHeight * 0.6;
      // A normal message must be ≥60% visible; a very tall message counts once
      // any meaningful slice is on screen (it can never reach 60%).
      return tallerThanViewport ? visible > 24 : visible / Math.max(er.height, 1) >= 0.6;
    };
    const consider = (el: HTMLElement) => {
      const seq = Number(el.dataset.seq || 0);
      if (seq > highestDisplayedSeq.current) {
        highestDisplayedSeq.current = seq;
        void reportReadState(seq);
      }
    };
    // Re-evaluate all currently-visible message nodes and report the max seq.
    // Used by the observer AND by a retry after a transient read failure so a
    // still-visible marker can advance again without needing a NEW higher seq
    // to scroll into view (review #5).
    const scanVisible = () => {
      if (!isFocusedRef.current) return;
      let maxSeq = 0;
      container.querySelectorAll('[data-seq]').forEach((node) => {
        const el = node as HTMLElement;
        if (isDisplayed(el)) maxSeq = Math.max(maxSeq, Number(el.dataset.seq || 0));
      });
      if (maxSeq > highestDisplayedSeq.current) {
        highestDisplayedSeq.current = maxSeq;
        void reportReadState(maxSeq);
      }
    };
    scanVisibleRef.current = scanVisible;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!isFocusedRef.current) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          if (isDisplayed(el)) consider(el);
        }
      },
      { root: container, threshold: [0, 0.25, 0.6, 1] },
    );
    const nodes = container.querySelectorAll('[data-seq]');
    nodes.forEach((node) => observer.observe(node));
    // Advancing read markers should also re-check when focus returns.
    window.addEventListener('focus', scanVisible);
    return () => {
      observer.disconnect();
      window.removeEventListener('focus', scanVisible);
    };
  }, [messages, reportReadState]);

  const persistDraft = useCallback(
    (next: TeamThreadDraft) => {
      setDraftState(next);
      setThreadDraft(userId, workspaceId, threadId, next);
    },
    [userId, workspaceId, threadId],
  );

  // Release B (F8): stage an explicit Lumo invocation that INCLUDES a
  // version-pinned annotation reference. We add BOTH an `@Lumo` token (so an
  // explicit Send actually starts a run — an annotation reference alone is an
  // ordinary human message and never invokes the agent) AND the annotation
  // reference. Nothing is sent until the user presses Send; clicking Include
  // never starts a request on its own.
  const includeAnnotationInLumo = useCallback(
    (item: ThreadLinkedItem) => {
      const reference = buildAnnotationLumoReference(item);
      setActiveTab('conversation');
      setDraftState((current) => {
        const hasLumo = current.tokens.some((t) => t.reference.kind === 'agent' && t.reference.id === 'lumo');
        let text = current.text;
        const tokens = [...current.tokens];
        // Prepend @Lumo when not already present.
        if (!hasLumo) {
          const lumoLabel = '@Lumo';
          const lumoToken = { start: 0, end: lumoLabel.length, reference: { kind: 'agent', id: 'lumo', label: 'Lumo' } as TeamChatReference };
          text = `${lumoLabel} ${text}`;
          // Shift existing tokens by the inserted prefix length.
          const shift = lumoLabel.length + 1;
          for (let i = 0; i < tokens.length; i += 1) {
            tokens[i] = { ...tokens[i], start: tokens[i].start + shift, end: tokens[i].end + shift };
          }
          tokens.unshift(lumoToken);
        }
        // Append the annotation reference token.
        const label = `@${reference.label}`;
        const needsSpace = text.length > 0 && !/\s$/.test(text);
        const start = text.length + (needsSpace ? 1 : 0);
        const nextText = `${text}${needsSpace ? ' ' : ''}${label} `;
        tokens.push({ start, end: start + label.length, reference });
        const next: TeamThreadDraft = {
          ...current,
          text: nextText,
          tokens,
          status: 'editing',
          failed: false,
        };
        setThreadDraft(userId, workspaceId, threadId, next);
        return next;
      });
      setNotice('Lumo request staged with this annotation. Review your message, then Send to run Lumo with it.');
      setComposerNonce((n) => n + 1);
      setFocusKey((k) => k + 1);
    },
    [userId, workspaceId, threadId],
  );

  const loadOlder = useCallback(async () => {
    if (olderCursor == null || loadingOlder) return;
    const token = requestToken.current;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const previousHeight = el?.scrollHeight ?? 0;
    try {
      const page = await listWorkspaceTeamThreadMessages(workspaceId, threadId, {
        beforeSeq: olderCursor,
        limit: MESSAGE_PAGE,
      });
      if (!alive(token)) return;
      setMessages((current) => mergeMessages(current, page.messages));
      setCursorsFromPage(page, 'append-older');
      noteArtifacts(page.messages);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - previousHeight + el.scrollTop;
      });
    } catch (loadError) {
      if (!alive(token)) return;
      if (loadError instanceof TeamThreadApiError && loadError.isAccessLoss) return onAccessLost();
      setError(loadError instanceof Error ? loadError.message : 'Failed to load earlier messages');
    } finally {
      if (alive(token)) setLoadingOlder(false);
    }
  }, [workspaceId, threadId, olderCursor, loadingOlder, setCursorsFromPage, onAccessLost]);

  const jumpToNewest = useCallback(async () => {
    if (hasNewer) await loadLatest(false);
    setNewMessagesWaiting(false);
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
  }, [hasNewer, loadLatest]);

  const handleSend = async (body: string, references: TeamChatReference[]) => {
    if (!body.trim() || sending || !canComment) return;
    const token = requestToken.current;
    setSending(true);
    setError('');
    const destinationReply = replyTo?.id;
    // Durable attempt identity (lifecycle review #2): reuse the SAME
    // clientMessageId when the current stored attempt is pending/failed AND the
    // payload+destination are unchanged. This covers a committed-but-unknown
    // send (pending) whose ack was lost — the server dedupes on the key so the
    // retry never duplicates. An intentional payload edit sets status 'editing'
    // (via onDraftChange), forcing a fresh id here.
    const canReuse =
      (draft.status === 'pending' || draft.status === 'failed') &&
      Boolean(draft.clientMessageId) &&
      draft.text === body &&
      draft.replyToMessageId === destinationReply;
    const clientMessageId = canReuse ? (draft.clientMessageId as string) : newClientMessageId();
    // Persist the attempt as PENDING to the store BEFORE the request so it
    // survives navigation/remount and owns the store entry (spec F2/A02).
    const attemptDraft: TeamThreadDraft = {
      text: body,
      tokens: draft.tokens,
      replyToMessageId: destinationReply,
      clientMessageId,
      status: 'pending',
      failed: false,
    };
    persistDraft(attemptDraft);
    try {
      const message = await postWorkspaceTeamThreadMessage(workspaceId, threadId, {
        body,
        replyToMessageId: destinationReply,
        references,
        mentionedUserIds: references.filter((ref) => ref.kind === 'person').map((ref) => ref.id),
        clientMessageId,
      });
      // Clear the draft ONLY if this exact attempt still owns the store entry —
      // works even if the panel unmounted (navigated to another thread), and
      // never clobbers a newer draft the user started here in the meantime
      // (lifecycle review #1/#2).
      clearThreadDraftIfAttemptOwned(userId, workspaceId, threadId, clientMessageId);
      // UI updates only apply to the STILL-ACTIVE thread view.
      if (!alive(token)) return;
      setDraftState(emptyDraft());
      setReplyTo(null);
      setMessages((current) => mergeMessages(current, [message]));
      newerCursorRef.current = Math.max(newerCursorRef.current ?? 0, seqOf(message));
      setThread((current) => ({ ...current, lastMessageSeq: Math.max(current.lastMessageSeq, seqOf(message)) }));
      setFocusKey((k) => k + 1);
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
    } catch (sendError) {
      // Mark failed ONLY if this attempt still owns the store entry. A late
      // failure after sign-out or after a newer attempt must not resurrect a
      // cleared/replaced draft (lifecycle review #2).
      markThreadDraftFailedIfOwned(userId, workspaceId, threadId, clientMessageId);
      if (alive(token)) {
        const stillOwned = getThreadDraft(userId, workspaceId, threadId);
        if (stillOwned && stillOwned.clientMessageId === clientMessageId) {
          setDraftState(stillOwned);
        }
        if (sendError instanceof TeamThreadApiError && sendError.isAccessLoss) return onAccessLost();
        setError(
          sendError instanceof TeamThreadApiError && sendError.isRunActive
            ? 'Lumo is already working in this thread. Your draft is kept — try again when it finishes.'
            : sendError instanceof Error
              ? sendError.message
              : 'Failed to send message',
        );
      }
      throw sendError;
    } finally {
      if (alive(token)) setSending(false);
    }
  };

  const respond = async (messageId: string, input: { decision?: 'approve' | 'reject'; actionId?: string; message?: string }) => {
    const token = requestToken.current;
    try {
      await respondToTeamInteraction(workspaceId, messageId, input);
      if (!alive(token)) return;
      await loadLatest(false);
    } catch (respondError) {
      if (alive(token)) setError(respondError instanceof Error ? respondError.message : 'Unable to respond');
    }
  };

  const toggleResolve = async () => {
    const token = requestToken.current;
    setError('');
    const nextStatus = thread.status === 'resolved' ? 'open' : 'resolved';
    try {
      const updated = await patchWorkspaceTeamThread(workspaceId, threadId, { status: nextStatus });
      if (!alive(token)) return;
      setThread(updated);
      onThreadUpdated(updated);
      setNotice(nextStatus === 'resolved' ? 'Thread resolved.' : 'Thread reopened.');
    } catch (patchError) {
      if (!alive(token)) return;
      if (patchError instanceof TeamThreadApiError && patchError.isAccessLoss) return onAccessLost();
      setError(patchError instanceof Error ? patchError.message : 'Failed to update thread');
    }
  };

  const toggleFollow = async () => {
    const token = requestToken.current;
    setError('');
    try {
      const result = await setWorkspaceTeamThreadFollowState(workspaceId, threadId, !thread.following);
      if (!alive(token)) return;
      const updated = { ...thread, following: result.following };
      setThread(updated);
      onThreadUpdated(updated);
    } catch (followError) {
      if (!alive(token)) return;
      if (followError instanceof TeamThreadApiError && followError.isAccessLoss) return onAccessLost();
      setError(followError instanceof Error ? followError.message : 'Failed to update follow state');
    }
  };

  const submitRename = async () => {
    const token = requestToken.current;
    const title = renameValue.trim();
    if (!title || title === thread.title) {
      setRenaming(false);
      return;
    }
    try {
      const updated = await patchWorkspaceTeamThread(workspaceId, threadId, { title });
      if (!alive(token)) return;
      setThread(updated);
      onThreadUpdated(updated);
      setRenaming(false);
    } catch (renameError) {
      if (!alive(token)) return;
      if (renameError instanceof TeamThreadApiError && renameError.isAccessLoss) return onAccessLost();
      setError(renameError instanceof Error ? renameError.message : 'Failed to rename thread');
    }
  };

  const handleConvert = async (message: WorkspaceTeamMessage, conversion: CollaborationConversion) => {
    const token = requestToken.current;
    setError('');
    setNotice('');
    try {
      const created = await createWorkspaceCollaborationObject(workspaceId, {
        type: conversion.type === 'change_proposal' ? 'sticky_note' : conversion.type,
        visibility: conversion.visibility,
        title: titleFromMessage(message, conversion.label),
        body: message.body,
        filePath: conversion.requiresFile ? filePath : undefined,
        sourceTeamMessageId: message.id,
      });
      if (conversion.type === 'change_proposal') {
        await convertWorkspaceCollaborationObjectToProposal(workspaceId, created.id, threadId);
      }
      if (!alive(token)) return;
      setNotice(`${conversion.label} created from the conversation.`);
      setActionMessageId(null);
      if (conversion.type === 'change_proposal' && onOpenPrivateWorkingCopy) await onOpenPrivateWorkingCopy();
    } catch (conversionError) {
      if (alive(token)) setError(conversionError instanceof Error ? conversionError.message : `Failed to create ${conversion.label.toLowerCase()}`);
    }
  };

  // Release B (F7): explicit, user-facing "Work privately" entry. Creates a
  // thread-linked change proposal (which provisions/attaches the author's
  // linked private copy via convert-to-proposal, recording this thread as the
  // origin), then opens the private working copy. Returning to submit the
  // selected changes is discoverable via the proposal's Changes/review UI
  // (the WorkspaceCollaborationDialog author SubmitPanel), reachable from the
  // Linked items tab and the collaboration surface.
  const handleWorkPrivately = async () => {
    if (!canPropose || workingPrivately) return;
    const token = requestToken.current;
    setWorkingPrivately(true);
    setError('');
    setNotice('');
    try {
      // Reuse an EXISTING thread-linked proposal authored by me rather than
      // creating a redundant object on every click. Only create one when none
      // exists yet for this thread.
      const existing = await listWorkspaceCollaborationObjects(workspaceId);
      if (!alive(token)) return;
      const mine = existing.find(
        (o) =>
          o.type === 'change_proposal' &&
          (o as unknown as { sourceThreadId?: string | null }).sourceThreadId === threadId &&
          o.authorId === userId,
      );
      let proposalId: string;
      if (mine) {
        proposalId = mine.id;
        setNotice('Reopened your private working copy for this thread. Edit, then return here to submit the selected changes.');
      } else {
        const created = await createWorkspaceCollaborationObject(workspaceId, {
          type: 'sticky_note',
          visibility: 'workspace_audience',
          title: `Private work from “${thread.title}”`,
          body: `Private working copy started from thread “${thread.title}”.`,
          sourceThreadId: threadId,
        });
        const proposal = await convertWorkspaceCollaborationObjectToProposal(workspaceId, created.id, threadId);
        if (!alive(token)) return;
        proposalId = proposal.id;
        setNotice('Private working copy ready. Make your edits, then return here to submit the selected changes for review.');
      }
      // Authorized private navigation is REQUIRED to enter the private copy:
      // it returns the author's private workspace id + revision. If it fails
      // (e.g. authorization), we stay on the Shared thread with a clear error
      // and do NOT open another private copy.
      let privateWorkspaceId: string | null = null;
      try {
        const nav = await getProposalPrivateNavigation(workspaceId, proposalId);
        if (!alive(token)) return;
        privateWorkspaceId = nav.linkedPrivateWorkspaceId;
      } catch (navError) {
        if (alive(token)) {
          setError(
            navError instanceof TeamThreadApiError && navError.isAccessLoss
              ? 'You are not authorized to open this private copy.'
              : 'Could not open the private working copy. Please try again.',
          );
        }
        return;
      }
      if (!privateWorkspaceId) {
        if (alive(token)) setError('No private working copy is available for this proposal yet.');
        return;
      }
      // Record the origin so the PRIVATE context shows a "Return to thread /
      // submit" banner. The proposal modal is intentionally NOT opened now —
      // opening it on entry would cover the private editor. Return opens it.
      setPrivateWorkOrigin({
        privateWorkspaceId,
        originWorkspaceId: workspaceId,
        threadId,
        threadTitle: thread.title,
        proposalId,
      });
      if (!alive(token)) return;
      // Enter the private working copy (host switches workspace).
      if (onOpenPrivateWorkingCopy) await onOpenPrivateWorkingCopy();
    } catch (workError) {
      if (alive(token)) setError(workError instanceof Error ? workError.message : 'Failed to start private work');
    } finally {
      if (alive(token)) setWorkingPrivately(false);
    }
  };

  const availableConversions = DEFAULT_CONVERSIONS.filter((conversion) => {
    if (conversion.requiresContributor && !canPropose) return false;
    if (conversion.requiresCommenter && !canComment) return false;
    if (conversion.requiresFile && !filePath) return false;
    return true;
  });

  const messageById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden" data-testid="team-thread-detail" data-thread-id={threadId}>
      <div className={`border-b px-3 py-2.5 ${isDarkMode ? 'border-slate-800 bg-slate-950/30' : 'border-slate-200 bg-white'}`}>
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          {showBack ? <Button label="Back" size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack} /> : null}
          <div className="min-w-0 flex-1">
            {renaming ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  aria-label="Thread title"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitRename();
                    if (e.key === 'Escape') {
                      setRenaming(false);
                      setRenameValue(thread.title);
                    }
                  }}
                  className="min-w-0 flex-1 rounded border border-slate-500 bg-transparent px-2 py-1 text-sm"
                />
                <Button label="Save" size="sm" variant="primary" onClick={() => void submitRename()} />
              </div>
            ) : (
              <button
                type="button"
                disabled={!canManageThread}
                onClick={() => canManageThread && setRenaming(true)}
                className={`block w-full max-w-full truncate text-left text-sm font-semibold ${isDarkMode ? 'text-slate-100' : 'text-slate-900'} ${canManageThread ? 'hover:underline' : ''}`}
              >
                {thread.title}
              </button>
            )}
            <p className={`mt-0.5 truncate text-[11px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              {thread.participants.map((p) => p.displayName).join(', ') || 'No participants yet'}
              {thread.status === 'resolved' ? ' · Resolved' : ''}
            </p>
          </div>
          <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-1 sm:w-auto">
            {releaseBReady && canPropose ? (
              <Button
                label={workingPrivately ? 'Starting…' : 'Work privately'}
                size="sm"
                variant="secondary"
                isDisabled={workingPrivately}
                onClick={() => void handleWorkPrivately()}
              />
            ) : null}
            {releaseBReady && canComment ? (
              <ToggleButton
                label={isAssociatedToThisThread ? 'Attributing edits here' : 'Attribute my edits'}
                size="sm"
                icon={<Link2 size={14} />}
                isPressed={isAssociatedToThisThread}
                onPressedChange={(on) =>
                  on
                    ? setThreadAssociation(workspaceId, thread.id, thread.title)
                    : clearThreadAssociation()
                }
              />
            ) : null}
            <Button
              label={thread.following ? 'Following' : 'Follow'}
              size="sm"
              variant={thread.following ? 'primary' : 'secondary'}
              aria-pressed={thread.following}
              onClick={() => void toggleFollow()}
            />
            {canManageThread ? (
              <Button
                label={thread.status === 'resolved' ? 'Reopen' : 'Resolve'}
                size="sm"
                variant="ghost"
                icon={thread.status === 'resolved' ? <RotateCcw size={14} /> : <Check size={14} />}
                onClick={() => void toggleResolve()}
              />
            ) : null}
          </div>
        </div>
        {/* Active future-edit attribution is visible wherever the thread is
            open, and elsewhere via the editor indicator. Opening a thread never
            attributes — only the explicit toggle above does. */}
        {releaseBReady && association && !isAssociatedToThisThread ? (
          <p className={`mt-1 truncate text-[11px] ${isDarkMode ? 'text-amber-300/80' : 'text-amber-700'}`} data-testid="association-elsewhere">
            Your edits are currently attributed to “{association.threadTitle}”.
          </p>
        ) : null}
      </div>

      {releaseBReady ? (
        <div className={`border-b px-2 overflow-x-auto ${isDarkMode ? 'border-slate-800' : 'border-slate-200'}`}>
          <TabList value={activeTab} onChange={(v) => setActiveTab(v as typeof activeTab)} size="sm" aria-label="Thread views">
            <Tab value="conversation" label="Conversation" />
            <Tab value="changes" label="Changes" />
            <Tab value="linked" label="Linked items" />
          </TabList>
        </div>
      ) : null}

      {error || notice ? (
        <div
          role={error ? 'alert' : 'status'}
          className={`mx-3 mt-3 rounded-xl border px-3 py-2 text-xs ${
            error
              ? isDarkMode
                ? 'border-rose-400/30 bg-rose-400/10 text-rose-200'
                : 'border-rose-200 bg-rose-50 text-rose-700'
              : isDarkMode
                ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
        >
          {error || notice}
        </div>
      ) : null}

      {/* Changes / Linked items tabs (Release B). Conversation stays MOUNTED
          (hidden) when another tab is active so its polling, read-state, and
          scroll position survive tab switches. */}
      {releaseBReady && activeTab === 'changes' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="thread-changes-tab">
          <TeamThreadWorkHistory workspaceId={workspaceId} threadId={threadId} onAccessLoss={onAccessLost} />
        </div>
      ) : null}
      {releaseBReady && activeTab === 'linked' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="thread-linked-tab">
          <TeamThreadLinkedItems
            workspaceId={workspaceId}
            threadId={threadId}
            canManage={canManageThread}
            onOpenObject={(objectId) => {
              // Open the ORIGINAL object discussion (annotation on any file OR a
              // proposal) via the collaboration dialog host. Never duplicates
              // replies into the thread. Also set ?annotationId so a same-file
              // canvas annotation highlights when the dialog isn't the host.
              window.dispatchEvent(
                new CustomEvent('helpudoc-open-collaboration-object', { detail: { objectId, workspaceId } }),
              );
              const url = new URL(window.location.href);
              url.searchParams.set('annotationId', objectId);
              window.history.pushState({}, '', url.toString());
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}
            onIncludeInLumo={(reference) => {
              includeAnnotationInLumo({
                objectId: reference.id,
                type: 'annotation',
                status: 'open',
                title: reference.label,
                fileId: null,
                filePath: null,
                anchorText: null,
                anchorVersionId: reference.anchorVersionId ?? null,
                anchorVersionNumber: null,
                currentVersionNumber: null,
                fileDeleted: false,
                anchorChanged: false,
                createdAt: '',
              });
            }}
            onAccessLoss={onAccessLost}
          />
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className={`relative min-h-0 flex-1 overflow-y-auto px-3 py-3 ${activeTab === 'conversation' ? '' : 'hidden'}`}
        data-testid="thread-message-scroll"
      >
        {loading ? (
          <div className={`grid h-full place-items-center text-sm ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>Loading conversation…</div>
        ) : (
          <div className="space-y-2">
            {hasOlder ? (
              <div className="flex justify-center">
                <Button label={loadingOlder ? 'Loading…' : 'Load earlier messages'} size="sm" variant="ghost" onClick={() => void loadOlder()} isDisabled={loadingOlder} />
              </div>
            ) : null}
            {messages.map((message) => {
              const quoted = message.replyToMessageId ? messageById.get(message.replyToMessageId) : undefined;
              return (
                <TeamMessageArticle
                  key={message.id}
                  message={message}
                  workspaceId={workspaceId}
                  isDarkMode={isDarkMode}
                  markdownComponents={markdownComponents}
                  canComment={canComment}
                  conversions={availableConversions}
                  isActionsOpen={actionMessageId === message.id}
                  interactionText={interactionText[message.id] || ''}
                  highlighted={focusMessageId === message.id}
                  domId={`thread-message-${message.id}`}
                  extraArticleProps={{ 'data-seq': seqOf(message), 'data-testid': `thread-message-${message.id}` }}
                  quote={
                    message.replyToMessageId ? (
                      <button
                        type="button"
                        data-testid={`thread-quote-${message.id}`}
                        onClick={async () => {
                          if (quoted) document.getElementById(`thread-message-${quoted.id}`)?.scrollIntoView({ block: 'center' });
                          else if (message.replyToMessageId) await loadAround(message.replyToMessageId);
                        }}
                        className={`mt-1 block w-full truncate rounded-lg border-l-2 px-2 py-1 text-left text-[11px] ${
                          isDarkMode ? 'border-slate-600 bg-slate-800/60 text-slate-300' : 'border-slate-300 bg-slate-100 text-slate-600'
                        }`}
                      >
                        {quoted ? `↪ ${quoted.authorName}: ${quoted.body.slice(0, 80)}` : '↪ Show quoted message'}
                      </button>
                    ) : undefined
                  }
                  onReply={(m) => {
                    setReplyTo(m);
                    persistDraft({ ...draft, replyToMessageId: m.id });
                  }}
                  onToggleActions={(m) => setActionMessageId(actionMessageId === m.id ? null : m.id)}
                  onConvert={(m, conversion) => void handleConvert(m, conversion)}
                  onInteractionTextChange={(id, value) => setInteractionText((current) => ({ ...current, [id]: value }))}
                  onRespond={(id, input) => void respond(id, input)}
                />
              );
            })}
            <div ref={bottomRef} />
          </div>
        )}
        {newMessagesWaiting ? (
          <div className="sticky bottom-2 flex justify-center">
            <Button label="New messages" size="sm" variant="primary" icon={<ArrowDown size={14} />} onClick={() => void jumpToNewest()} />
          </div>
        ) : null}
      </div>

      <div className={`border-t p-3 ${activeTab === 'conversation' ? '' : 'hidden'} ${isDarkMode ? 'border-slate-800 bg-[#0d1524]' : 'border-slate-200 bg-white'}`}>
        {draft.status === 'failed' || draft.failed ? (
          <div role="alert" data-testid="thread-failed-draft" className={`mb-2 rounded-xl px-3 py-2 text-xs ${isDarkMode ? 'bg-amber-400/10 text-amber-200' : 'bg-amber-50 text-amber-700'}`}>
            Your message wasn’t sent. The draft{draft.replyToMessageId ? ' and its reply target' : ''} are kept — press Send to retry.
          </div>
        ) : null}
        {replyTo ? (
          <div className={`mb-2 flex items-center justify-between rounded-xl px-3 py-2 text-xs ${isDarkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>
            <span className="truncate" data-testid="thread-quote-target">
              Replying to {replyTo.authorName}: {replyTo.body}
            </span>
            <Button
              label="Cancel reply"
              size="sm"
              variant="ghost"
              onClick={() => {
                setReplyTo(null);
                persistDraft({ ...draft, replyToMessageId: undefined });
              }}
            />
          </div>
        ) : null}
        <TeamChatComposer
          key={`${threadId}:${composerNonce}`}
          draftKey={threadId}
          options={referenceOptions}
          disabled={!canComment}
          sending={sending}
          reply={Boolean(replyTo)}
          value={{ text: draft.text, tokens: draft.tokens }}
          onDraftChange={(next) => persistDraft({ ...draft, text: next.text, tokens: next.tokens, status: 'editing', failed: false })}
          placeholder="Message this thread…"
          autoFocusKey={focusKey}
          onSend={handleSend}
        />
      </div>
    </div>
  );
}
