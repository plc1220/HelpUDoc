/**
 * F6 — "Changes from this discussion" (Release B).
 *
 * OWNERSHIP: NEW Release B component. It is designed to be dropped into the
 * A-owned thread detail as the "Changes" tab body once ownership transfers
 * (see /tmp/helpudoc-kiro-threads/frontend-b-integration.md). It has no
 * dependency on any A-owned chat component and is fully driven by props so it
 * can be mounted standalone (fixtures / tests) or inside the thread detail.
 *
 * It renders an ATTRIBUTED history of immutable file operations — never a diff
 * of "workspace when the thread started" vs "now". Each record shows actor,
 * time, source message/run + run status, change kind, exact before/after
 * version ids and historical path, a superseded indicator, and honest handling
 * of creations/deletions/failed-run committed work. Text formats get a safe
 * line diff computed from the exact immutable bytes; binaries get a
 * download/preview affordance (no fabricated text diff, no same-origin HTML
 * execution).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { Divider } from '@astryxdesign/core/Divider';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import {
  listThreadChanges,
  fetchThreadChangeBytes,
  downloadThreadChangeBlobUrl,
  type TeamThreadChangeRecord,
} from '../../services/teamThreadWorkApi';
import { TeamThreadApiError } from '../../services/workspaceCollaborationApi';
import { diffLines, diffSummary, type DiffResult } from '../../utils/lineDiff';
import './teamThreadWork.css';

export interface TeamThreadWorkHistoryProps {
  workspaceId: string;
  threadId: string;
  /** Optional run filter (endContent of a run row, etc.). */
  runId?: string;
  /** Notify the host of access loss so it can clear/stop polling. */
  onAccessLoss?: () => void;
  pageSize?: number;
}

type ByteState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; diff: DiffResult | null; binary: boolean; contentType: string; beforeAbsent: boolean; afterAbsent: boolean };

const changeKindVariant = (kind: string): 'green' | 'red' | 'blue' | 'orange' | 'neutral' => {
  switch (kind) {
    case 'create':
      return 'green';
    case 'delete':
      return 'red';
    case 'rename':
    case 'move':
      return 'orange';
    case 'restore':
      return 'blue';
    default:
      return 'neutral';
  }
};

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

