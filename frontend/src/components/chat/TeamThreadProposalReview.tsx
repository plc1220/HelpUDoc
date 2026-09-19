/**
 * F7 — Thread-linked Review proposals with explicit content selection
 * (Release B).
 *
 * OWNERSHIP: NEW Release B component. Two responsibilities, both prop-driven so
 * it can mount standalone (fixtures/tests) or inside the A-owned thread detail /
 * the WorkspaceCollaborationDialog once ownership transfers:
 *
 *  1. mode="submit" — the proposal author explicitly selects which operations
 *     (from the server-derived candidate list) to freeze into an immutable
 *     submission, with exact base/resulting versions, target workspace and an
 *     optional public explanation. Required asset/dependency groups must be
 *     included together (never silently bundled), and the disclosure shows
 *     EXACTLY what becomes shared. Never "submit all private changes".
 *
 *  2. mode="review" — a shared reviewer sees the frozen selection, reads the
 *     authorized snapshot bytes (proposal-owned endpoint — no private access),
 *     records approve / request-changes against the EXACT submission, and (with
 *     apply authority) applies once against the expected shared revision. A
 *     stale/superseded/already-applied/legacy conflict surfaces with a typed
 *     message + refresh affordance.
 *
 * Backend shape notes (from release-b-backend-contract.md):
 *  - submission-candidates REQUIRES expectedSharedRevision (host supplies it).
 *  - GET /submissions returns SUMMARIES (operationCount, no operations); the
 *    full operations + reviews come from GET /submissions/:id, fetched here for
 *    the active submission only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Divider } from '@astryxdesign/core/Divider';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import {
  listSubmissionCandidates,
  submitProposalChangeSet,
  listProposalSubmissions,
  getProposalSubmission,
  getProposalPrivateNavigation,
  reviewProposalSubmission,
  applyProposalSubmission,
  downloadSubmissionOperationBlobUrl,
  parseMissingDependencies,
  type SubmissionCandidate,
  type ProposalChangeSetSummary,
  type ProposalSubmission,
  type ProposalPrivateNavigation,
  type ApplyConflictCode,
} from '../../services/teamThreadWorkApi';
import { TeamThreadApiError } from '../../services/workspaceCollaborationApi';
import './teamThreadWork.css';

export interface TeamThreadProposalReviewProps {
  workspaceId: string;
  objectId: string;
  /** The thread this proposal originated from (recorded, never grants access). */
  sourceThreadId?: string;
  targetWorkspaceLabel?: string;
  /**
   * The current authorized Shared revision. REQUIRED for submit mode (the
   * candidates endpoint needs it and the frozen submission pins it). The host
   * (workspace/object) supplies the exact observed value; a stale value
   * surfaces a typed refresh error, never an auto-resubmit.
   */
  expectedSharedRevision?: number;
  /** submit = author selection UI; review = reviewer/apply UI. */
  mode: 'submit' | 'review';
  /** Reviewer has Owner/Publisher apply authority. */
  canApply?: boolean;
  /** Reviewer can record verdicts. */
  canReview?: boolean;
  /**
   * Bumped by the host after a successful submit (in a sibling submit panel) so
   * the review list refreshes and selects the newest frozen submission in the
   * SAME open dialog — without close/reopen (round47).
   */
  refreshToken?: number;
  /** Ask the host to re-fetch the current Shared revision (stale refresh). */
  onRefreshRevision?: () => void;
  onSubmitted?: (submission: ProposalSubmission) => void;
  onApplied?: () => void;
  onAccessLoss?: () => void;
}

const APPLY_CONFLICT_MESSAGES: Record<ApplyConflictCode, string> = {
  PROPOSAL_STALE: 'Shared Working has changed since this submission. Refresh the comparison and resubmit before applying.',
  SUBMISSION_ALREADY_APPLIED: 'This submission has already been applied. It can only be applied once.',
  SUBMISSION_SUPERSEDED: 'A newer submission supersedes this one. Review and apply the latest submission instead.',
  SUBMISSION_REQUIRED: 'This is a legacy whole-copy proposal. Freeze an explicit selection of changes before applying it.',
};

