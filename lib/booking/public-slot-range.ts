import { createAdminClient } from "@/lib/supabase/admin-server";
import { getStudioBySlug } from "@/lib/booking/queries";
import {
  buildDaySlots,
  filterFutureSlots,
  pickDayWindow,
  type ReservationRow,
  type Slot,
} from "@/lib/booking/slots";
import {
  getStudioWideDefaultsSafe,
  getStudioWideOverridesSafe,
} from "@/lib/booking/studio-wide-availability";
import { isPubliclyBookable } from "@/lib/booking/readiness";
import { horizonRangeInStudioTz } from "@/lib/booking/horizon";
import { utcInstantFromLocal } from "@/lib/booking/tz";
import { fetchAllRows } from "@/lib/export/paginate";

// ===========================================================================
// PUBLIC SLOTS FOR A RANGE OF DATES — loaded in bulk, throttled by the caller
// ===========================================================================
//
// WHY THIS EXISTS SEPARATELY FROM `fetchPublicSlotsAction`.
//
// That action answers for ONE date and rate-limits itself on every call, which
// is right for the public booking page — a person picks a day, one request goes
// out — and wrong for a caller that must cover a whole authorized window: the
// limiter counts per (IP, slug), so a wide window exhausts its own quota and the
// remaining days come back refused. The caller cannot tell "refused by the
// throttle" from "nothing is open", and availability vanishes silently.
//
// IT LOADS THE RANGE, NOT A DAY AT A TIME. An earlier revision of this file
// simply looped `getAvailableSlots`, which issues a separate blockout,
// availability and reservation query FOR EVERY DATE. At the supported 12-month
// horizon that is ~373 days x 3 queries — over a thousand reads and fifty-odd
// serial waves for one page load, enough to time the page out, and it made the
// once-per-operation throttle far too permissive for what a single call
// actually costs. Batching concurrency did not fix that; it only spread it.
//
// So the horizon inputs are read ONCE — four queries total, whatever the window
// — and `buildDaySlots` runs per date over in-memory data. That split is the one
// `lib/booking/slots.ts` documents at `buildDaySlots`: "a caller that read a
// whole horizon in a single query rather than three per day can reach the same
// candidate generation without a second implementation of it." This is that
// caller. Every RULE still lives in `buildDaySlots`; nothing here re-decides
// what a slot is.
//
// IT PROPAGATES READ FAILURES. `getAvailableSlots` discards the `error` field
// of each query, so a failed availability read becomes an empty day and a failed
// reservation read yields apparently-open times that are unbookable. For a
// surface whose whole job is telling one invited person what is genuinely
// available, "I could not read" must not render as "nothing is open" — the
// caller turns a failure into a retryable state, and it can only do that if it
// is told. The studio-wide loaders already fail closed by throwing; the two
// direct queries here check `error` explicitly.
//
// IT DOES NOT RATE LIMIT, deliberately — a caller that skipped its own gate
// would turn this into an unthrottled public fan-out, so every caller must hold
// `limitPublicSlots` (or an equivalent) around it.
//
// THE HORIZON IS THE AUTHORITY ON HOW FAR FORWARD ANY DATE MAY BE. Anything
// outside the studio's own public booking horizon is dropped here rather than
// queried: `fetchPublicSlotsAction` would refuse it anyway.

export type PublicSlotRangeResult =
  | {
      ok: true;
      slots: Slot[];
      /** The dates actually evaluated, after the horizon clamp. */
      scanned: string[];
      /** Dates the caller asked for that the horizon excluded. */
      skippedOutsideHorizon: string[];
    }
  | { ok: false; error: string };

/**
 * The weekday of a STUDIO-LOCAL calendar date.
 *
 * Derived from the date string itself, which is the only correct source: a
 * calendar date's weekday is intrinsic to it. `getAvailableSlots` instead builds
 * `new Date(dateStr + "T12:00:00Z")` and asks which LOCAL date that instant
 * falls on — for a studio at UTC+13 or +14 (Auckland in southern daylight time,
 * Chatham, Kiritimati) noon UTC is already the next local day, so a Monday was
 * evaluated against Tuesday's weekly hours. Monday openings vanished, or
 * Tuesday's hours generated times that were refused at booking.
 */
