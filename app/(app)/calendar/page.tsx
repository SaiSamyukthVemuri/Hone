import Link from "next/link";
import {
  getClientsForStudio,
  getCurrentPractitionerWithStudio,
} from "@/lib/supabase/queries";
import {
  getActiveServices,
  getAppointmentsForRange,
  getAvailabilityDefaults,
  getBlockouts,
  getRecurringBreakOccurrencesForRange,
  getTimedBlocksForRange,
} from "@/lib/booking/queries";
import {
  addDays,
  localDateString,
  startOfWeek,
  todayInTz,
  utcInstantFromLocal,
} from "@/lib/booking/tz";
import type {
  AppointmentWithPractitionerColor,
  RecurringBreakOccurrenceWithRule,
} from "@/lib/booking/queries";
import type { StudioTimedBlock } from "@/lib/types/database";
import {
  DayColumn,
  GRID_HEIGHT,
  HOUR_END,
  HOUR_START,
  ROW_HEIGHT_PX,
  type DayAvailability,
} from "./DayColumn";
// Server-safe formatters: must come from a plain module, not the
// "use client" DayColumn — see calendar-format.ts header.
import {
  formatHourLabel,
  monthDayLabel,
  weekdayLabel,
} from "./calendar-format";

type Search = Promise<{ week?: string }>;

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Search;
}) {
  const { studio } = await getCurrentPractitionerWithStudio();
  const params = await searchParams;
  const today = todayInTz(studio.timezone);
  const weekStartParam = params.week ?? startOfWeek(today);
  const weekStart = startOfWeek(weekStartParam);
  const weekEnd = addDays(weekStart, 6);

  const startUtc = utcInstantFromLocal(weekStart, "00:00", studio.timezone);
  const endUtc = utcInstantFromLocal(addDays(weekStart, 7), "00:00", studio.timezone);

  const [
    appointments,
    blockouts,
    timedBlocks,
    recurringOccurrences,
    services,
    clients,
    availabilityDefaults,
  ] = await Promise.all([
    getAppointmentsForRange(studio.id, startUtc.toISOString(), endUtc.toISOString()),
    getBlockouts(studio.id),
    getTimedBlocksForRange(studio.id, startUtc.toISOString(), endUtc.toISOString()),
    getRecurringBreakOccurrencesForRange(
      studio.id,
      startUtc.toISOString(),
      endUtc.toISOString(),
    ),
    getActiveServices(studio.id),
    getClientsForStudio(studio.id),
    // Read-only weekly availability for the calendar's neutral
    // open/closed tint. One small query (≤7 rows), parallel with the
    // rest; never feeds booking math. Visual guidance only.
    getAvailabilityDefaults(studio.id),
  ]);

  // Index weekly availability by day_of_week (0=Sun..6=Sat), matching the
  // Sunday-start `days` array below. Days with no configured default map
  // to null → no tint.
  const availabilityByDow = new Map<number, DayAvailability>();
  for (const d of availabilityDefaults) {
    availabilityByDow.set(d.day_of_week, {
      isOpen: d.is_open,
      openTime: d.open_time,
      closeTime: d.close_time,
    });
  }

  // The drawer only needs the small subset used for search + display. We
  // strip out timestamps, intake fields, and notes so the RSC payload sent
  // to the client tree stays compact even on studios with many clients.
  const drawerClients = clients.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    pronouns: c.pronouns,
  }));

  const prevWeek = addDays(weekStart, -7);
  const nextWeek = addDays(weekStart, 7);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // Group appointments by their local date in the studio timezone.
  const byDate = new Map<string, AppointmentWithPractitionerColor[]>();
  for (const a of appointments) {
    if (a.status !== "confirmed") continue;
    const localDate = localDateString(new Date(a.starts_at), studio.timezone);
    const arr = byDate.get(localDate) ?? [];
    arr.push(a);
    byDate.set(localDate, arr);
  }

  const blockoutDates = new Set<string>();
  for (const b of blockouts) {
    for (let d = b.starts_on; d <= b.ends_on; d = addDays(d, 1)) {
      blockoutDates.add(d);
    }
  }

  // Group timed blocks by their local date in studio tz, same as
  // appointments. A block straddling local midnight is rendered on
  // its starting day.
  const timedBlocksByDate = new Map<string, StudioTimedBlock[]>();
  for (const tb of timedBlocks) {
    const localDate = localDateString(new Date(tb.starts_at), studio.timezone);
    const arr = timedBlocksByDate.get(localDate) ?? [];
    arr.push(tb);
    timedBlocksByDate.set(localDate, arr);
  }

  // Same grouping for recurring break occurrences.
  const recurringByDate = new Map<string, RecurringBreakOccurrenceWithRule[]>();
  for (const occ of recurringOccurrences) {
    const localDate = localDateString(new Date(occ.starts_at), studio.timezone);
    const arr = recurringByDate.get(localDate) ?? [];
    arr.push(occ);
    recurringByDate.set(localDate, arr);
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Calendar</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Week of {weekStart} → {weekEnd} · {studio.timezone}
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`/calendar?week=${prevWeek}`}
            className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            ← Prev
          </Link>
          <Link
            href="/calendar"
            className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Today
          </Link>
          <Link
            href={`/calendar?week=${nextWeek}`}
            className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Next →
          </Link>
          <Link
            href="/calendar/upcoming"
            className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Upcoming
          </Link>
        </div>
      </header>

      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
        <div className="min-w-[840px]">
          <div className="grid grid-cols-[60px_repeat(7,_minmax(0,1fr))] border-b border-neutral-200 bg-neutral-50/70 dark:border-neutral-800 dark:bg-neutral-900/50">
            <div />
            {days.map((date, i) => {
              const isToday = date === today;
              return (
                <div
                  key={date}
                  className="border-l border-neutral-100 px-3 py-2.5 dark:border-neutral-800/60"
                >
                  {/* Two-line Google/Fresha header: weekday over date.
                      Today gets a subtle text accent only — no ring, no
                      badge, no extra height. */}
                  <div
                    className={
                      "text-[11px] uppercase tracking-wide " +
                      (isToday
                        ? "font-semibold text-neutral-900 dark:text-neutral-100"
                        : "font-medium text-neutral-500 dark:text-neutral-400")
                    }
                  >
                    {weekdayLabel(i)}
                  </div>
                  <div
                    className={
                      "text-sm " +
                      (isToday
                        ? "font-semibold text-neutral-900 dark:text-neutral-100"
                        : "font-normal text-neutral-700 dark:text-neutral-300")
                    }
                  >
                    {monthDayLabel(date)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Body grid. Time rail uses the calendar's OWN positioning
              model — a relative, explicit-height column with each hour
              label absolutely positioned at its top offset — exactly how
              DayColumn places its grid lines and event cards. The earlier
              flow-based rail (block cells relying on grid-row stretch)
              rendered blank in production three times despite correct
              markup; absolute positioning removes the dependency on
              grid-row stretch entirely. Row math is unchanged:
              top = (h - HOUR_START) * 2 * ROW_HEIGHT_PX lines each label
              up with the DayColumn hour boundaries. */}
          <div className="grid grid-cols-[60px_repeat(7,_minmax(0,1fr))]">
            <div
              className="relative border-r border-neutral-200 dark:border-neutral-800"
              style={{ height: GRID_HEIGHT }}
            >
              {Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i).map(
                (h) => (
                  <div
                    key={h}
                    style={{
                      top: (h - HOUR_START) * 2 * ROW_HEIGHT_PX,
                      height: 2 * ROW_HEIGHT_PX,
                    }}
                    className="absolute inset-x-0 border-b border-neutral-200 px-2 pt-1 text-right text-[11px] font-semibold uppercase tracking-wider text-neutral-700 dark:border-neutral-800 dark:text-neutral-200"
                  >
                    {formatHourLabel(h)}
                  </div>
                ),
              )}
            </div>
            {days.map((date, i) => (
              <DayColumn
                key={date}
                date={date}
                appts={byDate.get(date) ?? []}
                timedBlocks={timedBlocksByDate.get(date) ?? []}
                recurringBreaks={recurringByDate.get(date) ?? []}
                blocked={blockoutDates.has(date)}
                tz={studio.timezone}
                clients={drawerClients}
                services={services}
                isToday={date === today}
                availability={availabilityByDow.get(i) ?? null}
              />
            ))}
          </div>
        </div>
      </div>

      <p className="text-xs text-neutral-500">
        Click an appointment for details, or click an empty time slot to draft
        a new appointment.
      </p>
    </div>
  );
}