export default function TeamThreadProposalReview(props: TeamThreadProposalReviewProps) {
  return props.mode === 'submit' ? <SubmitPanel {...props} /> : <ReviewPanel {...props} />;
}

// ---------------------------------------------------------------------------
// Author submission panel
// ---------------------------------------------------------------------------

function SubmitPanel({
  workspaceId,
  objectId,
  targetWorkspaceLabel,
  expectedSharedRevision,
  onRefreshRevision,
  onSubmitted,
  onAccessLoss,
}: TeamThreadProposalReviewProps) {
  const [candidates, setCandidates] = useState<SubmissionCandidate[]>([]);
  const [baseSharedRevision, setBaseSharedRevision] = useState<number>(0);
  const [basePrivateRevision, setBasePrivateRevision] = useState<number>(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [explanation, setExplanation] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [privateNav, setPrivateNav] = useState<ProposalPrivateNavigation | null>(null);
  const [privateStale, setPrivateStale] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [groupWarning, setGroupWarning] = useState('');
  const mountedRef = useRef(true);
  const genRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleError = useCallback(
    (e: unknown, fallback: string) => {
      if (e instanceof TeamThreadApiError && e.isAccessLoss) onAccessLoss?.();
      setError(e instanceof Error ? e.message : fallback);
    },
    [onAccessLoss],
  );

  const reload = useCallback(async () => {
    if (expectedSharedRevision === undefined) {
      setLoading(false);
      setError('The current shared revision is not available yet. Reopen the proposal to select changes.');
      return;
    }
    const gen = (genRef.current += 1);
    setLoading(true);
    setError('');
    setStale(false);
    try {
      const res = await listSubmissionCandidates(workspaceId, objectId, expectedSharedRevision);
      if (!mountedRef.current || gen !== genRef.current) return;
      setCandidates(res.candidates);
      setBaseSharedRevision(res.baseSharedRevision);
      setBasePrivateRevision(res.basePrivateRevision);
      // Selecting resets whenever the comparison base moves.
      setSelected(new Set());
      // Private navigation is fetched ONLY for authorization + the private
      // destination + to DETECT drift — never to source expectedPrivateRevision
      // (round30 review). If the private copy advanced past the revision the
      // candidates were computed at, we force an explicit refresh instead of
      // silently submitting the old selection against a newer private revision.
      try {
        const nav = await getProposalPrivateNavigation(workspaceId, objectId);
        if (!mountedRef.current || gen !== genRef.current) return;
        setPrivateNav(nav);
        if (
          nav.privateContentRevision !== null &&
          nav.privateContentRevision !== res.basePrivateRevision
        ) {
          setPrivateStale(true);
        } else {
          setPrivateStale(false);
        }
      } catch {
        // Navigation is best-effort for drift detection; a failure does not
        // block selection (submit still pins the candidate-captured revision,
        // and the server re-validates it).
        if (mountedRef.current && gen === genRef.current) setPrivateNav(null);
      }
    } catch (e) {
      if (!mountedRef.current || gen !== genRef.current) return;
      // A revision mismatch on the candidates call means Shared Working moved.
      if (e instanceof TeamThreadApiError && (e.code === 'PROPOSAL_STALE' || e.status === 409)) {
        setStale(true);
      } else {
        handleError(e, 'Failed to load selectable changes');
      }
    } finally {
      if (mountedRef.current && gen === genRef.current) setLoading(false);
    }
  }, [workspaceId, objectId, expectedSharedRevision, handleError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Map each candidate path to its required content-dependency paths (deps that
  // ALSO changed vs Shared Working and must submit together). Used to (a) offer
  // "add required dependencies" and (b) reject an incomplete selection before
  // hitting the server (the server also enforces MISSING_REQUIRED_DEPENDENCIES).
  const depsByPath = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of candidates) map.set(c.path, c.requiredDeps || []);
    return map;
  }, [candidates]);

  const toggle = (path: string) => {
    setGroupWarning('');
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /** Missing required deps for the current selection (client-side pre-check). */
  const missingDeps = useCallback((): Array<{ path: string; missing: string[] }> => {
    const rows: Array<{ path: string; missing: string[] }> = [];
    for (const path of selected) {
      const deps = depsByPath.get(path) || [];
      const missing = deps.filter((d) => !selected.has(d));
      if (missing.length) rows.push({ path, missing });
    }
    return rows;
  }, [selected, depsByPath]);

  /** Add every required dependency of the current selection (never silent). */
  const addRequiredDeps = () => {
    setGroupWarning('');
    setSelected((prev) => {
      const next = new Set(prev);
      let changed = true;
      // Transitive closure: a dep may itself have deps.
      while (changed) {
        changed = false;
        for (const path of Array.from(next)) {
          for (const dep of depsByPath.get(path) || []) {
            if (!next.has(dep)) {
              next.add(dep);
              changed = true;
            }
          }
        }
      }
      return next;
    });
  };

  const submit = async () => {
    if (!selected.size) {
      setError('Select at least one change to submit.');
      return;
    }
    if (privateStale) {
      setGroupWarning('Your private copy changed since these candidates were computed. Refresh the comparison and re-review your selection before submitting.');
      return;
    }
    const missing = missingDeps();
    if (missing.length) {
      const flat = Array.from(new Set(missing.flatMap((m) => m.missing)));
      setGroupWarning(
        `This selection needs its changed dependencies: ${flat.join(', ')}. Add them (they must be submitted together) or deselect the files that require them.`,
      );
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const selectedOperations = candidates
        .filter((c) => selected.has(c.path))
        .map((c) => ({ path: c.path, fileId: c.fileId, changeKind: c.changeKind, fromPath: c.fromPath ?? undefined }));
      const submission = await submitProposalChangeSet(workspaceId, objectId, {
        expectedSharedRevision: baseSharedRevision,
        expectedPrivateRevision: basePrivateRevision,
        selectedOperations,
        publicExplanation: explanation.trim() || undefined,
      });
      if (!mountedRef.current) return;
      onSubmitted?.(submission);
    } catch (e) {
      if (!mountedRef.current) return;
      // Server-side dependency rejection (authoritative): surface the exact
      // missing set the server computed.
      const md = parseMissingDependencies(e);
      if (md) {
        setGroupWarning(
          `Server requires these dependencies too: ${md.missing.join(', ')}. Add them and resubmit.`,
        );
      } else if (e instanceof TeamThreadApiError && (e.code === 'PROPOSAL_STALE' || e.status === 409)) {
        setStale(true);
      } else {
        handleError(e, 'Failed to submit change set');
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="team-thread-b" aria-busy="true"><Spinner size="sm" /> <Text type="supporting">Loading selectable changes…</Text></div>
    );
  }

  const selectedList = candidates.filter((c) => selected.has(c.path));

  return (
    <div className="team-thread-b" aria-label="Submit change set">
      {error && <Banner status="error" title="Submission problem" description={error} />}
      {stale && (
        <Banner
          status="warning"
          title="Shared Working changed"
          description="The comparison base is out of date. Refresh to recompute what can be selected — the previous selection is not silently reused."
        />
      )}
      {groupWarning && <Banner status="warning" title="Dependencies / selection" description={groupWarning} />}
      {privateStale && (
        <Banner
          status="warning"
          title="Your private copy changed"
          description="These candidates were computed at an earlier private revision. Refresh the comparison and re-review your selection — the submission pins the reviewed private revision, never a newer one."
        />
      )}

      {(stale || privateStale) && (
        <div>
          <Button
            label="Refresh comparison"
            variant="secondary"
            size="sm"
            onClick={() => {
              onRefreshRevision?.();
              void reload();
            }}
          />
        </div>
      )}

      <Text type="label" display="block">Select the changes to submit</Text>
      <Text type="supporting" display="block">
        Only the changes you select become shared. Other edits in your private copy — including work
        for other threads — stay private. Target: {targetWorkspaceLabel || 'this shared workspace'}.
      </Text>

      {!candidates.length && !stale && (
        <div className="team-thread-b__empty"><Text type="supporting">No differences between your private copy and Shared Working.</Text></div>
      )}

      <div className="team-thread-b__ops">
        {candidates.map((c) => (
          <div className="team-thread-b__op" key={c.path}>
            <CheckboxInput
              label={`Select ${c.path}`}
              isLabelHidden
              value={selected.has(c.path)}
              onChange={() => toggle(c.path)}
            />
            <div className="team-thread-b__op-main">
              <div className="team-thread-b__row-head">
                <Badge variant="neutral" label={c.changeKind} />
                <Text type="body" className="team-thread-b__path">
                  {c.changeKind === 'rename' && c.fromPath ? `${c.fromPath} → ${c.path}` : c.path}
                </Text>
                {c.requiredDeps.length > 0 && (
                  <Badge variant="purple" label={`Needs ${c.requiredDeps.length} dep${c.requiredDeps.length === 1 ? '' : 's'}`} />
                )}
              </div>
              {c.requiredDeps.length > 0 && (
                <Text type="supporting" display="block">
                  Requires: {c.requiredDeps.join(', ')}
                </Text>
              )}
              <Text type="supporting">
                base v:{c.baseVersionId ? c.baseVersionId.slice(0, 8) : '∅'} → proposed v:{c.proposedVersionId ? c.proposedVersionId.slice(0, 8) : '∅'}
                {c.size !== null ? ` · ${c.size} bytes` : ''}
              </Text>
            </div>
          </div>
        ))}
      </div>

      {selectedList.length > 0 && (
        <>
          <Divider />
          <Text type="label" display="block">Disclosure — exactly what becomes shared</Text>
          <ul>
            {selectedList.map((c) => (
              <li key={c.path}><Text type="supporting">{c.changeKind}: {c.path}</Text></li>
            ))}
          </ul>
          <Text type="supporting" display="block">Comparison base: Shared revision {baseSharedRevision}.</Text>
          {privateNav?.linkedPrivateWorkspaceId && (
            <Text type="supporting" display="block">
              Submitting from your private copy at revision {privateNav.privateContentRevision ?? basePrivateRevision}.
            </Text>
          )}
        </>
      )}

      <TextArea
        label="Public explanation (optional)"
        placeholder="Explain the proposed change for reviewers…"
        value={explanation}
        onChange={setExplanation}
        rows={3}
        maxLength={5000}
        size="sm"
        width="100%"
      />

      <div>
        {missingDeps().length > 0 && (
          <Button
            label="Add required dependencies"
            variant="secondary"
            size="sm"
            onClick={addRequiredDeps}
          />
        )}{' '}
        <Button
          label={submitting ? 'Submitting…' : `Submit ${selectedList.length} change${selectedList.length === 1 ? '' : 's'}`}
          variant="primary"
          size="sm"
          isDisabled={submitting || !selectedList.length || stale || privateStale}
          onClick={() => void submit()}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reviewer / apply panel
// ---------------------------------------------------------------------------

function ReviewPanel({
  workspaceId,
  objectId,
  canApply,
  canReview,
  refreshToken,
  onApplied,
  onAccessLoss,
}: TeamThreadProposalReviewProps) {
  const [summaries, setSummaries] = useState<ProposalChangeSetSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<ProposalSubmission | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState('');
  const mountedRef = useRef(true);
  const listGenRef = useRef(0);
  const detailGenRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleError = useCallback(
    (e: unknown, fallback: string) => {
      if (e instanceof TeamThreadApiError && e.isAccessLoss) onAccessLoss?.();
      setError(e instanceof Error ? e.message : fallback);
    },
    [onAccessLoss],
  );

  const reloadList = useCallback(async () => {
    const gen = (listGenRef.current += 1);
    setLoading(true);
    setError('');
    try {
      const list = await listProposalSubmissions(workspaceId, objectId);
      if (!mountedRef.current || gen !== listGenRef.current) return;
      setSummaries(list);
      setActiveId((prev) => (prev && list.some((s) => s.id === prev) ? prev : list[0]?.id ?? null));
    } catch (e) {
      if (mountedRef.current && gen === listGenRef.current) handleError(e, 'Failed to load submissions');
    } finally {
      if (mountedRef.current && gen === listGenRef.current) setLoading(false);
    }
  }, [workspaceId, objectId, handleError]);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  // On a host-signalled refresh (a sibling submit succeeded), reload the list
  // and select the NEWEST submission so the just-frozen selection is visible in
  // the same open dialog. Skips the initial mount.
  const refreshTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (refreshTokenRef.current === refreshToken) return;
    refreshTokenRef.current = refreshToken;
    const gen = (listGenRef.current += 1);
    void listProposalSubmissions(workspaceId, objectId)
      .then((list) => {
        if (!mountedRef.current || gen !== listGenRef.current) return;
        setSummaries(list);
        setActiveId(list[0]?.id ?? null); // newest first
      })
      .catch((e) => {
        if (mountedRef.current && gen === listGenRef.current) handleError(e, 'Failed to load submissions');
      });
  }, [refreshToken, workspaceId, objectId, handleError]);

  // Fetch the FULL active submission (operations + reviews) by exact id, guarding
  // stale responses. The list only carries summaries — never map operations off
  // a summary.
  useEffect(() => {
    if (!activeId) {
      setActive(null);
      return;
    }
    const gen = (detailGenRef.current += 1);
    setDetailLoading(true);
    setActive(null);
    getProposalSubmission(workspaceId, objectId, activeId)
      .then((full) => {
        if (!mountedRef.current || gen !== detailGenRef.current) return;
        setActive(full);
      })
      .catch((e) => {
        if (mountedRef.current && gen === detailGenRef.current) handleError(e, 'Failed to load submission');
      })
      .finally(() => {
        if (mountedRef.current && gen === detailGenRef.current) setDetailLoading(false);
      });
  }, [workspaceId, objectId, activeId, handleError]);

  const latestId = summaries[0]?.id ?? null;

  const record = async (verdict: 'approved' | 'changes_requested') => {
    if (!active) return;
    setBusy(true);
    setError('');
    try {
      await reviewProposalSubmission(workspaceId, objectId, active.id, {
        verdict,
        comment: comment.trim() || undefined,
      });
      if (!mountedRef.current) return;
      setComment('');
      // Re-fetch the active submission so its review history updates.
      const full = await getProposalSubmission(workspaceId, objectId, active.id);
      if (mountedRef.current) setActive(full);
      void reloadList();
    } catch (e) {
      if (mountedRef.current) handleError(e, 'Failed to record review');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const apply = async () => {
    if (!active) return;
    setBusy(true);
    setError('');
    setConflict('');
    try {
      await applyProposalSubmission(workspaceId, objectId, {
        submissionId: active.id,
        expectedSharedRevision: active.baseSharedRevision,
      });
      if (!mountedRef.current) return;
      onApplied?.();
      // Refetch the exact active submission so its status flips to applied and
      // the Apply button disappears (the list callback alone would not refresh
      // the mounted detail — round47).
      try {
        const full = await getProposalSubmission(workspaceId, objectId, active.id);
        if (mountedRef.current) setActive(full);
      } catch {
        /* list reload below still reflects the applied status */
      }
      void reloadList();
    } catch (e) {
      if (!mountedRef.current) return;
      if (e instanceof TeamThreadApiError && e.code && e.code in APPLY_CONFLICT_MESSAGES) {
        setConflict(APPLY_CONFLICT_MESSAGES[e.code as ApplyConflictCode]);
        void reloadList();
      } else {
        handleError(e, 'Failed to apply submission');
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  if (loading) {
    return <div className="team-thread-b" aria-busy="true"><Spinner size="sm" /> <Text type="supporting">Loading submissions…</Text></div>;
  }

  return (
    <div className="team-thread-b" aria-label="Review proposal">
      {error && <Banner status="error" title="Review problem" description={error} />}
      {conflict && <Banner status="warning" title="Cannot apply" description={conflict} />}

      {!summaries.length && (
        <div className="team-thread-b__empty"><Text type="supporting">No submissions yet for this proposal.</Text></div>
      )}

      {summaries.length > 1 && (
        <div className="team-thread-b__badges" role="tablist" aria-label="Submission revisions">
          {summaries.map((s, i) => (
            <Button
              key={s.id}
              label={`Rev ${summaries.length - i}${s.id === latestId ? ' (latest)' : ''}`}
              variant={s.id === activeId ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setActiveId(s.id)}
            />
          ))}
        </div>
      )}

      {detailLoading && (
        <div aria-busy="true"><Spinner size="sm" /> <Text type="supporting">Loading submission…</Text></div>
      )}

      {active && (
        <>
          <div className="team-thread-b__row-head">
            <Badge variant={active.status === 'applied' ? 'green' : 'blue'} label={active.status} />
            {active.id !== latestId && <Badge variant="orange" label="Superseded by newer" />}
            <Text type="supporting">Base shared revision {active.baseSharedRevision}</Text>
          </div>
          {active.publicExplanation && <Text type="body" display="block">{active.publicExplanation}</Text>}

          <Text type="label" display="block">Selected operations</Text>
          <div className="team-thread-b__ops">
            {active.operations.map((op, index) => (
              <div className="team-thread-b__op" key={`${op.path}:${index}`}>
                <div className="team-thread-b__op-main">
                  <div className="team-thread-b__row-head">
                    <Badge variant="neutral" label={op.changeKind} />
                    <Text type="body" className="team-thread-b__path">{op.path}</Text>
                  </div>
                  <Text type="supporting">
                    base v:{op.baseVersionId ? op.baseVersionId.slice(0, 8) : '∅'} → proposed v:{op.proposedVersionId ? op.proposedVersionId.slice(0, 8) : '∅'}
                  </Text>
                  <div className="team-thread-b__badges">
                    {op.baseVersionId && (
                      <SnapshotDownloadButton
                        label="View base snapshot"
                        load={() => downloadSubmissionOperationBlobUrl(workspaceId, objectId, active.id, index, 'before')}
                      />
                    )}
                    {op.proposedVersionId && op.changeKind !== 'delete' && (
                      <SnapshotDownloadButton
                        label="View proposed snapshot"
                        load={() => downloadSubmissionOperationBlobUrl(workspaceId, objectId, active.id, index, 'after')}
                      />
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {active.reviews.length > 0 && (
            <>
              <Divider />
              <Text type="label" display="block">Review history</Text>
              <div className="team-thread-b__reviews">
                {active.reviews.map((r) => (
                  <div className="team-thread-b__review" key={r.id}>
                    <div className="team-thread-b__row-head">
                      <Badge variant={r.verdict === 'approved' ? 'green' : 'orange'} label={r.verdict === 'approved' ? 'Approved' : 'Changes requested'} />
                      <Text type="supporting">{r.reviewerName || r.reviewerId || 'Reviewer'}</Text>
                    </div>
                    {r.comment && <Text type="body" display="block">{r.comment}</Text>}
                  </div>
                ))}
              </div>
            </>
          )}

          {(canReview || canApply) && active.status !== 'applied' && (
            <>
              <Divider />
              {canReview && (
                <>
                  <TextArea
                    label="Review comment (optional)"
                    placeholder="Explain your decision…"
                    value={comment}
                    onChange={setComment}
                    rows={2}
                    maxLength={5000}
                    size="sm"
                    width="100%"
                  />
                  <div className="team-thread-b__badges">
                    <Button label="Approve" variant="secondary" size="sm" isDisabled={busy} onClick={() => void record('approved')} />
                    <Button label="Request changes" variant="ghost" size="sm" isDisabled={busy} onClick={() => void record('changes_requested')} />
                  </div>
                </>
              )}
              {canApply && (
                <div>
                  <Button
                    label={busy ? 'Applying…' : 'Apply to Shared Working'}
                    variant="primary"
                    size="sm"
                    isDisabled={busy || active.id !== latestId}
                    onClick={() => void apply()}
                  />
                  {active.id !== latestId && (
                    <Text type="supporting" display="block">Only the latest submission can be applied.</Text>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Authenticated snapshot download (works in header-identity auth). Reviewers
 *  never touch the private workspace. */
function SnapshotDownloadButton({
  label,
  load,
}: {
  label: string;
  load: () => Promise<{ url: string; contentType: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <span>
      <Button
        label={busy ? 'Preparing…' : label}
        variant="ghost"
        size="sm"
        isDisabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const { url } = await load();
            window.open(url, '_blank', 'noopener,noreferrer');
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to open snapshot');
          } finally {
            setBusy(false);
          }
        }}
      />
      {error && <Text type="supporting" display="block">{error}</Text>}
    </span>
  );
}