function weekdayOfLocalDate(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

/**
 * Slots for a set of dates, in one bulk-loaded pass.
 *
 * `dates` is taken as given apart from the horizon clamp — the caller owns which
 * days are worth asking about (a weekday-scoped offer should not hand over days
 * it does not permit).
 */
export async function fetchPublicSlotsForDates(params: {
  slug: string;
  serviceId: string;
  dates: readonly string[];
}): Promise<PublicSlotRangeResult> {
  const studio = await getStudioBySlug(params.slug);
  if (!studio) return { ok: false, error: "Studio not found." };

  const admin = createAdminClient();
  const tz = studio.timezone;

  // Same soft-gate the single-date action applies, asked ONCE: a studio that is
  // not publicly bookable is not bookable on any date.
  const [servicesRes, availabilityRes] = await Promise.all([
    admin
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studio.id)
      .eq("active", true),
    admin
      .from("studio_availability_default")
      .select("is_open,open_time,close_time")
      .eq("studio_id", studio.id),
  ]);
  if (servicesRes.error || availabilityRes.error) {
    return { ok: false, error: "Availability could not be read." };
  }
  const openAvailabilityDaysCount = (
    (availabilityRes.data ?? []) as Array<{
      is_open: boolean | null;
      open_time: string | null;
      close_time: string | null;
    }>
  ).filter(
    (d) =>
      d.is_open === true &&
      typeof d.open_time === "string" &&
      typeof d.close_time === "string",
  ).length;
  if (
    !isPubliclyBookable({
      activeServicesCount: servicesRes.count ?? 0,
      openAvailabilityDaysCount,
    })
  ) {
    return { ok: false, error: "This studio is not accepting bookings online." };
  }

  const { data: service, error: serviceError } = await admin
    .from("services")
    .select("default_duration_minutes")
    .eq("id", params.serviceId)
    .eq("studio_id", studio.id)
    .eq("active", true)
    .maybeSingle();
  if (serviceError) return { ok: false, error: "Availability could not be read." };
  if (!service) return { ok: false, error: "Service not found." };

  // Everything above this line is the AUTHORITY pass — studio, readiness,
  // service — and everything below it is the DATA pass. BOOK-NEXT-FAST-01 split
  // them so a caller that has already done the authority pass can reach the data
  // pass without repeating it; see `loadPublicSlotsByDate`.
  const grouped = await loadPublicSlotsByDate(
    admin,
    {
      studioId: studio.id,
      timezone: tz,
      publicBookingHorizonMonths: studio.public_booking_horizon_months,
      bufferMinutes: studio.buffer_minutes,
      serviceDurationMinutes: service.default_duration_minutes as number,
    },
    params.dates,
  );
  if (!grouped.ok) return grouped;

  // This entry point's contract is a FLAT slot list, and it is preserved
  // exactly: the groups are built in sorted-date order, so flattening them
  // reproduces the order the single list was always emitted in.
  return {
    ok: true,
    slots: grouped.byDate.flatMap((d) => d.slots),
    scanned: grouped.scanned,
    skippedOutsideHorizon: grouped.skippedOutsideHorizon,
  };
}

/** A studio + service context that has ALREADY passed the authority checks. */
export type PublicRangeContext = {
  studioId: string;
  timezone: string;
  publicBookingHorizonMonths: number | null;
  bufferMinutes: number | null;
  serviceDurationMinutes: number;
};

export type PublicSlotsByDateResult =
  | {
      ok: true;
      /** Sorted ascending by date. Only dates with at least one slot appear. */
      byDate: Array<{ date: string; slots: Slot[] }>;
      scanned: string[];
      skippedOutsideHorizon: string[];
    }
  | { ok: false; error: string };

