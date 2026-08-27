// ===========================================================================
// FIN-01A — the derivations behind /financials, with no I/O
// ===========================================================================
//
// SCOPE — SLICE 1, "the spine and the unknown vocabulary". This module knows
// about the CALENDAR only: how many appointments a studio-local period holds,
// and how they divide across the four statuses. It knows nothing about money.
//
// There is no card money here, no practitioner-attested disposition, and no
// service value, because none of those is answered by this release. They are
// ABSENT rather than stubbed — the same discipline OWNER-CAP Slice 1 applied to
// treatment access and weekly capacity — and the one place the screen mentions
// them, it says so in a sentence rather than in a zero.
//
// WHY THE CALENDAR CENSUS IS COUNTS AND NOT DOLLARS. Direction B's anchor is
// "work actually completed", and the frozen design values it in service value.
// Establishing service value means resolving a price per visit — snapshot-first
// off `appointment_settlements.quoted_amount_cents`, falling back to the
// authoritative resolver — which is Slice 2's decision (operator decisions 1
// and 2, ratified 2026-08-25) and is money arithmetic. Slice 1 therefore
// answers the anchor in VISITS, which is fully established from one read, and
// says plainly that its value is not supported yet.

import { known, unknownBecause, type Fact, type FinancialUnknownCause } from "./financial-fact";

/**
 * The appointment status vocabulary, as migration 0010's CHECK constrains it.
 *
 * Held as a closed list so an unrecognised value is DETECTED rather than
 * silently discarded. A status this build has never heard of is not evidence of
 * anything — but dropping it would quietly shrink the partition below and make
 * a total look like it balances when it does not.
 */
export const APPOINTMENT_STATUSES = [
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
] as const;

export type AppointmentStatusName = (typeof APPOINTMENT_STATUSES)[number];

