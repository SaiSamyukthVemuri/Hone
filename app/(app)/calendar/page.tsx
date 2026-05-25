import Link from "next/link";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getAppointmentsForRange,
  getBlockouts,
  getRecurringBreakOccurrencesForRange,
  getTimedBlocksForRange,
  type AppointmentWithPractitionerColor,
  type RecurringBreakOccurrenceWithRule,
} from "@/lib/booking/queries";
import type { StudioTimedBlock } from "@/lib/types/database";
import {
  addDays,
  localDateString,
  localTimeString,
  startOfWeek,
  todayInTz,
  utcInstantFromLocal,
} from "@/lib/booking/tz";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";

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

  const [appointments, blockouts, timedBlocks, recurringOccurrences] =
    await Promise.all([
      getAppointmentsForRange(studio.id, startUtc.toISOString(), endUtc.toISOString()),
      getBlockouts(studio.id),
      getTimedBlocksForRange(studio.id, startUtc.toISOString(), endUtc.toISOString()),
      getRecurringBreakOccurrencesForRange(
        studio.id,
        startUtc.toISOString(),
        endUtc.toISOString(),
      ),
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
                appts={byDate.get(date) ?? []}
                timedBlocks={timedBlocksByDate.get(date) ?? []}
                recurringBreaks={recurringByDate.get(date) ?? []}
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

const TIMED_BLOCK_LABEL: Record<string, string> = {
  lunch: "Lunch",
  break: "Break",
  meeting: "Meeting",
  emergency: "Emergency",
  personal: "Personal",
  training: "Training",
  admin: "Admin",
  other: "Unavailable",
};

const RECURRING_BREAK_LABEL: Record<string, string> = {
  lunch: "Lunch",
  break: "Break",
  admin: "Admin",
  other: "Break",
};

function DayColumn({
  appts,
  timedBlocks,
  recurringBreaks,
  blocked,
  tz,
}: {
  appts: AppointmentWithPractitionerColor[];
  timedBlocks: StudioTimedBlock[];
  recurringBreaks: RecurringBreakOccurrenceWithRule[];
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
      {recurringBreaks.map((occ) => {
        const start = new Date(occ.starts_at);
        const end = new Date(occ.ends_at);
        const localTime = localTimeString(start, tz);
        const localEndTime = localTimeString(end, tz);
        const [h, m] = localTime.split(":").map(Number);
        const startMinutesFromGridTop = (h - HOUR_START) * 60 + m;
        if (
          startMinutesFromGridTop < 0 ||
          startMinutesFromGridTop >= VISIBLE_MINUTES
        ) {
          return null;
        }
        const durationMinutes = Math.max(
          5,
          Math.round((end.getTime() - start.getTime()) / 60_000),
        );
        const top = (startMinutesFromGridTop / ROW_MINUTES) * ROW_HEIGHT_PX;
        const height = Math.max(
          ROW_HEIGHT_PX - 2,
          (durationMinutes / ROW_MINUTES) * ROW_HEIGHT_PX - 2,
        );
        const rawLabel = occ.rule?.label ?? "break";
        const label = RECURRING_BREAK_LABEL[rawLabel] ?? "Break";
        return (
          <BlockoutCard
            key={occ.id}
            label={label}
            title={label}
            startLocal={localTime}
            endLocal={localEndTime}
            durationMinutes={durationMinutes}
            top={top}
            height={height}
          />
        );
      })}
      {timedBlocks.map((tb) => {
        const start = new Date(tb.starts_at);
        const end = new Date(tb.ends_at);
        const localTime = localTimeString(start, tz);
        const localEndTime = localTimeString(end, tz);
        const [h, m] = localTime.split(":").map(Number);
        const startMinutesFromGridTop = (h - HOUR_START) * 60 + m;
        if (
          startMinutesFromGridTop < 0 ||
          startMinutesFromGridTop >= VISIBLE_MINUTES
        ) {
          return null;
        }
        const durationMinutes = Math.max(
          5,
          Math.round((end.getTime() - start.getTime()) / 60_000),
        );
        const top = (startMinutesFromGridTop / ROW_MINUTES) * ROW_HEIGHT_PX;
        const height = Math.max(
          ROW_HEIGHT_PX - 2,
          (durationMinutes / ROW_MINUTES) * ROW_HEIGHT_PX - 2,
        );
        const label = TIMED_BLOCK_LABEL[tb.category] ?? "Unavailable";
        const titleNote = tb.private_note
          ? `${label}: ${tb.private_note}`
          : label;
        return (
          <BlockoutCard
            key={tb.id}
            label={label}
            title={titleNote}
            startLocal={localTime}
            endLocal={localEndTime}
            durationMinutes={durationMinutes}
            top={top}
            height={height}
          />
        );
      })}
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
        const color = resolvePractitionerColor(a.practitioner?.color);
        return (
          <Link
            key={a.id}
            href={`/calendar/${a.id}`}
            style={{ top, height }}
            className={`absolute inset-x-1 z-10 overflow-hidden rounded-md ${color.bg} ${color.text} px-2 py-1 text-[11px] hover:opacity-90`}
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

// Gray blockout/break/timed-block card. The card always renders inside the
// caller-computed (top, height) box so schedule positioning is unchanged.
// Layout is height-adaptive: at 40px or more we can show label + time on
// two lines with leading-tight; below that the box is too short for two
// text-[11px] lines + px-2 py-1 padding, so a one-line compact form is
// rendered instead ("Lunch · 12:15–12:30"). Without this branch a 15-
// minute lunch ends up showing "Lunch" with its time clipped under the
// card bottom — the bug this card fixes.
function BlockoutCard({
  label,
  title,
  startLocal,
  endLocal,
  durationMinutes,
  top,
  height,
}: {
  label: string;
  title: string;
  startLocal: string;
  endLocal: string;
  durationMinutes: number;
  top: number;
  height: number;
}) {
  const twoLine = height >= 40;
  return (
    <div
      title={title}
      style={{ top, height }}
      className="absolute inset-x-1 z-[5] overflow-hidden rounded-md bg-neutral-200 px-2 py-1 text-[11px] leading-tight text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
    >
      {twoLine ? (
        <>
          <div className="truncate font-medium">{label}</div>
          <div className="truncate text-[10px] opacity-80">
            {startLocal}–{endLocal} · {durationMinutes}m
          </div>
        </>
      ) : (
        <div className="truncate font-medium">
          {label} <span className="opacity-70">· {startLocal}–{endLocal}</span>
        </div>
      )}
    </div>
  );
}
