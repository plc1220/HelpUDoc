import { Card } from '@astryxdesign/core/Card';
import { Item } from '@astryxdesign/core/Item';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  Bot,
  CheckCircle2,
  FileUp,
  Loader2,
  Send,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  cancelSkillBuilderRun,
  importSkillBuilderGithub,
  validateSkillBuilderProposal,
  createSkillBuilderSession,
  deleteSkillBuilderContextFile,
  listSkillBuilderContextFiles,
  listSkillBuilderReferences,
  type SkillBuilderReference,
  startSkillBuilderRun,
  streamSkillBuilderRun,
  submitSkillBuilderDecision,
  uploadSkillBuilderContextFile,
  type SkillBuilderAction,
  type SkillBuilderContextFile,
} from '../../services/settingsApi';
import {
  applySkillBuilderDraftActions,
  createSkillDraft,
  deleteSkillDraft,
  type SkillDraft,
} from '../../services/governanceApi';
import { SettingsNotice } from '../../components/settings/SettingsScaffold';

type CreatorMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
};

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const parseActions = (text: string): SkillBuilderAction[] => {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const candidates = [...blocks.reverse(), text.trim()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const actions = Array.isArray(parsed) ? parsed : parsed?.actions;
      if (Array.isArray(actions) && actions.every((action) => action && typeof action.type === 'string')) {
        return actions as SkillBuilderAction[];
      }
    } catch {
      // A normal conversational response is expected while the creator asks questions.
    }
  }
  return [];
};

const actionLabel = (action: SkillBuilderAction) => {
  if (action.type === 'create_skill') return `Create ${action.name || action.skillId}`;
  if (action.type === 'upsert_text') return `Write ${action.path}`;
  if (action.type === 'upload_binary_from_context') return `Add ${action.targetPath}`;
  return `Remove ${action.path}`;
};

