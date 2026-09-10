import { useState } from 'react';
import { fetchSkillExecutionControls, fetchSkillVersions, setSkillExecutionBlock, type SkillExecutionControls } from '../../services/governanceApi';

export default function SkillExecutionControlsPanel() {
  const [controls, setControls] = useState<SkillExecutionControls | null>(null);
  const [skillKey, setSkillKey] = useState('');
  const [versionId, setVersionId] = useState('');
  const [versions, setVersions] = useState<Array<{ id: string; semanticVersion: string }>>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    setBusy(true);
    try { setControls(await fetchSkillExecutionControls()); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to load controls'); }
    finally { setBusy(false); }
  };
  const selectSkill = async (key: string) => {
    setSkillKey(key); setVersionId(''); setVersions([]);
    const skill = controls?.skills.find(item => item.skillKey === key);
    if (skill?.scope === 'personal' && skill.activeRevisionId) setVersions([{ id: skill.activeRevisionId, semanticVersion: 'currently available personal version' }]);
    if (skill?.scope === 'team') {
      setBusy(true);
      try { const result = await fetchSkillVersions(skill.id); setVersions(result.versions); }
      catch (e) { setError(e instanceof Error ? e.message : 'Unable to load versions'); }
      finally { setBusy(false); }
    }
  };
  const change = async (key: string, blocked: boolean, version?: string) => {
    if (!reason.trim()) { setError('Enter a reason for this action.'); return; }
    setBusy(true);
    try {
      await setSkillExecutionBlock({ skillKey: key, versionId: version || undefined, blocked, reason });
      setControls(await fetchSkillExecutionControls()); setError(''); setReason('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to update block'); }
    finally { setBusy(false); }
  };
  return <details className="my-4 rounded-xl border border-slate-200 p-4" onToggle={event => { if (event.currentTarget.open && !controls && !busy) void load(); }}>
    <summary className="cursor-pointer font-semibold">Admin execution controls</summary>
    <p className="my-3 text-sm text-slate-600">Block a skill across all versions, or block one package wherever it is used. Only an admin can remove a block. Further tool calls stop; a process already running may finish within its execution limit.</p>
    {error && <p role="alert" className="my-2 text-sm text-rose-700">{error}</p>}
    <div className="flex flex-wrap gap-3">
      <select aria-label="Skill to block" value={skillKey} onChange={e => void selectSkill(e.target.value)} disabled={busy} className="settings-control rounded-lg p-2">
        <option value="">Select skill</option>
        {controls?.skills.map(skill => <option key={skill.skillKey} value={skill.skillKey}>{skill.displayName} — {skill.ownerName} ({skill.scope})</option>)}
      </select>
      <select aria-label="Block scope" value={versionId} onChange={e => setVersionId(e.target.value)} disabled={busy} className="settings-control rounded-lg p-2">
        <option value="">All versions of this skill</option>
        {versions.map(version => <option key={version.id} value={version.id}>Package {version.semanticVersion}</option>)}
      </select>
      <input aria-label="Block or unblock reason" placeholder="Reason for block or unblock" value={reason} onChange={e => setReason(e.target.value)} className="settings-control flex-1 rounded-lg p-2" />
      <button disabled={busy || !skillKey || !reason.trim()} onClick={() => void change(skillKey, true, versionId)} className="rounded-lg bg-rose-50 px-4 py-2 text-rose-700 disabled:opacity-50">Block execution</button>
    </div>
    <ul className="mt-4 space-y-2">{controls?.blocks.map(block => <li key={block.id} className="flex items-center justify-between gap-3 text-sm">
      <span>{controls.skills.find(skill => skill.skillKey === block.skillKey)?.displayName || block.skillKey} {block.versionId ? '(package)' : '(all versions)'}: {block.reason}</span>
      <button disabled={busy || !reason.trim()} onClick={() => void change(block.skillKey, false, block.versionId)} className="settings-portal-button-secondary rounded-lg px-3 py-2 disabled:opacity-50">Unblock</button>
    </li>)}</ul>
  </details>;
}
