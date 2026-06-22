import { CalendarClock, CircleAlert, Loader2, Pause, Play, RefreshCw, Trash2, X, Zap } from 'lucide-react';
import type { Workspace, WorkspaceSchedule } from '../../types';

type WorkspaceSchedulesPanelProps = {
  open: boolean;
  colorMode: 'light' | 'dark';
  workspace: Workspace | null;
  schedules: WorkspaceSchedule[];
  loading?: boolean;
  error?: string;
  busyScheduleId?: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onEdit: (schedule: WorkspaceSchedule) => void;
  onDelete: (schedule: WorkspaceSchedule) => void;
  onToggleStatus: (schedule: WorkspaceSchedule) => void;
  onRunNow: (schedule: WorkspaceSchedule) => void;
};

const formatDateTime = (value?: string | null): string => {
  if (!value) {
    return 'Not scheduled';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Not scheduled';
  }
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const statusLabel = (schedule: WorkspaceSchedule) => {
  if (schedule.status === 'active') return 'Active';
  if (schedule.status === 'paused') return 'Paused';
  return 'Needs attention';
};

export default function WorkspaceSchedulesPanel({
  open,
  colorMode,
  workspace,
  schedules,
  loading = false,
  error,
  busyScheduleId,
  onClose,
  onRefresh,
  onEdit,
  onDelete,
  onToggleStatus,
  onRunNow,
}: WorkspaceSchedulesPanelProps) {
  if (!open) {
    return null;
  }
  const isDarkMode = colorMode === 'dark';
  const mutedText = isDarkMode ? 'text-slate-400' : 'text-slate-500';
  const panelClassName = isDarkMode
    ? 'border-slate-700 bg-slate-950 text-slate-100'
    : 'border-slate-200 bg-white text-slate-900';
  const itemClassName = isDarkMode
    ? 'border-slate-800 bg-slate-950 hover:bg-slate-900'
    : 'border-slate-200 bg-white hover:bg-slate-50';
  const iconButtonClassName = `inline-flex h-8 w-8 items-center justify-center rounded-lg transition disabled:cursor-wait disabled:opacity-50 ${
    isDarkMode ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
  }`;

  return (
    <div className="fixed inset-0 z-[1650] flex justify-end bg-slate-950/35" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <aside className={`flex h-full w-full max-w-md flex-col border-l shadow-2xl ${panelClassName}`}>
        <div className={`flex items-center justify-between border-b px-5 py-4 ${
          isDarkMode ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <CalendarClock size={18} className={isDarkMode ? 'text-sky-300' : 'text-blue-600'} />
              <h2 className="text-base font-semibold">Schedules</h2>
            </div>
            <p className={`mt-1 truncate text-xs ${mutedText}`}>
              {workspace?.name || 'No workspace selected'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={onRefresh} className={iconButtonClassName} title="Refresh schedules" aria-label="Refresh schedules">
              {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            </button>
            <button type="button" onClick={onClose} className={iconButtonClassName} title="Close schedules" aria-label="Close schedules">
              <X size={17} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {error ? (
            <div className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
              isDarkMode ? 'border-red-500/40 bg-red-950/30 text-red-200' : 'border-red-200 bg-red-50 text-red-700'
            }`}>
              {error}
            </div>
          ) : null}

          {loading && !schedules.length ? (
            <div className={`flex h-48 items-center justify-center gap-2 text-sm ${mutedText}`}>
              <Loader2 size={16} className="animate-spin" />
              Loading schedules
            </div>
          ) : schedules.length ? (
            <div className="space-y-3">
              {schedules.map((schedule) => {
                const isBusy = busyScheduleId === schedule.id;
                const isActive = schedule.status === 'active';
                const statusClassName = schedule.status === 'active'
                  ? isDarkMode ? 'bg-emerald-500/15 text-emerald-200' : 'bg-emerald-50 text-emerald-700'
                  : schedule.status === 'paused'
                    ? isDarkMode ? 'bg-amber-500/15 text-amber-200' : 'bg-amber-50 text-amber-700'
                    : isDarkMode ? 'bg-red-500/15 text-red-200' : 'bg-red-50 text-red-700';
                return (
                  <article key={schedule.id} className={`rounded-xl border p-3 transition ${itemClassName}`}>
                    <button type="button" onClick={() => onEdit(schedule)} className="block w-full text-left">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold">{schedule.name}</h3>
                          <p className={`mt-1 text-xs ${mutedText}`}>
                            Next: {formatDateTime(schedule.nextRunAt)}
                          </p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ${statusClassName}`}>
                          {statusLabel(schedule)}
                        </span>
                      </div>
                      <p className={`mt-3 line-clamp-2 text-sm leading-5 ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                        {schedule.prompt}
                      </p>
                      <div className={`mt-3 flex flex-wrap gap-2 text-[11px] font-semibold ${mutedText}`}>
                        <span>{schedule.cadence}</span>
                        <span>{schedule.cronExpression}</span>
                        <span>{schedule.timezone}</span>
                      </div>
                      {schedule.lastError ? (
                        <div className={`mt-3 flex items-start gap-2 rounded-lg px-2 py-2 text-xs ${
                          isDarkMode ? 'bg-red-950/30 text-red-200' : 'bg-red-50 text-red-700'
                        }`}>
                          <CircleAlert size={14} className="mt-0.5 shrink-0" />
                          <span>{schedule.lastError}</span>
                        </div>
                      ) : null}
                    </button>
                    <div className={`mt-3 flex items-center justify-between border-t pt-3 ${
                      isDarkMode ? 'border-slate-800' : 'border-slate-200'
                    }`}>
                      <div className={`text-xs ${mutedText}`}>
                        Last: {formatDateTime(schedule.lastRunAt)}
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onRunNow(schedule)}
                          disabled={isBusy}
                          className={iconButtonClassName}
                          title="Run now"
                          aria-label={`Run ${schedule.name} now`}
                        >
                          {isBusy ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggleStatus(schedule)}
                          disabled={isBusy}
                          className={iconButtonClassName}
                          title={isActive ? 'Pause schedule' : 'Resume schedule'}
                          aria-label={isActive ? `Pause ${schedule.name}` : `Resume ${schedule.name}`}
                        >
                          {isActive ? <Pause size={15} /> : <Play size={15} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(schedule)}
                          disabled={isBusy}
                          className={iconButtonClassName}
                          title="Delete schedule"
                          aria-label={`Delete ${schedule.name}`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                    {schedule.recentRuns?.length ? (
                      <div className={`mt-3 rounded-lg px-2 py-2 text-xs ${
                        isDarkMode ? 'bg-slate-900 text-slate-400' : 'bg-slate-50 text-slate-500'
                      }`}>
                        {schedule.recentRuns.slice(0, 3).map((run) => (
                          <div key={run.id} className="flex items-center justify-between gap-2 py-0.5">
                            <span>{formatDateTime(run.startedAt || run.createdAt)}</span>
                            <span className="font-semibold capitalize">{run.status.replace('_', ' ')}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className={`flex h-64 flex-col items-center justify-center text-center text-sm ${mutedText}`}>
              <CalendarClock size={28} className="mb-3 opacity-70" />
              <p>No schedules in this workspace.</p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
