// ===========================================================================
// FIN-01A — the derivations behind /financials, with no I/O
// ===========================================================================
//
// TWO CENSUSES, DELIBERATELY SEPARATE.
//
//   summarizeCalendar        SLICE 1. The calendar only: how many appointments
//                            a studio-local period holds and how they divide
//                            across the four statuses. Knows nothing of money.
//
//   summarizeDeliveredMoney  SLICE 2. Delivered work and the money against it,
//                            over a NARROWER window. See its own header.
//
// They are not merged and neither is derived from the other. The calendar
// census answers "what was on the books", windowed on `starts_at` across the
// whole requested period. The money census answers "what was delivered and what
// was collected", windowed on `charged_at` / `refunded_at` for money and
// floored at the date from which the studio's record-keeping supports the
// question at all. Those windows are different by construction, so a figure
// from one is not a subtotal of the other and must never be presented as one.
//
// Slice 1's anchor stays counted in VISITS. Its value now has its own section
// rather than being folded into it, because service value is a PRICE and the
// anchor is WORK, and a single figure cannot be both.

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
  /**
   * Every appointment record starting inside the period, whatever became of it.
   *
   * `rows.length`, with NO status filter anywhere on the path: the query
   * narrows by studio and the half-open window only, and this count is taken
   * independently of the classification loop below. So it includes cancelled,
   * no-show, AND rows whose status this build does not recognise — which is
   * exactly why the loop's `continue` statements cannot shrink it.
   *
   * THE FIELD IS NAMED `booked`; THE OWNER-FACING LABEL IS NOT, and the
   * difference is deliberate. Rendered as "Booked in this period" it read as
   * work the studio had on, while 18 of August's 92 were cancelled — the label
   * quietly overstated the month by a fifth. The screen now says "Appointments
   * in this period", which claims only what this count is. The field keeps its
   * name because renaming it is a refactor with no owner-facing truth in it;
   * this comment is here so the next author does not read `booked` and
   * reintroduce the word on screen.
   */
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

// ===========================================================================
// FIN-01A SLICE 2 — August-onward delivered-money truth
// ===========================================================================
//
// SCOPE. Present-tense observable facts over one studio-local window. No
// forecast, no scenario, no client projection, no capacity utilisation.
//
// THE THREE EVIDENCE CLASSES ARE MODELLED APART AND NEVER SUMMED.
//
//   PROVIDER-VERIFIED    payment_charge_attempts. Hone watched the card move.
//   STUDIO-ATTESTED      appointment_settlements. A practitioner wrote it down.
//   SERVICE VALUE        services.price_cents. A price, not money.
//
// No field on this census adds any two of them, and there is no total line.
//
// ---------------------------------------------------------------------------
// CLASSIFICATION — `isConsultationService`, NEVER price
// ---------------------------------------------------------------------------
//
// An earlier draft of this module classified a visit by `price_cents === 0`.
// That was wrong three ways at once, and the shared predicate says so in its
// own header: it "does not look at price, duration, or any per-studio
// override".
//
//   * A PAID consultation was counted as TREATMENT — inflating treatment
//     hours, and putting consultation money into a treatment-yield figure.
//   * A ZERO-DOLLAR TREATMENT (a comp, a redo, a goodwill visit) was counted
//     as a CONSULTATION — removing real clinical work from treatment time.
//   * It was a SECOND definition of a product concept Hone had already
//     settled, so /financials could disagree with the public booking page,
//     its server-side guard and the owner capacity briefing about what a
//     consultation is.
//
// The predicate is the one `app/book/[slug]/PublicBookForm.tsx`, its server
// action, and `lib/dashboard/owner-capacity.ts` all share. This module never
// re-decides it and never infers it from price, duration or name on its own.
//
// THE THIRD MEMBER IS THE POINT. `appointments.service_id` is nullable and the
// service row can be deleted, so "no service on this appointment" is a real
// production state carrying neither modality nor name — the only two things
// the predicate reads. It is `unknown`, not silently treatment.
//
// PRICE STILL DOES ONE JOB, and only one: deciding whether there was anything
// to collect. That is what a price IS. It never decides what a visit is.
//
// ---------------------------------------------------------------------------
// TWO MONEY CONTRACTS, NAMED APART — they answer different questions
// ---------------------------------------------------------------------------
//
//   CASH MOVEMENT (transaction period)
//     Charges windowed on `charged_at`, refunds windowed on `refunded_at`,
//     independently. This is what moved through the card rails in the period.
//     A refund here may reverse a charge taken months earlier, so the net is
//     movement, NOT "what this period's work earned". The count of such
//     cross-period reversals is published rather than described in the
//     abstract.
//
//   COLLECTED ON DELIVERED TREATMENT (service period)
//     Restricted to visits that were BOTH delivered in this window AND paid by
//     card in it, with each charge netted by its OWN refund whenever that
//     refund happened. Numerator and denominator are then the SAME VISITS, so
//     the per-hour figure is a rate over one population rather than a quotient
//     of two different periods.
//
// The previous draft divided cash-movement net by delivered-visit hours. Those
// are different populations: a charge in the window can pay for a visit outside
// it, and a visit in the window can be paid outside it. The quotient had no
// population to be a rate OF. It is replaced, not relabelled.