function isKnownStatus(value: string): value is AppointmentStatusName {
  return (APPOINTMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * One appointment, reduced to the two fields this slice reasons about.
 *
 * `starts_at` is here because STATUS ALONE CANNOT SAY WHETHER SOMETHING IS
 * STILL TO HAPPEN. `confirmed` means "on the calendar, not closed out either
 * way" — it says nothing about whether the appointment's start has passed, and
 * nothing in this system writes a terminal status when one elapses. Read as
 * "still to happen", a stale `confirmed` row reports a visit as upcoming
 * forever. Measured on production 2026-08-27: 29 of Willow's appointments were
 * past and still confirmed, the oldest from 2026-05-17.
 *
 * The wire shape is PostgREST's, so the column name is kept verbatim.
 */
export type CensusRow = { readonly status: string; readonly starts_at: string };

/**
 * THE PARTITION CLAIM.
 *
 * `closed` is an assertion the screen is allowed to print, not a sum the
 * renderer recomputes. It is true only when every appointment read fell into
 * exactly one of the four known statuses — so an unrecognised status makes the
 * claim FALSE while leaving the four counts themselves perfectly true, which is
 * the honest description of that state.
 */
export type PartitionClaim = {
  readonly closed: boolean;
  readonly unrecognisedStatuses: readonly string[];
  /**
   * Confirmed rows whose `starts_at` could not be read as an instant.
   *
   * They are counted in NEITHER temporal bucket, because neither answer is
   * established: "still to happen" and "past, still confirmed" are both claims
   * about a start time this row did not supply. Silently letting them fall to
   * one side is the specific fail-open this field exists to prevent —
   * `new Date("nonsense").getTime()` is `NaN`, and every comparison against
   * `NaN` is false, so an unguarded `>=` would have quietly called each one
   * PAST. Same treatment as an unrecognised status: the counts stay true, and
   * the completeness claim is withdrawn rather than the row being dropped.
   */
  readonly undatableConfirmed: number;
};

export type CalendarCensus = {
  /** Every appointment starting inside the period, whatever became of it. */
  readonly booked: Fact<number>;
  /** `confirmed` AND starting at or after the reference instant. */
  readonly stillToHappen: Fact<number>;
  /**
   * `confirmed` but already started. A FACT ABOUT THE RECORD, NOT ABOUT THE
   * VISIT: the only established truth is that a past appointment is still
   * marked confirmed. It is not evidence that the visit happened, was missed,
   * or was cancelled, and nothing here may imply otherwise.
   */
  readonly pastConfirmed: Fact<number>;
  /** `completed` — Direction B's anchor: the work that actually happened. */
  readonly completed: Fact<number>;
  readonly cancelled: Fact<number>;
  readonly noShow: Fact<number>;
  readonly partition: PartitionClaim;
};

/**
 * PURE. Counts one period's appointments by status, splitting `confirmed` on
 * time.
 *
 * THE REFERENCE INSTANT IS A PARAMETER, NOT A CLOCK READ. A pure function that
 * calls `new Date()` cannot be tested at the boundary it is most likely to get
 * wrong, and the tie rule below would be untestable by construction. The caller
 * reads the clock ONCE and passes the same instant that anchored the period
 * window, so the window and the split can never disagree with each other.
 *
 * THE TIE RULE, PINNED: `starts_at === referenceInstant` counts as STILL TO
 * HAPPEN. An appointment starting exactly now has not yet passed, and the
 * boundary matches the half-open `[start, end)` convention the period window
 * already uses — `>=` opens the interval, `<` closes it.
 *
 * An empty period returns `known(0)` for every line, and that is correct: the
 * read succeeded and the answer is genuinely nothing. This is the ONLY route by
 * which a zero reaches this screen — every other absence goes through
 * `unreadableCalendar` and arrives carrying a cause.
 */
export function summarizeCalendar(
  rows: readonly CensusRow[],
  referenceInstant: Date,
): CalendarCensus {
  const reference = referenceInstant.getTime();
  const byStatus = new Map<AppointmentStatusName, number>();
  const unrecognised = new Set<string>();
  let stillToHappen = 0;
  let pastConfirmed = 0;
  let undatableConfirmed = 0;

  for (const row of rows) {
    if (!isKnownStatus(row.status)) {
      unrecognised.add(row.status);
      continue;
    }
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    if (row.status !== "confirmed") continue;

    // Guarded explicitly rather than by comparison. `NaN >= reference` is
    // false, so a bare `>=` would silently file every unreadable start under
    // PAST — a wrong answer that looks like a decision.
    const startsAt = Date.parse(row.starts_at);
    if (Number.isNaN(startsAt)) {
      undatableConfirmed += 1;
      continue;
    }
    if (startsAt >= reference) stillToHappen += 1;
    else pastConfirmed += 1;
  }

  const count = (status: AppointmentStatusName) => known(byStatus.get(status) ?? 0);

  return {
    booked: known(rows.length),
    stillToHappen: known(stillToHappen),
    pastConfirmed: known(pastConfirmed),
    completed: count("completed"),
    cancelled: count("cancelled"),
    noShow: count("no_show"),
    partition: {
      closed: unrecognised.size === 0 && undatableConfirmed === 0,
      unrecognisedStatuses: [...unrecognised].sort(),
      undatableConfirmed,
    },
  };
}

/**
 * A census that could not be established, with every line carrying the SAME
 * cause.
 *
 * Deliberately not a partial result. A read that failed or was truncated tells
 * us nothing about any individual status, so publishing four zeroes and one
 * unknown — or the statuses that happened to arrive before the ceiling — is how
 * a confident, understated screen gets in front of an owner. The partition is
 * refused too: there is nothing to claim balance over.
 */
export function unreadableCalendar(cause: FinancialUnknownCause): CalendarCensus {
  const absent = unknownBecause<number>(cause);
  return {
    booked: absent,
    stillToHappen: absent,
    pastConfirmed: absent,
    completed: absent,
    cancelled: absent,
    noShow: absent,
    partition: { closed: false, unrecognisedStatuses: [], undatableConfirmed: 0 },
  };
}
