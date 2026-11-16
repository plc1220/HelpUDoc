import { useCallback, useEffect, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Selector } from '@astryxdesign/core/Selector';
import { MessageSquare } from 'lucide-react';
import { getFiles } from '../../services/fileApi';
import { listWorkspaceTeamThreads } from '../../services/workspaceCollaborationApi';
import type { File, TeamThreadSummary } from '../../types';
import { calendarApi } from './calendarApi';

type Rule = {
  id: string; event_ref: string; workspace_id: string; file_path: string;
  thread_id: string; lead_minutes: number; enabled: boolean;
};
type Audit = { id: string; outcome: string; created_at: string };

const outcomeLabel = (outcome: string) => ({
  POSTED: 'Posted pending review items', posted: 'Posted pending review items',
  NO_PENDING_ITEMS: 'No pending review items', no_pending_items: 'No pending review items', no_pending: 'No pending review items',
  CANCELLED: 'Meeting cancelled', cancelled: 'Meeting cancelled',
  REVOKED: 'Access revoked', revoked: 'Access revoked',
  MISSED: 'Review has already started', missed: 'Review has already started', expired: 'Review has already started', blocked: 'Delivery blocked by access or review destination',
}[outcome] || outcome.toLowerCase().replaceAll('_', ' '));

/** A rule is created only after the user chooses and explicitly approves its destination. */
export default function CalendarReviewFollowUps({ eventRef, workspaceId, disabled = false, timedOccurrence = true }: {
  eventRef: string; workspaceId?: string; disabled?: boolean; timedOccurrence?: boolean;
}) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [threads, setThreads] = useState<TeamThreadSummary[]>([]);
  const [filePath, setFilePath] = useState(''), [threadId, setThreadId] = useState('');
  const [leadMinutes, setLeadMinutes] = useState('60'), [consent, setConsent] = useState(false);
  const [configuring, setConfiguring] = useState(false), [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [audits, setAudits] = useState<Record<string, Audit[]>>({});
  const refresh = useCallback(async () => {
    const found = await calendarApi<Rule[]>(`/calendar/review-follow-ups?event_ref=${encodeURIComponent(eventRef)}`);
    setRules(found.filter(rule => rule.workspace_id === workspaceId));
  }, [eventRef, workspaceId]);

  useEffect(() => {
    let active = true;
    setLoading(true); setRules([]); setAudits({}); setError('');
    setConfiguring(false); setConsent(false); setFilePath(''); setThreadId('');
    void calendarApi<Rule[]>(`/calendar/review-follow-ups?event_ref=${encodeURIComponent(eventRef)}`)
      .then(found => { if (active) setRules(found.filter(rule => rule.workspace_id === workspaceId)); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Unable to load review follow-ups'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [eventRef, workspaceId]);

  useEffect(() => {
    if (!configuring || !workspaceId) return;
    let active = true;
    setBusy(true); setError(''); setFiles([]); setThreads([]);
    void Promise.all([getFiles(workspaceId) as Promise<File[]>, listWorkspaceTeamThreads(workspaceId, { status: 'open', limit: 100 })])
      .then(([availableFiles, result]) => {
        if (active) { setFiles(availableFiles); setThreads(result.threads); }
      })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Unable to load workspace review destinations'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [configuring, workspaceId]);

  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to update review follow-up'); }
    finally { setBusy(false); }
  };
  return <section className="calendar-related" aria-label="Review follow-ups" aria-busy={loading || busy}>
    <h3><MessageSquare size={15} /> Review follow-up</h3>
    <p className="calendar-muted">Post pending shared review items to one Team Chat thread before this meeting occurrence. Calendar access is read-only for this rule.</p>
    {!workspaceId && <p className="calendar-muted">Open a shared workspace to choose its artifact and Team Chat thread.</p>}
    {!timedOccurrence && <p className="calendar-muted">Choose a timed meeting occurrence to enable a follow-up. All-day events and entire recurring series are unavailable.</p>}
    {loading && <p className="calendar-muted" role="status">Loading follow-ups…</p>}
    {rules.map(rule => <div className="calendar-schedule-card" key={rule.id}>
      <strong>{rule.file_path}</strong>
      <p className="calendar-muted">{rule.enabled ? 'Enabled' : 'Disabled'} · {rule.lead_minutes} minutes before this occurrence</p>
      <p className="calendar-muted">Team Chat thread: {threads.find(thread => thread.id === rule.thread_id)?.title || rule.thread_id}</p>
      <div className="calendar-actions">
        {rule.enabled && <Button label="Disable follow-up" variant="secondary" size="sm" isDisabled={busy} onClick={() => void action(async () => {
          await calendarApi(`/calendar/review-follow-ups/${encodeURIComponent(rule.id)}`, 'DELETE'); await refresh();
        })} />}
        <Button label="Show delivery history" variant="ghost" size="sm" isDisabled={busy} onClick={() => void action(async () => {
          const history = await calendarApi<Audit[]>(`/calendar/review-follow-ups/${encodeURIComponent(rule.id)}/audit`);
          setAudits(current => ({ ...current, [rule.id]: history }));
        })} />
      </div>
      {audits[rule.id]?.length === 0 && <p className="calendar-muted" role="status">No delivery outcomes yet.</p>}
      {audits[rule.id]?.map(audit => <p className="calendar-muted" key={audit.id}>{outcomeLabel(audit.outcome)} · {new Date(audit.created_at).toLocaleString()}</p>)}
    </div>)}
    {workspaceId && !configuring && <Button label="Set up a review follow-up" variant="secondary" size="sm" isDisabled={disabled || busy || loading || !timedOccurrence} onClick={() => { setConsent(false); setConfiguring(true); }} />}
    {configuring && <form className="calendar-related" onSubmit={e => {
      e.preventDefault();
      if (!consent || !workspaceId || !filePath || !threadId || busy) return;
      void action(async () => {
        await calendarApi('/calendar/review-follow-ups', 'POST', { event_ref: eventRef, workspace_id: workspaceId, file_path: filePath, thread_id: threadId, lead_minutes: Number(leadMinutes) });
        setConfiguring(false); setConsent(false); await refresh();
      });
    }}>
      <Selector label="Shared artifact" value={filePath} options={files.map(file => ({ value: file.name, label: file.name }))} hasSearch isDisabled={busy} onChange={value => { setFilePath(value); setConsent(false); }} />
      <Selector label="Destination Team Chat thread" value={threadId} options={threads.map(thread => ({ value: thread.id, label: thread.title || thread.rootPreview || 'Untitled thread' }))} hasSearch isDisabled={busy} onChange={value => { setThreadId(value); setConsent(false); }} />
      <Selector label="When to check" value={leadMinutes} options={[{ value: '15', label: '15 minutes before' }, { value: '30', label: '30 minutes before' }, { value: '60', label: '1 hour before' }, { value: '1440', label: '1 day before' }]} isDisabled={busy} onChange={value => { setLeadMinutes(value); setConsent(false); }} />
      {!busy && (!files.length || !threads.length) && <p className="calendar-muted">This shared workspace needs an artifact and an open Team Chat thread.</p>}
      <CheckboxInput label="Enable this follow-up" description="Allow Lumo to check shared review state and post pending items to the selected thread. Private drafts and comments stay private." value={consent} isDisabled={busy} onChange={setConsent} />
      <p className="calendar-muted">Posts at most once for this rule and occurrence. Moved meetings use their latest time; cancelled meetings and revoked access block delivery.</p>
      <div className="calendar-actions"><Button label="Cancel" variant="ghost" size="sm" isDisabled={busy} onClick={() => setConfiguring(false)} /><Button label={busy ? 'Saving…' : 'Enable follow-up'} type="submit" size="sm" isDisabled={busy || disabled || !consent || !filePath || !threadId} /></div>
    </form>}
    {error && <p className="calendar-notice" role="alert">{error}</p>}
  </section>;
}
