import { addDays, startOfWeek } from "@/lib/booking/tz";
import type { ProtectedInterval } from "@/lib/booking/slots";

// ===========================================================================
// OWNER CAPACITY — the derivations, with no I/O
// ===========================================================================
//
// The owner briefing at /dashboard/capacity answers operational questions
// ("can I take another client?") from current studio truth. This module holds
// every rule it applies; the loader beside it holds every read.
//
// THE ONE DISCIPLINE THIS FILE EXISTS TO ENFORCE: an absent input is UNKNOWN,
// never zero. A studio that records no active treatment plans does not have
// zero active treatment clients — it has an unanswerable question, and saying
// "0" would read as "nobody is in treatment" on a screen the owner uses to
// decide whether to accept new work. Every derived figure therefore travels as
// a `Fact<T>`, and the admission evaluator refuses to produce a number while
// any required input is missing.

// ---------------------------------------------------------------------------
// Fact<T> — a value, or the reason there isn't one
// ---------------------------------------------------------------------------

export type Fact<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly reason: string };

export function known<T>(value: T): Fact<T> {
  return { known: true, value };
}

export function unknown<T>(reason: string): Fact<T> {
  return { known: false, reason };
}

/** Map a known value; an unknown passes through carrying its reason. */
export function mapFact<T, U>(fact: Fact<T>, fn: (value: T) => U): Fact<U> {
  return fact.known ? known(fn(fact.value)) : fact;
}

// ---------------------------------------------------------------------------
// Product constants
// ---------------------------------------------------------------------------

/**
 * How far forward the briefing looks. Eight weeks is long enough that a
 * booked-solid month is visible and short enough that the numbers are about
 * work the owner can still influence.
 */
export const CAPACITY_HORIZON_WEEKS = 8;
export const CAPACITY_HORIZON_DAYS = CAPACITY_HORIZON_WEEKS * 7;

/** New-consultation demand is reported at three depths, in studio-local days. */
export const NEW_CONSULTATION_HORIZON_DAYS = [7, 14, 28] as const;

/**
 * A consultation is MATURE once this many days have passed since it ended: only
 * then has it had a full, equal chance to convert. Immature consultations are
 * excluded from BOTH sides of the conversion ratio — counting them in the
 * denominator alone would report recent demand as failure.
 */
export const CONVERSION_MATURITY_DAYS = 14;

/** How far back the mature-conversion cohort reaches. Bounded, and labelled. */
export const CONVERSION_LOOKBACK_DAYS = 180;

/** Treatment access is probed at three real service lengths. */
export const ACCESS_DURATIONS_MINUTES = [30, 60, 90] as const;

/** The reference length for "how soon could a new client actually be treated". */
export const PRIMARY_ACCESS_DURATION_MINUTES = 60;

// ---------------------------------------------------------------------------
// Week buckets
// ---------------------------------------------------------------------------

export type WeekBucket = {
  /** Studio-local YYYY-MM-DD, Sunday. */
  startLocal: string;
  /** Studio-local YYYY-MM-DD, exclusive. */
  endLocalExclusive: string;
};

/**
 * The forward week grid, anchored to the SAME Sunday boundary the practitioner
 * calendar and the practice snapshot use (`startOfWeek`). A second week anchor
 * is exactly how the dashboard and the calendar once disagreed by a full week
 * every Sunday; there is deliberately one.
 *
 * The first bucket is the CURRENT week, so its figures describe the part of it
 * that is still ahead — the loader clips every window to `now`.
 */
export function capacityWeeks(
  todayLocal: string,
  weeks: number = CAPACITY_HORIZON_WEEKS,
): WeekBucket[] {
  const first = startOfWeek(todayLocal);
  return Array.from({ length: weeks }, (_, i) => {
    const startLocal = addDays(first, i * 7);
    return { startLocal, endLocalExclusive: addDays(startLocal, 7) };
  });
}

// ---------------------------------------------------------------------------
// Interval arithmetic
// ---------------------------------------------------------------------------

export type Interval = { start: number; end: number };

