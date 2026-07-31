import { useCallback, useEffect, useMemo, useState } from 'react';
import YAML from 'yaml';
import {
  BadgeCheck,
  BookOpenCheck,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Code2,
  FileCode2,
  GitPullRequestArrow,
  History,
  Library,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Users2,
  X,
  XCircle,
} from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';
import {
  SettingsEmptyState,
  SettingsLoadingState,
  SettingsNotice,
  SettingsSectionHeader,
  SettingsSurface,
  SettingsTabs,
} from '../components/settings/SettingsScaffold';
import {
  createImprovementDraft,
  createSkillDraft,
  decideSkillReview,
  fetchMySkills,
  fetchSkillCatalog,
  fetchSkillDraft,
  fetchSkillReview,
  fetchSkillVersions,
  fetchTeamReviews,
  pinWorkspaceSkillVersion,
  retrySkillActivation,
  submitSkillDraft,
  setDefaultSkillVersion,
  updateSkillDraft,
  updateSkillVersionStatus,
  validateSkillDraft,
  type CatalogSkill,
  type GovernanceTeam,
  type GovernedSkillVersion,
  type MySkillsResponse,
  type SkillDraft,
  type SkillValidation,
  type TeamReviewDetail,
  type TeamReviewSummary,
} from '../services/governanceApi';
import { getWorkspaces } from '../services/workspaceApi';
import type { Workspace } from '../types';

type TabId = 'mine' | 'reviews' | 'catalog';

const statusTone = (status: string) => {
  if (['active', 'approved', 'pass', 'activation_active'].includes(status)) return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  if (['submitted', 'private'].includes(status)) return 'bg-blue-50 text-blue-700 ring-blue-200';
  if (['changes_requested', 'suspended'].includes(status)) return 'bg-amber-50 text-amber-700 ring-amber-200';
  if (['rejected', 'retired', 'block', 'activation_failed'].includes(status)) return 'bg-rose-50 text-rose-700 ring-rose-200';
  return 'bg-slate-50 text-slate-600 ring-slate-200';
};