/**
 * The DATA pass: one bulk load for a whole window, grouped by local date.
 *
 * WHY THIS IS SEPARATE FROM `fetchPublicSlotsForDates` (BOOK-NEXT-FAST-01).
 *
 * That function performs its own authority pass — studio lookup, public
 * readiness, service lookup — which is exactly right for a caller that has none.
 * `fetchNextAvailableDateAction` has all three ALREADY, because it must resolve
 * the studio's timezone and horizon before it can even name the dates it wants.
 * Calling the wrapper from there would have re-read the studio, re-run
 * readiness and re-read the service, and re-read `studio_availability_default`
 * a second time — four redundant round trips on the public path, for answers the
 * caller was holding. So the pass it actually needs is exported on its own.
 *
 * WHY IT RETURNS GROUPS RATHER THAN A FLAT LIST. `Slot` carries `start`/`end` as
 * ISO UTC instants and no date. Recovering "which local day is this slot on"
 * from a UTC instant is the precise mistake `weekdayOfLocalDate` above exists to
 * prevent: at UTC+13/+14 the arithmetic lands on the neighbouring day. The date
 * is known for free at generation time — `buildDaySlots` is called per
 * `dateStr` — so it is kept rather than thrown away and re-derived. A caller
 * asking "the earliest date with a slot" then reads it directly.
 *
 * THE QUERY BUDGET IS THE POINT, and it is flat in the number of dates: two
 * waves, four queries, plus one extra reservation page per additional 1000
 * overlapping reservations. A 12-month window costs the same waves as a 7-day
 * one. Every RULE still lives in `buildDaySlots`; nothing here re-decides what
 * a slot is.
 *
 * `now` is taken as a parameter so a caller that evaluates many dates applies
 * ONE clock reading to all of them, rather than letting the boundary move
 * underneath a long scan.
 */