import { isConsultationService } from "@/lib/booking/consultation";
import { resolveAuthoritativeSessionPaymentAmount } from "@/lib/billing/session-payment-amount";

/** The settlement vocabulary migration 0187 closes by CHECK. No card, no Hone. */
export const SETTLEMENT_METHODS = [
  "paid_cash",
  "paid_e_transfer",
  "paid_other_external",
  "waived",
  "still_owes",
] as const;

export type SettlementMethodName = (typeof SETTLEMENT_METHODS)[number];

/** Allocated once. A per-visit `[]` would churn an array for every row. */
const EMPTY_PRICING: readonly CustomPricingRow[] = [];

const EXTERNALLY_COLLECTED: ReadonlySet<string> = new Set([
  "paid_cash",
  "paid_e_transfer",
  "paid_other_external",
]);

/**
 * What a delivered visit IS. Same three-member vocabulary the owner capacity
 * briefing uses, resolved through the same predicate.
 */
export type ServiceClass = "consultation" | "treatment" | "unknown";

/** Wire shapes. PostgREST column names kept verbatim. */
export type ServiceRow = {
  readonly id: string;
  /** Read by `isConsultationService`, with `modality`. Never by this module. */
  readonly name: string;
  readonly modality: string | null;
  readonly price_cents: number | null;
};

export type DeliveryRow = {
  readonly id: string;
  /**
   * WHOSE VISIT, and the ONLY reason this column is read.
   *
   * `client_pricing` is keyed by client, so a per-client price cannot be
   * resolved without knowing whose visit this is. It is read, grouped, and
   * discarded: nothing derived from it reaches the census, and no component
   * may render it. This is the first client identifier the money read model
   * has ever carried, and an aggregate screen must not quietly become a way
   * to learn who paid what — `tests/app/finance/financials-truth.test.ts`
   * pins that.
   */
  readonly client_id: string | null;
  readonly service_id: string | null;
  readonly status: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly duration_minutes: number | null;
  readonly blocked_ends_at: string | null;
};

/**
 * A per-client price, as `client_pricing` stores it.
 *
 * MATCHED BY SERVICE NAME, NOT BY ID. That is the table's own long-standing
 * linkage rather than a choice made here — `lib/billing/session-payment-amount.ts`
 * preserves it deliberately, and changing it is a migration-shaped decision
 * belonging to its own slice.
 *
 * The consequence is worth stating because it is live: RENAMING A SERVICE
 * SILENTLY DETACHES every custom price attached to it, and that client quietly
 * reverts to the menu price. Production already shows this — the two
 * `client_pricing` rows in the entire database name services that no longer
 * exist under those names, so today they resolve for nobody.
 */
export type CustomPricingRow = {
  readonly client_id: string;
  readonly service_name: string;
  readonly price_cents: number;
  readonly notes: string | null;
  /** Studio-local `YYYY-MM-DD`. */
  readonly effective_from: string;
};

export type ChargeRow = {
  readonly appointment_id: string | null;
  readonly amount_cents: number | null;
  /** Netted against its OWN charge, whenever the refund happened. */
  readonly refund_amount_cents: number | null;
  readonly refund_status: string | null;
};

/** `charged_at` rides along so a cross-period reversal can be COUNTED. */
export type RefundRow = {
  readonly refund_amount_cents: number | null;
  readonly charged_at: string | null;
};

export type SettlementRow = {
  readonly appointment_id: string | null;
  readonly method: string;
  readonly amount_cents: number | null;
  /**
   * THE PRICE AT THE TIME, from 0187. Null when the resolver could not produce
   * one, which that migration deliberately keeps as a fact rather than a zero.
   */
  readonly quoted_amount_cents: number | null;
};

/**
 * PURE. `isConsultationService` needs only modality and name; a missing service
 * supplies neither, so the answer is `unknown` rather than a guess.
 */
export function classifyService(service: ServiceRow | null | undefined): ServiceClass {
  if (!service) return "unknown";
  return isConsultationService(service) ? "consultation" : "treatment";
}

/**
 * What the census could NOT account for. The counts above stay true and the
 * completeness claim is withdrawn, rather than a row being dropped to keep a
 * total tidy.
 */
