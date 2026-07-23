import {
  getClientsForStudio,
  getCurrentPractitionerWithStudio,
} from "@/lib/supabase/queries";
import {
  getActiveServices,
  getAppointmentsForRange,
  getAvailabilityDefaults,
  getBlockouts,
  getOverridesForRange,
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
import { DayColumn, type DayAvailability } from "./DayColumn";
import { buildCalendarReturnParams } from "./calendar-return";
// Grid constants + formatters MUST come from plain (non-"use client")
// modules. Importing them from the "use client" DayColumn turned them
// into client-reference proxies in this Server Component, so the rail's
// `Array.from({ length: HOUR_END - HOUR_START })` produced 0 children
// and the time labels never rendered. See calendar-constants.ts.
import {
  GRID_HEIGHT,
  HOUR_END,
  HOUR_START,
  ROW_HEIGHT_PX,
} from "./calendar-constants";
import {
  formatHourLabel,
  monthDayLabel,
  weekdayLabel,
  weekRangeLabel,
} from "./calendar-format";
import { CalendarToolbar } from "./CalendarToolbar";
import {
  CalendarMobileDayView,
  type MobileDayData,
} from "./CalendarMobileDayView";
import { MonthView, groupMonthAppointmentsByDate } from "./MonthView";
import { groupMonthBlockedByDate } from "./month-blocked";
import {
  firstOfMonthString,
  firstOfNextMonthString,
  firstOfPreviousMonthString,
  monthYearLabel,
} from "@/lib/booking/month-grid";
import { formatTimeForStudio, resolveTimeFormat, type TimeFormat } from "@/lib/booking/tz";

type Search = Promise<{
  week?: string;
  view?: string;
  month?: string;
  // Mobile day view: the selected day. Anchors the loaded week to the week
  // containing that day; desktop still renders that whole week unchanged.
  day?: string;
}>;

function parseView(raw: string | undefined): "week" | "month" {
  return raw === "month" ? "month" : "week";
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Search;
}) {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const timeFormat = resolveTimeFormat(studio); // 0109: 12h/24h display pref
  const isOwner = practitioner.role === "owner"; // PR C: owner-only block editing
  const params = await searchParams;
  const today = todayInTz(studio.timezone);
  const view = parseView(params.view);

  // The week view continues to default to the current week unless a
  // ?week= is provided. The month view is gated on `view === "month"`
  // and uses its own ?month= anchor; the two states are independent
  // so a week-tab click never resets a month anchor and vice versa.
  if (view === "month") {
    return renderMonthView({
      studio,
      timeFormat,
      today,
      monthParam: params.month,
      // Pass the same week anchor through so the Week tab in the
      // header carries the practitioner's last week context (or
      // defaults to today when missing).
      lastWeekParam: params.week,
    });
  }

  // Anchor the loaded week. A ?day= (from the mobile day view) wins and loads
  // the week CONTAINING that day; existing ?week= links are unchanged; else the
  // current week. Desktop always renders the resolved 7-day week either way.
  const weekStartParam = params.day ?? params.week ?? startOfWeek(today);
  const weekStart = startOfWeek(weekStartParam);
  const weekEnd = addDays(weekStart, 6);
  // Mobile day view's initial selected day: the ?day= if present, else today
  // when it's in the loaded week, else the week's first day.
  const initialSelectedDate =
    params.day ?? (today >= weekStart && today <= weekEnd ? today : weekStart);

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
    availabilityOverrides,
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
    // Read-only per-date availability overrides for the visible week,
    // used (with the weekday defaults) to resolve each date's open/closed
    // status the SAME way public booking does: override wins, else default,
    // else closed. Display-only; never feeds booking math.
    getOverridesForRange(studio.id, weekStart, weekEnd),
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

  // Per-date availability overrides keyed by effective_date ("YYYY-MM-DD").
  const overrideByDate = new Map<string, boolean>();
  for (const o of availabilityOverrides) {
    overrideByDate.set(o.effective_date, o.is_open);
  }

  // Resolve whether a given visible date (Sunday-start index i = day_of_week)
  // is closed, using the SAME precedence as public booking's slot generation
  // (lib/booking/slots.ts): a date override wins; else the weekday default;
  // else (no default configured) the day is closed. Display-only — used to
  // hide auto-materialized recurring breaks on closed dates.
  function isClosedDate(date: string, dow: number): boolean {
    const override = overrideByDate.get(date);
    if (override !== undefined) return !override;
    const def = availabilityByDow.get(dow);
    if (def) return !def.isOpen;
    return true;
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

  // Return context for appointment-detail links: send the practitioner back to
  // THIS week view/date when they return from an appointment (not today).
  const returnTo = buildCalendarReturnParams({ view: "week", week: weekStart });

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // Group appointments by their local date in the studio timezone.
  const byDate = new Map<string, AppointmentWithPractitionerColor[]>();
  for (const a of appointments) {
    // Show confirmed, completed, and no-show appointments on the grid.
    // Only cancelled appointments are hidden (their slot is freed). Previously
    // every non-confirmed status was dropped, which made completed and
    // no-show appointments disappear from the calendar. Display-only: slot
    // availability still gates on confirmed via the booking engine.
    if (a.status === "cancelled") continue;
    const localDate = localDateString(new Date(a.starts_at), studio.timezone);
    const arr = byDate.get(localDate) ?? [];
    arr.push(a);
    byDate.set(localDate, arr);
  }

  // Map each blocked date to its blockout reason (first blockout covering the
  // date wins) so the week overlay can show the reason instead of bare
  // "Blocked". Presence in the map = blocked; the value may be null (no reason).
  const blockoutReasonByDate = new Map<string, string | null>();
  for (const b of blockouts) {
    for (let d = b.starts_on; d <= b.ends_on; d = addDays(d, 1)) {
      if (!blockoutReasonByDate.has(d)) blockoutReasonByDate.set(d, b.reason);
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

  // Per-day slices of the SAME loaded week data for the mobile day view — no
  // new query, no divergent status/tz rules (identical maps the desktop grid
  // uses). Passed as plain JSON to the client CalendarMobileDayView.
  const mobileDays: MobileDayData[] = days.map((date, i) => ({
    date,
    weekdayShort: weekdayLabel(i),
    monthDayLabel: monthDayLabel(date),
    appts: byDate.get(date) ?? [],
    timedBlocks: timedBlocksByDate.get(date) ?? [],
    recurringBreaks: recurringByDate.get(date) ?? [],
    availability: availabilityByDow.get(i) ?? null,
    closedDay: isClosedDate(date, i),
    blocked: blockoutReasonByDate.has(date),
    blockedReason: blockoutReasonByDate.get(date) ?? null,
    isToday: date === today,
  }));

  return (
    <div className="flex flex-col gap-6">
      {/* Google/Apple-style toolbar. Week-scoped step nav (Today/‹/›) is
          desktop-only: on mobile the PR #380 day view owns day navigation, so
          these week controls would be redundant. */}
      <CalendarToolbar
        view="week"
        rangeLabel={weekRangeLabel(weekStart, weekEnd)}
        timezone={studio.timezone}
        weekHref={`/calendar?view=week&week=${weekStart}`}
        monthHref={`/calendar?view=month&month=${firstOfMonthString(weekStart)}&week=${weekStart}`}
        prevHref={`/calendar?week=${prevWeek}`}
        todayHref="/calendar"
        nextHref={`/calendar?week=${nextWeek}`}
        upcomingHref="/calendar/upcoming"
        hideStepNavOnMobile
      />

      {/* Layout (PR B): the calendar body scrolls INTERNALLY — the grid is a
          fixed 1020px, so without a height bound it forced the whole page to
          scroll. max-h + overflow-y-auto keeps it within the viewport; the
          day-of-week header stays sticky at the top and the time rail stays
          sticky at the left (so hour labels remain visible while scrolling
          across days on mobile). Drag/positioning math is viewport-relative
          (getBoundingClientRect) and unaffected. */}
      {/* Mobile primary surface (PR: mobile calendar redesign): a single-day
          vertical timeline. Replaces the sideways-scrollable 7-day grid on
          small screens. Reuses the same loaded week data + the existing
          drawers. Self-gates with md:hidden. */}
      <CalendarMobileDayView
        days={mobileDays}
        initialDate={initialSelectedDate}
        today={today}
        tz={studio.timezone}
        timeFormat={timeFormat}
        isOwner={isOwner}
        practitionerCapacityEnabled={studio.practitioner_capacity_enabled === true}
        currentPractitionerId={practitioner.id}
        currentPractitionerName={practitioner.display_name}
        clients={drawerClients}
        services={services}
        returnTo={returnTo}
      />

      {/* Desktop/tablet keep the existing week grid, untouched, at md+. */}
      {/* PR B: desktop week body = ONE clean vertical scroll. The columns are
          minmax(0,1fr) so they always flex to fit the container width — no
          horizontal scroll and no min-width forcing on desktop. Sticky day
          header + sticky time rail + the 1px=1min positioning math are
          unchanged. */}
      <div className="hidden max-h-[calc(100dvh-13rem)] overflow-y-auto rounded-xl border border-neutral-200 bg-white shadow-sm md:block dark:border-neutral-800 dark:bg-neutral-950">
        <div>
          <div className="sticky top-0 z-20 grid grid-cols-[60px_repeat(7,_minmax(0,1fr))] border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="sticky left-0 z-30 border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900" />
            {days.map((date, i) => {
              const isToday = date === today;
              return (
                <div
                  key={date}
                  className={
                    "border-l border-neutral-300 px-3 py-2.5 dark:border-neutral-700" +
                    // Today's header cell: PR #194 (Chloe iPad feedback)
                    // strengthened the tint and added a top accent bar
                    // so the current day is unmistakable on washed-out
                    // tablet screens. Still calm: one band, no badge.
                    (isToday
                      ? " border-t-[3px] border-t-sky-600 bg-sky-200 dark:border-t-sky-400 dark:bg-sky-900/60"
                      : "")
                  }
                >
                  {/* Two-line Google/Fresha header: weekday over date.
                      Today gets a subtle text accent + faint sky tint — no
                      ring, no badge, no extra height. */}
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
            {/* Time rail: sticky-left so hour labels stay visible while
                scrolling across days on mobile. `sticky` (not `relative`) still
                establishes the positioning context the absolute hour labels
                rely on, so their top offsets are unchanged. z-30 keeps the rail
                above day-column cards (z-5/6) + now-line (z-20) as columns
                scroll under it. */}
            <div
              className="sticky left-0 z-30 border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
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
                blocked={blockoutReasonByDate.has(date)}
                blockedReason={blockoutReasonByDate.get(date) ?? null}
                tz={studio.timezone}
                timeFormat={timeFormat}
                isOwner={isOwner}
                practitionerCapacityEnabled={studio.practitioner_capacity_enabled === true}
                currentPractitionerId={practitioner.id}
                currentPractitionerName={practitioner.display_name}
                clients={drawerClients}
                services={services}
                isToday={date === today}
                availability={availabilityByDow.get(i) ?? null}
                closedDay={isClosedDate(date, i)}
                returnTo={returnTo}
              />
            ))}
          </div>
        </div>
      </div>

      <p className="hidden text-xs text-neutral-500 md:block">
        Click an empty time slot to draft a new appointment, or drag to
        select a duration. Click an appointment for details.
      </p>
    </div>
  );
}

// -----------------------------------------------------------------
// Month view path.
// -----------------------------------------------------------------
// Separate render function so the week-view code above stays a
// straight-line render that mirrors the pre-PR shape. The month
// view shares the same auth / studio resolution as the week view
// (already done in the caller) but loads a different appointment
// range and uses its own grouping helper.
//
// Closed-day resolution here uses the SAME precedence as the week
// view (override wins → weekday default → no-default = closed). The
// month view only renders the closed pill in-month so spillover
// days don't get a distracting bottom-right "Closed" tag.

async function renderMonthView(opts: {
  studio: { id: string; timezone: string };
  timeFormat: TimeFormat;
  today: string;
  monthParam: string | undefined;
  lastWeekParam: string | undefined;
}) {
  const { studio, timeFormat, today, monthParam, lastWeekParam } = opts;
  const monthAnchor = firstOfMonthString(monthParam ?? today);
  const monthEnd = firstOfNextMonthString(monthAnchor);
  const prevMonth = firstOfPreviousMonthString(monthAnchor);
  const nextMonth = firstOfNextMonthString(monthAnchor);

  // Visible appointment range: the 42-cell grid usually spans from a
  // Sunday in the previous month to a Saturday in the next month. We
  // load appointments for the whole month (not the spillover days)
  // because the month view's main job is to surface "what's on this
  // month"; the spillover days are shown for orientation and only
  // get appointments when they happen to also be in the studio month
  // we loaded. This is intentional; spillover counts come from the
  // month load itself when applicable, not from extra queries.
  const startUtc = utcInstantFromLocal(monthAnchor, "00:00", studio.timezone);
  const endUtc = utcInstantFromLocal(monthEnd, "00:00", studio.timezone);

  const [
    appointments,
    availabilityDefaults,
    availabilityOverrides,
    blockouts,
    timedBlocks,
    recurringOccurrences,
  ] = await Promise.all([
    getAppointmentsForRange(
      studio.id,
      startUtc.toISOString(),
      endUtc.toISOString(),
    ),
    getAvailabilityDefaults(studio.id),
    // Read-only per-date overrides for the month so the muted
    // "Closed" tint resolves the same way the week view does.
    getOverridesForRange(studio.id, monthAnchor, monthEnd),
    // Blocked-time sources for the month, same as the week view, so the
    // month grid shows blocked-time indicators (Chloe pilot feedback).
    getBlockouts(studio.id),
    getTimedBlocksForRange(studio.id, startUtc.toISOString(), endUtc.toISOString()),
    getRecurringBreakOccurrencesForRange(
      studio.id,
      startUtc.toISOString(),
      endUtc.toISOString(),
    ),
  ]);

  const availabilityByDow = new Map<number, boolean>();
  for (const d of availabilityDefaults) {
    availabilityByDow.set(d.day_of_week, d.is_open);
  }
  const overrideByDate = new Map<string, boolean>();
  for (const o of availabilityOverrides) {
    overrideByDate.set(o.effective_date, o.is_open);
  }
  function isClosedDate(dateStr: string): boolean {
    const override = overrideByDate.get(dateStr);
    if (override !== undefined) return !override;
    // Sunday-start dow consistent with the week view's mapping.
    const [y, m, d] = dateStr.split("-").map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const def = availabilityByDow.get(dow);
    if (def === undefined) return true;
    return !def;
  }

  const appointmentsByDate = groupMonthAppointmentsByDate(
    appointments,
    studio.timezone,
    (iso, tz) => formatTimeForStudio(new Date(iso), tz, timeFormat),
  );

  const blockedByDate = groupMonthBlockedByDate(
    blockouts,
    timedBlocks,
    recurringOccurrences,
    studio.timezone,
    isClosedDate,
  );

  const lastWeekHref = `/calendar?view=week${
    lastWeekParam ? `&week=${lastWeekParam}` : ""
  }`;

  return (
    <div className="flex flex-col gap-6">
      {/* Same Google/Apple-style toolbar as the week view, for coherent
          switching. Month step nav stays visible on all sizes (mobile month
          has no separate day-nav). */}
      <CalendarToolbar
        view="month"
        rangeLabel={monthYearLabel(monthAnchor)}
        timezone={studio.timezone}
        weekHref={lastWeekHref}
        monthHref={`/calendar?view=month&month=${monthAnchor}`}
        prevHref={`/calendar?view=month&month=${prevMonth}`}
        todayHref="/calendar?view=month"
        nextHref={`/calendar?view=month&month=${nextMonth}`}
        upcomingHref="/calendar/upcoming"
        hideStepNavOnMobile={false}
      />

      <MonthView
        monthAnchor={monthAnchor}
        appointmentsByDate={appointmentsByDate}
        blockedByDate={blockedByDate}
        today={today}
        isClosedDate={isClosedDate}
      />

      <p className="text-xs text-neutral-500">
        Click any day to open the week view for that date. The month
        view is for orientation; bookings are made from the week view.
      </p>
    </div>
  );
}