export default function SkillCreatorDialog({
  onClose,
  onManual,
  onSaved,
}: {
  onClose: () => void;
  onManual: () => Promise<void>;
  onSaved: (draft: SkillDraft) => Promise<void>;
}) {
  const [ready, setReady] = useState(false);
  const [messages, setMessages] = useState<CreatorMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [actions, setActions] = useState<SkillBuilderAction[]>([]);
  const [contextFiles, setContextFiles] = useState<SkillBuilderContextFile[]>([]);
  const [selectedContextIds, setSelectedContextIds] = useState<string[]>([]);
  const [allowedExtensions, setAllowedExtensions] = useState<string[]>([]);
  const [referenceOptions, setReferenceOptions] = useState<SkillBuilderReference[]>([]);
  const [selectedReferences, setSelectedReferences] = useState<SkillBuilderReference[]>([]);
  const [referenceQuery, setReferenceQuery] = useState('');
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [referenceTrigger, setReferenceTrigger] = useState('@');
  const [referenceIndex, setReferenceIndex] = useState(0);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const referenceRange = useRef<{ start: number; end: number } | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [proposalValid, setProposalValid] = useState(false);
  const [githubUrl, setGithubUrl] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastEventIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    const setup = async () => {
      try {
        const session = await createSkillBuilderSession();
        const files = await listSkillBuilderContextFiles();
        if (!active) return;
        setAllowedExtensions(session.allowedExtensions);
        setContextFiles(files);
        setReady(true);
        try { const options = await listSkillBuilderReferences(); if (active) setReferenceOptions(options); }
        catch (e) { if (active) setReferenceError(e instanceof Error ? e.message : 'References unavailable'); }
      } catch (setupError) {
        if (active) setError(setupError instanceof Error ? setupError.message : 'Skill Creator is unavailable');
      }
    };
    void setup();
    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, []);

  const consumeRun = async (activeRunId: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    let assistantText = '';
    let failed = false;
    let proposedActions: SkillBuilderAction[] = [];
    const assistantId = makeId();
    setMessages((current) => [...current, { id: assistantId, role: 'assistant', text: '' }]);
    await streamSkillBuilderRun(activeRunId, (chunk) => {
      const eventId = (chunk as { id?: string }).id;
      if (eventId) lastEventIdRef.current = eventId;
      if (['token', 'chunk'].includes(chunk.type)) {
        const content = (chunk as { content?: string }).content || '';
        if (!content) return;
        assistantText += content;
        setMessages((current) => current.map((message) => (
          message.id === assistantId ? { ...message, text: assistantText } : message
        )));
      } else if (chunk.type === 'interrupt') {
        setAwaitingApproval(true);
      } else if (chunk.type === 'error') {
        failed = true;
        setError(chunk.message || 'Skill Creator failed');
      } else if (chunk.type === 'done') {
        const proposed = parseActions(assistantText);
        if (proposed.length) { setActions(proposed); proposedActions = proposed; }
        else if (/```json/i.test(assistantText)) setError('The creator returned an invalid draft format. Ask it to regenerate the draft as valid JSON.');
      }
    }, controller.signal, lastEventIdRef.current);
    if (proposedActions.length && !failed) {
      setValidating(true);
      try {
        const validation = await validateSkillBuilderProposal(proposedActions);
        setProposalValid(validation.valid);
        if (!validation.valid) {
          const feedback = validation.issues.map(issue => issue.message).join('\n');
          setError(`Draft needs correction: ${feedback}`);
          setPrompt(`Correct the proposed draft and return the complete JSON actions. Validation found:\n${feedback}\nFor MCP workflows declare tools: [] and use only the registered mcp_servers; do not invent operation names.`);
        }
      } catch (e) { setProposalValid(false); setError(e instanceof Error ? e.message : 'Unable to validate draft'); }
      finally { setValidating(false); }
    }
    if (failed) setMessages(current => current.filter(message => message.id !== assistantId || message.text));
    else setMessages(current => current.map(message => message.id === assistantId && !message.text
      ? { ...message, text: 'No response was produced. You can retry your message.' } : message));
  };

  const sendPrompt = async () => {
    const text = prompt.trim();
    if (!text || running || !ready) return;
    const userMessageId = makeId();
    const nextMessages = [...messages, { id: userMessageId, role: 'user' as const, text }];
    let started = false;
    setMessages(nextMessages);
    setPrompt('');
    setError(null);
    setActions([]);
    setProposalValid(false);
    setRunning(true);
    try {
      const run = await startSkillBuilderRun({
        prompt: text,
        contextFileIds: selectedContextIds,
        forceReset: messages.length === 0,
        references: selectedReferences.map(({ kind, id }) => ({ kind, id })),
        history: messages
          .filter((message) => message.role !== 'system' && message.text.trim())
          .map((message) => ({ role: message.role, content: message.text })),
      });
      started = true;
      setRunId(run.runId);
      lastEventIdRef.current = undefined;
      await consumeRun(run.runId);
    } catch (runError) {
      if ((runError as { name?: string })?.name !== 'AbortError') {
        setError(runError instanceof Error ? runError.message : 'Skill Creator failed');
        if (!started) { setPrompt(text); setMessages(current => current.filter(message => message.id !== userMessageId)); }
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const decide = async (decision: 'approve' | 'reject') => {
    if (!runId) return;
    setError(null);
    try {
      await submitSkillBuilderDecision(runId, decision);
      setAwaitingApproval(false);
      if (decision === 'approve') {
        setRunning(true);
        await consumeRun(runId);
      }
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : 'Failed to continue the creator');
    } finally {
      setRunning(false);
    }
  };

  const stop = async () => {
    abortRef.current?.abort();
    if (runId) await cancelSkillBuilderRun(runId).catch(() => undefined);
    setRunning(false);
    setRunId(null);
  };

  const uploadContext = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const uploaded = await uploadSkillBuilderContextFile(file);
      setActions([]); setProposalValid(false);
      setContextFiles((current) => [...current, uploaded]);
      setSelectedContextIds((current) => [...current, uploaded.fileId]);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Failed to add context');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const importGithub = async () => {
    if (!githubUrl.trim() || uploading || running) return;
    setUploading(true); setError(null); setImportNotice(''); setActions([]); setProposalValid(false);
    try {
      const imported = await importSkillBuilderGithub(githubUrl.trim());
      setContextFiles(current => [...current, imported.file]);
      setSelectedContextIds(current => [...current, imported.file.fileId]);
      setImportNotice(`Imported ${imported.fileCount} source files at commit ${imported.source.commit.slice(0, 8)}. Ready to adapt.`);
      setGithubUrl('');
      setPrompt(current => current || 'Adapt the imported GitHub skill into a personal HelpUDoc skill. Preserve source attribution and required supporting files; explain any unsupported dependencies.');
    } catch (e) { setError(e instanceof Error ? e.message : 'GitHub import failed'); }
    finally { setUploading(false); }
  };

  const removeContext = async (fileId: string) => {
    try {
      await deleteSkillBuilderContextFile(fileId);
      setActions([]); setProposalValid(false);
      setContextFiles((current) => current.filter((file) => file.fileId !== fileId));
      setSelectedContextIds((current) => current.filter((id) => id !== fileId));
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to remove attachment'); }
  };

  const referenceKey = (ref: SkillBuilderReference) => `${ref.kind}:${ref.id}`;
  const toggleReference = (ref: SkillBuilderReference) => {
    const selected = selectedReferences.some(item => referenceKey(item) === referenceKey(ref));
    if (!selected && selectedReferences.length >= 20) { setReferenceError('You can tag up to 20 references.'); return; }
    setActions([]);
    setProposalValid(false);
    setSelectedReferences(current => selected ? current.filter(item => referenceKey(item) !== referenceKey(ref)) : [...current, ref]);
    const range = referenceRange.current;
    if (!selected && range) {
      setPrompt(current => current.slice(0, range.start) + current.slice(range.end));
      requestAnimationFrame(() => { promptRef.current?.focus(); promptRef.current?.setSelectionRange(range.start, range.start); });
    }
    setReferencesOpen(false);
    referenceRange.current = null;
    setReferenceError(null);
  };
  const updateReferencePicker = (input: HTMLTextAreaElement) => {
    const cursor = input.selectionStart;
    const match = /(^|[\s([{])([@/])([^\s@/]*)$/.exec(input.value.slice(0, cursor));
    setReferencesOpen(Boolean(match));
    referenceRange.current = match ? { start: cursor - match[3].length - 1, end: cursor } : null;
    if (match) { setReferenceTrigger(match[2]); setReferenceQuery(match[3]); setReferenceIndex(0); }
  };
  const visibleReferences = referenceOptions.filter(ref => (referenceTrigger === '/' ? ['skill', 'mcp'].includes(ref.kind) : ['knowledge', 'knowledge_base'].includes(ref.kind)) && !selectedReferences.some(item => referenceKey(item) === referenceKey(ref))).filter(ref => `${ref.name} ${ref.id} ${ref.kind} ${ref.description}`.toLowerCase().includes(referenceQuery.toLowerCase()));


  const saveProposal = async () => {
    if (!actions.length || !proposalValid) return;
    setSaving(true);
    setError(null);
    let created: SkillDraft | null = null;
    try {
      const validation = await validateSkillBuilderProposal(actions);
      if (!validation.valid) { setProposalValid(false); throw new Error(validation.issues.map(issue => issue.message).join('; ')); }
      created = await createSkillDraft({ proposalType: 'new' });
      const skillId = actions[0]?.skillId;
      const proposalActions: SkillBuilderAction[] = selectedReferences.length && skillId ? [
        ...actions.filter(action => !(action.type === 'upsert_text' && action.path === 'references/registered-resources.json')),
        { type: 'upsert_text', skillId, path: 'references/registered-resources.json', encoding: 'utf-8',
          content: JSON.stringify(selectedReferences.map(({ kind, id, name }) => ({ kind, id, name })), null, 2) },
      ] : [...actions];
      const sources = contextFiles.filter(file => selectedContextIds.includes(file.fileId) && file.source).map(file => file.source);
      if (sources.length && skillId) {
        const prior = proposalActions.findIndex(action => action.type === 'upsert_text' && action.path === 'references/source-provenance.json');
        if (prior >= 0) proposalActions.splice(prior, 1);
        proposalActions.push({ type: 'upsert_text', skillId, path: 'references/source-provenance.json', encoding: 'utf-8', content: JSON.stringify({ sources }, null, 2) });
      }
      const updated = await applySkillBuilderDraftActions(created.id, created.draftRevision, proposalActions);
      await onSaved(updated);
    } catch (saveError) {
      if (created) await deleteSkillDraft(created.id, created.draftRevision).catch(() => undefined);
      setError(saveError instanceof Error ? saveError.message : 'Failed to save the private draft');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <div className="settings-modal-panel flex h-[min(92vh,920px)] w-full max-w-6xl flex-col overflow-hidden rounded-[28px]" role="dialog" aria-modal="true" aria-labelledby="skill-creator-title">
        <header className="flex items-start justify-between border-b border-slate-200 px-5 py-4 sm:px-6">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-blue-600">
              <Sparkles size={15} /> Guided creation
            </div>
            <h2 id="skill-creator-title" className="mt-2 text-xl font-semibold text-slate-900">Create a skill with Skill Creator</h2>
            <p className="mt-1 text-sm text-slate-600">Describe the workflow, constraints, edge cases, and what a good result looks like. The creator will ask questions before preparing a private draft.</p>
          </div>
          <button type="button" onClick={onClose} className="settings-portal-button-secondary rounded-xl p-2" aria-label="Close Skill Creator"><X size={18} /></button>
        </header>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_330px]">
          <section className="flex min-h-0 flex-col border-b border-slate-200 lg:border-b-0 lg:border-r">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              {!messages.length ? (
                <div className="rounded-2xl border border-blue-100 bg-blue-50 p-5 text-sm leading-6 text-slate-700">
                  <p className="font-semibold text-slate-900">A useful first description includes:</p>
                  <p className="mt-2">When the workflow should run, required inputs, expected outputs, tools it may use, steps that must never be skipped, and known failure cases.</p>
                </div>
              ) : null}
              {messages.map((message) => (
                <div key={message.id} className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : ''}`}>
                  {message.role !== 'user' ? <span className="mt-1 rounded-full bg-blue-100 p-2 text-blue-700"><Bot size={16} /></span> : null}
                  <div className={`max-w-[82%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === 'user' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-800'}`}>
                    {message.text || <Loader2 size={16} className="animate-spin" />}
                  </div>
                  {message.role === 'user' ? <span className="mt-1 rounded-full bg-slate-200 p-2 text-slate-700"><UserRound size={16} /></span> : null}
                </div>
              ))}
            </div>
            {error ? <div className="px-5 pb-3"><SettingsNotice variant="error">{error}</SettingsNotice></div> : null}
            {awaitingApproval ? (
              <div className="flex items-center justify-between gap-3 border-t border-amber-200 bg-amber-50 px-5 py-3 text-sm">
                <span>The creator needs approval to continue this plan.</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void decide('reject')} className="settings-portal-button-secondary rounded-lg px-3 py-2 font-semibold">Reject</button>
                  <button type="button" onClick={() => void decide('approve')} className="settings-button-primary rounded-lg px-3 py-2 font-semibold">Approve</button>
                </div>
              </div>
            ) : null}
            <div className="relative border-t border-slate-200 p-4">
              {referencesOpen && <Card padding={1} className="lumo-composer-suggestions lumo-composer-command-suggestions" role="listbox" aria-label="Skill Creator references">
                {visibleReferences.length ? visibleReferences.map((ref, index) => <Item key={referenceKey(ref)} density="compact" label={ref.name} description={`${ref.kind.replace('_', ' ')} · ${ref.description || ref.id}`} isHighlighted={index === referenceIndex} onClick={() => toggleReference(ref)} />) : <div className="lumo-composer-empty-suggestion">No matching references</div>}
              </Card>}
              {referenceError && <p role="alert" className="mb-2 text-xs text-rose-600">{referenceError}</p>}
              {selectedReferences.length > 0 && <div className="mb-3 flex flex-wrap gap-2" aria-label="Tagged references">
                {selectedReferences.map(ref => <button key={referenceKey(ref)} type="button" disabled={running} onClick={() => toggleReference(ref)} title={`Remove ${ref.name}`} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs text-blue-800">@{ref.name}<X size={12} /></button>)}
              </div>}
              <div className="flex gap-2">
                <textarea ref={promptRef} value={prompt} onChange={event => { setPrompt(event.target.value); updateReferencePicker(event.currentTarget); }} onClick={event => updateReferencePicker(event.currentTarget)} onKeyDown={event => {
                  if (!referencesOpen || event.nativeEvent.isComposing) return;
                  if (event.key === 'Escape') { event.preventDefault(); setReferencesOpen(false); referenceRange.current = null; }
                  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setReferenceIndex(current => visibleReferences.length ? (current + (event.key === 'ArrowDown' ? 1 : -1) + visibleReferences.length) % visibleReferences.length : 0); }
                  else if ((event.key === 'Enter' || event.key === 'Tab') && visibleReferences[referenceIndex]) { event.preventDefault(); toggleReference(visibleReferences[referenceIndex]); }
                }} rows={3} disabled={!ready || running} placeholder="Describe your workflow… / for skills and MCP servers, @ for knowledge." aria-label="Skill Creator message" aria-expanded={referencesOpen} className="settings-control min-h-[84px] flex-1 resize-none rounded-xl px-3 py-2.5 text-sm" />
                <button type="button" onClick={() => void sendPrompt()} disabled={!prompt.trim() || running || !ready} className="settings-button-primary self-end rounded-xl p-3 disabled:opacity-50" aria-label="Send to Skill Creator">
                  {running ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                </button>
              </div>
              {running ? <button type="button" onClick={() => void stop()} className="mt-2 text-xs font-semibold text-rose-600">Stop generation</button> : null}
            </div>
          </section>

          <aside className="min-h-0 overflow-y-auto p-5">
            <h3 className="text-sm font-semibold text-slate-900">Supporting context</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">Attach examples, policies, templates, or screenshots the creator should consider.</p>
            <input ref={uploadRef} type="file" accept={allowedExtensions.join(',')} className="hidden" onChange={(event) => void uploadContext(event)} />
            <button type="button" onClick={() => uploadRef.current?.click()} disabled={uploading || running || !ready} className="settings-portal-button-secondary mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold">
              {uploading ? <Loader2 size={16} className="animate-spin" /> : <FileUp size={16} />} Add context
            </button>
            <p className="mt-2 text-xs text-slate-500">Office documents, PDFs, text, data and images · 20 MB per file</p>
            <div className="mt-4 border-t border-slate-200 pt-4">
              <label htmlFor="skill-github-url" className="text-sm font-semibold text-slate-900">Import from GitHub</label>
              <input id="skill-github-url" type="url" value={githubUrl} onChange={event => setGithubUrl(event.target.value)} disabled={uploading || running} placeholder="https://github.com/owner/repo/tree/main/skill" className="settings-control mt-2 w-full rounded-lg px-3 py-2 text-xs" />
              <button type="button" onClick={() => void importGithub()} disabled={!githubUrl.trim() || uploading || running} className="settings-portal-button-secondary mt-2 w-full rounded-lg px-3 py-2 text-xs">{uploading ? 'Importing…' : 'Import skill source'}</button>
              <p className="mt-2 text-xs text-slate-500">Public skill folders with SKILL.md · text files only · 30 files / 2 MB. Source code is read, never executed.</p>
              {importNotice && <p role="status" className="mt-2 text-xs text-emerald-700">{importNotice}</p>}
            </div>
            <div className="mt-3 space-y-2">
              {contextFiles.map((file) => (
                <div key={file.fileId} className="flex items-center gap-2 rounded-xl border border-slate-200 p-2 text-xs">
                  <input type="checkbox" disabled={running} aria-label={`Include ${file.name}`} checked={selectedContextIds.includes(file.fileId)} onChange={() => setSelectedContextIds((current) => current.includes(file.fileId) ? current.filter((id) => id !== file.fileId) : [...current, file.fileId])} />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <button type="button" disabled={running || saving} onClick={() => void removeContext(file.fileId)} className="text-rose-600" aria-label={`Remove ${file.name}`}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>

            <div className="mt-6 border-t border-slate-200 pt-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">Proposed draft</h3>
                {proposalValid ? <CheckCircle2 size={17} className="text-emerald-600" /> : null}
              </div>
              {proposalValid && <p className="mt-2 text-xs text-emerald-700">Validation passed. Save to create your personal skill; it has not been saved yet.</p>}
              {!actions.length ? <p className="mt-2 text-xs leading-5 text-slate-500">The proposed files will appear here when the creator has enough information.</p> : null}
              <div className="mt-3 space-y-2">
                {actions.map((action, index) => (
                  <div key={`${action.type}-${index}`} className="rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-700">{actionLabel(action)}</div>
                ))}
              </div>
            </div>
          </aside>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-4 sm:px-6">
          <button type="button" onClick={() => void onManual()} disabled={saving} className="settings-portal-button-secondary rounded-xl px-4 py-2.5 text-sm font-semibold">Create manually</button>
          <div className="flex gap-3">
            <button type="button" onClick={onClose} className="settings-portal-button-secondary rounded-xl px-4 py-2.5 text-sm font-semibold">Cancel</button>
            <button type="button" onClick={() => void saveProposal()} disabled={!actions.length || !proposalValid || validating || saving || running} className="settings-button-primary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} {validating ? 'Checking draft…' : 'Save personal skill'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