export type DeliveryBasis = {
  readonly complete: boolean;
  /** `ends_at` unreadable, so "has it elapsed" is unanswerable. */
  readonly undatable: number;
  /** No resolvable service, so the visit cannot be classified at all. */
  readonly unclassifiable: number;
  /** Classified TREATMENT but carrying no price, so it cannot be valued. */
  readonly unvalued: number;
  /**
   * Visits whose CUSTOM price could not be determined because two equally
   * current `client_pricing` rows disagree.
   *
   * A SUBSET OF `unvalued`, reported separately because the two have different
   * remedies and the owner can only act on one of them. An unpriced service
   * needs a price; a contradiction needs one of two rows removed. Collapsing
   * them into a single sentence would tell an owner to go and price a service
   * that already carries two prices.
   *
   * FAILING CLOSED IS THE POINT. `client_pricing` has no uniqueness
   * constraint, so two rows may share an `effective_from` and disagree. The
   * resolver refuses to pick one, and the visit is counted and left unvalued
   * rather than valued at a guess — the same rule the billing path already
   * follows, so the two cannot disagree about what a visit was worth.
   */
  readonly ambiguouslyPriced: number;
  /** `blocked_ends_at` unreadable, so chair time is unmeasurable. */
  readonly unmeasurable: number;
  /**
   * Settlement rows naming an appointment that is not a delivered visit of
   * this window.
   *
   * Settlements are read STUDIO-WIDE, so most such rows belong to other
   * periods. The name is kept; the sentence on screen says what the count
   * actually is, because the two are not identical: a row can also name a
   * visit inside this window that has not yet elapsed, or one that was
   * cancelled.
   */
  readonly settlementsOutsideWindow: number;
  /**
   * Money or duration columns that did not arrive as a finite number.
   *
   * NOT COERCED TO ZERO AND NOT ADDED. A `?? 0` here would be the exact defect
   * this module is shaped against: an amount nobody could read would silently
   * become an amount of nothing, and the sum would look complete.
   */
  readonly unreadableAmounts: number;
};

export type DeliveredMoneyCensus = {
  // --- delivered work, classified by the shared predicate -----------------
  readonly deliveredTreatmentVisits: Fact<number>;
  readonly consultationVisits: Fact<number>;
  /** Delivered, but carrying no service Hone could classify. */
  readonly unclassifiedVisits: Fact<number>;
  /** Treatment visits with a positive price — the ones with something to collect. */
  readonly chargeableTreatmentVisits: Fact<number>;

  // --- SERVICE VALUE (a price, never money) -------------------------------
  readonly treatmentServiceValueCents: Fact<number>;
  /** Kept apart so a PAID consultation's value is neither lost nor merged. */
  readonly consultationServiceValueCents: Fact<number>;
  /**
   * Delivered visits valued at the price 0187 recorded when they were settled,
   * rather than at today's menu price.
   *
   * Published because the two figures above are a MIX of two bases wherever
   * this is neither zero nor the whole delivered set, and a reader cannot tell
   * which from the total. Repricing a service moves the today's-price part and
   * leaves this part alone.
   */
  readonly visitsValuedAtRecordedPrice: Fact<number>;
  /**
   * Visits valued at THIS CLIENT'S negotiated price rather than the menu.
   *
   * Reported so the basis of the service-value figure is legible: an owner
   * looking at a total that includes custom rates should be able to see that
   * it does, without being shown WHICH clients — the count is an aggregate
   * and carries no identity.
   */
  readonly visitsValuedAtClientPrice: Fact<number>;

  // --- CONTRACT 1: CASH MOVEMENT (transaction period) ---------------------
  readonly movedInGrossCents: Fact<number>;
  readonly movedOutRefundedCents: Fact<number>;
  readonly netMovementCents: Fact<number>;
  readonly chargeCount: Fact<number>;
  /** Of the refunds in this window, how many reverse a charge from another. */
  readonly refundsReversingOtherPeriods: Fact<number>;

  // --- CONTRACT 2: COLLECTED ON DELIVERED TREATMENT (service period) ------
  readonly collectedOnDeliveredCents: Fact<number>;
  readonly collectedOnDeliveredVisits: Fact<number>;
  readonly collectedOnDeliveredMinutes: Fact<number>;
  readonly perTreatmentHourCents: Fact<number>;

  // --- STUDIO-ATTESTED external money -------------------------------------
  readonly externallyAttestedCents: Fact<number>;
  readonly waivedCents: Fact<number>;
  readonly stillOwedCents: Fact<number>;

  // --- the bridge ---------------------------------------------------------
  readonly cardPaidVisits: Fact<number>;
  /**
   * Card-paid delivered treatment visits that carried NO positive price.
   *
   * They are outside the collection rate — "did you collect for it" has no
   * answer when there was nothing to collect — but they ARE inside the
   * service-period figures, because money did land on them. This count is what
   * makes the two paid-visit numbers on the screen reconcile.
   */
  readonly cardPaidWithoutAPrice: Fact<number>;
  /**
   * Delivered treatment whose card payment was refunded to nothing.
   *
   * Its own line because such a visit belongs in none of the others: money was
   * collected and sent back, so it is not in the collection rate, and it is
   * emphatically not "No payment recorded". v1 refunds are always full
   * reversals, so this is the shape every refund Hone writes produces.
   */
  readonly refundedToZeroVisits: Fact<number>;
  readonly collectionRateBasisPoints: Fact<number>;
  readonly unresolvedVisits: Fact<number>;
  readonly unresolvedServiceValueCents: Fact<number>;

  // --- time ---------------------------------------------------------------
  readonly treatmentBookedMinutes: Fact<number>;
  readonly treatmentBlockedMinutes: Fact<number>;
  readonly consultationBlockedMinutes: Fact<number>;
  readonly treatmentTimeShareBasisPoints: Fact<number>;
  readonly consultationTimeShareBasisPoints: Fact<number>;

  readonly basis: DeliveryBasis;
};

