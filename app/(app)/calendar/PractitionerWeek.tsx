"use client";

import { PendingLink } from "@/components/pending-link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { formatClockLabel, formatTimeForStudio, type TimeFormat } from "@/lib/booking/tz";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";
import { clientDisplayName } from "@/lib/clients/identity";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import { appointmentCardClasses } from "@/lib/calendar/service-colors";
import { AppointmentPreviewDrawer } from "./AppointmentPreviewDrawer";
import type { MobileDayData } from "./CalendarMobileDayView";
import { appointmentDisplayStatus, appointmentStatusTag, NO_SHOW_CARD_CLASS } from "./appointment-display-status";
import { displayBlockoutLabel, displayRecurringBreakLabel, TIMED_BLOCK_LABEL, timeRangeLabel } from "./calendar-format";

type Person = { id: string | null; name: string; swatchClass: string };
type Hours = { isOpen: boolean; openTime: string | null; closeTime: string | null };

export function PractitionerWeek({ days, initialDate, practitioners, hours, tz, timeFormat, returnTo }: {
  days: MobileDayData[];
  initialDate: string;
  practitioners: Person[];
  hours: Record<string, (Hours | null)[]>;
  tz: string;
  timeFormat: TimeFormat;
  returnTo: string;
}) {
  const search = useSearchParams();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = previewId && days.flatMap(day => day.appts).find(a => a.id === previewId);
  const people = new Map(practitioners.map(p => [p.id, p]));
  const byDay = days.map(day => {
    const groups = new Map<string | null, AppointmentWithPractitionerColor[]>();
    for (const visit of day.appts) {
      const id = visit.practitioner_id;
      if (!people.has(id)) people.set(id, {
        id, name: id ? visit.practitioner?.display_name?.trim() || "Former practitioner" : "Unassigned",
        swatchClass: resolvePractitionerColor(visit.practitioner?.color).bg,
      });
      const group = groups.get(id);
      if (group) group.push(visit);
      else groups.set(id, [visit]);
    }
    return groups;
  });
  const formatTime = (iso: string) => formatTimeForStudio(new Date(iso), tz, timeFormat);
  return <>
    <div aria-label="Day to show" role="group" className="grid grid-cols-7 gap-1 md:hidden">
      {days.map(d => {
        const query = new URLSearchParams(search.toString());
        query.set("view", "week");
        query.set("day", d.date);
        return <PendingLink key={d.date} href={`/calendar?${query}`} scroll={false} aria-current={d.date === initialDate ? "date" : undefined}
          pendingLabel={`Opening ${d.weekdayShort}…`} className={`flex min-h-11 items-center justify-center rounded-md text-center text-xs ${d.date === initialDate ? "bg-neutral-900 text-white" : "bg-neutral-50 text-neutral-700"}`}>
          {d.weekdayShort}<span className="block font-semibold">{Number(d.date.slice(-2))}</span>
        </PendingLink>;
      })}
    </div>
    <div data-testid="practitioner-week" className="max-h-[75dvh] overflow-auto rounded-xl border border-neutral-200">
      <table aria-label="Weekly appointments by practitioner" className="w-full table-fixed border-separate border-spacing-0 text-left text-xs md:min-w-[56rem]">
        <thead className="sticky top-0 z-20 bg-neutral-50">
          <tr>
            <th scope="col" className="sticky left-0 w-24 border-b border-r border-neutral-200 bg-neutral-50 px-2 py-3 text-neutral-700 md:w-28">Practitioner</th>
            {days.map(d => <th key={d.date} scope="col" className={`border-b border-neutral-200 px-2 py-2 ${d.date === initialDate ? "" : "hidden md:table-cell"} ${d.isToday ? "bg-sky-100 text-sky-900" : ""}`}>
              <span className="block text-[10px] font-medium uppercase">{d.weekdayShort}</span>{d.monthDayLabel}
            </th>)}
          </tr>
        </thead>
        <tbody>{Array.from(people.values()).map(person => <tr key={person.id ?? "unassigned"}>
          <th scope="row" className="sticky left-0 z-10 border-r border-b border-neutral-200 bg-white px-2 py-3 align-top">
            <span className="flex items-baseline gap-1.5 break-words"><span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${person.swatchClass}`} /><span className="min-w-0">{person.name}</span></span>
          </th>
          {days.map((day, i) => {
            const visits = byDay[i].get(person.id) ?? [];
            const window = person.id ? hours[person.id]?.[i] : null;
            const off = window?.isOpen === false;
            const scoped = (b: { practitioner_id: string | null }) => b.practitioner_id === null || b.practitioner_id === person.id;
            const blocks = [
              ...day.timedBlocks.filter(scoped).map(b => ({ key: 'block-'+b.id, start: b.starts_at, end: b.ends_at, label: TIMED_BLOCK_LABEL[b.category] || "Unavailable" })),
              ...day.recurringBreaks.filter(b => !day.closedDay && !off && scoped(b)).map(b => ({ key: 'break-'+b.id, start: b.starts_at, end: b.ends_at, label: displayRecurringBreakLabel(b.rule?.label) })),
            ].sort((a,b) => a.start.localeCompare(b.start));
            return <td key={day.date} className={`border-r border-b border-neutral-200 p-1.5 align-top last:border-r-0 ${day.date === initialDate ? "" : "hidden md:table-cell"} ${day.blocked || off ? "bg-neutral-50" : "bg-white"}`}>
              <div className="space-y-1">
                {day.blocked || off ? <span className="block text-neutral-600">{day.blocked ? displayBlockoutLabel(day.blockedReason) : "Off"}</span> :
                  window?.openTime && window.closeTime && <span className="block text-[10px] text-neutral-600">{timeRangeLabel(formatClockLabel(window.openTime.slice(0,5), timeFormat), formatClockLabel(window.closeTime.slice(0,5), timeFormat))}</span>}
                {blocks.map(b => <div key={b.key} className="rounded border border-dashed border-neutral-300 bg-neutral-50 px-1.5 py-1 text-neutral-700">{b.label} · {timeRangeLabel(formatTime(b.start), formatTime(b.end))}</div>)}
                {visits.map(a => {
                  const name = clientDisplayName(a.client ?? {}) || "Client";
                  const range = timeRangeLabel(formatTime(a.starts_at), a.ends_at ? formatTime(a.ends_at) : null);
                  const status = appointmentStatusTag(appointmentDisplayStatus(a.status, a.ends_at));
                  const label = [person.name, name, range, a.service?.name, status].filter(Boolean).join(" · ");
                  return <button key={a.id} type="button" data-week-appointment={a.id} aria-label={label} title={label} onClick={() => setPreviewId(a.id)}
                    className={`block w-full min-h-11 rounded-md border-l-2 px-1.5 py-1 text-left leading-tight hover:brightness-95 focus-visible:outline-2 ${appointmentCardClasses(a.service)} ${a.status === "no_show" ? NO_SHOW_CARD_CLASS : ""}`}>
                    <span className="flex items-center gap-1 text-[10px] font-medium tabular-nums"><span aria-hidden data-week-practitioner-dot="" className={`h-2 w-2 shrink-0 rounded-full ${person.swatchClass}`}/>{range}</span>
                    <span className="block break-words font-semibold">{a.status === "no_show" && "No-show · "}{name}</span>
                    <span className="block break-words text-[10px]">{[a.service?.name, a.status !== "no_show" && status].filter(Boolean).join(" · ")}</span>
                  </button>;
                })}
                {!visits.length && !blocks.length && !day.blocked && !off && <span className="text-neutral-500" aria-label="No appointments">—</span>}
              </div>
            </td>;
          })}
        </tr>)}</tbody>
      </table>
    </div>
    <AppointmentPreviewDrawer appointment={preview || null} onClose={() => setPreviewId(null)} studioTimezone={tz} timeFormat={timeFormat} returnTo={returnTo}/>
  </>;
}