const StatusBadge = ({ status }: { status: string }) => (
  <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${statusTone(status)}`}>
    {status.replace(/_/g, ' ')}
  </span>
);

const shortHash = (value?: string | null) => value ? value.slice(0, 10) : '—';

const formatTime = (value?: string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const updateSkillFrontmatter = (
  markdown: string,
  changes: { name?: string; description?: string },
): string => {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  try {
    const metadata = match ? (YAML.parse(match[1]) || {}) : {};
    if (changes.name !== undefined) metadata.name = changes.name;
    if (changes.description !== undefined) metadata.description = changes.description;
    const frontmatter = YAML.stringify(metadata).trimEnd();
    const body = match ? markdown.slice(match[0].length) : markdown;
    return `---\n${frontmatter}\n---\n${body}`;
  } catch {
    // Leave malformed frontmatter intact so validation can show the precise
    // error without discarding hand-edited draft content.
    return markdown;
  }
};

const DraftEditor = ({
  initialDraft,
  onClose,
  onSubmitted,
}: {
  initialDraft: SkillDraft;
  onClose: () => void;
  onSubmitted: () => Promise<void>;
}) => {
  const [draft, setDraft] = useState(initialDraft);
  const [skillKey, setSkillKey] = useState(initialDraft.proposedSkillKey || '');
  const [displayName, setDisplayName] = useState(initialDraft.displayName || '');
  const [description, setDescription] = useState(initialDraft.description || '');
  const [teamId, setTeamId] = useState(initialDraft.proposedOwnerTeamId || initialDraft.eligibleTeams[0]?.id || '');
  const [skillMarkdown, setSkillMarkdown] = useState(
    initialDraft.files.find((file) => file.path === 'SKILL.md')?.content || '',
  );
  const [semanticVersion, setSemanticVersion] = useState(initialDraft.proposalType === 'new' ? '1.0.0' : '1.0.1');
  const [submissionNote, setSubmissionNote] = useState('');
  const [validation, setValidation] = useState<SkillValidation | null>(
    initialDraft.validationSummary?.checkedAt ? initialDraft.validationSummary as SkillValidation : null,
  );
  const [busy, setBusy] = useState<'save' | 'validate' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const next = await updateSkillDraft(draft.id, draft.draftRevision, {
        displayName,
        description,
        proposedSkillKey: skillKey,
        proposedOwnerTeamId: teamId || null,
        files: [{ path: 'SKILL.md', content: skillMarkdown }],
      });
      setDraft(next);
      setValidation(null);
      return next;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save draft');
    } finally {
      setBusy(null);
    }
  };

  const runValidation = async () => {
    setBusy('validate');
    setError(null);
    try {
      const result = await validateSkillDraft(draft.id);
      setValidation(result);
      return result;
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : 'Validation failed');
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    setBusy('submit');
    setError(null);
    try {
      const saved = await updateSkillDraft(draft.id, draft.draftRevision, {
        displayName,
        description,
        proposedSkillKey: skillKey,
        proposedOwnerTeamId: teamId || null,
        files: [{ path: 'SKILL.md', content: skillMarkdown }],
      });
      setDraft(saved);
      const checked = await validateSkillDraft(saved.id);
      setValidation(checked);
      if (!checked.valid) {
        setError('Resolve the validation issues before submission.');
        return;
      }
      await submitSkillDraft(saved.id, {
        owningTeamId: teamId || undefined,
        semanticVersion,
        submissionNote,
        expectedDraftRevision: saved.draftRevision,
      });
      await onSubmitted();
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Submission failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <div
        className="settings-modal-panel flex h-[min(92vh,980px)] w-full max-w-6xl flex-col overflow-hidden rounded-[28px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-draft-title"
      >
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4 sm:px-6">
          <div>
            <div className="flex items-center gap-2">
              <StatusBadge status="private" />
              <span className="text-xs text-slate-500">Revision {draft.draftRevision}</span>
            </div>
            <h2 id="skill-draft-title" className="mt-2 text-xl font-semibold text-slate-900">
              {draft.proposalType === 'new' ? 'Private new-skill draft' : 'Private improvement draft'}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Only you can read this editable draft. Submission freezes a candidate for the owning Team Lead.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="settings-portal-button-secondary rounded-xl p-2"
            aria-label="Close draft editor"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="overflow-y-auto border-b border-slate-200 p-5 lg:border-b-0 lg:border-r">
            <div className="space-y-4">
              <label className="block text-sm font-medium text-slate-700">
                Skill ID
                <input
                  value={skillKey}
                  onChange={(event) => setSkillKey(event.target.value)}
                  disabled={draft.proposalType === 'improvement'}
                  className="settings-control mt-1.5 w-full rounded-xl px-3 py-2.5 font-mono text-sm disabled:opacity-60"
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Display name
                <input
                  value={displayName}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDisplayName(value);
                    setSkillMarkdown((current) => updateSkillFrontmatter(current, { name: value }));
                  }}
                  className="settings-control mt-1.5 w-full rounded-xl px-3 py-2.5 text-sm"
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Description
                <textarea
                  value={description}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDescription(value);
                    setSkillMarkdown((current) => updateSkillFrontmatter(current, { description: value }));
                  }}
                  rows={3}
                  className="settings-control mt-1.5 w-full rounded-xl px-3 py-2.5 text-sm"
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Owning Team
                <select
                  value={teamId}
                  onChange={(event) => setTeamId(event.target.value)}
                  disabled={draft.proposalType === 'improvement'}
                  className="settings-control mt-1.5 w-full rounded-xl px-3 py-2.5 text-sm disabled:opacity-60"
                >
                  <option value="">Select a Team</option>
                  {draft.eligibleTeams.map((team) => (
                    <option key={team.id} value={team.id}>{team.name}</option>
                  ))}
                </select>
              </label>
              {!draft.eligibleTeams.length ? (
                <SettingsNotice variant="warning">
                  You may keep editing privately, but Team membership is required before submission.
                </SettingsNotice>
              ) : null}
              <label className="block text-sm font-medium text-slate-700">
                Proposed version
                <input
                  value={semanticVersion}
                  onChange={(event) => setSemanticVersion(event.target.value)}
                  className="settings-control mt-1.5 w-full rounded-xl px-3 py-2.5 font-mono text-sm"
                  placeholder="1.0.0"
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Submission note
                <textarea
                  value={submissionNote}
                  onChange={(event) => setSubmissionNote(event.target.value)}
                  rows={3}
                  className="settings-control mt-1.5 w-full rounded-xl px-3 py-2.5 text-sm"
                  placeholder="What should the Team Lead focus on?"
                />
              </label>
            </div>

            {validation ? (
              <div className={`mt-5 rounded-2xl p-4 ring-1 ${validation.valid ? 'bg-emerald-50 ring-emerald-200' : 'bg-rose-50 ring-rose-200'}`}>
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  {validation.valid ? <CheckCircle2 size={17} className="text-emerald-600" /> : <CircleAlert size={17} className="text-rose-600" />}
                  {validation.valid ? 'Ready for Team review' : `${validation.issues.length} issue${validation.issues.length === 1 ? '' : 's'}`}
                </div>
                <p className="mt-1 text-xs text-slate-600">Risk class: {validation.riskClass}</p>
                {validation.issues.length ? (
                  <ul className="mt-3 space-y-2 text-xs text-rose-800">
                    {validation.issues.map((issue, index) => (
                      <li key={`${issue.code}-${issue.path || issue.field || index}`}>
                        {issue.path || issue.field ? <code>{issue.path || issue.field}: </code> : null}
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </aside>

          <section className="flex min-h-0 flex-col">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <FileCode2 size={16} />
                SKILL.md
              </div>
              <span className="text-xs text-slate-500">{skillMarkdown.length.toLocaleString()} characters</span>
            </div>
            <textarea
              value={skillMarkdown}
              onChange={(event) => {
                setSkillMarkdown(event.target.value);
                setValidation(null);
              }}
              spellCheck={false}
              aria-label="SKILL.md content"
              className="min-h-0 flex-1 resize-none bg-slate-950 p-5 font-mono text-sm leading-6 text-slate-100 outline-none"
            />
          </section>
        </div>

        {error ? <div className="border-t border-rose-200 bg-rose-50 px-6 py-3 text-sm text-rose-700">{error}</div> : null}
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 px-5 py-4 sm:px-6">
          <button type="button" onClick={onClose} className="settings-portal-button-secondary rounded-xl px-4 py-2.5 text-sm font-semibold">
            Close
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={Boolean(busy)}
            className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
          >
            {busy === 'save' ? <Loader2 size={16} className="animate-spin" /> : <Code2 size={16} />}
            Save draft
          </button>
          <button
            type="button"
            onClick={() => void runValidation()}
            disabled={Boolean(busy)}
            className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
          >
            {busy === 'validate' ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
            Validate
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={Boolean(busy) || !teamId}
            className="settings-button-primary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
          >
            {busy === 'submit' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            Submit to Team Lead
          </button>
        </div>
      </div>
    </div>
  );
};

const ReviewDialog = ({
  review,
  onClose,
  onDecided,
}: {
  review: TeamReviewDetail;
  onClose: () => void;
  onDecided: () => Promise<void>;
}) => {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const skillFile = review.candidate.files.find((file) => file.path === 'SKILL.md');

  const decide = async (decision: 'approve' | 'request_changes' | 'reject') => {
    setBusy(decision);
    setError(null);
    try {
      await decideSkillReview(review.id, {
        decision,
        comment,
        expectedRequestRevision: review.requestRevision,
      });
      await onDecided();
      onClose();
    } catch (decisionError) {
      if ((decisionError as { code?: string })?.code === 'SKILL_MATERIALIZATION_UNAVAILABLE') {
        await onDecided();
        onClose();
        return;
      }
      setError(decisionError instanceof Error ? decisionError.message : 'Decision failed');
    } finally {
      setBusy(null);
    }
  };

  const retryActivation = async () => {
    setBusy('retry');
    setError(null);
    try {
      await retrySkillActivation(review.id, review.requestRevision);
      await onDecided();
      onClose();
    } catch (retryError) {
      if ((retryError as { code?: string })?.code === 'SKILL_MATERIALIZATION_UNAVAILABLE') {
        await onDecided();
        onClose();
        return;
      }
      setError(retryError instanceof Error ? retryError.message : 'Activation retry failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <div className="settings-modal-panel flex h-[min(92vh,920px)] w-full max-w-5xl flex-col overflow-hidden rounded-[28px]" role="dialog" aria-modal="true">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={review.status} />
              {review.activationStatus ? <StatusBadge status={`activation_${review.activationStatus}`} /> : null}
              <StatusBadge status={review.candidate.validationSummary.outcome} />
              <span className="text-xs text-slate-500">Risk: {review.candidate.validationSummary.riskClass}</span>
            </div>
            <h2 className="mt-2 text-xl font-semibold text-slate-900">
              {review.candidate.skillKey}@{review.candidate.semanticVersion}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Frozen candidate {review.candidate.candidateNumber} · manifest {shortHash(review.candidate.manifestHash)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="settings-portal-button-secondary rounded-xl p-2" aria-label="Close review">
            <X size={18} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="flex min-h-0 flex-col border-b border-slate-200 lg:border-b-0 lg:border-r">
            <div className="border-b border-slate-200 px-5 py-3 text-sm font-semibold text-slate-800">Frozen SKILL.md</div>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap bg-slate-950 p-5 font-mono text-sm leading-6 text-slate-100">
              {skillFile?.content || 'Binary or missing SKILL.md'}
            </pre>
          </section>
          <aside className="overflow-y-auto p-5">
            <h3 className="text-sm font-semibold text-slate-900">Automated checks</h3>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Files</dt><dd>{review.candidate.files.length}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Added</dt><dd>{review.candidate.diff.added.length}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Modified</dt><dd>{review.candidate.diff.modified.length}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Deleted</dt><dd>{review.candidate.diff.deleted.length}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Tools</dt><dd>{review.candidate.validationSummary.declaredCapabilities.tools.length}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">MCP servers</dt><dd>{review.candidate.validationSummary.declaredCapabilities.mcpServers.length}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Scripts</dt><dd>{review.candidate.validationSummary.declaredCapabilities.scripts.length}</dd></div>
            </dl>
            {!review.candidate.diff.basedOnCurrentDefault ? (
              <SettingsNotice variant="warning">
                This proposal is based on {review.candidate.diff.baseSemanticVersion || 'an older active version'}, not the current default.
              </SettingsNotice>
            ) : null}
            {review.candidate.submissionNote ? (
              <div className="settings-soft-panel mt-5 rounded-2xl p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Proposer note</p>
                <p className="mt-2 text-sm leading-6 text-slate-700">{review.candidate.submissionNote}</p>
              </div>
            ) : null}
            <label className="mt-5 block text-sm font-medium text-slate-700">
              Decision note
              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                rows={5}
                className="settings-control mt-1.5 w-full rounded-xl px-3 py-2.5 text-sm"
                placeholder="Explain the decision or requested changes."
              />
            </label>
            {!review.permissions.canReview ? (
              <SettingsNotice variant="warning">
                You cannot decide this candidate. Self-approval is disabled by default.
              </SettingsNotice>
            ) : null}
            {review.activationStatus === 'failed' ? (
              <SettingsNotice variant="error">
                Approval is recorded, but the immutable runtime package is unavailable
                {review.activationErrorCode ? ` (${review.activationErrorCode})` : ''}. A Team Lead can retry activation.
              </SettingsNotice>
            ) : null}
            {error ? <div className="mt-4 text-sm text-rose-700">{error}</div> : null}
          </aside>
        </div>

        <div className="flex flex-wrap justify-end gap-3 border-t border-slate-200 px-6 py-4">
          <button type="button" onClick={onClose} className="settings-portal-button-secondary rounded-xl px-4 py-2.5 text-sm font-semibold">
            Close
          </button>
          {review.activationStatus === 'failed' ? (
            <button
              type="button"
              onClick={() => void retryActivation()}
              disabled={Boolean(busy) || !review.permissions.canRetryActivation}
              className="settings-button-primary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
            >
              {busy === 'retry' ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              Retry activation
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void decide('reject')}
                disabled={Boolean(busy) || !review.permissions.canReview}
                className="settings-button-danger inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
              >
                <XCircle size={16} /> Reject
              </button>
              <button
                type="button"
                onClick={() => void decide('request_changes')}
                disabled={Boolean(busy) || !review.permissions.canReview}
                className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
              >
                <GitPullRequestArrow size={16} /> Request changes
              </button>
              <button
                type="button"
                onClick={() => void decide('approve')}
                disabled={Boolean(busy) || !review.permissions.canReview || !review.candidate.validationSummary.valid}
                className="settings-button-primary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
              >
                {busy === 'approve' ? <Loader2 size={16} className="animate-spin" /> : <BadgeCheck size={16} />}
                Approve & activate
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const VersionDialog = ({
  skill,
  onClose,
  onChanged,
}: {
  skill: CatalogSkill;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) => {
  const [versions, setVersions] = useState<GovernedSkillVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchSkillVersions(skill.id);
      setVersions(response.versions);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load versions');
    } finally {
      setLoading(false);
    }
  }, [skill.id]);

  useEffect(() => {
    void refresh();
    void getWorkspaces()
      .then((rows: Workspace[]) => {
        const eligible = (rows || []).filter((workspace) =>
          workspace.visibility !== 'team'
          && (workspace.role === 'owner' || workspace.role === 'editor' || workspace.canPublish));
        setWorkspaces(eligible);
        setWorkspaceId((current) => current || eligible[0]?.id || '');
      })
      .catch(() => setWorkspaces([]));
  }, [refresh]);

  const changeStatus = async (
    version: GovernedSkillVersion,
    action: 'default' | 'suspend' | 'restore' | 'retire',
  ) => {
    setBusy(`${version.id}:${action}`);
    setError(null);
    try {
      if (action === 'default') await setDefaultSkillVersion(skill.id, version.id);
      else await updateSkillVersionStatus(skill.id, version.id, action);
      await Promise.all([refresh(), onChanged()]);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Version action failed');
    } finally {
      setBusy(null);
    }
  };

  const pinVersion = async (version: GovernedSkillVersion) => {
    if (!workspaceId) return;
    setBusy(`${version.id}:pin`);
    setError(null);
    setNotice(null);
    try {
      await pinWorkspaceSkillVersion(workspaceId, skill.id, version.id);
      const workspace = workspaces.find((entry) => entry.id === workspaceId);
      setNotice(`${skill.skillKey}@${version.semanticVersion} is now pinned to ${workspace?.name || 'the workspace'}.`);
    } catch (pinError) {
      setError(pinError instanceof Error ? pinError.message : 'Failed to pin version');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <div className="settings-modal-panel flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-[28px]" role="dialog" aria-modal="true">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">{skill.displayName} versions</h2>
            <p className="mt-1 font-mono text-xs text-slate-500">{skill.skillKey} · immutable history</p>
          </div>
          <button type="button" onClick={onClose} className="settings-portal-button-secondary rounded-xl p-2" aria-label="Close versions">
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
          {error ? <SettingsNotice variant="error">{error}</SettingsNotice> : null}
          {notice ? <SettingsNotice>{notice}</SettingsNotice> : null}
          {skill.entitled && workspaces.length ? (
            <label className="mb-4 block text-sm font-medium text-slate-700">
              Workspace for an exact pin
              <select
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
                className="settings-control mt-1.5 w-full rounded-xl px-3 py-2.5 text-sm"
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          {loading ? <SettingsLoadingState label="Loading immutable versions..." /> : null}
          {!loading && !versions.length ? (
            <SettingsEmptyState title="No immutable versions" description="Approved versions appear here." icon={History} />
          ) : null}
          {!loading && versions.length ? (
            <div className="space-y-3">
              {versions.map((version) => (
                <div key={version.id} className="settings-selection-card rounded-2xl p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-slate-900">{version.semanticVersion}</p>
                        <StatusBadge status={version.status} />
                        {version.isDefault ? <span className="text-xs font-semibold text-blue-700">Default</span> : null}
                      </div>
                      <p className="mt-2 font-mono text-xs text-slate-500">
                        {shortHash(version.manifestHash)} · {formatTime(version.activatedAt || version.createdAt)}
                      </p>
                    </div>
                    {skill.canAdminister ? (
                      <div className="flex flex-wrap justify-end gap-2">
                        {version.status === 'active' && !version.isDefault ? (
                          <button
                            type="button"
                            onClick={() => void changeStatus(version, 'default')}
                            disabled={Boolean(busy)}
                            className="settings-portal-button-secondary rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50"
                          >
                            Set default
                          </button>
                        ) : null}
                        {version.status === 'active' ? (
                          <button
                            type="button"
                            onClick={() => void changeStatus(version, 'suspend')}
                            disabled={Boolean(busy)}
                            className="settings-portal-button-secondary rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50"
                          >
                            Suspend
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void changeStatus(version, 'restore')}
                            disabled={Boolean(busy)}
                            className="settings-portal-button-secondary rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50"
                          >
                            Restore
                          </button>
                        )}
                        {version.status !== 'retired' ? (
                          <button
                            type="button"
                            onClick={() => void changeStatus(version, 'retire')}
                            disabled={Boolean(busy)}
                            className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-50"
                          >
                            Retire
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {skill.entitled && workspaceId && version.status === 'active' ? (
                      <button
                        type="button"
                        onClick={() => void pinVersion(version)}
                        disabled={Boolean(busy)}
                        className="settings-button-primary rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        Pin exact version
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex justify-end border-t border-slate-200 px-6 py-4">
          <button type="button" onClick={onClose} className="settings-portal-button-secondary rounded-xl px-4 py-2.5 text-sm font-semibold">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

const SkillGovernancePage = () => {
  const [tab, setTab] = useState<TabId>('mine');
  const [mine, setMine] = useState<MySkillsResponse | null>(null);
  const [catalog, setCatalog] = useState<CatalogSkill[]>([]);
  const [selectedLeadTeamId, setSelectedLeadTeamId] = useState('');
  const [reviews, setReviews] = useState<TeamReviewSummary[]>([]);
  const [draftEditor, setDraftEditor] = useState<SkillDraft | null>(null);
  const [reviewDialog, setReviewDialog] = useState<TeamReviewDetail | null>(null);
  const [versionDialog, setVersionDialog] = useState<CatalogSkill | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const leadTeams = useMemo(() => (mine?.eligibleTeams || []).filter((team) => team.isLead), [mine]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [mySkills, catalogResponse] = await Promise.all([fetchMySkills(), fetchSkillCatalog()]);
      setMine(mySkills);
      setCatalog(catalogResponse.skills);
      const leads = mySkills.eligibleTeams.filter((team) => team.isLead);
      setSelectedLeadTeamId((current) => current || leads[0]?.id || '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load skill governance');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadReviews = useCallback(async (teamId: string) => {
    if (!teamId) {
      setReviews([]);
      return;
    }
    try {
      const response = await fetchTeamReviews(teamId);
      setReviews(response.reviews);
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Failed to load Team review queue');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selectedLeadTeamId) void loadReviews(selectedLeadTeamId);
  }, [loadReviews, selectedLeadTeamId]);

  const openDraft = async (draftId: string) => {
    setActionBusy(draftId);
    setError(null);
    try {
      setDraftEditor(await fetchSkillDraft(draftId));
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : 'Failed to open private draft');
    } finally {
      setActionBusy(null);
    }
  };

  const createNew = async () => {
    setActionBusy('new');
    setError(null);
    try {
      const draft = await createSkillDraft({ proposalType: 'new' });
      setDraftEditor(draft);
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create draft');
    } finally {
      setActionBusy(null);
    }
  };

  const improve = async (skill: CatalogSkill) => {
    setActionBusy(skill.id);
    setError(null);
    try {
      const draft = await createImprovementDraft(skill.id, skill.defaultVersionId || undefined);
      setDraftEditor(draft);
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create improvement draft');
    } finally {
      setActionBusy(null);
    }
  };

  const openReview = async (requestId: string) => {
    setActionBusy(requestId);
    setError(null);
    try {
      setReviewDialog(await fetchSkillReview(requestId));
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Failed to open review');
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <SettingsShell
      eyebrow="Unified governance"
      title="Skill governance"
      description="Create privately, submit an immutable candidate to your Team Lead, and consume only approved versions assigned directly or through a Team."
      actions={(
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-medium"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      )}
    >
      <SettingsTabs
        tabs={[
          { id: 'mine', label: 'My skills', icon: Code2 },
          { id: 'reviews', label: `Team reviews${leadTeams.length ? ` (${reviews.length})` : ''}`, icon: Users2 },
          { id: 'catalog', label: 'Catalog', icon: Library },
        ]}
        value={tab}
        onChange={setTab}
      />

      {error ? <SettingsNotice variant="error">{error}</SettingsNotice> : null}
      {loading || !mine ? <SettingsLoadingState label="Loading skill governance..." /> : null}

      {!loading && mine && tab === 'mine' ? (
        <div className="space-y-6">
          <SettingsSurface>
            <SettingsSectionHeader
              eyebrow="Private by default"
              title="Private drafts"
              description="Draft files remain visible only to you until you submit a frozen candidate."
              actions={(
                <button
                  type="button"
                  onClick={() => void createNew()}
                  disabled={Boolean(actionBusy)}
                  className="settings-button-primary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
                >
                  {actionBusy === 'new' ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                  Create skill
                </button>
              )}
            />
            {!mine.drafts.filter((draft) => draft.status === 'private').length ? (
              <SettingsEmptyState
                title="No private drafts"
                description="Create a skill or start an improvement from the governed catalog."
                icon={FileCode2}
              />
            ) : (
              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {mine.drafts.filter((draft) => draft.status === 'private').map((draft) => (
                  <button
                    type="button"
                    key={draft.id}
                    onClick={() => void openDraft(draft.id)}
                    className="settings-selection-card rounded-2xl p-4 text-left transition"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900">{draft.displayName || draft.proposedSkillKey}</p>
                        <p className="mt-1 truncate font-mono text-xs text-slate-500">{draft.proposedSkillKey}</p>
                      </div>
                      {actionBusy === draft.id ? <Loader2 size={16} className="animate-spin" /> : <ChevronRight size={16} />}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <StatusBadge status={draft.status} />
                      <span className="text-xs text-slate-500">rev {draft.draftRevision}</span>
                      <span className="text-xs text-slate-500">{draft.proposedOwnerTeamName || 'Team not selected'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </SettingsSurface>

          <SettingsSurface>
            <SettingsSectionHeader
              eyebrow="Immutable review"
              title="Submitted candidates"
              description="Team Leads review frozen candidates; they never edit your live private draft."
            />
            {!mine.reviews.length ? (
              <SettingsEmptyState title="Nothing in review" description="Submitted candidates and requested changes appear here." icon={GitPullRequestArrow} />
            ) : (
              <div className="mt-5 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-3">Skill</th>
                      <th className="px-3 py-3">Team</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3">Manifest</th>
                      <th className="px-3 py-3">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {mine.reviews.map((review) => (
                      <tr key={review.id}>
                        <td className="px-3 py-3"><span className="font-medium">{review.skillKey}</span><span className="text-slate-500">@{review.semanticVersion}</span></td>
                        <td className="px-3 py-3">{review.ownerTeamName}</td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1">
                            <StatusBadge status={review.status} />
                            {review.activationStatus ? <StatusBadge status={`activation_${review.activationStatus}`} /> : null}
                          </div>
                        </td>
                        <td className="px-3 py-3 font-mono text-xs">{shortHash(review.manifestHash)}</td>
                        <td className="px-3 py-3 text-slate-500">{formatTime(review.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SettingsSurface>

          <SettingsSurface>
            <SettingsSectionHeader
              eyebrow="Creator attribution"
              title="Approved versions you created"
              description="Approved versions are immutable and owned by their governing Team."
            />
            {!mine.versions.length ? (
              <SettingsEmptyState title="No approved versions yet" description="Approved and activated versions will appear here." icon={BookOpenCheck} />
            ) : (
              <div className="mt-5 grid gap-3 md:grid-cols-2">
                {mine.versions.map((version) => (
                  <div key={version.versionId} className="settings-selection-card rounded-2xl p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-slate-900">{version.displayName}</p>
                        <p className="mt-1 font-mono text-xs text-slate-500">{version.skillKey}@{version.semanticVersion}</p>
                      </div>
                      <StatusBadge status={version.status} />
                    </div>
                    <p className="mt-4 text-xs text-slate-500">{version.ownerTeamName} · {shortHash(version.manifestHash)}</p>
                  </div>
                ))}
              </div>
            )}
          </SettingsSurface>
        </div>
      ) : null}

      {!loading && mine && tab === 'reviews' ? (
        <SettingsSurface>
          <SettingsSectionHeader
            eyebrow="Team Lead"
            title="Skill review queue"
            description="The owning Team Lead is the only human approver. Automated platform policy is rechecked before activation."
            actions={leadTeams.length ? (
              <select
                value={selectedLeadTeamId}
                onChange={(event) => setSelectedLeadTeamId(event.target.value)}
                className="settings-control rounded-xl px-3 py-2.5 text-sm"
                aria-label="Reviewing Team"
              >
                {leadTeams.map((team: GovernanceTeam) => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
            ) : undefined}
          />
          {!leadTeams.length ? (
            <SettingsEmptyState
              title="No Team Lead assignments"
              description="A Platform Admin must assign Team Lead authority directly to a named Team member."
              icon={ShieldCheck}
            />
          ) : !reviews.length ? (
            <SettingsEmptyState title="Queue is clear" description="There are no submitted candidates waiting for this Team." icon={CheckCircle2} />
          ) : (
            <div className="mt-5 space-y-3">
              {reviews.map((review) => (
                <button
                  type="button"
                  key={review.id}
                  onClick={() => void openReview(review.id)}
                  className="settings-selection-card flex w-full items-center justify-between gap-4 rounded-2xl p-4 text-left"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-slate-900">{review.skillKey}@{review.semanticVersion}</p>
                      <StatusBadge status={review.validationSummary.outcome} />
                      {review.activationStatus ? <StatusBadge status={`activation_${review.activationStatus}`} /> : null}
                      <span className="text-xs text-slate-500">{review.validationSummary.riskClass} risk</span>
                    </div>
                    <p className="mt-1 text-sm text-slate-600">Proposed by {review.proposerName} · candidate {review.candidateNumber}</p>
                    <p className="mt-2 font-mono text-xs text-slate-500">manifest {shortHash(review.manifestHash)}</p>
                  </div>
                  {actionBusy === review.id ? <Loader2 size={18} className="animate-spin" /> : <ChevronRight size={18} />}
                </button>
              ))}
            </div>
          )}
        </SettingsSurface>
      ) : null}

      {!loading && mine && tab === 'catalog' ? (
        <SettingsSurface>
          <SettingsSectionHeader
            eyebrow="Approved catalog"
            title="Governed skills"
            description="Access assignment, Team ownership, default versions, and runtime entitlement remain separate."
          />
          {!catalog.length ? (
            <SettingsEmptyState title="No visible governed skills" description="Skills appear after Team Lead approval or when assigned to you." icon={Library} />
          ) : (
            <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {catalog.map((skill) => (
                <article key={skill.id} className="settings-selection-card rounded-2xl p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold text-slate-900">{skill.displayName}</h3>
                      <p className="mt-1 truncate font-mono text-xs text-slate-500">
                        {skill.skillKey}@{skill.defaultSemanticVersion || '—'}
                      </p>
                    </div>
                    <StatusBadge status={skill.status} />
                  </div>
                  <p className="mt-3 line-clamp-3 min-h-[60px] text-sm leading-5 text-slate-600">{skill.description || 'No description provided.'}</p>
                  <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
                    <p>Owned by {skill.ownerTeamName}</p>
                    <p className="mt-1">
                      {skill.entitled ? skill.accessReasons.join(' · ') || 'Assigned' : 'Not assigned for consumption'}
                    </p>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void improve(skill)}
                      disabled={Boolean(actionBusy)}
                      className="settings-portal-button-secondary inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold disabled:opacity-50"
                    >
                      {actionBusy === skill.id ? <Loader2 size={16} className="animate-spin" /> : <GitPullRequestArrow size={16} />}
                      Improve
                    </button>
                    <button
                      type="button"
                      onClick={() => setVersionDialog(skill)}
                      className="settings-portal-button-secondary inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold"
                    >
                      <History size={16} />
                      Versions
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </SettingsSurface>
      ) : null}

      {draftEditor ? (
        <DraftEditor
          initialDraft={draftEditor}
          onClose={() => setDraftEditor(null)}
          onSubmitted={load}
        />
      ) : null}
      {reviewDialog ? (
        <ReviewDialog
          review={reviewDialog}
          onClose={() => setReviewDialog(null)}
          onDecided={async () => {
            await load();
            await loadReviews(reviewDialog.ownerTeamId);
          }}
        />
      ) : null}
      {versionDialog ? (
        <VersionDialog
          skill={versionDialog}
          onClose={() => setVersionDialog(null)}
          onChanged={load}
        />
      ) : null}
    </SettingsShell>
  );
};

export default SkillGovernancePage;
