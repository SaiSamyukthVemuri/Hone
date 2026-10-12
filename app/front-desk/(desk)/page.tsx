import { requireReceptionistWithStudio } from "@/lib/receptionist/identity";
import { getFrontDeskCalendar, type FrontDeskAppointment } from "@/lib/receptionist/projections";
import {
  localCalendarDays,
  localDateKey as dayKey,
  localDateLabel as dayLabel,
  localDaysOverlapped,
} from "@/lib/receptionist/calendar-days";

// STUDIO-READY-02d (#824): the operational schedule, today plus six days, from
// receptionist_calendar and receptionist_calendar_closures ONLY. Read-only:
// receptionist booking, moving and cancelling come in a later slice (S4), over
// the shared scheduling core.
export const dynamic = "force-dynamic";

const DAYS = 7;

function time(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export default async function FrontDeskSchedulePage() {
  const { studio } = await requireReceptionistWithStudio();
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  // One extra day either side covers the studio's timezone offset; rows are
  // grouped by the studio's local day below.
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + DAYS + 2);

  const { appointments, closures } = await getFrontDeskCalendar(studio.id, from.toISOString(), to.toISOString());

  const tz = studio.timezone;
  const today = dayKey(new Date().toISOString(), tz);
  const keys = localCalendarDays(today, DAYS);
  const byDay = new Map<string, FrontDeskAppointment[]>();
  for (const a of appointments) {
    const k = dayKey(a.starts_at, tz);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(a);
  }
  const closuresByDay = new Map<string, number>();
  // A closure counts on EVERY local day it overlaps, not only the day it starts.
  for (const c of closures) {
    for (const k of localDaysOverlapped(c.starts_at, c.ends_at, tz)) {
      closuresByDay.set(k, (closuresByDay.get(k) ?? 0) + 1);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-medium">Schedule</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Times in {tz}. Showing appointment times, services and who is treating; treatment records are not
          available at the front desk.
        </p>
      </div>
      {keys.filter((k) => k >= today).map((k) => {
        const rows = (byDay.get(k) ?? []).filter((a) => a.status !== "cancelled");
        const blocked = closuresByDay.get(k) ?? 0;
        return (
          <section key={k} className="flex flex-col gap-2" aria-label={k}>
            <h2 className="text-sm font-medium">
              {dayLabel(k)}
              <span className="ml-2 text-xs font-normal text-neutral-500">
                {rows.length === 0 ? "No appointments" : `${rows.length} appointment${rows.length === 1 ? "" : "s"}`}
                {blocked > 0 ? ` · ${blocked} blocked period${blocked === 1 ? "" : "s"}` : ""}
              </span>
            </h2>
            {rows.length > 0 && (
              <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                {rows.map((a) => (
                  <li key={a.appointment_id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                    <span className="w-36 shrink-0 tabular-nums">
                      {time(a.starts_at, tz)}–{time(a.ends_at, tz)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{a.client_display_name ?? "—"}</span>
                    <span className="text-neutral-500">{a.service_name ?? "—"}</span>
                    <span className="flex items-center gap-1.5 text-neutral-500">
                      <span
                        aria-hidden
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: a.practitioner_color ?? "#a3a3a3" }}
                      />
                      {a.practitioner_display_name ?? "Unassigned"}
                    </span>
                    {a.status !== "confirmed" && (
                      <span className="text-xs text-neutral-500">{a.status.replace(/_/g, " ")}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
