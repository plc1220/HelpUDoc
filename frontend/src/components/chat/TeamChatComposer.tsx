import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, Bot, FileText, MessageSquare, Plus, Send, Sparkles, Users, X } from 'lucide-react';
import type { TeamChatReference } from '../../types';
import { composerQuery, insertReference, reconcileTokens, type ComposerToken } from './teamComposer';

export type { ComposerToken } from './teamComposer';

type Category = 'people' | 'files' | 'skills';
const categoryOf = (ref: TeamChatReference) => ref.kind === 'file' ? 'files' : ref.kind === 'skill' ? 'skills' : 'people';
const Icon = ({ kind }: { kind: TeamChatReference['kind'] }) => kind === 'file' ? <FileText size={14} /> : kind === 'skill' ? <Sparkles size={14} /> : kind === 'agent' ? <Bot size={14} /> : kind === 'annotation' ? <MessageSquare size={14} /> : <Users size={14} />;
export default function TeamChatComposer({ options, disabled, sending, reply, onSend, value, onDraftChange, draftKey, placeholder, sendLabel, autoFocusKey }: {
  options: Array<TeamChatReference & { description?: string }>;
  disabled: boolean; sending: boolean; reply: boolean;
  onSend: (body: string, references: TeamChatReference[]) => Promise<void>;
  /**
   * Optional controlled draft (spec F2). Carries the EXACT composer tokens
   * (position + reference identity/version), never reconstructed by textual
   * matching — so a reference cannot be reassigned to plain text with the same
   * label, and identical labels for different files/versions stay distinct.
   */
  value?: { text: string; tokens: ComposerToken[] };
  onDraftChange?: (draft: { text: string; tokens: ComposerToken[] }) => void;
  /**
   * Identity of the draft's destination (e.g. thread id). Changing it is the
   * ONLY trigger for an external restore, so a slow send completing for one
   * destination can never overwrite a draft the user started for another.
   */
  draftKey?: string;
  placeholder?: string;
  sendLabel?: string;
  /** Change this key to request focus (e.g. after a successful send). */
  autoFocusKey?: string | number;
}) {
  const [text, setText] = useState(value?.text ?? '');
  const [tokens, setTokens] = useState<ComposerToken[]>(() => value?.tokens ?? []);
  const [caret, setCaret] = useState(0);
  const [menu, setMenu] = useState(false);
  const [category, setCategory] = useState<Category | null>(null);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  // --- Controlled draft synchronization (spec F2) ------------------------
  // Restore ONLY when the destination (draftKey) changes. A restore reads the
  // latest `value` for that destination directly, so no text/token comparison
  // is needed and a stale async completion cannot clobber the current draft.
  const controlled = value !== undefined;
  const restoredKey = useRef<string | undefined>(draftKey);
  const valueRef = useRef(value);
  valueRef.current = value;
  // Live refs updated EVERY render so async completions read the CURRENT
  // destination/text, never the stale closure values captured when send()
  // was invoked (review: stale composer clear). A mounted ref prevents any
  // post-unmount clear.
  const liveText = useRef(text);
  liveText.current = text;
  const liveKey = useRef(draftKey);
  liveKey.current = draftKey;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!controlled) return;
    if (restoredKey.current === draftKey) return;
    restoredKey.current = draftKey;
    const incoming = valueRef.current;
    setText(incoming?.text ?? '');
    setTokens(incoming?.tokens ?? []);
    setCaret((incoming?.text ?? '').length);
    setCategory(null); setMenu(false); setSearch(''); setDismissed('');
  }, [controlled, draftKey]);
  const emitDraft = (nextText: string, nextTokens: ComposerToken[]) => {
    onDraftChange?.({ text: nextText, tokens: nextTokens });
  };
  useEffect(() => {
    if (autoFocusKey === undefined) return;
    const handle = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(handle);
  }, [autoFocusKey]);
  const rawQuery = composerQuery(text, caret);
  const query = rawQuery && tokens.some((token) => token.start === rawQuery.start && caret >= token.end) ? null : rawQuery;
  const queryKey = query ? `${query.start}:${query.trigger}:${query.query}` : '';
  const open = Boolean(category || (query && dismissed !== queryKey));
  const results = useMemo(() => options.filter((item) => {
    const group = categoryOf(item);
    if (category && group !== category) return false;
    if (!category && query?.trigger === '/' && group !== 'skills') return false;
    if (!category && query?.trigger === '@' && group === 'skills') return false;
    const needle = category ? search : query?.query || '';
    return `${item.label} ${item.description || ''}`.toLowerCase().includes(needle.toLowerCase());
  }).slice(0, 30), [options, category, query?.trigger, query?.query, search]);
  const close = () => { setCategory(null); setMenu(false); setSearch(''); setDismissed(queryKey); setActive(0); };
  const select = (reference: TeamChatReference) => {
    const start = category ? caret : query?.start ?? caret;
    const end = category ? caret : query?.end ?? caret;
    let next = insertReference(text, tokens, start, end, reference);
    if (reference.kind === 'skill' && !next.tokens.some((token) => token.reference.kind === 'agent')) {
      const prefix = insertReference(next.text, next.tokens, 0, 0, { kind: 'agent', id: 'lumo', label: 'Lumo' });
      next = { ...prefix, caret: next.caret + prefix.text.length - next.text.length };
    }
    // One explicit skill per request.
    if (reference.kind === 'skill') {
      const previousSkills = next.tokens.filter((token) => token.reference.kind === 'skill').sort((a, b) => b.start - a.start);
      // Keep the newly inserted skill, removing older skill selections and text.
      const newest = next.tokens.filter((token) => token.reference.kind === 'skill').at(-1);
      for (const token of previousSkills.filter((token) => token !== newest)) {
        const changed = next.text.slice(0, token.start) + next.text.slice(token.end);
        next = { text: changed, tokens: reconcileTokens(next.text, changed, next.tokens), caret: next.caret > token.end ? next.caret - (token.end - token.start) : next.caret };
      }
    }
    setText(next.text); setTokens(next.tokens); setCaret(next.caret); close();
    emitDraft(next.text, next.tokens);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); });
  };
  const send = async () => {
    if (disabled || sending || !text.trim()) return;
    const sentText = text;
    const sentTokens = tokens;
    const sentKey = draftKey;
    try {
      await onSend(sentText, sentTokens.map((token) => token.reference));
      // Read LIVE refs (current render), not the values captured at call time.
      // Only clear if still mounted, still bound to the same destination, and
      // the text hasn't changed — so a slow send for A completing after the
      // user switched to B (or edited) can never wipe B (review: stale clear).
      if (mountedRef.current && liveKey.current === sentKey && liveText.current === sentText) {
        setText(''); setTokens([]); setCaret(0); close();
        emitDraft('', []);
      }
    } catch { /* parent presents error; retain draft (destination preserved by parent) */ }
  };
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (open && event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (open && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); setActive((value) => (value + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(results.length, 1)) % Math.max(results.length, 1)); return;
    }
    if (open && results.length && ['Enter', 'Tab'].includes(event.key) && !event.shiftKey) {
      event.preventDefault(); select(results[Math.min(active, results.length - 1)]); return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !category) { event.preventDefault(); void send(); }
  };
  return <div className="relative space-y-2">
    {open && <div className="absolute bottom-full left-0 z-40 mb-2 max-h-72 w-full overflow-y-auto rounded-xl border border-slate-500/40 bg-[var(--surface,#172033)] p-2 shadow-xl">
      {category && <input autoFocus aria-label={`Search ${category}`} placeholder={`Search ${category}`} value={search} onChange={(e) => { setSearch(e.target.value); setActive(0); }} onKeyDown={keyDown} className="mb-2 w-full rounded border border-slate-500 bg-transparent p-2" />}
      <div id="team-reference-options" role="listbox" aria-label="People, files and skills">
        {!results.length && <p className="p-2 text-sm">No matching {category || 'references'}.</p>}
        {results.map((item, index) => <Fragment key={`${item.kind}:${item.id}`}>
          {(index === 0 || results[index - 1].kind !== item.kind) && <div role="presentation" className="px-2 pt-2 text-[10px] font-semibold uppercase opacity-60">{item.kind === 'agent' ? 'Agent' : categoryOf(item)}</div>}
          <button id={`team-reference-${index}`} key={`${item.kind}:${item.id}`} role="option" aria-selected={index === Math.min(active, results.length - 1)} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => select(item)} className={`flex w-full items-start gap-2 rounded p-2 text-left text-sm ${index === active ? 'bg-blue-500/20' : 'hover:bg-slate-500/15'}`}>
          <Icon kind={item.kind} /><span className="min-w-0 break-words"><strong>{item.label}</strong><span className="block text-xs opacity-70">{item.description || (item.kind === 'file' ? item.publishedVersionId ? 'Locked snapshot' : `Working · v${item.version || 1}` : item.kind === 'agent' ? 'Ask Lumo to work' : categoryOf(item))}</span></span>
        </button></Fragment>)}
      </div>
    </div>}
    <textarea ref={input} aria-label="Workspace Chat message" aria-controls={open ? 'team-reference-options' : undefined} aria-activedescendant={open && results.length ? `team-reference-${Math.min(active, results.length - 1)}` : undefined}
      value={text} rows={3} disabled={disabled || sending} placeholder={disabled ? 'Viewer access is read-only' : placeholder || 'Message the team… @people or files, /skills'}
      onSelect={(e) => setCaret(e.currentTarget.selectionStart)} onChange={(e) => { const nextTokens = reconcileTokens(text, e.target.value, tokens); setTokens(nextTokens); setText(e.target.value); setCaret(e.target.selectionStart); setActive(0); setDismissed(''); emitDraft(e.target.value, nextTokens); }} onKeyDown={keyDown}
      className="w-full resize-y rounded-xl border border-slate-500/50 bg-transparent p-3 text-sm outline-none focus:border-blue-400" />
    {!!tokens.length && <div className="flex flex-wrap gap-1" aria-label="Selected references">{tokens.map((token, index) => <span key={`${token.start}:${index}`} className="inline-flex max-w-full items-center gap-1 rounded-full bg-blue-500/15 px-2 py-1 text-xs">
      <Icon kind={token.reference.kind} /><span className="truncate">{token.reference.label}{token.reference.kind === 'file' ? token.reference.publishedVersionId ? ' · Locked' : ` · Working v${token.reference.version || 1}` : ''}</span><button aria-label={`Remove ${token.reference.label}`} onClick={() => { const next = text.slice(0, token.start) + text.slice(token.end); const nextTokens = reconcileTokens(text, next, tokens); setTokens(nextTokens); setText(next); emitDraft(next, nextTokens); }}><X size={12} /></button>
    </span>)}</div>}
    <div className="flex items-center gap-2">
      <button type="button" aria-label="Add people, files or skills" aria-expanded={menu} disabled={disabled || sending} onClick={() => setMenu(!menu)} className="rounded-lg border border-slate-500/40 p-2"><Plus size={16} /></button>
      {menu && <div className="absolute bottom-14 left-0 z-40 flex w-full gap-2 rounded-xl border border-slate-500/40 bg-[var(--surface,#172033)] p-2 shadow-xl" aria-label="Add reference">{(['people', 'files', 'skills'] as const).map((group) => <button type="button" key={group} className="rounded px-2 py-1 text-xs hover:bg-blue-500/20" onClick={() => { setCategory(group); setMenu(false); setSearch(''); setActive(0); }}>{group[0].toUpperCase() + group.slice(1)}</button>)}</div>}
      <span className="min-w-0 flex-1 text-[10px] opacity-65"><AtSign size={12} className="inline" /> mentions · / skills<br />Shift+Enter for a new line</span>
      <button type="button" data-testid="composer-send" disabled={disabled || sending || !text.trim()} onClick={() => void send()} className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-xs text-white disabled:opacity-40"><Send size={14} />{sending ? 'Sending…' : sendLabel || (reply ? 'Reply' : 'Send')}</button>
    </div>
  </div>;
}
