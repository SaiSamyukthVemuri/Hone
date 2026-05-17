import Link from "next/link";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getAppointmentsForRange,
  getBlockouts,
} from "@/lib/booking/queries";
import {
  addDays,
  localDateString,
  localTimeString,
  startOfWeek,
  todayInTz,
  utcInstantFromLocal,
} from "@/lib/booking/tz";

const HOUR_START = 8;
const HOUR_END = 20;
const ROW_HEIGHT_PX = 30; // 30 minutes per row
const ROW_MINUTES = 30;
const VISIBLE_MINUTES = (HOUR_END - HOUR_START) * 60;
const GRID_HEIGHT = (VISIBLE_MINUTES / ROW_MINUTES) * ROW_HEIGHT_PX;

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

  const [appointments, blockouts] = await Promise.all([
    getAppointmentsForRange(studio.id, startUtc.toISOString(), endUtc.toISOString()),
    getBlockouts(studio.id),
  ]);

  const prevWeek = addDays(weekStart, -7);
  const nextWeek = addDays(weekStart, 7);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // Group appointments by their local date in the studio timezone.
  const byDate = new Map<string, typeof appointments>();
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

      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <div className="min-w-[840px]">
          <div className="grid grid-cols-[60px_repeat(7,_minmax(0,1fr))] border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
            <div />
            {days.map((date, i) => (
              <div key={date} className="border-l border-neutral-200 px-3 py-2 text-xs dark:border-neutral-800">
                <div className="font-medium">{DAY_LABELS[i]}</div>
                <div className="text-neutral-500">{date.slice(5)}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-[60px_repeat(7,_minmax(0,1fr))]">
            <div className="border-r border-neutral-200 dark:border-neutral-800">
              {Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i).map(
                (h) => (
                  <div
                    key={h}
                    style={{ height: 2 * ROW_HEIGHT_PX }}
                    className="border-b border-neutral-200 px-2 pt-1 text-[10px] uppercase tracking-wider text-neutral-500 dark:border-neutral-800"
                  >
                    {h}:00
                  </div>
                ),
              )}
            </div>
            {days.map((date) => (
              <DayColumn
                key={date}
                date={date}
                appts={byDate.get(date) ?? []}
                blocked={blockoutDates.has(date)}
                tz={studio.timezone}
              />
            ))}
          </div>
        </div>
      </div>

      <p className="text-xs text-neutral-500">
        Click an appointment for details. To book, open a client&rsquo;s page and
        tap Book appointment.
      </p>
    </div>
  );
}

function DayColumn({
  date,
  appts,
  blocked,
  tz,
}: {
  date: string;
  appts: import("@/lib/types/database").Appointment[];
  blocked: boolean;
  tz: string;
}) {
  return (
    <div
      className="relative border-l border-neutral-200 dark:border-neutral-800"
      style={{ height: GRID_HEIGHT }}
    >
      {/* Half-hour grid lines */}
      {Array.from(
        { length: VISIBLE_MINUTES / ROW_MINUTES },
        (_, i) => i,
      ).map((i) => (
        <div
          key={i}
          style={{
            top: i * ROW_HEIGHT_PX,
            height: ROW_HEIGHT_PX,
          }}
          className={
            "absolute inset-x-0 border-b " +
            (i % 2 === 1
              ? "border-neutral-200/60 dark:border-neutral-800/60"
              : "border-neutral-200 dark:border-neutral-800")
          }
        />
      ))}
      {blocked && (
        <div className="absolute inset-0 bg-neutral-100/80 dark:bg-neutral-800/40">
          <div className="px-2 pt-2 text-[11px] uppercase tracking-wider text-neutral-500">
            Blocked
          </div>
        </div>
      )}
      {appts.map((a) => {
        const start = new Date(a.starts_at);
        const localTime = localTimeString(start, tz);
        const [h, m] = localTime.split(":").map(Number);
        const startMinutesFromGridTop = (h - HOUR_START) * 60 + m;
        if (startMinutesFromGridTop < 0 || startMinutesFromGridTop >= VISIBLE_MINUTES) {
          return null;
        }
        const top = (startMinutesFromGridTop / ROW_MINUTES) * ROW_HEIGHT_PX;
        const height = Math.max(
          ROW_HEIGHT_PX - 2,
          (a.duration_minutes / ROW_MINUTES) * ROW_HEIGHT_PX - 2,
        );
        return (
          <Link
            key={a.id}
            href={`/calendar/${a.id}`}
            style={{ top, height }}
            className="absolute inset-x-1 z-10 overflow-hidden rounded-md border border-neutral-900 bg-neutral-900 px-2 py-1 text-[11px] text-white hover:bg-neutral-800 dark:border-white dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            <div className="truncate font-medium">
              {localTime} · {a.duration_minutes}m
            </div>
          </Link>
        );
      })}
    </div>
  );
}