const MINUTE_MS = 60_000;

/** Clip to [lo, hi), drop the empties, merge overlaps. Input order is free. */
export function mergeClipped(
  intervals: ReadonlyArray<Interval>,
  lo: number,
  hi: number,
): Interval[] {
  const clipped = intervals
    .map((i) => ({ start: Math.max(i.start, lo), end: Math.min(i.end, hi) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const i of clipped) {
    const last = merged[merged.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else merged.push({ ...i });
  }
  return merged;
}

export function minutesIn(intervals: ReadonlyArray<Interval>): number {
  return intervals.reduce((sum, i) => sum + (i.end - i.start), 0) / MINUTE_MS;
}

/** [lo, hi) minus already-merged `cuts` — the day's free windows. */
export function gapsIn(
  cuts: ReadonlyArray<Interval>,
  lo: number,
  hi: number,
): Interval[] {
  const free: Interval[] = [];
  let cursor = lo;
  for (const cut of cuts) {
    if (cut.start > cursor) free.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < hi) free.push({ start: cursor, end: hi });
  return free;
}

/**
 * How many WHOLE treatments of `durationMs` still fit in a free window.
 *
 * Free minutes are not free treatments: three separate 40-minute gaps are two
 * hours of white space and zero 60-minute appointments. This is the arithmetic
 * that keeps "currently free" from being read as spare capacity.
 *
 * The buffer rule is Hone's existing one, not a new one. Between two bookings
 * the trailing buffer must fit inside the window, so k slots need
 * `k * duration + k * buffer`. Against CLOSING TIME the buffer is allowed to
 * spill past close — `validate_appointment_availability` tests the SERVICE end
 * against close, and lib/booking/slots.ts packs the closing edge the same way —
 * so the final slot of the day needs only its duration.
 */
export function wholeOpenings(
  free: ReadonlyArray<Interval>,
  closeMs: number,
  durationMs: number,
  bufferMs: number,
): number {
  if (durationMs <= 0) return 0;
  let total = 0;
  for (const w of free) {
    const span = w.end - w.start;
    if (span < durationMs) continue;
    const bufferedSpan = w.end >= closeMs ? span + bufferMs : span;
    total += Math.floor(bufferedSpan / (durationMs + bufferMs));
  }
  return total;
}

// ---------------------------------------------------------------------------
// One day's capacity
// ---------------------------------------------------------------------------

export type DayCapacity = {
  netBookableMinutes: number;
  bookedMinutes: number;
  freeMinutes: number;
  /** Whole openings of the probe duration that genuinely still fit. */
  usableOpenings: number;
};

export const EMPTY_DAY: DayCapacity = {
  netBookableMinutes: 0,
  bookedMinutes: 0,
  freeMinutes: 0,
  usableOpenings: 0,
};

export type DayCapacityInput = {
  /** The day's open and close instants, from the resolved availability window. */
  openMs: number;
  closeMs: number;
  /** Nothing before this instant is bookable, so the day is clipped to it. */
  fromMs: number;
  /**
   * Every reservation touching the day, already carrying Hone's source-aware
   * protected end (`protectedIntervals`): appointments include the trailing
   * buffer, blocks and breaks do not.
   */
  intervals: ReadonlyArray<ProtectedInterval>;
  probeDurationMs: number;
  bufferMs: number;
};

/**
 * Net bookable = the open window still ahead, minus authoritative closed time.
 * Free = what survives once every reservation is removed.
 * Booked = what is left: `netBookable − free`.
 *
 * BOOKED IS DERIVED, NOT MEASURED, and that is the point. Measuring it directly
 * as appointment-plus-buffer double-counts against closed time, because the two
 * really can overlap: migration 0152 stores an appointment's ACTUAL end in the
 * shadow and the GiST exclusion covers only that, so a break may legally begin
 * inside the buffer this code reconstructs. Verified against the real database
 * — a 09:00–10:00 appointment with a 30-minute buffer accepts a 10:00–11:00
 * block beside it. Measured separately on a 09:00–11:00 day that yields 60 net
 * bookable minutes and 90 booked ones: 150% booked, from two correct numbers.
 *
 * Deriving booked from the gaps keeps the three figures consistent by
 * construction — booked + free = net bookable, always — so the share can never
 * exceed 100%, and time that is closed is counted once, as closed.
 */
export function dayCapacity({
  openMs,
  closeMs,
  fromMs,
  intervals,
  probeDurationMs,
  bufferMs,
}: DayCapacityInput): DayCapacity {
  const start = Math.max(openMs, fromMs);
  if (closeMs <= start) return EMPTY_DAY;

  const closed = mergeClipped(
    intervals.filter((i) => i.sourceKind !== "appointment"),
    start,
    closeMs,
  );
  const free = gapsIn(mergeClipped(intervals, start, closeMs), start, closeMs);

  const netBookableMinutes = (closeMs - start) / MINUTE_MS - minutesIn(closed);
  const freeMinutes = minutesIn(free);
  return {
    netBookableMinutes,
    // Never negative: `free` is a subset of the window that `closed` was also
    // removed from, so it can never exceed what remains after the closures.
    bookedMinutes: Math.max(0, netBookableMinutes - freeMinutes),
    freeMinutes,
    usableOpenings: wholeOpenings(free, closeMs, probeDurationMs, bufferMs),
  };
}

export function addDayCapacity(a: DayCapacity, b: DayCapacity): DayCapacity {
  return {
    netBookableMinutes: a.netBookableMinutes + b.netBookableMinutes,
    bookedMinutes: a.bookedMinutes + b.bookedMinutes,
    freeMinutes: a.freeMinutes + b.freeMinutes,
    usableOpenings: a.usableOpenings + b.usableOpenings,
  };
}

/** Booked share of net bookable time. Null when there is nothing to be booked. */
export function bookedPercent(week: DayCapacity): number | null {
  if (week.netBookableMinutes <= 0) return null;
  return Math.round((week.bookedMinutes / week.netBookableMinutes) * 100);
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

/**
 * An appointment reduced to the fields the briefing reasons about. `isConsultation`
 * is resolved by the loader through `isConsultationService`, the same predicate the
 * public booking page and its server guard share — this module never re-decides it.
 *
 * An appointment with NO service is treatment, not a consultation: it is booked
 * studio time with a client, and calling it a consultation would inflate the
 * new-client numbers with ordinary work.
 */
export type BriefingAppointment = {
  id: string;
  clientId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  isConsultation: boolean;
};

const ACTIVE_STATUSES = new Set(["confirmed", "completed"]);

/** Active = the studio is actually committed to it. Cancelled and no-show are not. */
export function isActiveBooking(a: Pick<BriefingAppointment, "status">): boolean {
  return ACTIVE_STATUSES.has(a.status);
}

/**
 * True when `appointment` is the client's FIRST-EVER active booking — the only
 * consultation that represents a genuinely new client.
 *
 * `history` is that client's full active booking history. A repeat consultation
 * for an existing client fails this test, which is exactly what stops returning
 * clients from being counted as new-client demand.
 */
export function isFirstEverBooking(
  appointment: BriefingAppointment,
  history: ReadonlyArray<BriefingAppointment>,
): boolean {
  return !history.some(
    (h) =>
      h.id !== appointment.id &&
      isActiveBooking(h) &&
      (h.startsAt < appointment.startsAt ||
        (h.startsAt === appointment.startsAt && h.id < appointment.id)),
  );
}

export type NewConsultationDemand = {
  /** Keyed by the horizons in NEW_CONSULTATION_HORIZON_DAYS. */
  readonly countsByDays: Readonly<Record<number, number>>;
};

/**
 * First-ever consultations starting inside each horizon. A client booking two
 * consultations counts once per booking only if each is genuinely their first,
 * which by construction at most one can be.
 */
export function countNewConsultations(
  upcoming: ReadonlyArray<BriefingAppointment>,
  historyByClient: ReadonlyMap<string, ReadonlyArray<BriefingAppointment>>,
  nowMs: number,
  horizons: ReadonlyArray<number> = NEW_CONSULTATION_HORIZON_DAYS,
): NewConsultationDemand {
  const countsByDays: Record<number, number> = {};
  for (const days of horizons) countsByDays[days] = 0;
  for (const a of upcoming) {
    if (!a.isConsultation || !isActiveBooking(a)) continue;
    if (!isFirstEverBooking(a, historyByClient.get(a.clientId) ?? [])) continue;
    const startMs = new Date(a.startsAt).getTime();
    if (!Number.isFinite(startMs) || startMs < nowMs) continue;
    for (const days of horizons) {
      if (startMs < nowMs + days * 24 * 60 * MINUTE_MS) countsByDays[days] += 1;
    }
  }
  return { countsByDays };
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export type ConversionSummary = {
  converted: number;
  matured: number;
  /** Rounded whole percent, or null when the cohort is empty. */
  percent: number | null;
};

/**
 * Of the first-ever consultations that have had a full `CONVERSION_MATURITY_DAYS`
 * to convert, how many were followed by a real treatment booking inside that
 * window.
 *
 * `cohort` must already be the matured, first-ever consultations. A consultation
 * that ended yesterday is not a failure, it is unfinished, and it appears on
 * neither side of this ratio.
 */
export function summarizeConversion(
  cohort: ReadonlyArray<BriefingAppointment>,
  historyByClient: ReadonlyMap<string, ReadonlyArray<BriefingAppointment>>,
  windowDays: number = CONVERSION_MATURITY_DAYS,
): ConversionSummary {
  let converted = 0;
  for (const c of cohort) {
    const endMs = new Date(c.endsAt).getTime();
    if (!Number.isFinite(endMs)) continue;
    const deadline = endMs + windowDays * 24 * 60 * MINUTE_MS;
    const followed = (historyByClient.get(c.clientId) ?? []).some((h) => {
      if (h.id === c.id || h.isConsultation || !isActiveBooking(h)) return false;
      const startMs = new Date(h.startsAt).getTime();
      return Number.isFinite(startMs) && startMs > endMs && startMs <= deadline;
    });
    if (followed) converted += 1;
  }
  return {
    converted,
    matured: cohort.length,
    percent:
      cohort.length === 0
        ? null
        : Math.round((converted / cohort.length) * 100),
  };
}

// ---------------------------------------------------------------------------
// Booking depth
// ---------------------------------------------------------------------------

export type BookingDepth = {
  zero: number;
  oneOrMore: number;
  twoOrMore: number;
  threeOrMore: number;
};

/**
 * How deeply the studio's active treatment clients are actually booked.
 *
 * `activeClientIds` is the active-treatment-client set. A client in that set
 * with no future treatment is counted in `zero` — they are the latent-demand
 * signal, and they are NOT converted into projected hours anywhere: nobody
 * knows when they will book.
 */
export function summarizeBookingDepth(
  activeClientIds: ReadonlySet<string>,
  futureTreatmentCountByClient: ReadonlyMap<string, number>,
): BookingDepth {
  const depth: BookingDepth = { zero: 0, oneOrMore: 0, twoOrMore: 0, threeOrMore: 0 };
  for (const id of activeClientIds) {
    const n = futureTreatmentCountByClient.get(id) ?? 0;
    if (n === 0) depth.zero += 1;
    if (n >= 1) depth.oneOrMore += 1;
    if (n >= 2) depth.twoOrMore += 1;
    if (n >= 3) depth.threeOrMore += 1;
  }
  return depth;
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/**
 * The evidence a truthful "can I take another client?" needs. Every field is a
 * Fact, because several of them describe things Hone does not record at all
 * today, and the difference between "zero" and "not recorded" is the whole
 * point of this screen.
 */
export type AdmissionEvidence = {
  /** Free treatment hours across the horizon. Already net of booked demand. */
  freeTreatmentHours: Fact<number>;
  /** Days until the next legal treatment-sized opening; null = none in horizon. */
  nextTreatmentOpeningDays: Fact<number | null>;
  /** The studio's own target for how soon a converted consultation gets treated. */
  firstTreatmentLeadTimeTargetDays: Fact<number>;
  /** Active treatment clients holding no future treatment appointment. */
  activeClientsWithoutFutureBooking: Fact<number>;
  /** Treatment hours the existing active clients will need across the horizon. */
  latentRecurringDemandHours: Fact<number>;
  /** First-ever consultations already booked in the next 7 days. */
  newConsultationsNext7Days: Fact<number>;
  /** People already privately promised a place who have not booked yet. */
  outstandingInvitations: Fact<number>;
  /** The studio's own declared intake ceiling, new clients per week. */
  studioIntakeCapPerWeek: Fact<number>;
};

export type AdmissionState =
  | { kind: "can_take_more"; count: number }
  | { kind: "hold"; reason: string }
  | { kind: "unknown"; missing: string[] };

const EVIDENCE_LABELS: Record<keyof AdmissionEvidence, string> = {
  freeTreatmentHours: "Free treatment capacity",
  nextTreatmentOpeningDays: "Next treatment opening",
  firstTreatmentLeadTimeTargetDays: "First-treatment lead-time target",
  activeClientsWithoutFutureBooking: "Active clients with no future booking",
  latentRecurringDemandHours: "Recurring demand from existing clients",
  newConsultationsNext7Days: "New consultations booked this week",
  outstandingInvitations: "Outstanding private invitations",
  studioIntakeCapPerWeek: "Studio intake cap",
};

/**
 * The admission ladder. It produces a number ONLY when every input is present.
 *
 * This is deliberately not `free hours / 60`. Dividing white space by a service
 * length answers "how many appointments fit", which is a different question from
 * "how many recurring clients can this practice absorb" — the second one needs
 * to know what the existing clients will come back for, how fast a new client
 * has to be seen, and whether the studio has a ceiling it set for itself. Hone
 * records none of those three today, so today this returns `unknown` and names
 * them. That is the honest output, and it is more useful than a confident 2.
 */
export function evaluateAdmission(evidence: AdmissionEvidence): AdmissionState {
  const missing = (Object.keys(EVIDENCE_LABELS) as Array<keyof AdmissionEvidence>)
    .filter((key) => !evidence[key].known)
    .map((key) => `${EVIDENCE_LABELS[key]}: ${(evidence[key] as { reason: string }).reason}`);
  if (missing.length > 0) return { kind: "unknown", missing };

  // Every branch below reads a `.value` that the check above proved present.
  const free = (evidence.freeTreatmentHours as { value: number }).value;
  const opening = (evidence.nextTreatmentOpeningDays as { value: number | null }).value;
  const target = (evidence.firstTreatmentLeadTimeTargetDays as { value: number }).value;
  const stranded = (evidence.activeClientsWithoutFutureBooking as { value: number }).value;
  const latent = (evidence.latentRecurringDemandHours as { value: number }).value;
  const booked = (evidence.newConsultationsNext7Days as { value: number }).value;
  const invited = (evidence.outstandingInvitations as { value: number }).value;
  const cap = (evidence.studioIntakeCapPerWeek as { value: number }).value;

  if (opening === null) {
    return { kind: "hold", reason: "No treatment opening inside the horizon." };
  }
  if (opening > target) {
    return {
      kind: "hold",
      reason: `A new client would wait ${opening} days for a first treatment, past the ${target}-day target.`,
    };
  }
  if (stranded > 0) {
    return {
      kind: "hold",
      reason: `${stranded} active treatment ${stranded === 1 ? "client has" : "clients have"} no future appointment.`,
    };
  }
  if (latent > free) {
    return {
      kind: "hold",
      reason: "Existing clients' recurring demand already exceeds free capacity.",
    };
  }
  const remaining = cap - booked - invited;
  if (remaining <= 0) {
    return { kind: "hold", reason: "This week's intake is already committed." };
  }
  return { kind: "can_take_more", count: remaining };
}
