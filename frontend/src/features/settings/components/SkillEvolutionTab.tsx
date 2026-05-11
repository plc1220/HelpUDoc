import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import type { SkillEvolutionSuggestion } from '../../../types';
import {
  decideSkillEvolutionSuggestion,
  fetchSkillEvolutionSuggestions,
  generateSkillEvolutionSuggestions,
} from '../../../services/settingsApi';
import { SettingsEmptyState, SettingsLoadingState, SettingsTabPanel } from './SettingsScaffold';

const targetLabel = (row: SkillEvolutionSuggestion) => {
  if (row.targetKind === 'memory_skill_routing') {
    return row.memoryTargetPath || 'memory skill-routing';
  }
  return row.targetSkillId ? `skill:${row.targetSkillId}/docs/HELPUDOC_LEARNINGS.md` : 'skill learnings';
};

const SkillEvolutionTab = () => {
  const [rows, setRows] = useState<SkillEvolutionSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSkillEvolutionSuggestions('pending');
      setRows(data);
      const next: Record<string, string> = {};
      for (const r of data) {
        next[r.id] = r.proposedContent;
      }
      setDrafts(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load suggestions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onDecide = async (id: string, decision: 'accept' | 'reject') => {
    setSavingId(id);
    setError(null);
    try {
      await decideSkillEvolutionSuggestion(id, {
        decision,
        editedContent: decision === 'accept' ? drafts[id] : undefined,
      });
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Request failed';
      setError(msg);
    } finally {
      setSavingId(null);
    }
  };

  const onGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      await generateSkillEvolutionSuggestions(40);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <SettingsTabPanel className="flex min-h-[320px] items-center justify-center">
        <SettingsLoadingState label="Loading skill evolution suggestions..." />
      </SettingsTabPanel>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Skill evolution</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Review proposed updates to per-user skill-routing memory or shared HELPUDOC_LEARNINGS.md files.
            Approvals apply immediately without redeploying the app. New proposals for the same target supersede
            older pending rows so reviews stay aligned with the latest file state.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium"
          >
            <RefreshCw size={16} />
            Refresh
          </button>
          <button
            type="button"
            disabled={generating}
            onClick={() => void onGenerate()}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {generating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            Generate from recent runs
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      ) : null}

      {rows.length === 0 ? (
        <SettingsTabPanel>
          <SettingsEmptyState
            title="No pending suggestions"
            description="Completed runs with friction signals will create proposals after reflection or manual generation."
            icon={Sparkles}
          />
        </SettingsTabPanel>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => (
            <div
              key={row.id}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                  {row.targetKind}
                </span>
                <span className="text-xs text-slate-500">{targetLabel(row)}</span>
                <span className="text-xs text-slate-400">user {row.memoryUserId.slice(0, 8)}…</span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-700">{row.rationale}</p>
              {row.evidence?.sourceRunIds?.length ? (
                <p className="mt-2 text-xs text-slate-500">
                  Runs: {row.evidence.sourceRunIds.join(', ')}
                  {row.evidence.sourceConversationIds?.length
                    ? ` · Conversations: ${row.evidence.sourceConversationIds.join(', ')}`
                    : ''}
                </p>
              ) : null}
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Base content (at proposal time)
                  </span>
                  {row.baseContentSnapshot != null && row.baseContentSnapshot !== '' ? (
                    <pre className="mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs leading-relaxed text-slate-800">
                      {row.baseContentSnapshot}
                    </pre>
                  ) : (
                    <p className="mt-2 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                      Not recorded for this suggestion (created before snapshots were stored).
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Proposed content (edit before approve)
                  </label>
                  <textarea
                    value={drafts[row.id] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [row.id]: e.target.value }))}
                    rows={12}
                    className="mt-2 min-h-[12rem] w-full rounded-xl border border-slate-200 px-3 py-2 font-mono text-xs leading-relaxed text-slate-900 md:min-h-0 md:h-[calc(100%-1.5rem)]"
                  />
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={savingId === row.id}
                  onClick={() => void onDecide(row.id, 'accept')}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={savingId === row.id}
                  onClick={() => void onDecide(row.id, 'reject')}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-800 disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SkillEvolutionTab;
