import { withDashboardRebook, type RebookOrigin } from "@/lib/calendar/dashboard-rebook";
import { PendingContainerLink, PendingLink } from "@/components/pending-link";
import { localDateString, startOfWeek } from "@/lib/booking/tz";
import { dayOfMonth, firstOfMonthString, isInMonth, monthGridDates, monthYearLabel } from "@/lib/booking/month-grid";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";
import { appointmentCardClasses } from "@/lib/calendar/service-colors";
import { clientDisplayName } from "@/lib/clients/identity";
import { calendarPractitionerIdentity, type CalendarPractitionerIdentity } from "@/lib/calendar/practitioner-identity";
import { withSelection } from "@/lib/calendar/practitioner-selection";
import { appointmentDisplayStatus, appointmentStatusTag } from "./appointment-display-status";
import { displayBlockoutLabel } from "./calendar-format";
import { buildCalendarReturnParams } from "./calendar-return";
import type { MonthDayBlocked } from "./month-blocked";

type MonthDayAppt = Pick<AppointmentWithPractitionerColor, "id" | "status" | "starts_at" | "ends_at" | "service"> & {
  clientName: string;
  localTime: string;
  practitionerId: string | null;
  practitioner: CalendarPractitionerIdentity | null;
};

function visitsLabel(count: number) {
  return `${count} ${count === 1 ? "visit" : "visits"}`;
}