function parseInstant(value: string | null): number | null {
  if (value === null) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Finite numbers only. A null or a NaN is an absent measurement, not a zero. */
function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * PURE. The whole money census for one window.
 *
 * THE SNAPSHOT IS A PARAMETER, so every "has it elapsed" decision resolves
 * against the same instant the period window was anchored to. Production moved
 * under this measurement while it was being specified — delivered August visits
 * went 63 to 64 and card-paid 34 to 35 inside twenty-six minutes — so two reads
 * minutes apart legitimately disagree, and only a pinned instant makes one
 * report internally consistent.
 *
 * `windowStartUtc` / `windowEndUtc` are the MONEY window, and are used for one
 * job only: deciding whether a refund in this period reverses a charge from
 * another. Nothing else re-derives a window here.
 */
export function summarizeDeliveredMoney(input: {
  readonly services: readonly ServiceRow[];
  readonly appointments: readonly DeliveryRow[];
  readonly charges: readonly ChargeRow[];
  readonly refunds: readonly RefundRow[];
  readonly settlements: readonly SettlementRow[];
  readonly customPricing: readonly CustomPricingRow[];
  /** Studio-local `YYYY-MM-DD`. Injected: this module never reads a clock. */
  readonly todayLocal: string;
  readonly snapshot: Date;
  readonly windowStartUtc: string;
  readonly windowEndUtc: string;
}): DeliveredMoneyCensus {
  const at = input.snapshot.getTime();
  const windowStart = Date.parse(input.windowStartUtc);
  const windowEnd = Date.parse(input.windowEndUtc);
  const serviceById = new Map<string, ServiceRow>();
  for (const s of input.services) serviceById.set(s.id, s);

  /**
   * Custom prices grouped by client, ONCE.
   *
   * The resolver takes the candidate rows for one client and applies the
   * precedence itself; grouping here keeps the per-visit work a map lookup
   * rather than a filter over every pricing row in the studio.
   *
   * `client_id` GOES NO FURTHER THAN THIS MAP. It is the key, never a value,
   * and nothing derived from it reaches the census.
   */
  const customPricingByClient = new Map<string, CustomPricingRow[]>();
  for (const row of input.customPricing) {
    const existing = customPricingByClient.get(row.client_id);
    if (existing) existing.push(row);
    else customPricingByClient.set(row.client_id, [row]);
  }

  /**
   * THE PRICE EACH VISIT WAS ACTUALLY QUOTED, where a settlement recorded one.
   *
   * `services.price_cents` is a SINGLE CURRENT VALUE. Valuing past work with it
   * means repricing a service in March silently rewrites what February's visits
   * were worth — the same defect `blocked_ends_at` is read per appointment to
   * avoid, and the reason 0187 snapshots the quote at settlement time.
   *
   * EXACTLY ONE LIVE ROW PER APPOINTMENT, enforced by 0187's partial unique
   * index on (studio_id, appointment_id) where superseded_at is null, so this
   * map cannot be ambiguous and needs no tie-break. The loader reads live rows
   * only, so a superseded correction's predecessor never reaches it.
   */
  const recordedPriceOf = new Map<string, number>();
  for (const s of input.settlements) {
    if (s.appointment_id === null) continue;
    const quoted = finite(s.quoted_amount_cents);
    if (quoted !== null) recordedPriceOf.set(s.appointment_id, quoted);
  }

  let undatable = 0;
  let unclassifiable = 0;
  let unvalued = 0;
  let unmeasurable = 0;
  let unreadableAmounts = 0;

  const deliveredTreatment = new Set<string>();
  /**
   * EVERY delivered visit in this window, whatever kind it turned out to be.
   *
   * SETTLEMENTS ARE NARROWED AGAINST THIS, NOT AGAINST THE TREATMENT SET. A
   * practitioner who writes down cash for a delivered consultation attested
   * real money. Narrowing to treatment dropped that money from the external
   * total AND reported the loss as a settlement naming "a visit outside this
   * window" — a sentence that was false on a screen already showing the
   * consultation inside the window. An unclassifiable visit is in here too: a
   * missing service row says nothing about whether somebody was paid.
   */
  const deliveredAny = new Set<string>();
  const chargeable = new Map<string, number>();
  const bookedMinutesOf = new Map<string, number>();
  let consultationVisits = 0;
  let unclassifiedVisits = 0;
  let treatmentServiceValueCents = 0;
  let consultationServiceValueCents = 0;
  let treatmentBookedMinutes = 0;
  let treatmentBlockedMinutes = 0;
  let consultationBlockedMinutes = 0;
  let valuedAtRecordedPrice = 0;
  let valuedAtClientPrice = 0;
  let ambiguouslyPriced = 0;

  for (const row of input.appointments) {
    if (row.status !== "completed" && row.status !== "confirmed") continue;

    // Guarded explicitly. `NaN < at` is false, so a bare comparison would
    // silently file every unreadable end time as undelivered — a wrong answer
    // that looks like a decision.
    const endsAt = parseInstant(row.ends_at);
    if (endsAt === null) {
      undatable += 1;
      continue;
    }
    if (endsAt >= at) continue; // has not elapsed: not delivered, not a defect

    // Delivered, whatever it proves to be. Recorded BEFORE classification, so a
    // visit whose service is gone is still a visit a settlement can name.
    deliveredAny.add(row.id);

    const service = row.service_id === null ? null : serviceById.get(row.service_id);
    const serviceClass = classifyService(service);
    if (serviceClass === "unknown") {
      unclassifiable += 1;
      unclassifiedVisits += 1;
      continue;
    }

    const startsAt = parseInstant(row.starts_at);
    const blockedEndsAt = parseInstant(row.blocked_ends_at);
    const blockedMinutes =
      startsAt === null || blockedEndsAt === null || blockedEndsAt < startsAt
        ? null
        : (blockedEndsAt - startsAt) / 60_000;
    if (blockedMinutes === null) unmeasurable += 1;

    // ---------------------------------------------------------------------
    // WHAT THIS VISIT WAS WORTH — three tiers, tried in order
    // ---------------------------------------------------------------------
    //
    //   1. THE PRICE ON RECORD. `appointment_settlements.quoted_amount_cents`,
    //      snapshotted by 0187 at settlement time. Frozen: a later menu edit
    //      cannot rewrite what a settled visit was worth.
    //
    //   2. THE PRICE THIS CLIENT PAYS. `resolveAuthoritativeSessionPaymentAmount`
    //      — the SAME resolver the billing path uses to decide what to charge.
    //      That sharing is the whole point of tier 2: a screen that valued work
    //      differently from the code that collected for it would disagree with
    //      the client's own card statement, and the owner would have no way to
    //      tell which number was wrong.
    //
    //   3. UNKNOWN. Counted, disclosed, never zero.
    //
    // TIER 2 REPLACES A BARE `services.price_cents` READ, and that read was
    // wrong rather than merely coarse: it ignored `client_pricing` entirely, so
    // every client on a negotiated rate was valued at the menu price they do
    // not pay. It was invisible in production only because this studio's two
    // custom-price rows name services that have since been renamed.
    const recordedPrice = recordedPriceOf.get(row.id);
    let price: number | null;
    if (recordedPrice !== undefined) {
      price = recordedPrice;
      valuedAtRecordedPrice += 1;
    } else {
      const resolved = resolveAuthoritativeSessionPaymentAmount({
        service: service ? { name: service.name, price_cents: service.price_cents } : null,
        appointmentDurationMinutes: finite(row.duration_minutes),
        customPricing: row.client_id === null
          ? EMPTY_PRICING
          : customPricingByClient.get(row.client_id) ?? EMPTY_PRICING,
        today: input.todayLocal,
      });
      if (resolved.kind === "resolved") {
        price = resolved.amountCents;
        if (resolved.source === "custom_pricing") valuedAtClientPrice += 1;
      } else if (resolved.kind === "free") {
        // FREE-01. A studio pricing a service at $0 made a DECISION, and this
        // is a real zero rather than an absence. It is not `unvalued`.
        price = 0;
      } else {
        // `missing_price`, `missing_service`, `ambiguous_custom_pricing`.
        // The visit still counts; only its value is absent.
        price = null;
        if (resolved.kind === "ambiguous_custom_pricing") ambiguouslyPriced += 1;
      }
    }

    if (serviceClass === "consultation") {
      consultationVisits += 1;
      if (blockedMinutes !== null) consultationBlockedMinutes += blockedMinutes;
      // A consultation is USUALLY free. When it is not, its value is kept in
      // its own line rather than folded into treatment value, so a paid
      // consultation is neither lost nor counted as treatment earnings.
      if (price !== null) consultationServiceValueCents += price;
      continue;
    }

    deliveredTreatment.add(row.id);
    if (blockedMinutes !== null) treatmentBlockedMinutes += blockedMinutes;
    const booked = finite(row.duration_minutes);
    if (booked === null) unreadableAmounts += 1;
    else {
      treatmentBookedMinutes += booked;
      bookedMinutesOf.set(row.id, booked);
    }

    if (price === null) {
      // Classified treatment, but nothing establishes what it was worth. The
      // VISIT still counts; only its value is absent.
      unvalued += 1;
    } else {
      treatmentServiceValueCents += price;
      // PRICE DECIDES ONLY ONE THING: whether there was anything to collect.
      // A zero-value treatment is real clinical work with nothing owed on it,
      // so it belongs in treatment time and NOT in a collection rate — "did
      // you collect for it" has no answer when there was nothing to collect.
      if (price > 0) chargeable.set(row.id, price);
    }
  }

  // --- CONTRACT 1: CASH MOVEMENT ------------------------------------------
  let movedInGrossCents = 0;
  // COUNTED, NOT `input.charges.length`. A charge whose amount could not be
  // read is excluded from the gross above, so counting the returned ROWS would
  // print "N payments" beside a total that sums fewer than N of them. The count
  // and the sum now describe the same set; the excluded rows are disclosed by
  // `basis.unreadableAmounts`.
  let summedCharges = 0;
  /**
   * Visits a card charge LANDED on. Not yet "paid": whether the money stayed
   * is not known until the charge has been netted by its own refund, which is
   * why this set is no longer the one the collection rate reads.
   */
  const chargedVisits = new Set<string>();
  // Each charge netted by its OWN refund, whenever that refund happened. This
  // is the service-period numerator and it never touches the window.
  const netOnVisit = new Map<string, number>();
  /** Visits whose card net could not be established, so they join no rate. */
  const unnettable = new Set<string>();
  for (const c of input.charges) {
    const amount = finite(c.amount_cents);
    if (amount === null) {
      unreadableAmounts += 1;
      continue;
    }
    movedInGrossCents += amount;
    summedCharges += 1;
    const id = c.appointment_id;
    if (id === null || !deliveredTreatment.has(id)) continue;
    chargedVisits.add(id);
    // A SUCCEEDED REFUND WITH AN UNREADABLE AMOUNT MAKES THE NET UNKNOWABLE.
    // Treating it as zero would count the whole charge as collected and
    // OVERSTATE what the visit earned — the one direction a money figure must
    // never fail in. The visit is withdrawn from the service-period set
    // instead, and counted.
    let refunded = 0;
    if (c.refund_status === "succeeded") {
      const amountRefunded = finite(c.refund_amount_cents);
      if (amountRefunded === null) {
        unreadableAmounts += 1;
        unnettable.add(id);
        continue;
      }
      refunded = amountRefunded;
    }
    const previous = netOnVisit.get(id);
    netOnVisit.set(id, (previous === undefined ? 0 : previous) + amount - refunded);
  }

  /**
   * WHETHER THE MONEY STAYED, decided AFTER the netting rather than when the
   * charge was seen.
   *
   * The defect this replaces: membership was taken at the moment a charge
   * landed, so a visit charged and then refunded in full counted as collected.
   * The screen read "1 visit paid by card · 100.0%" directly above "Collected
   * by card, after refunds: $0.00", claimed the account was complete, and kept
   * the visit out of "No payment recorded" as well — so it appeared in no
   * honest line at all. That overstates collection, the one direction a money
   * figure must never fail in.
   *
   * IT IS NOT AN EDGE CASE. lib/billing/payment-refund.ts states its v1
   * contract outright — "No partial refund. v1 sets refund_amount_cents =
   * amount_cents always" — so a full reversal is the ONLY refund shape this
   * product can currently write, and it is exactly the shape that nets to zero.
   *
   * A visit whose net could not be established joins NEITHER set: an unknown
   * net is not a collection and it is not a reversal. It is already disclosed
   * by `basis.unreadableAmounts`.
   */
  const cardPaid = new Set<string>();
  const refundedToZero = new Set<string>();
  for (const id of chargedVisits) {
    if (unnettable.has(id)) continue;
    const net = netOnVisit.get(id);
    if (net === undefined) continue;
    if (net > 0) cardPaid.add(id);
    else refundedToZero.add(id);
  }

  // Windowed on `refunded_at` INDEPENDENTLY, because a refund can fall in a
  // different period from the charge it reverses. That makes this NET a
  // statement about cash movement, not about what this period's work earned —
  // which is why the cross-period reversals are counted and published rather
  // than left for the reader to assume away.
  let movedOutRefundedCents = 0;
  let refundsReversingOtherPeriods = 0;
  for (const r of input.refunds) {
    const amount = finite(r.refund_amount_cents);
    if (amount === null) {
      unreadableAmounts += 1;
      continue;
    }
    movedOutRefundedCents += amount;
    const chargedAt = parseInstant(r.charged_at);
    if (chargedAt === null || chargedAt < windowStart || chargedAt >= windowEnd) {
      refundsReversingOtherPeriods += 1;
    }
  }

  // --- CONTRACT 2: COLLECTED ON DELIVERED TREATMENT -----------------------
  // Delivered in this window AND paid by card in it. Numerator and denominator
  // are the SAME VISITS, so the per-hour figure is a rate over one population.
  let collectedOnDeliveredCents = 0;
  let collectedOnDeliveredMinutes = 0;
  let collectedOnDeliveredVisits = 0;
  for (const [id, net] of netOnVisit) {
    if (unnettable.has(id)) continue;
    const minutes = bookedMinutesOf.get(id);
    // A visit whose booked time could not be read cannot join a per-hour rate:
    // including its money over no time would inflate the rate without bound.
    if (minutes === undefined) continue;
    collectedOnDeliveredCents += net;
    collectedOnDeliveredMinutes += minutes;
    collectedOnDeliveredVisits += 1;
  }
  const perTreatmentHourCents =
    collectedOnDeliveredMinutes === 0
      ? unknownBecause<number>("not_recorded")
      : known(Math.round(collectedOnDeliveredCents / (collectedOnDeliveredMinutes / 60)));

  // --- STUDIO-ATTESTED ----------------------------------------------------
  let externallyAttestedCents = 0;
  let waivedCents = 0;
  let stillOwedCents = 0;
  let settlementsOutsideWindow = 0;
  // Rows that named a delivered visit in this window AND carried a readable
  // amount. This — not the studio's all-time row count — is what decides
  // whether "nothing was attested" is a true thing to say about this window.
  let attestedRows = 0;
  const settled = new Set<string>();
  for (const s of input.settlements) {
    if (s.appointment_id === null || !deliveredAny.has(s.appointment_id)) {
      settlementsOutsideWindow += 1;
      continue;
    }
    settled.add(s.appointment_id);
    const amount = finite(s.amount_cents);
    if (amount === null) {
      unreadableAmounts += 1;
      continue;
    }
    attestedRows += 1;
    if (EXTERNALLY_COLLECTED.has(s.method)) externallyAttestedCents += amount;
    else if (s.method === "waived") waivedCents += amount;
    else if (s.method === "still_owes") stillOwedCents += amount;
  }

  // NOTHING ATTESTED IS NOT NOTHING COLLECTED. An absent settlement row means
  // nobody wrote it down, which is exactly the state production is in: one row
  // in the entire database, and none for this studio. Rendering 0 would tell an
  // owner who takes cash every week that she took none. Operator decision 4.
  //
  // AND IT IS A QUESTION ABOUT THIS WINDOW. Gating on `input.settlements.length`
  // asked the studio's ALL-TIME row count instead: settlements are read
  // studio-wide, so the first row a studio ever wrote flipped every OTHER
  // window from "Nothing recorded" to a confident $0.00 — printing the exact
  // sentence the paragraph above exists to prevent, in every period the studio
  // had not settled. A row whose amount could not be read does not open the
  // gate either: it is evidence that something was attested, never evidence of
  // an amount, and it is disclosed by `basis.unreadableAmounts`.
  const nothingAttested = attestedRows === 0;
  const attested = (cents: number): Fact<number> =>
    nothingAttested ? unknownBecause<number>("not_recorded") : known(cents);

  // --- the bridge ---------------------------------------------------------
  let unresolvedVisits = 0;
  let unresolvedServiceValueCents = 0;
  let cardPaidChargeable = 0;
  // THE ONE PLACE THE SCREEN'S TWO PAID-VISIT COUNTS CAN DISAGREE, measured
  // rather than left for a reader to notice.
  //
  // "Paid by card" under the collection rate counts visits that HAD SOMETHING
  // TO COLLECT and were collected. The service-period section counts every
  // delivered treatment visit a card payment landed on. A visit priced at
  // nothing, or carrying no price at all, that was nonetheless charged sits in
  // the second and not the first — so the two numbers differ, both correctly.
  //
  // Rather than describe that possibility in prose, it is counted here and
  // shown only when it actually happens. Production holds three null-priced
  // services today, so this is reachable, not hypothetical.
  let cardPaidWithoutAPrice = 0;
  for (const id of cardPaid) {
    if (!chargeable.has(id)) cardPaidWithoutAPrice += 1;
  }
  for (const [id, value] of chargeable) {
    if (cardPaid.has(id)) {
      cardPaidChargeable += 1;
      continue;
    }
    // Reversed to nothing. Out of the rate, and NOT "No payment recorded" —
    // a payment was recorded, and then it was sent back. Counted for the whole
    // set below, not just here.
    if (refundedToZero.has(id)) continue;
    // Net unknowable: neither collected nor unrecorded. Carried by `basis`.
    if (unnettable.has(id)) continue;
    if (settled.has(id)) continue;
    unresolvedVisits += 1;
    unresolvedServiceValueCents += value;
  }

  // VISIT COUNT ON BOTH SIDES, over the visits that had something to collect.
  // Never dollars: the numerator would be an operator-authored till total and
  // the denominator a mutable menu price, and that quotient is not a rate.
  const collectionRateBasisPoints =
    chargeable.size === 0
      ? unknownBecause<number>("not_recorded")
      : known(Math.round((cardPaidChargeable / chargeable.size) * 10_000));

  const clinicalMinutes = treatmentBlockedMinutes + consultationBlockedMinutes;
  const share = (part: number): Fact<number> =>
    clinicalMinutes === 0
      ? unknownBecause<number>("not_recorded")
      : known(Math.round((part / clinicalMinutes) * 10_000));

  return {
    deliveredTreatmentVisits: known(deliveredTreatment.size),
    consultationVisits: known(consultationVisits),
    unclassifiedVisits: known(unclassifiedVisits),
    chargeableTreatmentVisits: known(chargeable.size),

    treatmentServiceValueCents: known(treatmentServiceValueCents),
    consultationServiceValueCents: known(consultationServiceValueCents),
    visitsValuedAtRecordedPrice: known(valuedAtRecordedPrice),
    visitsValuedAtClientPrice: known(valuedAtClientPrice),

    movedInGrossCents: known(movedInGrossCents),
    movedOutRefundedCents: known(movedOutRefundedCents),
    netMovementCents: known(movedInGrossCents - movedOutRefundedCents),
    chargeCount: known(summedCharges),
    refundsReversingOtherPeriods: known(refundsReversingOtherPeriods),

    collectedOnDeliveredCents: known(collectedOnDeliveredCents),
    collectedOnDeliveredVisits: known(collectedOnDeliveredVisits),
    collectedOnDeliveredMinutes: known(collectedOnDeliveredMinutes),
    perTreatmentHourCents,

    externallyAttestedCents: attested(externallyAttestedCents),
    waivedCents: attested(waivedCents),
    stillOwedCents: attested(stillOwedCents),

    cardPaidVisits: known(cardPaidChargeable),
    cardPaidWithoutAPrice: known(cardPaidWithoutAPrice),
    // EVERY delivered treatment visit reversed to nothing, not only the ones
    // that carried a price. Counting only the chargeable ones left a priceless
    // treatment that was charged and then refunded explaining nothing: it sat
    // in the service-period visit count, outside `cardPaidVisits`, and outside
    // `cardPaidWithoutAPrice` too — so two adjacent numbers on the screen
    // disagreed with no line saying why, which is the mismatch that reads as a
    // bug report.
    refundedToZeroVisits: known(refundedToZero.size),
    collectionRateBasisPoints,
    unresolvedVisits: known(unresolvedVisits),
    unresolvedServiceValueCents: known(unresolvedServiceValueCents),

    treatmentBookedMinutes: known(treatmentBookedMinutes),
    treatmentBlockedMinutes: known(treatmentBlockedMinutes),
    consultationBlockedMinutes: known(consultationBlockedMinutes),
    treatmentTimeShareBasisPoints: share(treatmentBlockedMinutes),
    consultationTimeShareBasisPoints: share(consultationBlockedMinutes),

    basis: {
      complete:
        undatable === 0 &&
        unclassifiable === 0 &&
        unvalued === 0 &&
        unmeasurable === 0 &&
        settlementsOutsideWindow === 0 &&
        unreadableAmounts === 0,
      undatable,
      unclassifiable,
      unvalued,
      ambiguouslyPriced,
      unmeasurable,
      settlementsOutsideWindow,
      unreadableAmounts,
    },
  };
}

/**
 * A money census that could not be established, EVERY line carrying the same
 * cause. Deliberately not partial: a failed or truncated read tells us nothing
 * about any individual figure, and publishing the lines that happened to arrive
 * is how a confident, understated money screen reaches an owner.
 */
export function unreadableDeliveredMoney(
  cause: FinancialUnknownCause,
): DeliveredMoneyCensus {
  const absent = unknownBecause<number>(cause);
  return {
    deliveredTreatmentVisits: absent,
    consultationVisits: absent,
    unclassifiedVisits: absent,
    chargeableTreatmentVisits: absent,
    treatmentServiceValueCents: absent,
    consultationServiceValueCents: absent,
    visitsValuedAtRecordedPrice: absent,
    visitsValuedAtClientPrice: absent,
    movedInGrossCents: absent,
    movedOutRefundedCents: absent,
    netMovementCents: absent,
    chargeCount: absent,
    refundsReversingOtherPeriods: absent,
    collectedOnDeliveredCents: absent,
    collectedOnDeliveredVisits: absent,
    collectedOnDeliveredMinutes: absent,
    perTreatmentHourCents: absent,
    externallyAttestedCents: absent,
    waivedCents: absent,
    stillOwedCents: absent,
    cardPaidVisits: absent,
    cardPaidWithoutAPrice: absent,
    refundedToZeroVisits: absent,
    collectionRateBasisPoints: absent,
    unresolvedVisits: absent,
    unresolvedServiceValueCents: absent,
    treatmentBookedMinutes: absent,
    treatmentBlockedMinutes: absent,
    consultationBlockedMinutes: absent,
    treatmentTimeShareBasisPoints: absent,
    consultationTimeShareBasisPoints: absent,
    basis: {
      complete: false,
      undatable: 0,
      unclassifiable: 0,
      unvalued: 0,
      ambiguouslyPriced: 0,
      unmeasurable: 0,
      settlementsOutsideWindow: 0,
      unreadableAmounts: 0,
    },
  };
}
