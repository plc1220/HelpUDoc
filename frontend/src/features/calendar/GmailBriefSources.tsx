import { useEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Search } from 'lucide-react';
import { calendarApi } from './calendarApi';

type ThreadSummary = { id: string; title: string; from?: string; date?: string };

/** Searches metadata only. Message text is requested by the parent on Prepare. */
export default function GmailBriefSources({ onSelectionChange }: { onSelectionChange: (ids: string[]) => void }) {
  const [enabled, setEnabled] = useState(false), [query, setQuery] = useState('');
  const [threads, setThreads] = useState<ThreadSummary[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    const invalidate = () => { generation.current++; };
    return invalidate;
  }, []);
  const choose = (ids: string[]) => { setSelected(ids); onSelectionChange(ids); };
  const toggle = (value: boolean) => {
    generation.current++; setEnabled(value); setBusy(false); setError('');
    if (!value) { setThreads([]); setQuery(''); choose([]); }
  };
  const search = async () => {
    const request = ++generation.current;
    setBusy(true); setError(''); setThreads([]); choose([]);
    try {
      const result = await calendarApi<ThreadSummary[]>(`/calendar/context/gmail/search?q=${encodeURIComponent(query.trim())}`);
      if (request === generation.current) setThreads(result.slice(0, 5));
    } catch (e) { if (request === generation.current) setError(e instanceof Error ? e.message : 'Email search is unavailable. You can prepare without Gmail.'); }
    finally { if (request === generation.current) setBusy(false); }
  };
  return <section className="calendar-related" aria-label="Email context">
    <CheckboxInput label="Choose Gmail context" description="Optional. Search email metadata, then choose which threads this briefing may read." value={enabled} onChange={toggle} />
    {enabled && <>
      <form className="calendar-search" onSubmit={event => { event.preventDefault(); if (!busy && query.trim()) void search(); }}>
        <TextInput label="Find email threads" isLabelHidden placeholder="Project, sender, or subject…" startIcon={<Search size={14} />} value={query} onChange={setQuery} width="100%" />
        <Button label={busy ? 'Searching…' : 'Search email'} variant="secondary" size="sm" type="submit" isDisabled={busy || !query.trim()} />
      </form>
      {threads.map(thread => <CheckboxInput key={thread.id} label={thread.title || 'Untitled email thread'} description={[thread.from, thread.date].filter(Boolean).join(' · ')} value={selected.includes(thread.id)} onChange={checked => choose(checked ? [...selected, thread.id] : selected.filter(id => id !== thread.id))} />)}
      <p className="calendar-muted">{selected.length ? `${selected.length} ${selected.length === 1 ? 'thread' : 'threads'} selected. Only these threads will be read when you choose Prepare briefing.` : 'No email threads selected. You can prepare this briefing without Gmail.'}</p>
      {error && <p className="calendar-notice" role="alert">{error}</p>}
    </>}
  </section>;
}