export function MonthView({
  rebook,
  monthAnchor, appointmentsByDate, blockedByDate, today, selectedDate = today, hasDayView = false, isClosedDate, selectionParam,
}: {
  rebook?: RebookOrigin | null;
  monthAnchor: string;
  appointmentsByDate: Map<string, MonthDayAppt[]>;
  blockedByDate: Map<string, MonthDayBlocked>;
  today: string;
  selectedDate?: string;
  hasDayView?: boolean;
  isClosedDate: (date: string) => boolean;
  selectionParam?: string;
}) {
  const picked = appointmentsByDate.get(selectedDate) ?? [];
  const returnTo = buildCalendarReturnParams({ view: "month", month: monthAnchor, day: selectedDate });
  const scheduleHref = hasDayView
    ? withSelection(`/calendar?view=day&day=${selectedDate}`, selectionParam)
    : withSelection(`/calendar?view=week&week=${startOfWeek(selectedDate)}&day=${selectedDate}`, selectionParam);
  const selectedLabel = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })
    .format(new Date(selectedDate + "T12:00:00Z"));

  return <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,26%)]">
    <section aria-label={monthYearLabel(monthAnchor)} className="min-w-0 overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <div className="grid grid-cols-7 border-b border-neutral-200 bg-neutral-50 text-center text-[11px] font-semibold text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => <span key={d} className="py-2">{d}</span>)}
      </div>
      <div className="grid grid-cols-7">
        {monthGridDates(monthAnchor).map(cellDate => {
          const inMonth = isInMonth(cellDate, monthAnchor);
          const closed = inMonth && isClosedDate(cellDate);
          const visits = appointmentsByDate.get(cellDate) ?? [];
          const counts = new Map<string | null, { name: string; swatch: string; count: number }>();
          for (const a of visits) {
            const group = counts.get(a.practitionerId);
            if (group) group.count++;
            else counts.set(a.practitionerId, {
              name: a.practitioner?.name || (a.practitionerId ? "Former practitioner" : "Unassigned"),
              swatch: a.practitioner?.swatchClass || "bg-neutral-400", count: 1,
            });
          }
          const blocked = blockedByDate.get(cellDate);
          const blockedLabel = blocked?.fullDay ? displayBlockoutLabel(blocked.fullDayReason) : blocked?.labels.join(" · ");
          const summaryId = `month-day-${cellDate}`;
          const dayHref = withSelection(`/calendar?view=month&month=${firstOfMonthString(cellDate)}&day=${cellDate}`, selectionParam);
          return <PendingContainerLink key={cellDate} href={withDashboardRebook(dayHref, rebook) + "#month-agenda"} prefetch={false}
            aria-label={`Open ${cellDate}`} aria-describedby={inMonth ? summaryId : undefined}
            aria-current={cellDate === selectedDate ? "date" : undefined}
            className={`flex min-h-[64px] min-w-0 flex-col gap-1 border-b border-r border-neutral-100 p-1 hover:bg-neutral-100 sm:min-h-[84px] sm:p-2 dark:border-neutral-800 dark:hover:bg-neutral-800 ${cellDate === today ? "border-t-2 border-t-sky-500" : ""} ${closed || !inMonth ? "bg-neutral-50 dark:bg-neutral-900" : ""} aria-[current=date]:bg-neutral-100 aria-[current=date]:ring-1 aria-[current=date]:ring-inset aria-[current=date]:ring-neutral-700 dark:aria-[current=date]:bg-neutral-800`}>
            <span aria-label={cellDate === today ? "Today" : undefined} className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${cellDate === today ? "bg-sky-600 text-white dark:bg-sky-500" : !inMonth ? "text-neutral-400" : ""}`}>
              {dayOfMonth(cellDate)}
            </span>
            {inMonth && <>
              <span id={summaryId} className="text-[10px] tabular-nums text-neutral-600 sm:text-xs dark:text-neutral-300">
                <span data-month-count={visits.length}>{visits.length}</span><span className="sr-only sm:not-sr-only"> {visits.length === 1 ? "visit" : "visits"}</span>
                <span className="sr-only">{Array.from(counts.values()).map(p => `, ${p.name} ${p.count}`).join("")}</span>
              </span>
              {counts.size > 0 && <span className="flex flex-wrap gap-[3px]">
                {Array.from(counts, ([id, p]) => <span key={id ?? "unassigned"} title={`${p.name} · ${visitsLabel(p.count)}`}
                  aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${p.swatch}`} />)}
              </span>}
              {closed && <span className="truncate text-[9px] text-neutral-500">Closed</span>}
              {blockedLabel && <span title={blockedLabel} className="truncate rounded border border-stone-300 bg-stone-100 px-0.5 text-[9px] text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200">{blockedLabel}</span>}
            </>}
          </PendingContainerLink>;
        })}
      </div>
    </section>
    <section id="month-agenda" aria-label="Selected day appointments" className="min-w-0 scroll-mt-4 overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <div className="space-y-1 border-b border-neutral-200 p-3 dark:border-neutral-800">
        <h2 className="font-semibold">{selectedLabel}</h2>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">{visitsLabel(picked.length)}</p>
        <PendingLink href={scheduleHref} className="inline-flex min-h-11 items-center text-sm font-medium underline">{hasDayView ? "Open day calendar" : "Open week calendar"}</PendingLink>
      </div>
      {picked.length === 0 && <p className="p-3 text-sm text-neutral-600 dark:text-neutral-400">No appointments for the selected practitioners.</p>}
      <ul className="max-h-[60dvh] divide-y divide-neutral-100 overflow-y-auto dark:divide-neutral-800">
        {picked.map(a => {
          const status = appointmentDisplayStatus(a.status, a.ends_at);
          const statusTag = appointmentStatusTag(status);
          const time = a.localTime.replace(/^0/, "");
          return <li key={a.id}>
            <PendingContainerLink href={`/calendar/${a.id}${returnTo}`} prefetch={false}
              className="flex min-h-11 items-center gap-2 p-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900">
              <span title={[time, a.service?.name, a.practitioner?.name, statusTag].filter(Boolean).join(" · ")}
                className={`flex min-w-0 flex-1 flex-col gap-0.5 rounded border-l-[3px] px-2 py-1 ${appointmentCardClasses(a.service)} ${status === "upcoming" ? "" : "opacity-60"} ${status === "no_show" ? "border-dashed" : ""}`}>
                <span className="text-xs tabular-nums">{statusTag && <span>{statusTag} · </span>}{time}</span>
                <span className="break-words font-semibold">{a.clientName}</span>
                <span className="break-words text-xs">{a.service?.name}</span>
                <span className="text-xs">{a.practitioner && <span aria-hidden="true" data-testid="month-chip-swatch" className={`mr-1 inline-block h-2 w-2 rounded-full ${a.practitioner.swatchClass}`} />}{a.practitioner?.name || (a.practitionerId ? "Former practitioner" : "Unassigned")}</span>
              </span>
            </PendingContainerLink>
          </li>;
        })}
      </ul>
    </section>
  </div>;
}

export function groupMonthAppointmentsByDate(
  appointments: ReadonlyArray<AppointmentWithPractitionerColor>,
  tz: string,
  localTimeForLabel: (iso: string, tz: string) => string,
): Map<string, MonthDayAppt[]> {
  const byDate = new Map<string, MonthDayAppt[]>();
  for (const a of appointments) {
    if (a.status === "cancelled") continue;
    const localDate = localDateString(new Date(a.starts_at), tz);
    const arr = byDate.get(localDate) ?? [];
    arr.push({
      id: a.id, status: a.status, starts_at: a.starts_at, ends_at: a.ends_at, service: a.service,
      clientName: clientDisplayName(a.client ?? {}) || "Client",
      localTime: localTimeForLabel(a.starts_at, tz), practitionerId: a.practitioner_id,
      practitioner: calendarPractitionerIdentity(a.practitioner),
    });
    byDate.set(localDate, arr);
  }
  for (const list of byDate.values()) list.sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  return byDate;
}
