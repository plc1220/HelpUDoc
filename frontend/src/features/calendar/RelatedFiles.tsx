import { useEffect, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Selector } from '@astryxdesign/core/Selector';
import { chooseDriveFile } from './googlePicker';
import { TextInput } from '@astryxdesign/core/TextInput';
import { ExternalLink, Link2, Search, Unlink, X } from 'lucide-react';
import { calendarApi, googleConnectUrl, type FileLink } from './calendarApi';

export default function RelatedFiles({ subjectRef, driveEnabled, accounts = [], workspaceId, onPickerOpenChange, onPickerError }: { subjectRef: string; driveEnabled: boolean; accounts?: Array<{ id: string; principal: string; drive_enabled: boolean }>; workspaceId?: string; onPickerOpenChange?: (open: boolean) => void; onPickerError?: (message: string) => void }) {
  const [links, setLinks] = useState<FileLink[]>([]), [results, setResults] = useState<FileLink[]>([]);
  const [suggestions, setSuggestions] = useState<FileLink[]>([]), [dismissed, setDismissed] = useState<string[]>([]);
  const [supportsSeries, setSupportsSeries] = useState(false), [linkScope, setLinkScope] = useState<'single' | 'series'>('single');
  const [source, setSource] = useState('drive');
  const [accountId, setAccountId] = useState('');
  const [query, setQuery] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const refresh = async () => {
    const data = await calendarApi<{ confirmed: FileLink[]; suggested?: FileLink[]; supports_series?: boolean }>(`/context/links?subject_ref=${encodeURIComponent(subjectRef)}`);
    setLinks(data.confirmed); setSuggestions(data.suggested || []); setSupportsSeries(Boolean(data.supports_series));
  };
  useEffect(() => { let active = true; setLinks([]); setResults([]); setSuggestions([]); setDismissed([]); setLinkScope('single'); setSupportsSeries(false); setError('');
    calendarApi<{ confirmed: FileLink[]; suggested?: FileLink[]; supports_series?: boolean }>(`/context/links?subject_ref=${encodeURIComponent(subjectRef)}`).then(data => { if (active) { setLinks(data.confirmed); setSuggestions(data.suggested || []); setSupportsSeries(Boolean(data.supports_series)); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [subjectRef]);
  const action = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to update links'); } finally { setBusy(false); } };
  const candidates = [...new Map([...suggestions, ...results].map(file => [file.file_ref, file])).values()].filter(file => !dismissed.includes(file.file_ref) && !links.some(link => link.file_ref === file.file_ref));
  return <section className="calendar-related" aria-label="Related files">
    <h3><Link2 size={15} /> Related files</h3>
    <p className="calendar-muted">Personal links · original files stay in Drive.</p>
    {links.map(file => <div className="calendar-file" key={file.link_id}>
      <div>{file.url ? <a href={file.url} target="_blank" rel="noopener noreferrer">{file.title} <ExternalLink size={12} /></a> : <span>{file.title}</span>}<small>{file.provenance === 'OUTPUT' ? 'Generated output' : file.scope === 'series' ? 'Linked to entire meeting series' : 'Linked by you'}{file.inherited ? ' · reused for this occurrence' : ''}</small>{file.changed && <small>{file.provenance === 'OUTPUT' ? 'Changed since generated' : 'Changed since linked'} · review the latest version</small>}</div>
      <IconButton label={`Unlink ${file.title}${file.scope === 'series' ? ' from entire series' : ''}`} icon={<Unlink size={14} />} variant="ghost" isDisabled={busy} onClick={() => void action(() => calendarApi(`/context/links/${file.link_id}`, 'DELETE'))} />
    </div>)}
    {!links.length && <p className="calendar-muted">No confirmed files.</p>}
    {supportsSeries && <Selector label="Link files to" size="sm" value={linkScope} options={[{ value: 'single', label: 'This occurrence only' }, { value: 'series', label: 'Entire meeting series' }]} onChange={value => setLinkScope(value as 'single' | 'series')} />}
    {workspaceId && <Selector label="File source" size="sm" value={source} options={[{ value: 'drive', label: 'Google Drive' }, { value: 'workspace', label: 'This workspace' }]} onChange={value => { setSource(value); setResults([]); }} />}
    {driveEnabled && accounts.some(a => a.drive_enabled) && <><Selector label="Drive account" size="sm" value={accountId || accounts.find(a => a.drive_enabled)?.id} options={accounts.filter(a => a.drive_enabled).map(a => ({ value: a.id, label: a.principal }))} onChange={setAccountId} /><Button label="Choose from Google Drive" variant="secondary" size="sm" isDisabled={busy} onClick={() => void action(async () => { try { const file_ref = await chooseDriveFile(accountId || accounts.find(a => a.drive_enabled)!.id, () => onPickerOpenChange?.(true)); if (file_ref) await calendarApi('/context/links', 'POST', { subject_ref: subjectRef, file_ref, scope: linkScope }, { 'Idempotency-Key': crypto.randomUUID() }); } catch (error) { onPickerError?.(error instanceof Error ? error.message : 'Unable to link the chosen file'); throw error; } finally { onPickerOpenChange?.(false); } })} /></>}
    {(driveEnabled || source === 'workspace') ? <form className="calendar-search" onSubmit={e => { e.preventDefault(); void action(async () => { const found = await calendarApi<FileLink[]>(source === 'workspace' ? `/context/workspace-files?workspace_id=${workspaceId}&q=${encodeURIComponent(query)}` : `/drive/files/search?q=${encodeURIComponent(query)}`); setResults(found); }); }}>
      <TextInput label={source === 'workspace' ? 'Find a workspace file' : 'Find a Drive file'} isLabelHidden placeholder={source === 'workspace' ? 'Find a workspace file…' : 'Find a Drive file…'} startIcon={<Search size={14} />} value={query} onChange={setQuery} width="100%" />
      <Button label="Find" variant="secondary" size="sm" type="submit" isDisabled={busy || !query.trim()} />
    </form> : <Button label="Enable Drive file linking" size="sm" variant="secondary" onClick={() => { window.location.href = googleConnectUrl(true); }} />}
    {candidates.length > 0 && <p className="calendar-muted">Suggestions · review before linking</p>}
    {candidates.map(file => <div className="calendar-file" key={file.file_ref}><div>{file.url ? <a href={file.url} target="_blank" rel="noopener noreferrer">{file.title} <ExternalLink size={12} /></a> : <span>{file.title}</span>}<small>{file.provenance === 'EXPLICIT_SOURCE' ? 'Referenced in meeting' : 'Suggested by Lumo'}{file.reason ? ` · ${file.reason}` : ''}</small></div><Button label="Link" variant="secondary" size="sm" isDisabled={busy} onClick={() => void action(() => calendarApi('/context/links', 'POST', { subject_ref: subjectRef, file_ref: file.file_ref, scope: linkScope }, { 'Idempotency-Key': crypto.randomUUID() }))} /><IconButton label={`Dismiss suggestion ${file.title}`} icon={<X size={13} />} variant="ghost" isDisabled={busy} onClick={() => setDismissed(current => [...current, file.file_ref])} /></div>)}
    {error && <p role="alert" className="calendar-notice">{error}</p>}
  </section>;
}
