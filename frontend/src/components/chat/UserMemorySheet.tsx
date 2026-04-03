import { useEffect, useMemo, useState } from 'react';
import { Brain, RefreshCw, Save, X } from 'lucide-react';
import type { UserMemorySuggestion, UserMemoryView } from '../../types';

type SectionKey = keyof UserMemoryView;

const SECTION_META: Array<{
  key: SectionKey;
  title: string;
  hint: string;
  scope: 'global' | 'workspace';
  section: 'preferences' | 'context';
}> = [
  {
    key: 'globalPreferences',
    title: 'Global Preferences',
    hint: 'Persistent preferences across every workspace.',
    scope: 'global',
    section: 'preferences',
  },
  {
    key: 'globalContext',
    title: 'Global Context',
    hint: 'Stable background the agent should remember about you.',
    scope: 'global',
    section: 'context',
  },
  {
    key: 'workspacePreferences',
    title: 'Workspace Preferences',
    hint: 'Tone or working preferences specific to this workspace.',
    scope: 'workspace',
    section: 'preferences',
  },
  {
    key: 'workspaceContext',
    title: 'Workspace Context',
    hint: 'Long-lived project context for this workspace.',
    scope: 'workspace',
    section: 'context',
  },
] as const;

export default function UserMemorySheet({
  colorMode,
  isOpen,
  workspaceName,
  workspaceId,
  memory,
  suggestions,
  isLoading,
  isSaving,
  error,
  onClose,
  onRefresh,
  onSaveSection,
  onDecideSuggestion,
}: {
  colorMode: 'light' | 'dark';
  isOpen: boolean;
  workspaceName?: string | null;
  workspaceId?: string | null;
  memory: UserMemoryView;
  suggestions: UserMemorySuggestion[];
  isLoading: boolean;
  isSaving: boolean;
  error?: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSaveSection: (input: {
    scope: 'global' | 'workspace';
    section: 'preferences' | 'context';
    content: string;
    workspaceId?: string;
  }) => Promise<void>;
  onDecideSuggestion: (
    suggestionId: string,
    payload: { decision: 'accept' | 'reject'; editedContent?: string },
  ) => Promise<void>;
}) {
  const isDarkMode = colorMode === 'dark';
  const [drafts, setDrafts] = useState<UserMemoryView>(memory);
  const [suggestionDrafts, setSuggestionDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setDrafts(memory);
  }, [memory]);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const suggestion of suggestions) {
      next[suggestion.id] = suggestion.reviewedContent || suggestion.proposedContent;
    }
    setSuggestionDrafts(next);
  }, [suggestions]);

  const pendingSuggestions = useMemo(
    () => suggestions.filter((suggestion) => suggestion.status === 'pending'),
    [suggestions],
  );

  if (!isOpen) {
    return null;
  }

  return (
    <div className="absolute inset-0 z-40 flex justify-end bg-slate-950/30 backdrop-blur-[2px]">
      <div className={`flex h-full w-full max-w-[560px] flex-col border-l shadow-2xl ${
        isDarkMode ? 'border-slate-700 bg-slate-950 text-slate-100' : 'border-slate-200 bg-white text-slate-900'
      }`}>
        <div className={`flex items-start justify-between gap-4 border-b px-5 py-4 ${
          isDarkMode ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-sky-500">
              <Brain size={14} />
              Memory
            </div>
            <h2 className="mt-2 text-lg font-semibold">Persistent user memory</h2>
            <p className={`mt-1 text-sm ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              Approved memory is user-owned and carried across future chats.
              {workspaceName ? ` Workspace: ${workspaceName}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              className={`rounded-xl p-2 ${isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
              title="Refresh memory"
            >
              <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className={`rounded-xl p-2 ${isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
              title="Close memory panel"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {error ? (
            <div className={`mb-4 rounded-2xl px-4 py-3 text-sm ${
              isDarkMode ? 'bg-red-950/50 text-red-200' : 'bg-red-50 text-red-700'
            }`}>
              {error}
            </div>
          ) : null}

          <div className="space-y-6">
            {SECTION_META.map((section) => (
              <div key={section.key} className={`rounded-2xl border px-4 py-4 ${
                isDarkMode ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-slate-50/70'
              }`}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold">{section.title}</h3>
                    <p className={`mt-1 text-xs leading-5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                      {section.hint}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={isSaving || (section.scope === 'workspace' && !workspaceId)}
                    onClick={() => void onSaveSection({
                      scope: section.scope,
                      section: section.section,
                      content: drafts[section.key],
                      workspaceId: section.scope === 'workspace' ? workspaceId || undefined : undefined,
                    })}
                    className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    <Save size={14} />
                    Save
                  </button>
                </div>
                <textarea
                  value={drafts[section.key]}
                  onChange={(event) => setDrafts((prev) => ({ ...prev, [section.key]: event.target.value }))}
                  disabled={section.scope === 'workspace' && !workspaceId}
                  rows={section.key.toLowerCase().includes('context') ? 6 : 4}
                  placeholder={section.scope === 'workspace' && !workspaceId ? 'Select a workspace to edit workspace memory.' : 'Leave blank to keep this section empty.'}
                  className={`mt-3 w-full rounded-2xl border px-3 py-3 text-sm leading-6 outline-none transition ${
                    isDarkMode
                      ? 'border-slate-700 bg-slate-950 text-slate-100 placeholder:text-slate-500 focus:border-sky-500'
                      : 'border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-blue-400'
                  }`}
                />
              </div>
            ))}

            <div className={`rounded-2xl border px-4 py-4 ${
              isDarkMode ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-slate-50/70'
            }`}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold">Pending suggestions</h3>
                  <p className={`mt-1 text-xs leading-5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    Suggestions are extracted after completed conversations and only become active after review.
                  </p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                  isDarkMode ? 'bg-slate-800 text-slate-300' : 'bg-white text-slate-600'
                }`}>
                  {pendingSuggestions.length} pending
                </span>
              </div>

              <div className="mt-4 space-y-3">
                {pendingSuggestions.length === 0 ? (
                  <div className={`rounded-2xl border border-dashed px-4 py-5 text-sm ${
                    isDarkMode ? 'border-slate-700 text-slate-400' : 'border-slate-300 text-slate-500'
                  }`}>
                    No pending suggestions right now.
                  </div>
                ) : pendingSuggestions.map((suggestion) => (
                  <div key={suggestion.id} className={`rounded-2xl border px-4 py-4 ${
                    isDarkMode ? 'border-slate-800 bg-slate-950/70' : 'border-slate-200 bg-white'
                  }`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${
                        isDarkMode ? 'bg-sky-950 text-sky-200' : 'bg-sky-50 text-sky-700'
                      }`}>
                        {suggestion.targetScope}
                      </span>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${
                        isDarkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'
                      }`}>
                        {suggestion.targetSection}
                      </span>
                    </div>
                    <p className={`mt-3 text-sm leading-6 ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                      {suggestion.rationale}
                    </p>
                    <textarea
                      value={suggestionDrafts[suggestion.id] || ''}
                      onChange={(event) => setSuggestionDrafts((prev) => ({ ...prev, [suggestion.id]: event.target.value }))}
                      rows={6}
                      className={`mt-3 w-full rounded-2xl border px-3 py-3 text-sm leading-6 outline-none transition ${
                        isDarkMode
                          ? 'border-slate-700 bg-slate-950 text-slate-100 focus:border-sky-500'
                          : 'border-slate-200 bg-white text-slate-900 focus:border-blue-400'
                      }`}
                    />
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => void onDecideSuggestion(suggestion.id, {
                          decision: 'accept',
                          editedContent: suggestionDrafts[suggestion.id] || '',
                        })}
                        className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => void onDecideSuggestion(suggestion.id, { decision: 'reject' })}
                        className={`rounded-xl px-3 py-2 text-xs font-semibold disabled:opacity-50 ${
                          isDarkMode ? 'bg-slate-800 text-slate-200' : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
