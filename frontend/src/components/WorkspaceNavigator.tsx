import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Trash2, Search } from 'lucide-react';
import './WorkspaceNavigator.css';
import WorkspaceList from './WorkspaceList';
import { permanentlyDeleteWorkspace, restoreWorkspace } from '../services/workspaceApi';
import type { Workspace } from '../types';

type Props = ComponentProps<typeof WorkspaceList> & {
  storageKey: string;
  search: string;
  onRefresh: () => Promise<unknown>;
};
const readIds = (key: string): string[] => {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []; } catch { return []; }
};
const saveIds = (key: string, ids: string[]) => { try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* preferences are best effort */ } };

export default function WorkspaceNavigator({ storageKey, search, onRefresh, ...props }: Props) {
  const { workspaces, selectedWorkspace, onSelectWorkspace } = props;
  const [pinned, setPinned] = useState(() => readIds(`${storageKey}.pinned`));
  const [recent, setRecent] = useState(() => readIds(`${storageKey}.recent`));
  const [view, setView] = useState('recent');
  const [filter, setFilter] = useState('all');
  const [switcher, setSwitcher] = useState(false);
  const [switchSearch, setSwitchSearch] = useState('');
  const [trashOpen, setTrashOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmIds, setConfirmIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setSwitchSearch(''); setSwitcher((value) => !value);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const selectedId = selectedWorkspace?.status !== 'trashed' ? selectedWorkspace?.id : undefined;
  useEffect(() => {
    if (!selectedId) return;
    setRecent((ids) => {
      const next = [selectedId, ...ids.filter((id) => id !== selectedId)].slice(0, 30);
      saveIds(`${storageKey}.recent`, next); return next;
    });
  }, [selectedId, storageKey]);
  const active = workspaces.filter((workspace) => workspace.status !== 'trashed');
  const trash = workspaces.filter((workspace) => workspace.status === 'trashed' && workspace.role === 'owner');
  const ordered = [...active].sort((a, b) => {
    const rank = (id: string) => recent.includes(id) ? recent.indexOf(id) : 1000;
    return rank(a.id) - rank(b.id);
  });
  const matching = ordered.filter((workspace) => workspace.name.toLowerCase().includes(search.toLowerCase())
    && (filter === 'all' || (filter === 'shared' ? workspace.visibility === 'team' && workspace.status !== 'unshared' : workspace.visibility !== 'team' || workspace.status === 'unshared')));
  const togglePin = (workspace: Workspace) => setPinned((ids) => {
    const next = ids.includes(workspace.id) ? ids.filter((id) => id !== workspace.id) : [...ids, workspace.id];
    saveIds(`${storageKey}.pinned`, next); return next;
  });
  const renderList = (items: Workspace[]) => <WorkspaceList {...props} workspaces={items} pinnedIds={pinned} onTogglePin={togglePin} flat />;
  const run = async (ids: string[], remove: boolean) => {
    setBusy(true); setError('');
    const failures: string[] = [];
    for (const id of ids) {
      try { await (remove ? permanentlyDeleteWorkspace(id) : restoreWorkspace(id)); }
      catch (cause) { failures.push(`${workspaces.find((w) => w.id === id)?.name || id}: ${cause instanceof Error ? cause.message : 'Request failed'}`); }
    }
    try { await onRefresh(); } catch { failures.push('Could not refresh workspaces. Please reopen Trash.'); }
    setSelected([]); setConfirmIds([]); setBusy(false); setError(failures.join('\n'));
  };
  const commandMatches = ordered.filter((workspace) => workspace.name.toLowerCase().includes(switchSearch.toLowerCase()));
  return <div className="workspace-navigator">
    <SegmentedControl value={view} onChange={setView} label="Workspace view" layout="fill" size="sm">
      <SegmentedControlItem value="recent" label="Recent" /><SegmentedControlItem value="all" label="All workspaces" />
    </SegmentedControl>
    {(view === 'all' || search) && <SegmentedControl value={filter} onChange={setFilter} label="Workspace visibility" layout="fill" size="sm">
      <SegmentedControlItem value="all" label="All" /><SegmentedControlItem value="private" label="Private" /><SegmentedControlItem value="shared" label="Shared" />
    </SegmentedControl>}
    {view === 'recent' && !search ? <>
      {pinned.some((id) => active.some((w) => w.id === id)) && <><h3 className="workspace-section-label">Pinned</h3>{renderList(ordered.filter((w) => pinned.includes(w.id)))}</>}
      <h3 className="workspace-section-label">Recent</h3>{renderList(ordered.filter((w) => !pinned.includes(w.id)).slice(0, 8))}
    </> : renderList(matching)}
    {!active.length && <p className="workspace-empty">Create a workspace to get started.</p>}
    {(view === 'all' || search) && !matching.length && <p className="workspace-empty">No matching workspaces.</p>}
    <div className="workspace-trash-link"><Button label={`Trash (${trash.length})`} icon={<Trash2 size={16} />} variant="ghost" size="sm" onClick={() => { setTrashOpen(true); setError(''); }} /></div>
    {createPortal(<>
      <Dialog isOpen={switcher} onOpenChange={setSwitcher} width="min(480px, calc(100vw - 32px))" aria-label="Switch workspace">
        <DialogHeader title="Switch workspace" onOpenChange={setSwitcher} />
        <div className="workspace-dialog-content">
          <TextInput label="Search workspaces" isLabelHidden placeholder="Search workspaces" startIcon={<Search size={16} />} value={switchSearch} onChange={setSwitchSearch} hasAutoFocus onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); document.querySelector<HTMLButtonElement>('.workspace-command-result')?.focus(); }
            if (event.key === 'Enter' && commandMatches[0]) { onSelectWorkspace(commandMatches[0]); setSwitcher(false); }
          }} />
          <div className="workspace-command-list">{commandMatches.map((workspace) => <button className="workspace-command-result" type="button" key={workspace.id} onClick={() => { onSelectWorkspace(workspace); setSwitcher(false); }}>
            <span>{workspace.name}</span><small>{pinned.includes(workspace.id) ? 'Pinned · ' : ''}{workspace.visibility === 'team' && workspace.status !== 'unshared' ? 'Shared' : 'Private'}</small>
          </button>)}</div>
          {!commandMatches.length && <p className="workspace-empty">No matching workspaces.</p>}
        </div>
        <div className="workspace-dialog-actions"><Button label="Close" variant="ghost" onClick={() => setSwitcher(false)} /></div>
      </Dialog>
      <Dialog isOpen={trashOpen} onOpenChange={(open) => { if (!busy) { setTrashOpen(open); setSelected([]); } }} width="min(640px, calc(100vw - 32px))" aria-label="Workspace trash">
        <DialogHeader title={`Trash (${trash.length})`} />
        <div className="workspace-dialog-content">
          <p className="workspace-empty">Workspaces are kept for 30 days. Restored shared workspaces are private until you re-share them.</p>
          {error && <p className="workspace-error" role="alert">{error}</p>}
          {!!trash.length && <div className="workspace-trash-actions">
            <CheckboxInput label="Select all trashed workspaces" isLabelHidden value={trash.every((w) => selected.includes(w.id)) ? true : selected.length ? 'indeterminate' : false} isDisabled={busy} onChange={(checked) => setSelected(checked ? trash.map((w) => w.id) : [])} />
            <Button label="Restore selected" variant="ghost" size="sm" isDisabled={!selected.length || busy} onClick={() => void run(selected, false)} />
            <Button label="Delete selected" variant="ghost" size="sm" isDisabled={!selected.length || busy} onClick={() => setConfirmIds(selected)} />
          </div>}
          {trash.map((workspace) => <div className="workspace-trash-row" key={workspace.id}>
            <CheckboxInput label={`Select ${workspace.name}`} isLabelHidden value={selected.includes(workspace.id)} isDisabled={busy} onChange={(checked) => setSelected((ids) => checked ? [...ids, workspace.id] : ids.filter((id) => id !== workspace.id))} />
            <div className="workspace-trash-copy"><strong>{workspace.name}</strong><small>Deleted {workspace.trashedAt ? new Date(workspace.trashedAt).toLocaleDateString() : 'recently'}{workspace.purgeAfter ? ` · ${Math.max(0, Math.ceil((new Date(workspace.purgeAfter).getTime() - Date.now()) / 86400000))} days remaining` : ''}</small></div>
            <Button label="Restore" variant="ghost" size="sm" isDisabled={busy} onClick={() => void run([workspace.id], false)} />
            <Button label="Delete permanently" variant="ghost" size="sm" isDisabled={busy} onClick={() => setConfirmIds([workspace.id])} />
          </div>)}
          {!trash.length && <p className="workspace-empty">Trash is empty.</p>}
        </div>
        <div className="workspace-dialog-actions"><Button label="Empty trash" variant="ghost" isDisabled={!trash.length || busy} onClick={() => setConfirmIds(trash.map((w) => w.id))} /><Button label="Close" variant="secondary" isDisabled={busy} onClick={() => setTrashOpen(false)} /></div>
      </Dialog>
      <Dialog isOpen={confirmIds.length > 0} onOpenChange={(open) => { if (!open && !busy) setConfirmIds([]); }} purpose="form" width="min(480px, calc(100vw - 32px))" aria-label="Confirm permanent deletion">
        <DialogHeader title={`Permanently delete ${confirmIds.length} workspace${confirmIds.length === 1 ? '' : 's'}?`} />
        <div className="workspace-dialog-content"><p>This removes their files, conversations, and version history. This cannot be undone.</p>
          <ul>{confirmIds.map((id) => <li key={id}>{workspaces.find((w) => w.id === id)?.name || id}</li>)}</ul>
        </div>
        <div className="workspace-dialog-actions"><Button label="Cancel" variant="ghost" isDisabled={busy} onClick={() => setConfirmIds([])} /><Button label={busy ? 'Deleting…' : 'Delete permanently'} variant="destructive" isDisabled={busy} onClick={() => void run(confirmIds, true)} /></div>
      </Dialog>
    </>, document.body)}
  </div>;
}
