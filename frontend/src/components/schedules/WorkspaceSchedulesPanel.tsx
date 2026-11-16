import { CalendarClock, Pause, Play, RefreshCw, Trash2, Zap } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import type { Workspace, WorkspaceSchedule } from '../../types';
import '../../features/calendar/calendar.css';

type Props = {
  open: boolean; colorMode: 'light' | 'dark'; workspace: Workspace | null; schedules: WorkspaceSchedule[];
  loading?: boolean; error?: string; busyScheduleId?: string | null; leftOffset?: number;
  onClose: () => void; onRefresh: () => void; onEdit: (schedule: WorkspaceSchedule) => void;
  onDelete: (schedule: WorkspaceSchedule) => void; onToggleStatus: (schedule: WorkspaceSchedule) => void; onRunNow: (schedule: WorkspaceSchedule) => void;
};
const when = (value?: string | null) => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not scheduled';
export default function WorkspaceSchedulesPanel({ open, workspace, schedules, loading = false, error, busyScheduleId, onClose, onRefresh, onEdit, onDelete, onToggleStatus, onRunNow }: Props) {
  return <Dialog isOpen={open} onOpenChange={value => !value && onClose()} width={500} maxHeight="88dvh" aria-label="Lumo automations">
    <DialogHeader title="Lumo automations" />
    <div className="calendar-editor"><div className="calendar-actions"><CalendarClock size={18} /><p>{workspace?.name || 'Choose a workspace to manage automations'}</p><IconButton label="Refresh automations" icon={<RefreshCw size={16} />} variant="ghost" isDisabled={loading} onClick={onRefresh} /></div>
      <p className="calendar-muted">These jobs use the existing Lumo scheduler. Meetings in Google Calendar are managed separately.</p>
      {error && <p className="calendar-notice" role="alert">{error}</p>}
      {loading && <p role="status">Loading automations…</p>}
      {!loading && !schedules.length && <p className="calendar-muted">No automations in this workspace.</p>}
      {schedules.map(schedule => <article key={schedule.id} className="calendar-schedule-card">
        <h3>{schedule.name}</h3><p className="calendar-muted">{schedule.status === 'active' ? 'Active' : schedule.status === 'paused' ? 'Paused' : 'Needs attention'} · {schedule.cronExpression} · {schedule.timezone}</p>
        <p className="calendar-muted">Next run: {when(schedule.nextRunAt)}</p>
        <div className="calendar-actions"><Button label="Edit" size="sm" variant="secondary" isDisabled={busyScheduleId === schedule.id} onClick={() => onEdit(schedule)} /><IconButton label={`Run ${schedule.name} now`} icon={<Zap size={15} />} variant="ghost" isDisabled={busyScheduleId === schedule.id} onClick={() => onRunNow(schedule)} /><IconButton label={`${schedule.status === 'active' ? 'Pause' : 'Resume'} ${schedule.name}`} icon={schedule.status === 'active' ? <Pause size={15} /> : <Play size={15} />} variant="ghost" isDisabled={busyScheduleId === schedule.id} onClick={() => onToggleStatus(schedule)} /><IconButton label={`Delete ${schedule.name}`} icon={<Trash2 size={15} />} variant="ghost" isDisabled={busyScheduleId === schedule.id} onClick={() => onDelete(schedule)} /></div>
        {schedule.recentRuns?.slice(0, 3).map(run => <p className="calendar-muted" key={run.id}>{when(run.startedAt || run.createdAt)} · {run.status.replaceAll('_', ' ')}</p>)}
      </article>)}
      <div className="calendar-editor-actions"><Button label="Close" variant="secondary" onClick={onClose} /></div>
    </div>
  </Dialog>;
}