export default function TeamThreadWorkHistory({
  workspaceId,
  threadId,
  runId,
  onAccessLoss,
  pageSize = 50,
}: TeamThreadWorkHistoryProps) {
  const [changes, setChanges] = useState<TeamThreadChangeRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [byteState, setByteState] = useState<Record<string, ByteState>>({});
  const mountedRef = useRef(true);
  // Guards a per-row byte request against a stale response after navigation.
  const pendingByteKeyRef = useRef<Record<string, string>>({});
  // Monotonic load generation so a slow first/subsequent page never lands after
  // the thread/run changed (Point 5).
  const loadGenRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleError = useCallback(
    (e: unknown) => {
      if (e instanceof TeamThreadApiError && e.isAccessLoss) {
        onAccessLoss?.();
      }
      setError(e instanceof Error ? e.message : 'Failed to load changes');
    },
    [onAccessLoss],
  );

  // Reset when the thread or run filter changes; ignore stale responses.
  useEffect(() => {
    let cancelled = false;
    const gen = (loadGenRef.current += 1);
    setLoading(true);
    setError('');
    setChanges([]);
    setCursor(null);
    setExpandedId(null);
    setByteState({});
    pendingByteKeyRef.current = {};
    listThreadChanges(workspaceId, threadId, { runId, limit: pageSize })
      .then((res) => {
        if (cancelled || gen !== loadGenRef.current) return;
        setChanges(res.changes);
        setCursor(res.nextCursor);
      })
      .catch((e) => {
        if (!cancelled && gen === loadGenRef.current) handleError(e);
      })
      .finally(() => {
        if (!cancelled && gen === loadGenRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, threadId, runId, pageSize, handleError]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const gen = loadGenRef.current;
    setLoadingMore(true);
    try {
      const res = await listThreadChanges(workspaceId, threadId, { runId, cursor, limit: pageSize });
      // Point 5: drop the page if the thread/run changed while it was in flight,
      // so old rows never append into a different thread's Changes list.
      if (!mountedRef.current || gen !== loadGenRef.current) return;
      setChanges((prev) => {
        const seen = new Set(prev.map((c) => c.versionId));
        return [...prev, ...res.changes.filter((c) => !seen.has(c.versionId))];
      });
      setCursor(res.nextCursor);
    } catch (e) {
      if (mountedRef.current && gen === loadGenRef.current) handleError(e);
    } finally {
      if (mountedRef.current && gen === loadGenRef.current) setLoadingMore(false);
    }
  }, [cursor, loadingMore, workspaceId, threadId, runId, pageSize, handleError]);

  const toggle = useCallback(
    async (record: TeamThreadChangeRecord) => {
      if (expandedId === record.versionId) {
        setExpandedId(null);
        return;
      }
      setExpandedId(record.versionId);
      if (byteState[record.versionId]?.phase === 'ready') return;
      setByteState((prev) => ({ ...prev, [record.versionId]: { phase: 'loading' } }));
      // Guard against a stale response after the thread/run changed or the row
      // collapsed: capture identity and re-check before committing state.
      const requestKey = `${workspaceId}:${threadId}:${record.versionId}`;
      pendingByteKeyRef.current[record.versionId] = requestKey;
      try {
        // Point 4: only tell the byte fetch a side is legitimately absent when
        // the trusted change kind says so — a create has no `before`, a delete
        // has no `after`. Any OTHER 404 is a real failed preview, never faked
        // as empty content.
        const [before, after] = await Promise.all([
          fetchThreadChangeBytes(
            workspaceId,
            threadId,
            record.versionId,
            'before',
            record.changeKind === 'create',
          ),
          record.changeKind === 'delete'
            ? Promise.resolve({ text: null, binary: false, contentType: '', byteLength: 0, absent: true } as const)
            : fetchThreadChangeBytes(workspaceId, threadId, record.versionId, 'after', false),
        ]);
        if (!mountedRef.current || pendingByteKeyRef.current[record.versionId] !== requestKey) return;
        const binary = before.binary || after.binary;
        const diff =
          !binary && (before.text !== null || after.text !== null)
            ? diffLines(before.text ?? '', after.text ?? '')
            : null;
        setByteState((prev) => ({
          ...prev,
          [record.versionId]: {
            phase: 'ready',
            diff,
            binary,
            contentType: after.contentType || before.contentType,
            beforeAbsent: before.absent,
            afterAbsent: after.absent,
          },
        }));
      } catch (e) {
        if (!mountedRef.current || pendingByteKeyRef.current[record.versionId] !== requestKey) return;
        if (e instanceof TeamThreadApiError && e.isAccessLoss) onAccessLoss?.();
        setByteState((prev) => ({
          ...prev,
          [record.versionId]: {
            phase: 'error',
            message: e instanceof Error ? e.message : 'Failed to load version bytes',
          },
        }));
      }
    },
    [expandedId, byteState, workspaceId, threadId, onAccessLoss],
  );

  // Distinct run ids present, for the run filter segmented control.
  const runOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const c of changes) if (c.sourceRunId) ids.add(c.sourceRunId);
    return Array.from(ids);
  }, [changes]);

  if (loading) {
    return (
      <div className="team-thread-b" aria-busy="true">
        <Spinner size="sm" />
        <Text type="supporting">Loading changes…</Text>
      </div>
    );
  }

  return (
    <div className="team-thread-b" aria-label="Thread changes">
      {error && (
        <Banner className="team-thread-b__error" status="error" title="Could not load changes" description={error} />
      )}
      <div className="team-thread-b__toolbar">
        <Text type="supporting">
          {runId ? 'Changes from this run' : 'Attributed changes from this discussion'}
        </Text>
        <div className="team-thread-b__spacer" />
      </div>

      {runOptions.length > 0 && !runId && (
        <Text type="supporting">
          {runOptions.length} Lumo run{runOptions.length === 1 ? '' : 's'} contributed to these changes.
        </Text>
      )}

      {!changes.length && (
        <div className="team-thread-b__empty">
          <Text type="supporting">No attributed changes yet. Edits are listed here only when explicitly associated with this thread, or produced by this thread's Lumo runs.</Text>
        </div>
      )}

      <div className="team-thread-b__list">
        {changes.map((record) => {
          const state = byteState[record.versionId] ?? { phase: 'idle' as const };
          const expanded = expandedId === record.versionId;
          return (
            <Card key={record.versionId} variant="default" padding={3}>
              <div className="team-thread-b__row">
                <div className="team-thread-b__row-head">
                  <Badge variant={changeKindVariant(record.changeKind)} label={record.changeKind} />
                  <Text type="body" className="team-thread-b__path">{record.filePath}</Text>
                  <div className="team-thread-b__spacer" />
                  <div className="team-thread-b__badges">
                    {record.superseded && <Badge variant="orange" label="Superseded" />}
                    {record.fileDeleted && <Badge variant="red" label="File deleted" />}
                    {record.runStatus && record.runStatus !== 'succeeded' && (
                      <Badge variant={record.runStatus === 'failed' ? 'red' : 'neutral'} label={`Run ${record.runStatus}`} />
                    )}
                  </div>
                </div>
                <div className="team-thread-b__meta">
                  <Text type="supporting">{record.actorName || 'Unknown'}</Text>
                  <Text type="supporting">{formatTime(record.createdAt)}</Text>
                  <Text type="supporting">
                    v{record.baseVersion ?? '∅'} → v{record.version}
                    {record.currentVersion !== null && record.currentVersion !== record.version
                      ? ` (latest v${record.currentVersion})`
                      : ''}
                  </Text>
                  {record.sourceRunId && <Text type="supporting">run {record.sourceRunId.slice(0, 8)}</Text>}
                  {record.sourceMessageId && <Text type="supporting">from message</Text>}
                </div>
                {record.runStatus === 'failed' && (
                  <Text type="supporting">
                    This run failed, but the work below was committed before it stopped. A failed run is not proof that nothing changed.
                  </Text>
                )}
                <div>
                  <Button
                    label={expanded ? 'Hide changes' : 'View changes'}
                    variant="ghost"
                    size="sm"
                    onClick={() => void toggle(record)}
                  />
                </div>

                {expanded && (
                  <div className="team-thread-b__panel">
                    {state.phase === 'loading' && (
                      <div aria-busy="true"><Spinner size="sm" /> <Text type="supporting">Loading immutable version…</Text></div>
                    )}
                    {state.phase === 'error' && (
                      <Banner status="error" title="Could not load version bytes" description={state.message} />
                    )}
                    {state.phase === 'ready' && (
                      <ChangeContent
                        record={record}
                        state={state}
                        workspaceId={workspaceId}
                        threadId={threadId}
                      />
                    )}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {cursor && (
        <div>
          <Divider />
          <Button label={loadingMore ? 'Loading…' : 'Load more'} variant="secondary" size="sm" isDisabled={loadingMore} onClick={() => void loadMore()} />
        </div>
      )}
    </div>
  );
}

function ChangeContent({
  record,
  state,
  workspaceId,
  threadId,
}: {
  record: TeamThreadChangeRecord;
  state: Extract<ByteState, { phase: 'ready' }>;
  workspaceId: string;
  threadId: string;
}) {
  if (state.binary) {
    // Binary / office / HTML: never fabricate a text diff and never execute in
    // our origin. Offer authenticated downloads of the exact immutable snapshots
    // (a raw href would bypass header-identity auth — Point 7).
    return (
      <div>
        <Text type="supporting" display="block">
          Binary content ({state.contentType || 'unknown type'}). No text diff is shown.
        </Text>
        <div className="team-thread-b__badges">
          {!state.beforeAbsent && (
            <BlobDownloadButton
              label="Download previous version"
              load={() => downloadThreadChangeBlobUrl(workspaceId, threadId, record.versionId, 'before')}
              fileName={`${record.filePath.split('/').pop() || 'file'}.before`}
            />
          )}
          {!state.afterAbsent && record.changeKind !== 'delete' && (
            <BlobDownloadButton
              label="Download this version"
              load={() => downloadThreadChangeBlobUrl(workspaceId, threadId, record.versionId, 'after')}
              fileName={record.filePath.split('/').pop() || 'file'}
            />
          )}
        </div>
      </div>
    );
  }

  if (record.changeKind === 'create') {
    return <DiffView diff={state.diff} caption="New file — no previous version." />;
  }
  if (record.changeKind === 'delete') {
    return (
      <DiffView diff={state.diff} caption="File deleted — showing the content that existed before deletion." deletion />
    );
  }
  return <DiffView diff={state.diff} caption={record.changeKind === 'restore' ? 'Restored to an earlier version.' : undefined} />;
}

/** Downloads authenticated bytes as a Blob (works in header-identity auth
 *  modes) and triggers a browser download, then revokes the object URL. */
function BlobDownloadButton({
  label,
  load,
  fileName,
}: {
  label: string;
  load: () => Promise<{ url: string; contentType: string }>;
  fileName: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <span>
      <Button
        label={busy ? 'Preparing…' : label}
        variant="secondary"
        size="sm"
        isDisabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const { url } = await load();
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            // Revoke after the click has a chance to start the download.
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Download failed');
          } finally {
            setBusy(false);
          }
        }}
      />
      {error && <Text type="supporting" display="block">{error}</Text>}
    </span>
  );
}

function DiffView({ diff, caption, deletion = false }: { diff: DiffResult | null; caption?: string; deletion?: boolean }) {
  if (!diff) {
    return <Text type="supporting">No content available for this side.</Text>;
  }
  return (
    <div>
      {caption && <Text type="supporting" display="block">{caption}</Text>}
      <Text type="supporting" display="block">{diffSummary(diff)}</Text>
      <div className="team-thread-b__diff">
        <table className="team-thread-b__diff-table">
          <tbody>
            {diff.lines.map((line, index) => {
              const cls =
                line.op === 'insert'
                  ? 'team-thread-b__line--insert'
                  : line.op === 'delete'
                    ? 'team-thread-b__line--delete'
                    : '';
              const sign = line.op === 'insert' ? '+' : line.op === 'delete' ? '\u2212' : '';
              return (
                <tr key={index} className={cls}>
                  <td className="team-thread-b__gutter">{line.beforeLine ?? ''}</td>
                  <td className="team-thread-b__gutter">{deletion ? '' : line.afterLine ?? ''}</td>
                  <td className="team-thread-b__sign">{sign}</td>
                  <td>{line.text || '\u00a0'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
