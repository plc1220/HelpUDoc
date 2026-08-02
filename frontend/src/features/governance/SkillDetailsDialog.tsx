import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Archive,
  History,
  Loader2,
  RotateCcw,
  Sparkles,
  Users2,
  Wrench,
  X,
} from 'lucide-react';
import {
  fetchSkillDetail,
  updateSkillStatus,
  type CatalogSkill,
  type SkillDetail,
} from '../../services/governanceApi';
import {
  SettingsLoadingState,
  SettingsNotice,
} from '../../components/settings/SettingsScaffold';

const friendlyStatus = (status: string) => {
  if (status === 'active') return 'Available';
  if (status === 'retired') return 'Archived';
  if (status === 'suspended') return 'Unavailable';
  return status.replace(/_/g, ' ');
};

export default function SkillDetailsDialog({
  initialSkill,
  onClose,
  onImprove,
  onVersions,
  onChanged,
}: {
  initialSkill: CatalogSkill;
  onClose: () => void;
  onImprove: (skill: CatalogSkill) => Promise<void>;
  onVersions: (skill: CatalogSkill) => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'archive' | 'restore' | 'improve' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await fetchSkillDetail(initialSkill.id));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load skill details');
    } finally {
      setLoading(false);
    }
  }, [initialSkill.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const skillMarkdown = useMemo(
    () => (detail?.files.find((file) => file.path === 'SKILL.md')?.content || '')
      .replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, ''),
    [detail],
  );
  const skill = detail?.skill || initialSkill;

  const changeStatus = async (action: 'archive' | 'restore') => {
    if (action === 'archive') {
      const usage = detail?.usage;
      const impact = usage
        ? ` It is currently assigned to ${usage.teamGrantCount} Team(s), ${usage.userGrantCount} user(s), and pinned in ${usage.workspacePinCount} workspace(s).`
        : '';
      if (!window.confirm(`Archive “${skill.displayName}”? It will no longer be available to run or assign.${impact} Published versions and history will be kept.`)) return;
    }
    setBusy(action);
    setError(null);
    try {
      await updateSkillStatus(skill.id, action);
      await Promise.all([load(), onChanged()]);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : `Failed to ${action} the skill`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <div className="settings-modal-panel flex h-[min(92vh,940px)] w-full max-w-5xl flex-col overflow-hidden rounded-[28px]" role="dialog" aria-modal="true" aria-labelledby="skill-details-title">
        <header className="flex items-start justify-between border-b border-slate-200 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-blue-50 px-2.5 py-1 font-semibold text-blue-700">Team skill</span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">{friendlyStatus(skill.status)}</span>
              {skill.entitled ? <span className="text-emerald-700">You have access</span> : <span className="text-slate-500">Not assigned to you</span>}
            </div>
            <h2 id="skill-details-title" className="mt-2 truncate text-2xl font-semibold text-slate-900">{skill.displayName}</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">{skill.description || 'No description has been added yet.'}</p>
            <p className="mt-2 text-xs text-slate-500">Owned by {skill.ownerTeamName} · Published version {skill.defaultSemanticVersion || 'not selected'}</p>
          </div>
          <button type="button" onClick={onClose} className="settings-portal-button-secondary rounded-xl p-2" aria-label="Close skill details"><X size={18} /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
          {loading ? <SettingsLoadingState label="Loading skill details…" /> : null}
          {error ? <SettingsNotice variant="error">{error}</SettingsNotice> : null}
          {!loading && detail ? (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
              <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
                <div className="governance-skill-markdown prose prose-slate max-w-none prose-headings:scroll-mt-4 prose-pre:overflow-x-auto">
                  {skillMarkdown ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{skillMarkdown}</ReactMarkdown>
                  ) : (
                    <p>The published instructions are unavailable.</p>
                  )}
                </div>
              </article>

              <aside className="space-y-4">
                <div className="rounded-2xl border border-slate-200 p-4">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Wrench size={16} /> Tools and integrations</h3>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    {[...detail.capabilities.tools, ...detail.capabilities.mcpServers, ...detail.capabilities.scripts].length ? (
                      [...detail.capabilities.tools, ...detail.capabilities.mcpServers, ...detail.capabilities.scripts].map((item) => (
                        <span key={item} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-slate-700">{item}</span>
                      ))
                    ) : <span className="text-slate-500">No external tools declared</span>}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 p-4">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Users2 size={16} /> Access and usage</h3>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex justify-between"><dt className="text-slate-500">Teams</dt><dd>{detail.usage.teamGrantCount}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Direct users</dt><dd>{detail.usage.userGrantCount}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Workspace pins</dt><dd>{detail.usage.workspacePinCount}</dd></div>
                  </dl>
                  {skill.accessReasons.length ? <p className="mt-3 text-xs leading-5 text-slate-500">Your access: {skill.accessReasons.join(' · ')}</p> : null}
                </div>

                <details className="rounded-2xl border border-slate-200 p-4 text-sm">
                  <summary className="cursor-pointer font-semibold text-slate-900">Technical details</summary>
                  <dl className="mt-3 space-y-2 text-xs">
                    <div><dt className="text-slate-500">Skill ID</dt><dd className="mt-1 break-all font-mono">{skill.skillKey}</dd></div>
                    <div><dt className="text-slate-500">Version status</dt><dd className="mt-1">{detail.defaultVersion?.status || 'None'}</dd></div>
                    <div><dt className="text-slate-500">Version contents</dt><dd className="mt-1">{detail.files.length} file(s)</dd></div>
                  </dl>
                </details>
              </aside>
            </div>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-4 sm:px-6">
          <button type="button" onClick={() => onVersions(skill)} className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold"><History size={16} /> Published versions</button>
          <div className="flex flex-wrap gap-2">
            {detail?.permissions.canArchive ? (
              <button type="button" onClick={() => void changeStatus('archive')} disabled={Boolean(busy)} className="inline-flex items-center gap-2 rounded-xl bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-700 disabled:opacity-50">
                {busy === 'archive' ? <Loader2 size={16} className="animate-spin" /> : <Archive size={16} />} Archive skill
              </button>
            ) : null}
            {detail?.permissions.canRestore ? (
              <button type="button" onClick={() => void changeStatus('restore')} disabled={Boolean(busy)} className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold">
                {busy === 'restore' ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />} Restore skill
              </button>
            ) : null}
            {detail?.permissions.canImprove ? (
              <button type="button" onClick={async () => { setBusy('improve'); await onImprove(skill); setBusy(null); }} disabled={Boolean(busy)} className="settings-button-primary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
                {busy === 'improve' ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} Improve skill
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );
}
