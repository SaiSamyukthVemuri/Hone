import { appointmentLanes } from "@/lib/calendar/appointment-lanes";
import { localDateString, localMinutesSinceMidnight, localTimeString, minutesToHHMM, formatClockLabel } from "@/lib/booking/tz";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import { formatStudioTime } from "@/lib/desk/time";
import type { DeskScheduleRow } from "@/lib/desk/read";
import { type DeskPerson } from "./desk-period";

type TimeColumn = { date: string; person: DeskPerson; heading: string; visits: DeskScheduleRow[] };

export function DeskTimeGrid({ today, timezone, columns, bookableIds, onVisit, onBook }: {
  today: string; timezone: string; columns: TimeColumn[]; bookableIds: string[];
  onVisit: (row: DeskScheduleRow) => void; onBook: (date: string, person: string, time: string) => void;
}) {
  const layout = columns.map(column => {
    const cards = column.visits.map(row => {
      const start = new Date(row.startsAt), end = new Date(row.endsAt);
      const top = localDateString(start, timezone) < column.date ? 0 : localMinutesSinceMidnight(localTimeString(start, timezone));
      const bottom = localDateString(end, timezone) > column.date ? 1440 : localMinutesSinceMidnight(localTimeString(end, timezone));
      // Across the repeated fall-back hour an end clock can precede its start.
      const minutes = bottom > top ? bottom - top : Math.max(1, (end.getTime() - start.getTime()) / 60_000);
      return { row, id: row.appointmentId, top, height: Math.min(1440 - top, minutes) };
    });
    return { ...column, cards, lanes: appointmentLanes(cards) };
  });
  const rectangles = layout.flatMap(column => column.cards);
  const firstHour = Math.floor(Math.min(540, ...rectangles.map(v => v.top)) / 60);
  const lastHour = Math.ceil(Math.max(1020, ...rectangles.map(v => v.top + v.height)) / 60);
  const hours = Array.from({ length: lastHour - firstHour }, (_, index) => firstHour + index);
  return <div className="overflow-x-auto rounded-xl border border-line" aria-label="Appointment time grid">
    <div className="grid" style={{ gridTemplateColumns: `3.5rem repeat(${columns.length}, minmax(9rem,1fr))` }}>
      <div />
      {columns.map(({ date, person, heading }) => <div key={date + person.id} className="flex items-center gap-2 border-l border-line p-2 text-sm font-semibold">
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${resolvePractitionerColor(person.color).bg}`} />{heading}</div>)}
      <div className="text-right text-xs text-fg-muted">
        {hours.map(h => <div key={h} className="h-[60px] border-t border-line pr-1 pt-1">{formatClockLabel(minutesToHHMM(h * 60), "12h")}</div>)}
      </div>
      {layout.map(({ date, person, cards, lanes }) => {
        return <div key={date + person.id} className="relative border-l border-line">
          {hours.map(h => <div key={h} className="h-[60px] border-t border-line">
            {date >= today && bookableIds.includes(person.id) && <button type="button" className="block h-full w-full hover:bg-surface-sunken focus-visible:bg-surface-sunken"
              aria-label={`Find an opening with ${person.name} on ${date} from ${formatClockLabel(minutesToHHMM(h * 60), "12h")}`}
              onClick={event => {
                const bounds = event.currentTarget.getBoundingClientRect();
                const quarter = event.detail && bounds.height ? Math.min(3, Math.max(0, Math.floor((event.clientY - bounds.top) * 4 / bounds.height))) : 0;
                onBook(date, person.id, minutesToHHMM(h * 60 + 15 * quarter));
              }} />}
          </div>)}
          {cards.map(({ row, id, top, height }) => {
            const lane = lanes.get(id)!;
            const description = `${formatStudioTime(row.startsAt, timezone)}–${formatStudioTime(row.endsAt, timezone)} · ${row.clientName} · ${row.serviceName} · ${row.practitionerName}`;
            return <button key={id} type="button" title={description} aria-label={description} onClick={() => onVisit(row)}
              className="absolute overflow-hidden rounded-md border border-line bg-surface-sunken px-1.5 text-left text-xs leading-tight hover:border-fg-muted focus:z-10"
              style={{ top: top - firstHour * 60, height, left: `calc(${lane.column * 100 / lane.columns}% + 1px)`, width: `calc(${100 / lane.columns}% - 2px)` }}>
              <span className="block truncate font-semibold">{row.clientName}</span>
              {height >= 26 && <span className="block truncate">{formatStudioTime(row.startsAt, timezone)}–{formatStudioTime(row.endsAt, timezone)}</span>}
              {height >= 46 && <span className="block truncate text-fg-muted">{row.serviceName}</span>}
            </button>;
          })}
        </div>;
      })}
    </div>
  </div>;
}
