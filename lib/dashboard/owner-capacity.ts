import type { SupabaseClient } from "@supabase/supabase-js";

import { isConsultationService } from "@/lib/booking/consultation";
import {
  buildDaySlots,
  pickDayWindow,
  protectedIntervals,
  type ProtectedInterval,
  type ReservationRow,
} from "@/lib/booking/slots";
import {
  getStudioWideDefaultsSafe,
  getStudioWideOverridesSafe,
} from "@/lib/booking/studio-wide-availability";
import {
  addDays,
  localDayOfWeek,
  todayInTz,
  utcInstantFromLocal,
} from "@/lib/booking/tz";
import { createClient } from "@/lib/supabase/server";
import type {
  Studio,
  StudioAvailabilityDefault,
  StudioAvailabilityOverride,
  StudioBlockout,
} from "@/lib/types/database";
import {
  ACCESS_DURATIONS_MINUTES,
  CAPACITY_HORIZON_DAYS,
  CAPACITY_HORIZON_WEEKS,
  CONVERSION_LOOKBACK_DAYS,
  CONVERSION_MATURITY_DAYS,
  NEW_CONSULTATION_HORIZON_DAYS,
  PRIMARY_ACCESS_DURATION_MINUTES,
  addDayCapacity,
  bookedPercent,
  capacityWeeks,
  countNewConsultations,
  dayCapacity,
  evaluateAdmission,
  isActiveBooking,
  isFirstEverBooking,
  known,
  summarizeBookingDepth,
  summarizeConversion,
  unknown,
  type AdmissionState,
  type BookingDepth,
  type BriefingAppointment,
  type ConversionSummary,
  type DayCapacity,
  type Fact,
} from "./owner-capacity-model";

// ===========================================================================
// OWNER CAPACITY — the reads
// ===========================================================================
//
// Owner-only operational briefing for /dashboard/capacity. READ-ONLY: this
// module issues no INSERT, UPDATE, DELETE or RPC, and touches no payment,
// email, SMS, Google or analytics path.
//
// SHAPE OF THE READ: eight studio-scoped queries issued together, then at most
// one follow-up that needs the client ids the first wave found. Two waves, no
// per-day and no per-client query. The availability rules are NOT re-read per
// day — the four scheduling inputs are loaded once for the whole horizon and
// evaluated through lib/booking/slots.ts's own pure core, so a capacity figure
// and the booking page cannot disagree about what is legal.
//
// NO READ IS EVER CONSUMED AS COMPLETE UNLESS IT PROVABLY IS. Every read below
// goes through `readAll`, which pages against an EXACT count and throws on a
// PostgREST error. Two ways a briefing could otherwise lie with total
// confidence, both closed here:
//
//   * A ROW CEILING. supabase/config.toml sets `max_rows = 1000`, so the Data
//     API truncates a response long before any app-side limit is reached.
//     Comparing the returned length against a larger app-side cap therefore
//     proved nothing: a studio with 1,200 appointments looked complete at
//     1,000 rows, and the missing 200 read as free time. `readAll` compares
//     against the count PostgREST reports in Content-Range, which the row
//     ceiling does not bound, so completeness is proved rather than assumed —
//     and it stays correct whatever the deployment's ceiling happens to be.
//
//   * A FAILED READ. supabase-js RESOLVES with `{ data: null, error }` rather
//     than rejecting, so a discarded error becomes an empty row set: zero
//     booked hours, a wholly free calendar and a confident next opening, on
//     the screen an owner uses to decide whether to accept work. `readAll`
//     fails closed with a safe code and no row data, because no answer is
//     better than a wrong one here.
//
// Beyond the per-read ceilings below the figures that row set feeds go UNKNOWN,
// never truncated.

/** supabase/config.toml `max_rows`. One page may not exceed the Data API's own ceiling. */
const API_PAGE_SIZE = 1_000;