export async function loadPublicSlotsByDate(
  admin: ReturnType<typeof createAdminClient>,
  ctx: PublicRangeContext,
  dates: readonly string[],
  now: Date = new Date(),
  opts: {
    /**
     * Stop generating once a date with at least one offerable slot is found.
     *
     * MEASURED, not assumed. With the whole horizon evaluated, the bulk pass
     * answered a 12-month "nothing is open" case in 24 ms but took 1.5-2.3 s
     * whenever slots DID exist — the inverse of what a query-cost problem looks
     * like, because the all-blocked case never reaches slot generation at all.
     * The remaining time was `buildDaySlots` running over ~370 open days and
     * formatting every candidate's label through `Intl.DateTimeFormat`.
     *
     * A caller that wants the EARLIEST date needs exactly one group, so the
     * rest of that work is waste. This flag is off by default because the
     * range caller genuinely wants every slot; `fetchNextAvailableDateAction`
     * turns it on.
     *
     * It changes no RULE and no ANSWER: the dates are evaluated in ascending
     * order, so the first group found is the same first group a full pass
     * would have produced.
     */
    stopAfterFirstMatch?: boolean;
  } = {},
): Promise<PublicSlotsByDateResult> {
  const tz = ctx.timezone;

  // THE HORIZON CLAMP. Beyond it a date is unbookable by any route, so querying
  // it buys nothing and discovering that one refusal at a time is how an
  // over-wide range spends its budget on nothing.
  const horizon = horizonRangeInStudioTz(tz, ctx.publicBookingHorizonMonths);
  const scanned: string[] = [];
  const skippedOutsideHorizon: string[] = [];
  for (const d of dates) {
    if (d < horizon.minDateStr || d > horizon.maxDateStr) skippedOutsideHorizon.push(d);
    else scanned.push(d);
  }
  if (scanned.length === 0) {
    return { ok: true, byDate: [], scanned, skippedOutsideHorizon };
  }

  const sorted = [...scanned].sort();
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  // ---- FOUR QUERIES FOR THE WHOLE WINDOW, whatever its length ----
  const rangeStartUtc = utcInstantFromLocal(first, "00:00", tz);
  // The same 36-hour tail the per-day loader uses, so a reservation running past
  // midnight into the last day is still seen.
  const rangeEndUtc = new Date(
    utcInstantFromLocal(last, "00:00", tz).getTime() + 36 * 3600 * 1000,
  );

  let overrides: Array<{ effective_date: string } & Record<string, unknown>>;
  let defaults: Array<{ day_of_week: number } & Record<string, unknown>>;
  try {
    // Both FAIL CLOSED by throwing on any error other than a genuinely absent
    // 0135 column, which is exactly the propagation this helper needs.
    [overrides, defaults] = (await Promise.all([
      getStudioWideOverridesSafe(admin, ctx.studioId, first, last),
      getStudioWideDefaultsSafe(admin, ctx.studioId),
    ])) as [typeof overrides, typeof defaults];
  } catch {
    return { ok: false, error: "Availability could not be read." };
  }

  const [blockoutRes, reservationRes] = await Promise.all([
    admin
      .from("studio_blockouts")
      .select("starts_on, ends_on")
      .eq("studio_id", ctx.studioId)
      .lte("starts_on", last)
      .gte("ends_on", first),
    // PAGINATED, because PostgREST caps a response at `max_rows` (1000 in
    // supabase/config.toml) and SETS NO ERROR when it does.
    //
    // A single unbounded read looked correct and was the most dangerous query
    // in this module: a studio needs only ~3 reservations a day to cross 1000
    // over a 12-month horizon, and every omitted conflict becomes an
    // apparently-open time that the booking command then refuses. Truncating
    // the reservation set does not hide availability, it INVENTS it.
    //
    // `fetchAllRows` refuses rather than returning a capped set, which is the
    // whole reason it exists — the export lane learned this exact lesson on its
    // own tables. Ordering is `starts_at, id`: pagination over a non-unique
    // sort can put one row on two pages and drop another, and `id` is the
    // primary key.
    fetchAllRows<ReservationRow>((from, to) =>
      admin
        .from("studio_calendar_reservations")
        .select("starts_at, ends_at, source_kind, source_id")
        .eq("studio_id", ctx.studioId)
        .lt("starts_at", rangeEndUtc.toISOString())
        .gt("ends_at", rangeStartUtc.toISOString())
        .order("starts_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);
  // A blockout read that failed is not "no blockouts", and a reservation read
  // that failed is not "nothing is booked" — that one would generate open times
  // over occupied ones.
  if (blockoutRes.error || reservationRes.error) {
    return { ok: false, error: "Availability could not be read." };
  }

  const blockouts = (blockoutRes.data ?? []) as Array<{
    starts_on: string;
    ends_on: string;
  }>;
  const reservations = (reservationRes.data ?? []) as ReservationRow[];

  const overrideByDate = new Map(overrides.map((o) => [o.effective_date, o]));
  const defaultByDow = new Map(defaults.map((d) => [d.day_of_week, d]));

  const duration = ctx.serviceDurationMinutes;
  const buffer = Math.max(0, ctx.bufferMinutes ?? 0);

  const byDate: Array<{ date: string; slots: Slot[] }> = [];
  for (const dateStr of sorted) {
    if (blockouts.some((b) => b.starts_on <= dateStr && b.ends_on >= dateStr)) continue;

    // Override wins over the weekday default — `pickDayWindow` owns that
    // precedence, and its own comment names this batched shape as the reason it
    // takes both rows at once.
    const { isOpen, openTime, closeTime } = pickDayWindow(
      (overrideByDate.get(dateStr) ?? null) as never,
      (defaultByDow.get(weekdayOfLocalDate(dateStr)) ?? null) as never,
    );
    if (!isOpen || !openTime || !closeTime) continue;

    const dayStart = utcInstantFromLocal(dateStr, "00:00", tz).getTime();
    const dayEnd = dayStart + 36 * 3600 * 1000;
    const dayReservations = reservations.filter((r) => {
      const s = Date.parse(r.starts_at);
      const e = Date.parse(r.ends_at);
      return Number.isFinite(s) && Number.isFinite(e) && s < dayEnd && e > dayStart;
    });

    // The same past-time guard the single-date action applies, so the two
    // cannot drift about whether today's earlier hours are offerable. Applied
    // PER DATE with the caller's single `now`, which is what lets a long scan
    // avoid letting the boundary move underneath it.
    const daySlots = filterFutureSlots(
      // The SAME candidate generation the single-date path uses. One algorithm.
      buildDaySlots({
        dateStr,
        tz,
        duration,
        buffer,
        openTime,
        closeTime,
        reservations: dayReservations,
      }),
      now,
    );

    // A date with no offerable time is not a date — omitting it here is what
    // makes "the first group" mean "the first date that actually has a slot"
    // for the caller, with no second emptiness rule to keep in step.
    if (daySlots.length > 0) {
      byDate.push({ date: dateStr, slots: daySlots });
      if (opts.stopAfterFirstMatch) break;
    }
  }

  return { ok: true, byDate, scanned: sorted, skippedOutsideHorizon };
}
