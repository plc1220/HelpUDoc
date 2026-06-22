import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Check, Clock3, X } from 'lucide-react';
import type {
  FileContextRef,
  SkillDefinition,
  WorkspaceSchedule,
  WorkspaceScheduleCadence,
  WorkspaceScheduleDraft,
  WorkspaceScheduleNotificationMode,
  WorkspaceScheduleOutputMode,
} from '../../types';

type ScheduleDialogProps = {
  open: boolean;
  colorMode: 'light' | 'dark';
  workspaceName?: string;
  initialDraft: WorkspaceScheduleDraft | null;
  existingSchedule?: WorkspaceSchedule | null;
  availableSkills: SkillDefinition[];
  saving?: boolean;
  onClose: () => void;
  onSubmit: (draft: WorkspaceScheduleDraft) => Promise<void> | void;
};

const DAY_OPTIONS = [
  { value: '1', label: 'Mon' },
  { value: '2', label: 'Tue' },
  { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' },
  { value: '5', label: 'Fri' },
  { value: '6', label: 'Sat' },
  { value: '0', label: 'Sun' },
];

const defaultTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const parseCronDefaults = (cronExpression?: string) => {
  const fields = String(cronExpression || '0 9 * * *').trim().split(/\s+/);
  return {
    minute: fields[0] || '0',
    hour: fields[1] || '9',
    dayOfMonth: fields[2] && fields[2] !== '*' ? fields[2] : '1',
    dayOfWeek: fields[4] && fields[4] !== '*' ? fields[4] : '1',
  };
};

const buildCronExpression = (
  cadence: WorkspaceScheduleCadence,
  timeValue: string,
  weeklyDay: string,
  monthlyDay: number,
  customCron: string,
): string => {
  if (cadence === 'custom') {
    return customCron.trim() || '0 9 * * *';
  }
  const [hourRaw, minuteRaw] = timeValue.split(':');
  const hour = Math.max(0, Math.min(23, Number(hourRaw) || 0));
  const minute = Math.max(0, Math.min(59, Number(minuteRaw) || 0));
  if (cadence === 'hourly') {
    return `${minute} * * * *`;
  }
  if (cadence === 'weekly') {
    return `${minute} ${hour} * * ${weeklyDay}`;
  }
  if (cadence === 'monthly') {
    return `${minute} ${hour} ${Math.max(1, Math.min(31, monthlyDay))} * *`;
  }
  return `${minute} ${hour} * * *`;
};

const inferTimeValue = (cronExpression?: string) => {
  const { minute, hour } = parseCronDefaults(cronExpression);
  const hourValue = Number(hour);
  const minuteValue = Number(minute);
  return `${String(Number.isFinite(hourValue) ? hourValue : 9).padStart(2, '0')}:${String(Number.isFinite(minuteValue) ? minuteValue : 0).padStart(2, '0')}`;
};

export default function ScheduleDialog({
  open,
  colorMode,
  workspaceName,
  initialDraft,
  existingSchedule,
  availableSkills,
  saving = false,
  onClose,
  onSubmit,
}: ScheduleDialogProps) {
  const isDarkMode = colorMode === 'dark';
  const [name, setName] = useState('');
  const [cadence, setCadence] = useState<WorkspaceScheduleCadence>('daily');
  const [timeValue, setTimeValue] = useState('09:00');
  const [weeklyDay, setWeeklyDay] = useState('1');
  const [monthlyDay, setMonthlyDay] = useState(1);
  const [customCron, setCustomCron] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [prompt, setPrompt] = useState('');
  const [persona, setPersona] = useState('fast');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [contextRefs, setContextRefs] = useState<string[]>([]);
  const [taggedFiles, setTaggedFiles] = useState<string[]>([]);
  const [fileContextRefs, setFileContextRefs] = useState<FileContextRef[]>([]);
  const [outputMode, setOutputMode] = useState<WorkspaceScheduleOutputMode>('append_to_conversation');
  const [notificationMode, setNotificationMode] = useState<WorkspaceScheduleNotificationMode>('failure');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !initialDraft) {
      return;
    }
    const cronDefaults = parseCronDefaults(initialDraft.cronExpression);
    setName(initialDraft.name || '');
    setCadence(initialDraft.cadence || 'daily');
    setTimeValue(inferTimeValue(initialDraft.cronExpression));
    setWeeklyDay(cronDefaults.dayOfWeek || '1');
    setMonthlyDay(Number(cronDefaults.dayOfMonth) || 1);
    setCustomCron(initialDraft.cronExpression || '0 9 * * *');
    setTimezone(initialDraft.timezone || defaultTimezone());
    setPrompt(initialDraft.prompt || '');
    setPersona(initialDraft.persona || 'fast');
    setSelectedSkills(initialDraft.selectedSkills || []);
    setContextRefs(initialDraft.contextRefs || []);
    setTaggedFiles(initialDraft.taggedFiles || []);
    setFileContextRefs(initialDraft.fileContextRefs || []);
    setOutputMode(initialDraft.outputMode || 'append_to_conversation');
    setNotificationMode(initialDraft.notificationMode || 'failure');
    setError('');
  }, [initialDraft, open]);

  const cronExpression = useMemo(
    () => buildCronExpression(cadence, timeValue, weeklyDay, monthlyDay, customCron),
    [cadence, customCron, monthlyDay, timeValue, weeklyDay],
  );

  const skillOptions = useMemo(
    () => availableSkills.filter((skill) => skill.valid !== false).slice(0, 12),
    [availableSkills],
  );

  if (!open || !initialDraft) {
    return null;
  }

  const inputClassName = `w-full rounded-lg border px-3 py-2 text-sm outline-none transition ${
    isDarkMode
      ? 'border-slate-700 bg-slate-950 text-slate-100 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20'
      : 'border-slate-200 bg-white text-slate-900 focus:border-blue-400 focus:ring-2 focus:ring-blue-100'
  }`;
  const labelClassName = `text-xs font-semibold uppercase tracking-wide ${
    isDarkMode ? 'text-slate-400' : 'text-slate-500'
  }`;
  const sectionClassName = `border-t pt-4 ${isDarkMode ? 'border-slate-800' : 'border-slate-200'}`;

  const toggleSkill = (skillId: string) => {
    setSelectedSkills((prev) =>
      prev.includes(skillId) ? prev.filter((item) => item !== skillId) : [...prev, skillId],
    );
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('Name this schedule before saving.');
      return;
    }
    if (!prompt.trim()) {
      setError('Add the task instruction before saving.');
      return;
    }
    setError('');
    await onSubmit({
      ...initialDraft,
      name: name.trim(),
      cadence,
      cronExpression,
      timezone: timezone.trim() || 'UTC',
      prompt: prompt.trim(),
      persona,
      selectedSkills,
      contextRefs,
      taggedFiles,
      fileContextRefs,
      outputMode,
      notificationMode,
    });
  };

  return (
    <div
      className="fixed inset-0 z-[1700] flex items-center justify-center bg-slate-950/55 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className={`flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border shadow-2xl ${
        isDarkMode ? 'border-slate-700 bg-slate-950 text-slate-100' : 'border-slate-200 bg-white text-slate-900'
      }`}>
        <div className={`flex items-center justify-between border-b px-5 py-4 ${
          isDarkMode ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <CalendarClock size={18} className={isDarkMode ? 'text-sky-300' : 'text-blue-600'} />
              <h2 className="text-base font-semibold">
                {existingSchedule ? 'Edit schedule' : 'Schedule this'}
              </h2>
            </div>
            <p className={`mt-1 truncate text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              Runs in {workspaceName || 'this workspace'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`rounded-lg p-1.5 transition ${isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
            aria-label="Close schedule dialog"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <div className="grid gap-4 md:grid-cols-[1fr_11rem]">
            <label className="space-y-1.5">
              <span className={labelClassName}>Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={inputClassName}
                placeholder="Weekly competitor scan"
              />
            </label>
            <label className="space-y-1.5">
              <span className={labelClassName}>Mode</span>
              <select value={persona} onChange={(event) => setPersona(event.target.value)} className={inputClassName}>
                <option value="fast">Fast</option>
                <option value="lite">Lite</option>
                <option value="pro">Pro</option>
              </select>
            </label>
          </div>

          <div className={sectionClassName}>
            <div className="grid gap-4 md:grid-cols-[10rem_1fr_12rem]">
              <label className="space-y-1.5">
                <span className={labelClassName}>Cadence</span>
                <select
                  value={cadence}
                  onChange={(event) => setCadence(event.target.value as WorkspaceScheduleCadence)}
                  className={inputClassName}
                >
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="custom">Custom cron</option>
                </select>
              </label>
              {cadence === 'custom' ? (
                <label className="space-y-1.5">
                  <span className={labelClassName}>Cron</span>
                  <input
                    value={customCron}
                    onChange={(event) => setCustomCron(event.target.value)}
                    className={inputClassName}
                    placeholder="0 9 * * 1"
                  />
                </label>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5">
                    <span className={labelClassName}>Time</span>
                    <input
                      type="time"
                      value={timeValue}
                      onChange={(event) => setTimeValue(event.target.value)}
                      className={inputClassName}
                      disabled={cadence === 'hourly'}
                    />
                  </label>
                  {cadence === 'weekly' ? (
                    <label className="space-y-1.5">
                      <span className={labelClassName}>Day</span>
                      <select value={weeklyDay} onChange={(event) => setWeeklyDay(event.target.value)} className={inputClassName}>
                        {DAY_OPTIONS.map((day) => (
                          <option key={day.value} value={day.value}>{day.label}</option>
                        ))}
                      </select>
                    </label>
                  ) : cadence === 'monthly' ? (
                    <label className="space-y-1.5">
                      <span className={labelClassName}>Day</span>
                      <input
                        type="number"
                        min={1}
                        max={31}
                        value={monthlyDay}
                        onChange={(event) => setMonthlyDay(Number(event.target.value) || 1)}
                        className={inputClassName}
                      />
                    </label>
                  ) : (
                    <div className="space-y-1.5">
                      <span className={labelClassName}>Cron</span>
                      <div className={`flex h-10 items-center rounded-lg border px-3 text-sm ${
                        isDarkMode ? 'border-slate-800 bg-slate-900 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-500'
                      }`}>
                        {cronExpression}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <label className="space-y-1.5">
                <span className={labelClassName}>Timezone</span>
                <input value={timezone} onChange={(event) => setTimezone(event.target.value)} className={inputClassName} />
              </label>
            </div>
          </div>

          <div className={sectionClassName}>
            <label className="space-y-1.5">
              <span className={labelClassName}>Task instruction</span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                className={`${inputClassName} min-h-36 resize-y leading-6`}
              />
            </label>
          </div>

          <div className={sectionClassName}>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <span className={labelClassName}>Included skills</span>
                <div className={`max-h-40 overflow-y-auto rounded-lg border p-2 ${
                  isDarkMode ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-slate-50'
                }`}>
                  {skillOptions.length ? skillOptions.map((skill) => {
                    const checked = selectedSkills.includes(skill.id);
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        onClick={() => toggleSkill(skill.id)}
                        className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition ${
                          checked
                            ? isDarkMode ? 'bg-sky-500/15 text-sky-100' : 'bg-blue-50 text-blue-700'
                            : isDarkMode ? 'hover:bg-slate-900' : 'hover:bg-white'
                        }`}
                      >
                        <span className="truncate">{skill.name || skill.id}</span>
                        {checked ? <Check size={14} className="shrink-0" /> : null}
                      </button>
                    );
                  }) : (
                    <div className={`px-2 py-3 text-sm ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                      No skills available
                    </div>
                  )}
                </div>
              </div>
              <div className="space-y-3">
                <label className="space-y-1.5">
                  <span className={labelClassName}>Output</span>
                  <select
                    value={outputMode}
                    onChange={(event) => setOutputMode(event.target.value as WorkspaceScheduleOutputMode)}
                    className={inputClassName}
                  >
                    <option value="append_to_conversation">Append to scheduled-runs chat</option>
                    <option value="new_conversation_per_run">New chat for every run</option>
                  </select>
                </label>
                <label className="space-y-1.5">
                  <span className={labelClassName}>Notify</span>
                  <select
                    value={notificationMode}
                    onChange={(event) => setNotificationMode(event.target.value as WorkspaceScheduleNotificationMode)}
                    className={inputClassName}
                  >
                    <option value="none">Do not notify</option>
                    <option value="failure">Failures only</option>
                    <option value="all">Every run</option>
                  </select>
                </label>
                <div className={`rounded-lg border px-3 py-2 text-xs ${
                  isDarkMode ? 'border-slate-800 bg-slate-900 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-500'
                }`}>
                  <div className="mb-1 flex items-center gap-1.5 font-semibold">
                    <Clock3 size={13} />
                    <span>{cronExpression}</span>
                  </div>
                  <div className="line-clamp-3">
                    {contextRefs.length || taggedFiles.length || fileContextRefs.length
                      ? [...contextRefs, ...taggedFiles, ...fileContextRefs.map((ref) => ref.sourceName)].join(', ')
                      : 'No extra workspace context selected'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {error ? (
            <div className={`rounded-lg border px-3 py-2 text-sm ${
              isDarkMode ? 'border-red-500/40 bg-red-950/30 text-red-200' : 'border-red-200 bg-red-50 text-red-700'
            }`}>
              {error}
            </div>
          ) : null}
        </div>

        <div className={`flex items-center justify-end gap-2 border-t px-5 py-4 ${
          isDarkMode ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className={`rounded-lg px-3 py-2 text-sm font-semibold transition disabled:opacity-60 ${
              isDarkMode ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={saving}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-wait disabled:opacity-70 ${
              isDarkMode ? 'bg-sky-400 text-slate-950 hover:bg-sky-300' : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {saving ? 'Saving…' : existingSchedule ? 'Save changes' : 'Save schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
