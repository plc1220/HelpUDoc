import { useRef, useState } from 'react';
import { IconButton } from '@astryxdesign/core/IconButton';
import { GripHorizontal } from 'lucide-react';
import type { CalendarItem } from './calendarApi';
import { addDays, dayKey, intersectsDay, localTime, zonedInstant } from './calendarTime';

type Move = { item: CalendarItem; start: string; end: string };
type Props = { days: string[]; items: CalendarItem[]; zone: string; canCreate: boolean; renderCard: (item: CalendarItem, small?: boolean) => React.ReactNode; onCreate: (day: string, time: string) => void; onMove: (move: Move) => void; onEdit: (item: CalendarItem) => void };
const HOUR = 72;
const minute = (value: string, zone: string) => { const local = localTime(value, zone); return Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16)); };

function arrange(items: CalendarItem[], day: string, zone: string) {
  const rows = items.filter(item => !item.all_day && intersectsDay(item, day, zone)).map(item => {
    const start = dayKey(item.start, zone) < day ? 0 : minute(item.start, zone);
    const end = item.end ? dayKey(item.end, zone) > day ? 1440 : minute(item.end, zone) : start + 30;
    return { item, start, end: Math.max(start + 15, end), column: 0, columns: 1 };
  }).sort((a, b) => a.start - b.start || b.end - a.end);
  let group: typeof rows = [], groupEnd = 0, ends: number[] = [];
  const finish = () => { for (const row of group) row.columns = ends.length; };
  for (const row of rows) {
    if (row.start >= groupEnd) { finish(); group = []; ends = []; }
    let index = ends.findIndex(end => end <= row.start); if (index === -1) index = ends.length;
    row.column = index; ends[index] = row.end; group.push(row); groupEnd = Math.max(...group.map(r => r.end));
  }
  finish(); return rows;
}

export default function CalendarWeek({ days, items, zone, canCreate, renderCard, onCreate, onMove, onEdit }: Props) {
  const [resize, setResize] = useState<{ id: string; end: string; minutes: number }>();
  const drag = useRef<{ item: CalendarItem; y: number; end: string } | undefined>(undefined);
  const suppressClick = useRef(false);
  const heading = (day: string, options: Intl.DateTimeFormatOptions) => new Date(`${day}T12:00Z`).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
  return <div className="calendar-week" style={{ '--calendar-days': days.length } as React.CSSProperties}>
    <div className="calendar-week-corner">{zone.split('/').at(-1)?.replaceAll('_', ' ')}</div>
    {days.map(day => <div key={day} className={`calendar-week-heading${day === dayKey(new Date(), zone) ? ' is-today' : ''}`}><small>{heading(day, { weekday: 'short' })}</small><strong>{heading(day, { day: 'numeric' })}</strong></div>)}
    <div className="calendar-hour">All day</div>{days.map(day => <div key={day} className="calendar-allday">{items.filter(item => item.all_day && intersectsDay(item, day, zone)).map(item => renderCard(item, true))}</div>)}
    <div className="calendar-hour-labels">{Array.from({ length: 24 }, (_, hour) => <div key={hour} className="calendar-hour" style={{ height: HOUR }}>{`${String(hour).padStart(2, '0')}:00`}</div>)}</div>
    {days.map(day => <div key={day} className="calendar-day-column" style={{ height: HOUR * 24 }} onDragOver={event => event.preventDefault()} onDrop={event => {
      event.preventDefault();
      const item = items.find(candidate => candidate.id === event.dataTransfer.getData('text/lumo-calendar'));
      if (!item?.end || !item.capabilities.can_edit) return;
      const minutes = Math.max(0, Math.min(1410, Math.floor((event.clientY - event.currentTarget.getBoundingClientRect().top) / HOUR * 2) * 30));
      const start = zonedInstant(`${day}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${minutes % 60 ? '30' : '00'}`, zone);
      onMove({ item, start, end: new Date(Date.parse(start) + Date.parse(item.end) - Date.parse(item.start)).toISOString() });
    }}>
      {Array.from({ length: 48 }, (_, slot) => {
        const time = `${String(Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`;
        return <button key={slot} type="button" className="calendar-time-slot" style={{ top: slot * HOUR / 2, height: HOUR / 2 }} disabled={!canCreate} aria-label={`Create event ${day} at ${time}`} onClick={() => onCreate(day, time)} />;
      })}
      {arrange(items, day, zone).map(({ item, start, end, column, columns }) => {
        const liveEnd = resize?.id === item.id ? Math.max(start + 15, end + resize.minutes) : end;
        return <div key={item.id} className="calendar-timed-event" style={{ top: start / 60 * HOUR, height: Math.max(24, (liveEnd - start) / 60 * HOUR - 2), left: `${column / columns * 100}%`, width: `${100 / columns}%` }}>
          {renderCard(item, true)}
          {item.kind === 'MEETING' && item.capabilities.can_edit && item.end && dayKey(item.end, zone) <= addDays(day, 1) && <IconButton className="calendar-resize-handle" label={`Resize ${item.title}; drag to change duration or press to edit times`} icon={<GripHorizontal size={14} />} variant="ghost" onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onEdit(item); }}
            onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { item, y: event.clientY, end: item.end! }; }}
            onPointerMove={event => { if (!drag.current || drag.current.item.id !== item.id) return; const minutes = Math.round((event.clientY - drag.current.y) / HOUR * 4) * 15; const next = Math.max(Date.parse(item.start) + 900000, Date.parse(drag.current.end) + minutes * 60000); setResize({ id: item.id, end: new Date(next).toISOString(), minutes }); }}
            onPointerUp={event => { if (!drag.current) return; drag.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId); if (resize?.id === item.id && resize.minutes) { suppressClick.current = true; onMove({ item, start: item.start, end: resize.end }); } setResize(undefined); }}
            onPointerCancel={() => { drag.current = undefined; setResize(undefined); }} />}
          {resize?.id === item.id && <span className="calendar-resize-preview" role="status">Ends {localTime(resize.end, zone).slice(11)}</span>}
        </div>;
      })}
    </div>)}
  </div>;
}
