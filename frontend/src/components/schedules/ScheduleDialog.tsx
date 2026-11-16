import { useEffect, useMemo, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Selector } from '@astryxdesign/core/Selector';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { TimeInput, type TimeInputProps } from '@astryxdesign/core/TimeInput';
import '../../features/calendar/calendar.css';
import type {
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
  workspaceName,
  initialDraft,
  existingSchedule,
  availableSkills,
  saving = false,
  onClose,
  onSubmit,
}: ScheduleDialogProps) {
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
    setOutputMode(initialDraft.outputMode || 'append_to_conversation');
    setNotificationMode(initialDraft.notificationMode || 'failure');
    setError('');
  }, [initialDraft, open]);

  const cronExpression = useMemo(
    () => buildCronExpression(cadence, timeValue, weeklyDay, monthlyDay, customCron),
    [cadence, customCron, monthlyDay, timeValue, weeklyDay],
  );

  const skillOptions = useMemo(
    () => availableSkills.filter((skill) => skill.valid !== false),
    [availableSkills],
  );

  if (!open || !initialDraft) {
    return null;
  }

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
    try { await onSubmit({
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
      outputMode,
      notificationMode,
    }); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to save automation'); }
  };

  return <Dialog isOpen={open} onOpenChange={value => { if (!value && !saving) onClose(); }} purpose="form" width={620} maxHeight="90dvh" aria-label={existingSchedule ? 'Edit automation' : 'New automation'}>
    <DialogHeader title={existingSchedule ? 'Edit automation' : 'New automation'} />
    <form className="calendar-editor" onSubmit={event => { event.preventDefault(); void handleSubmit(); }}>
      <p className="calendar-muted">{workspaceName || 'Workspace'} · Lumo automation. This schedule is never added to Google Calendar.</p>
      <TextInput label="Name" isRequired value={name} onChange={setName} />
      <div className="calendar-editor-row"><Selector label="Agent" value={persona} options={['fast', 'lite', 'pro']} onChange={setPersona} /><Selector label="Cadence" value={cadence} options={['hourly', 'daily', 'weekly', 'monthly', 'custom']} onChange={value => setCadence(value as WorkspaceScheduleCadence)} /></div>
      <div className="calendar-editor-row">{cadence === 'custom' ? <TextInput label="Cron expression" value={customCron} onChange={setCustomCron} description="Five fields: minute, hour, day, month, weekday" /> : <TimeInput label={cadence === 'hourly' ? 'Minute within each hour' : 'Time'} value={timeValue as TimeInputProps['value']} onChange={value => value && setTimeValue(value)} />}
      <Selector label="Timezone" value={timezone} options={[...new Set([timezone, 'UTC', ...Intl.supportedValuesOf('timeZone')])]} hasSearch onChange={setTimezone} /></div>
      {cadence === 'weekly' && <Selector label="Weekday" value={weeklyDay} options={DAY_OPTIONS} onChange={setWeeklyDay} />}
      {cadence === 'monthly' && <Selector label="Day of month" value={String(monthlyDay)} options={Array.from({ length: 31 }, (_, index) => String(index + 1))} onChange={value => setMonthlyDay(Number(value))} description="Months without the selected day are skipped." />}
      <TextArea label="Task instruction" value={prompt} onChange={setPrompt} isRequired />
      <section className="calendar-schedule-skills" aria-label="Included skills"><h3>Included skills</h3>{skillOptions.map(skill => <CheckboxInput key={skill.id} label={skill.name || skill.id} value={selectedSkills.includes(skill.id)} onChange={() => toggleSkill(skill.id)} />)}{!skillOptions.length && <p className="calendar-muted">No skills available.</p>}</section>
      <Selector label="Output" value={outputMode} options={[{ value: 'append_to_conversation', label: 'Append to scheduled-runs chat' }, { value: 'new_conversation_per_run', label: 'New chat for each run' }]} onChange={value => setOutputMode(value as WorkspaceScheduleOutputMode)} />
      <Selector label="Notifications" value={notificationMode} options={[{ value: 'none', label: 'Do not notify' }, { value: 'failure', label: 'Failures only' }, { value: 'all', label: 'Every run' }]} onChange={value => setNotificationMode(value as WorkspaceScheduleNotificationMode)} />
      <p className="calendar-muted">{cronExpression} · {timezone}<br />{[...new Set([...contextRefs, ...taggedFiles])].join(', ') || 'No extra workspace context selected'}</p>
      {error && <p className="calendar-notice" role="alert">{error}</p>}
      <div className="calendar-editor-actions"><Button label="Cancel" variant="secondary" isDisabled={saving} onClick={onClose} /><Button label={saving ? 'Saving…' : 'Save automation'} variant="primary" type="submit" isDisabled={saving || !name.trim() || !prompt.trim()} /></div>
    </form>
  </Dialog>;
}