const READ_CAPS = {
  clients: 10_000,
  futureAppointments: 10_000,
  cohortConsultations: 10_000,
  clientHistory: 20_000,
  reservations: 20_000,
} as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Whole days from `from` to `to`, both studio-local YYYY-MM-DD. Noon-anchored so DST cannot shift the count. */
function daysBetweenLocal(from: string, to: string): number {
  const ms = Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`);
  return Math.round(ms / DAY_MS);
}

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export type NextOpening = {
  durationMinutes: number;
  /** ISO instant of the first legal start, or null when there is none. */
  startsAt: string | null;
  /** Days from now, one decimal. Null when there is no opening. */
  daysAway: number | null;
};

export type WeekCapacity = {
  startLocal: string;
  endLocalExclusive: string;
  /** True for the week in progress, whose figures cover only what is left of it. */
  isCurrentWeek: boolean;
  netBookableMinutes: number;
  bookedMinutes: number;
  freeMinutes: number;
  bookedPercent: number | null;
  /** Whole 60-minute treatments that genuinely still fit. */
  usableOpenings: number;
};

export type OwnerCapacityBriefing = {
  timezone: string;
  todayLocal: string;
  generatedAt: string;
  horizonWeeks: number;

  clients: {
    /** Non-archived client records. Not a measure of who is in treatment. */
    totalRecords: Fact<number>;
    activeTreatment: Fact<number>;
    activeTreatmentWithoutFutureBooking: Fact<number>;
    /** How "active treatment client" was established, for the screen to state. */
    activeTreatmentBasis: string;
  };

  newDemand: {
    consultationsByDays: Fact<Readonly<Record<number, number>>>;
    horizonDays: ReadonlyArray<number>;
    conversion: Fact<ConversionSummary>;
    maturityDays: number;
    lookbackDays: number;
  };

  access: Fact<ReadonlyArray<NextOpening>>;
  weeks: Fact<ReadonlyArray<WeekCapacity>>;
  depth: Fact<BookingDepth>;
  /** Real treatment time already on the calendar, in minutes. Excludes buffers. */
  futureTreatmentMinutes: Fact<number>;
  admission: AdmissionState;
};

// ---------------------------------------------------------------------------
// Row plumbing
// ---------------------------------------------------------------------------

type ServiceEmbed = { modality: string | null; name: string } | null;

type AppointmentRow = {
  id: string;
  client_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  service: ServiceEmbed | ServiceEmbed[];
};

const APPOINTMENT_SELECT =
  "id, client_id, starts_at, ends_at, status, service:services(modality, name)";

function toBriefingAppointment(row: AppointmentRow): BriefingAppointment {
  const service = Array.isArray(row.service) ? (row.service[0] ?? null) : row.service;
  return {
    id: row.id,
    clientId: row.client_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    // The SAME predicate the public booking page and its server guard share.
    // A service-less appointment is treatment: it is booked studio time.
    isConsultation: service ? isConsultationService(service) : false,
  };
}

/**
 * A row set, whether it stopped short of everything, and the EXACT total the
 * database reports — which stays truthful even when the rows do not.
 */
type Capped<T> = { rows: T[]; truncated: boolean; total: number | null };

type PageResult<T> = {
  data: T[] | null;
  error: { code?: string | null } | null;
  count?: number | null;
};

/**
 * Read every row of one studio-scoped query, or say so.
 *
 * `page(from, to)` must issue the SAME query with `{ count: "exact" }` and the
 * given range. Paging stops when the accumulated rows reach the reported count
 * (complete) or the per-read ceiling (truncated). A studio under the Data API's
 * page ceiling — which is every real studio — costs exactly one request, so the
 * two-wave read shape is unchanged for them.
 */
async function readAll<T>(
  what: string,
  cap: number,
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<Capped<T>> {
  const rows: T[] = [];
  let total: number | null = null;
  for (;;) {
    const from = rows.length;
    const to = Math.min(from + API_PAGE_SIZE, cap) - 1;
    if (to < from) break; // the ceiling below is the limit, not the data
    const { data, error, count } = await page(from, to);
    // Fail CLOSED. A swallowed error here renders an empty calendar as a free one.
    if (error) {
      throw new Error(
        `owner_capacity_read_failed:${what}:${error?.code ?? "unknown"}`,
      );
    }
    if (typeof count === "number") total = count;
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length === 0) break;
    if (total !== null && rows.length >= total) break;
  }
  // No count at all means completeness was never established; say so rather
  // than assume it.
  return { rows, truncated: total === null || rows.length < total, total };
}

function tooLarge(what: string, cap: number): string {
  return `This studio has more than ${cap.toLocaleString()} ${what} in range; this briefing does not report a partial figure.`;
}

function groupByClient(
  appointments: ReadonlyArray<BriefingAppointment>,
): Map<string, BriefingAppointment[]> {
  const byClient = new Map<string, BriefingAppointment[]>();
  for (const a of appointments) {
    const list = byClient.get(a.clientId);
    if (list) list.push(a);
    else byClient.set(a.clientId, [a]);
  }
  return byClient;
}

// ---------------------------------------------------------------------------
// The scheduling horizon, evaluated through the booking engine's own core
// ---------------------------------------------------------------------------

type ScheduleDay = {
  dateStr: string;
  openTime: string;
  closeTime: string;
  openMs: number;
  closeMs: number;
  intervals: ProtectedInterval[];
  reservations: ReservationRow[];
};

/**
 * Resolve every open day in the horizon from the four already-loaded inputs,
 * applying exactly the precedence lib/booking/slots.ts applies: a full-day
 * blockout closes the date outright, a dated override beats the weekly default,
 * and a row that says closed closes the day.
 */
function buildSchedule(params: {
  firstLocal: string;
  days: number;
  tz: string;
  bufferMinutes: number;
  defaults: ReadonlyArray<StudioAvailabilityDefault>;
  overrides: ReadonlyArray<StudioAvailabilityOverride>;
  blockouts: ReadonlyArray<Pick<StudioBlockout, "starts_on" | "ends_on">>;
  reservations: ReadonlyArray<ReservationRow>;
}): ScheduleDay[] {
  const defaultByDow = new Map(params.defaults.map((d) => [d.day_of_week, d]));
  const overrideByDate = new Map(params.overrides.map((o) => [o.effective_date, o]));
  const schedule: ScheduleDay[] = [];

  for (let i = 0; i < params.days; i += 1) {
    const dateStr = addDays(params.firstLocal, i);
    if (params.blockouts.some((b) => b.starts_on <= dateStr && b.ends_on >= dateStr)) {
      continue; // closed outright, exactly as getAvailableSlots returns []
    }
    const dow = localDayOfWeek(new Date(`${dateStr}T12:00:00Z`), params.tz);
    const { isOpen, openTime, closeTime } = pickDayWindow(
      overrideByDate.get(dateStr),
      defaultByDow.get(dow),
    );
    if (!isOpen || !openTime || !closeTime) continue;

    // The same 36-hour overlap window the per-day loader uses, so a late
    // previous-day reservation still reaches the day it runs into.
    //
    // The comparison is against the shadow's RAW `ends_at`, deliberately, and
    // NOT against the buffered end `protectedIntervals` reconstructs. That is
    // byte-for-byte what getAvailableSlots does (`gt("ends_at", windowStart)`),
    // and parity is the whole reason this module exists: an appointment ending
    // just before local midnight whose trailing buffer spills into the next day
    // is dropped by BOTH paths alike. Widening it here alone would make this
    // page disagree with the booking engine, which is worse than the shared
    // edge — and that edge is only reachable by a studio open across midnight.
    // It belongs to slots.ts, fixed in both paths at once, in its own change.
    const windowStart = utcInstantFromLocal(dateStr, "00:00", params.tz).getTime();
    const windowEnd = windowStart + 36 * HOUR_MS;
    const dayReservations = params.reservations.filter((r) => {
      const s = new Date(r.starts_at).getTime();
      const e = new Date(r.ends_at).getTime();
      return s < windowEnd && e > windowStart;
    });

    schedule.push({
      dateStr,
      openTime,
      closeTime,
      openMs: utcInstantFromLocal(dateStr, openTime, params.tz).getTime(),
      closeMs: utcInstantFromLocal(dateStr, closeTime, params.tz).getTime(),
      intervals: protectedIntervals(dayReservations, params.bufferMinutes),
      reservations: dayReservations,
    });
  }
  return schedule;
}

/**
 * The first legal start of `durationMinutes` at or after `now`, found through
 * buildDaySlots — the booking engine's own candidate generator, not a gap scan.
 *
 * Deliberately WITHOUT the internal closing-edge packing option. A candidate the
 * default generator offers is legal on both the public and the internal path; a
 * closing-edge candidate is internal-only. Under-promising is the safe error on
 * a screen that decides whether to accept a client.
 */
function findNextOpening(
  schedule: ReadonlyArray<ScheduleDay>,
  durationMinutes: number,
  bufferMinutes: number,
  tz: string,
  nowMs: number,
): NextOpening {
  for (const day of schedule) {
    if (day.closeMs <= nowMs) continue;
    const slots = buildDaySlots({
      dateStr: day.dateStr,
      tz,
      duration: durationMinutes,
      buffer: bufferMinutes,
      openTime: day.openTime,
      closeTime: day.closeTime,
      reservations: day.reservations,
    });
    for (const slot of slots) {
      const startMs = new Date(slot.start).getTime();
      if (startMs <= nowMs) continue;
      return {
        durationMinutes,
        startsAt: slot.start,
        daysAway: Math.round(((startMs - nowMs) / DAY_MS) * 10) / 10,
      };
    }
  }
  return { durationMinutes, startsAt: null, daysAway: null };
}

// ---------------------------------------------------------------------------
// The briefing
// ---------------------------------------------------------------------------

export async function getOwnerCapacityBriefing(
  studio: Studio,
  supabaseClient?: SupabaseClient,
): Promise<OwnerCapacityBriefing> {
  const supabase = supabaseClient ?? (await createClient());
  const tz = studio.timezone;
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const todayLocal = todayInTz(tz);
  const bufferMinutes = Math.max(0, studio.buffer_minutes ?? 0);

  const weeks = capacityWeeks(todayLocal, CAPACITY_HORIZON_WEEKS);
  const scheduleFirstLocal = weeks[0].startLocal;
  // The week grid is anchored to the CURRENT week's Sunday, so eight buckets
  // reach only `56 − <days elapsed this week>` days past today: on a Saturday
  // the last bucket ends 50 days out. Reporting is right to use calendar weeks,
  // but the openings search must not then claim "none in the next 8 weeks"
  // while never having looked at days 51–56. The schedule therefore runs to
  // whichever is later, the eighth bucket's end or eight full weeks from today.
  const scheduleDays =
    CAPACITY_HORIZON_DAYS + daysBetweenLocal(scheduleFirstLocal, todayLocal);
  const scheduleLastExclusive = addDays(scheduleFirstLocal, scheduleDays);
  const scheduleStartUtc = utcInstantFromLocal(scheduleFirstLocal, "00:00", tz);
  const scheduleEndUtc = utcInstantFromLocal(scheduleLastExclusive, "00:00", tz);

  const cohortNewestIso = new Date(nowMs - CONVERSION_MATURITY_DAYS * DAY_MS).toISOString();
  const cohortOldestIso = new Date(nowMs - CONVERSION_LOOKBACK_DAYS * DAY_MS).toISOString();

  // --- wave 1: eight independent studio-scoped reads ------------------------
  const [
    clientRows,
    planRows,
    futureRows,
    defaults,
    overrides,
    blockoutRows,
    reservationRows,
    cohortRows,
  ] = await Promise.all([
    readAll<{ id: string }>("clients", READ_CAPS.clients, (from, to) =>
      supabase
        .from("clients")
        .select("id", { count: "exact" })
        .eq("studio_id", studio.id)
        .is("archived_at", null)
        .order("id")
        .range(from, to),
    ),
    // The ONE owner-declared authority for "this client is in a course of
    // treatment": an open treatment plan (0024). Never inferred from bookings.
    readAll<{ client_id: string }>(
      "treatment_plans",
      READ_CAPS.clients,
      (from, to) =>
        supabase
          .from("treatment_plans")
          .select("client_id", { count: "exact" })
          .eq("studio_id", studio.id)
          .eq("status", "active")
          .order("client_id")
          .range(from, to),
    ),
    readAll<AppointmentRow>(
      "future_appointments",
      READ_CAPS.futureAppointments,
      (from, to) =>
        supabase
          .from("appointments")
          .select(APPOINTMENT_SELECT, { count: "exact" })
          .eq("studio_id", studio.id)
          .in("status", ["confirmed", "completed"])
          .gte("starts_at", nowIso)
          .order("starts_at")
          .order("id")
          .range(from, to),
    ),
    getStudioWideDefaultsSafe(supabase, studio.id),
    getStudioWideOverridesSafe(
      supabase,
      studio.id,
      scheduleFirstLocal,
      scheduleLastExclusive,
    ),
    readAll<Pick<StudioBlockout, "starts_on" | "ends_on">>(
      "studio_blockouts",
      READ_CAPS.clients,
      (from, to) =>
        supabase
          .from("studio_blockouts")
          .select("starts_on, ends_on", { count: "exact" })
          .eq("studio_id", studio.id)
          .lte("starts_on", scheduleLastExclusive)
          .gte("ends_on", scheduleFirstLocal)
          .order("starts_on")
          .range(from, to),
    ),
    readAll<ReservationRow>(
      "studio_calendar_reservations",
      READ_CAPS.reservations,
      (from, to) =>
        supabase
          .from("studio_calendar_reservations")
          .select("starts_at, ends_at, source_kind, source_id", { count: "exact" })
          .eq("studio_id", studio.id)
          .lt(
            "starts_at",
            new Date(scheduleEndUtc.getTime() + 36 * HOUR_MS).toISOString(),
          )
          .gt("ends_at", scheduleStartUtc.toISOString())
          .order("starts_at")
          .order("source_id")
          .range(from, to),
    ),
    // Consultations old enough to have had a full conversion window.
    readAll<AppointmentRow>(
      "cohort_consultations",
      READ_CAPS.cohortConsultations,
      (from, to) =>
        supabase
          .from("appointments")
          .select(APPOINTMENT_SELECT, { count: "exact" })
          .eq("studio_id", studio.id)
          .in("status", ["confirmed", "completed"])
          .gte("ends_at", cohortOldestIso)
          .lte("ends_at", cohortNewestIso)
          .order("ends_at")
          .order("id")
          .range(from, to),
    ),
  ]);

  const upcoming = futureRows.rows.map(toBriefingAppointment);
  const cohortCandidates = cohortRows.rows
    .map(toBriefingAppointment)
    .filter((a) => a.isConsultation);

  // --- wave 2: the ONE follow-up that needs wave 1's client ids -------------
  //
  // "First-ever" is a claim about a client's whole history, so it cannot be
  // answered inside a windowed read. It is asked once, for only the clients a
  // consultation actually implicates, rather than per consultation.
  const consultationClientIds = [
    ...new Set([
      ...upcoming.filter((a) => a.isConsultation).map((a) => a.clientId),
      ...cohortCandidates.map((a) => a.clientId),
    ]),
  ];
  let history: Capped<AppointmentRow> = { rows: [], truncated: false, total: 0 };
  if (consultationClientIds.length > 0) {
    history = await readAll<AppointmentRow>(
      "client_history",
      READ_CAPS.clientHistory,
      (from, to) =>
        supabase
          .from("appointments")
          .select(APPOINTMENT_SELECT, { count: "exact" })
          .eq("studio_id", studio.id)
          .in("client_id", consultationClientIds)
          .in("status", ["confirmed", "completed"])
          .order("starts_at")
          .order("id")
          .range(from, to),
    );
  }
  const historyByClient = groupByClient(history.rows.map(toBriefingAppointment));

  // --- clients --------------------------------------------------------------
  const activeClientIds = new Set(clientRows.rows.map((c) => c.id));
  // The EXACT count survives even when the id list does not: PostgREST reports
  // it in Content-Range, which no row ceiling bounds. A studio too large to
  // enumerate still gets a truthful total; only the figures that need the ids
  // go unknown.
  const totalRecords: Fact<number> =
    clientRows.total !== null
      ? known(clientRows.total)
      : unknown(tooLarge("client records", READ_CAPS.clients));

  // An active plan for an archived client is history, not current care.
  const planClientIds = new Set(
    planRows.rows.map((p) => p.client_id).filter((id) => activeClientIds.has(id)),
  );
  const ACTIVE_TREATMENT_BASIS =
    "A client with an open treatment plan (Settings → the client's Treatment tab). Hone records no other explicit statement that someone is in a course of treatment, and a client record on its own is not one.";
  // ZERO PLANS IS NOT ZERO CLIENTS. A studio that does not keep treatment plans
  // has an unanswerable question here, and printing "0 active treatment clients"
  // on an admission screen would be a lie with consequences.
  const noPlanEvidence = !planRows.truncated && planRows.rows.length === 0;
  const activeTreatment: Fact<number> = clientRows.truncated || planRows.truncated
    ? unknown(tooLarge("client records", READ_CAPS.clients))
    : noPlanEvidence
      ? unknown(
          "This studio has no open treatment plans on file, so who is in active treatment cannot be established. It is not zero.",
        )
      : known(planClientIds.size);

  // --- future treatment -----------------------------------------------------
  const futureTruncated = futureRows.truncated;
  const futureTreatment = upcoming.filter(
    (a) => !a.isConsultation && isActiveBooking(a),
  );
  const futureTreatmentCountByClient = new Map<string, number>();
  let futureTreatmentMinutes = 0;
  for (const a of futureTreatment) {
    futureTreatmentCountByClient.set(
      a.clientId,
      (futureTreatmentCountByClient.get(a.clientId) ?? 0) + 1,
    );
    const span = new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime();
    if (Number.isFinite(span) && span > 0) futureTreatmentMinutes += span / 60_000;
  }

  const futureCapReason = tooLarge("future appointments", READ_CAPS.futureAppointments);
  const committedTreatmentMinutes: Fact<number> = futureTruncated
    ? unknown(futureCapReason)
    : known(Math.round(futureTreatmentMinutes));

  const depth: Fact<BookingDepth> = !activeTreatment.known
    ? unknown(activeTreatment.reason)
    : futureTruncated
      ? unknown(futureCapReason)
      : known(summarizeBookingDepth(planClientIds, futureTreatmentCountByClient));
  const activeTreatmentWithoutFutureBooking: Fact<number> = depth.known
    ? known(depth.value.zero)
    : unknown(depth.reason);

  // --- new-client demand ----------------------------------------------------
  const historyCapReason = tooLarge("appointment history rows", READ_CAPS.clientHistory);
  const consultationsByDays: Fact<Readonly<Record<number, number>>> =
    futureTruncated
      ? unknown(futureCapReason)
      : history.truncated
        ? unknown(historyCapReason)
        : known(
            countNewConsultations(upcoming, historyByClient, nowMs).countsByDays,
          );

  const cohort = cohortCandidates.filter((c) =>
    isFirstEverBooking(c, historyByClient.get(c.clientId) ?? []),
  );
  const conversion: Fact<ConversionSummary> = cohortRows.truncated
    ? unknown(tooLarge("past consultations", READ_CAPS.cohortConsultations))
    : history.truncated
      ? unknown(historyCapReason)
      : known(summarizeConversion(cohort, historyByClient));

  // --- treatment access + weekly capacity -----------------------------------
  //
  // Both are read off the STUDIO-WIDE timeline. When per-practitioner capacity
  // (0134) is on for a studio, that timeline is not the authority — each
  // practitioner has their own — and this briefing does not yet model it.
  const capacityPerPractitioner = studio.practitioner_capacity_enabled === true;
  const scheduleUnavailable = capacityPerPractitioner
    ? "Per-practitioner capacity is enabled for this studio, so the studio-wide calendar is not the authority for openings or free hours."
    : reservationRows.truncated
      ? tooLarge("calendar reservations", READ_CAPS.reservations)
      : // A closure this read did not return would be reported as open time.
        blockoutRows.truncated
        ? tooLarge("full-day closures", READ_CAPS.clients)
        : null;

  let access: Fact<ReadonlyArray<NextOpening>>;
  let weekly: Fact<ReadonlyArray<WeekCapacity>>;
  if (scheduleUnavailable) {
    access = unknown(scheduleUnavailable);
    weekly = unknown(scheduleUnavailable);
  } else {
    const schedule = buildSchedule({
      firstLocal: scheduleFirstLocal,
      days: scheduleDays,
      tz,
      bufferMinutes,
      defaults,
      overrides,
      blockouts: blockoutRows.rows,
      reservations: reservationRows.rows,
    });
    const probeDurationMs = PRIMARY_ACCESS_DURATION_MINUTES * 60_000;
    const bufferMs = bufferMinutes * 60_000;
    const byDate = new Map<string, DayCapacity>(
      schedule.map((day) => [
        day.dateStr,
        dayCapacity({
          openMs: day.openMs,
          closeMs: day.closeMs,
          fromMs: nowMs,
          intervals: day.intervals,
          probeDurationMs,
          bufferMs,
        }),
      ]),
    );

    access = known(
      ACCESS_DURATIONS_MINUTES.map((minutes) =>
        findNextOpening(schedule, minutes, bufferMinutes, tz, nowMs),
      ),
    );
    weekly = known(
      weeks.map((week, index) => {
        let total: DayCapacity = {
          netBookableMinutes: 0,
          bookedMinutes: 0,
          freeMinutes: 0,
          usableOpenings: 0,
        };
        for (
          let d = week.startLocal;
          d < week.endLocalExclusive;
          d = addDays(d, 1)
        ) {
          const day = byDate.get(d);
          if (day) total = addDayCapacity(total, day);
        }
        return {
          startLocal: week.startLocal,
          endLocalExclusive: week.endLocalExclusive,
          isCurrentWeek: index === 0,
          // Minutes, not rounded hours: a 6h45m week is 405, never 6.8.
          netBookableMinutes: Math.round(total.netBookableMinutes),
          bookedMinutes: Math.round(total.bookedMinutes),
          freeMinutes: Math.round(total.freeMinutes),
          bookedPercent: bookedPercent(total),
          usableOpenings: total.usableOpenings,
        };
      }),
    );
  }

  // --- admission ------------------------------------------------------------
  const primaryOpening = access.known
    ? access.value.find((o) => o.durationMinutes === PRIMARY_ACCESS_DURATION_MINUTES)
    : undefined;
  const admission = evaluateAdmission({
    freeTreatmentHours: weekly.known
      ? known(weekly.value.reduce((sum, w) => sum + w.freeMinutes, 0) / 60)
      : unknown(weekly.reason),
    nextTreatmentOpeningDays: access.known
      ? known(primaryOpening?.daysAway ?? null)
      : unknown(access.reason),
    // Hone has no per-studio first-treatment lead-time target. Inventing one
    // here would turn a product decision the studio never made into a number.
    firstTreatmentLeadTimeTargetDays: unknown(
      "Hone does not record a target for how soon a converted consultation must get a first treatment.",
    ),
    activeClientsWithoutFutureBooking: activeTreatmentWithoutFutureBooking,
    // Treatment plans carry stages and cadence, but only for clients who have a
    // plan; every other active client's return interval is unrecorded, so the
    // studio's total recurring demand cannot be projected. Unrecorded is not nil.
    latentRecurringDemandHours: unknown(
      "Return cadence is recorded only for clients who have a treatment plan with stages, so total recurring demand cannot be projected.",
    ),
    newConsultationsNext7Days: consultationsByDays.known
      ? known(consultationsByDays.value[NEW_CONSULTATION_HORIZON_DAYS[0]] ?? 0)
      : unknown(consultationsByDays.reason),
    // New-client intake by private invitation is not persisted anywhere: the
    // waitlist is an operator environment switch and its submissions are email.
    outstandingInvitations: unknown(
      "Hone does not store private booking invitations, so places already promised cannot be counted.",
    ),
    // No studio-level intake ceiling exists in the schema or settings.
    studioIntakeCapPerWeek: unknown(
      "This studio has not set a limit on how many new clients it will take per week.",
    ),
  });

  return {
    timezone: tz,
    todayLocal,
    generatedAt: nowIso,
    horizonWeeks: CAPACITY_HORIZON_WEEKS,
    clients: {
      totalRecords,
      activeTreatment,
      activeTreatmentWithoutFutureBooking,
      activeTreatmentBasis: ACTIVE_TREATMENT_BASIS,
    },
    newDemand: {
      consultationsByDays,
      horizonDays: NEW_CONSULTATION_HORIZON_DAYS,
      conversion,
      maturityDays: CONVERSION_MATURITY_DAYS,
      lookbackDays: CONVERSION_LOOKBACK_DAYS,
    },
    access,
    weeks: weekly,
    depth,
    futureTreatmentMinutes: committedTreatmentMinutes,
    admission,
  };
}
