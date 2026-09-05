import Link from "next/link";

import { SectionLabel } from "@/components/ui/section-label";
import type { FinancialBriefing } from "@/lib/finance/financial-briefing";
import {
  CAPACITY_NOT_YET,
  CASH_MOVEMENT_IS_NOT_EARNINGS,
  COLLECTED_IS_GROSS,
  COLLECTED_ON_DELIVERED_IS_ONE_POPULATION,
  CONSULTATION_IS_A_SERVICE_KIND,
  COLLECTION_RATE_IS_VISITS,
  CONSULTATIONS_ARE_UNPAID_TIME,
  DELIVERED_MEANS,
  MONEY_WINDOW_IS_NARROWER,
  COMPLETED_IS_NOT_THE_MONEY_POPULATION,
  NO_PAYMENT_RECORDED_IS_NOT_OWED,
  PAID_BUT_NOTHING_TO_COLLECT,
  PER_HOUR_POPULATION,
  PAST_STILL_CONFIRMED_IS_A_RECORD_STATE,
  PERIOD_IS_BEFORE_MONEY_WINDOW,
  PERMANENT_LINES,
  REFUNDED_TO_ZERO_EXPLAINED,
  MONEY_AS_AT_MEANING,
  SERVICE_VALUE_PRICE_BASIS,
  SETTLEMENTS_NOT_IN_THIS_WINDOW,
  SOME_VISITS_PRICED_AT_THE_TIME,
  VISIT_FIGURES_ARE_CURRENT,
  THREE_CLASSES_NEVER_ADD_UP,
  UNATTRIBUTED_IS_ALL_TIME,
  UNCLASSIFIED_VISITS_EXPLAINED,
  UNKNOWN_EXPLANATION,
  UNKNOWN_LABEL,
  WINDOW_PRECEDES_LEDGER,
} from "@/lib/finance/financial-copy";
import type { Fact, FinancialUnknownCause } from "@/lib/finance/financial-fact";
import type { ReportingPeriod } from "@/lib/booking/reporting-period";

// ===========================================================================
// FIN-01A — Direction B's spine
// ===========================================================================
//
// The frozen information architecture: the calendar narrows to the work that
// actually happened, and what became of that work hangs beneath it. Slice 1
// builds the spine and answers the calendar; the disposition chain and the two
// money bridges say, in a sentence, that they are not answered yet.
//
// ONE COLUMN, ALWAYS. Every relationship on this screen is expressed by
// ORDER — calendar, then anchor, then what became of the work — and order is
// the only spatial relationship that survives a phone. There is deliberately no
// grid, no two-column split and no CSS ordering anywhere in this file, so the
// provenance chain cannot be re-sequenced by a viewport.
//
// STATE IS NEVER COLOUR ALONE. Every unknown carries a distinct SHAPE, a token
// colour and a written label. Remove the colour and the meaning survives;
// remove the shape and it still survives, because the label is a sentence.

const PERIODS: ReadonlyArray<{ key: ReportingPeriod; label: string }> = [
  { key: "today", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

/**
 * The shapes. One per cause, so the four are distinguishable in greyscale, in
 * forced-colors, and to a reader who cannot separate amber from grey.
 */
const MARK: Record<FinancialUnknownCause, React.ReactNode> = {
  not_recorded: (
    <circle cx="7" cy="7" r="5" fill="none" strokeWidth="1.6" strokeDasharray="2 2" />
  ),
  unavailable: (
    <>
      <circle cx="7" cy="7" r="5" fill="none" strokeWidth="1.6" />
      <path d="M4.5 7h5" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  unknowable: (
    <>
      <circle cx="7" cy="7" r="5" fill="none" strokeWidth="1.6" />
      <path d="M3.8 10.2 10.2 3.8" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  not_yet_supported: (
    <rect x="2.2" y="2.2" width="9.6" height="9.6" rx="1.6" fill="none" strokeWidth="1.6" />
  ),
  not_enumerable: (
    <>
      <path d="M2.5 4.5h9" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M2.5 7.5h9" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M2.5 10.5h6" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  // A broken outline: the shape of a record that was started and left open,
  // which is exactly what this cause describes. Distinguishable from
  // `not_recorded`'s dashed circle in greyscale because it is a rectangle.
  records_incomplete: (
    <>
      <path d="M2.2 3.8v-1.6h4" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M11.8 3.8v-1.6h-4" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M2.2 10.2v1.6h9.6v-1.6" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </>
  ),
};

/**
 * Amber is SCARCE and reserved for the absences an owner can actually shrink.
 * A read that failed and a release that has not shipped are Hone's problem, not
 * the studio's, and painting them as warnings would make the whole page read as
 * an error state.
 */
const ACTIONABLE: ReadonlySet<FinancialUnknownCause> = new Set<FinancialUnknownCause>([
  "not_recorded",
  "not_enumerable",
]);

function Mark({ cause }: { cause: FinancialUnknownCause }) {
  return (
    <svg
      viewBox="0 0 14 14"
      width="14"
      height="14"
      aria-hidden="true"
      stroke="currentColor"
      className="mt-[3px] shrink-0"
    >
      {MARK[cause]}
    </svg>
  );
}

/**
 * The absence, carrying its own reason.
 *
 * Never a dash, never a zero, and never a shared "Not available": the label and
 * the sentence are chosen by cause, because "nobody has said what happened" and
 * "Hone could not look" are different claims about different things.
 *
 * The explanation is `text-fg`, not `text-fg-muted`. Muted measures 4.54:1 on
 * the sunken surface this block sits on — it clears AA by 0.04 — and this
 * sentence is the entire meaning of the figure it replaces, so it does not ride
 * on a borderline pairing.
 */
function Unknown({ cause }: { cause: FinancialUnknownCause }) {
  const actionable = ACTIONABLE.has(cause);
  return (
    <div
      className={`flex gap-2 rounded-md border p-3 ${
        actionable
          ? "border-warning-fg/25 bg-warning-surface text-warning-fg"
          : "border-line bg-surface-sunken text-fg"
      }`}
    >
      <Mark cause={cause} />
      <div className="min-w-0">
        <p className="text-sm font-medium">{UNKNOWN_LABEL[cause]}</p>
        <p className="mt-1 text-xs leading-relaxed">{UNKNOWN_EXPLANATION[cause]}</p>
      </div>
    </div>
  );
}

/** A count, or the one sentence saying why there isn't one. */
function Counted({ fact, one, many }: { fact: Fact<number>; one: string; many: string }) {
  if (!fact.known) return <Unknown cause={fact.cause} />;
  return (
    <p className="tabular-nums text-sm font-medium">
      {fact.value.toLocaleString()}
      <span className="ml-1 font-normal text-fg-muted">
        {fact.value === 1 ? one : many}
      </span>
    </p>
  );
}

function Visits({ fact }: { fact: Fact<number> }) {
  return <Counted fact={fact} one="visit" many="visits" />;
}

/**
 * PAYMENT ROWS, NOT VISITS.
 *
 * `chargeCount` counts succeeded payment rows in the movement window, and the
 * two are not the same population: cash movement legitimately includes no-show
 * and late-cancellation fee payments, which are money without a delivered
 * visit behind them. Rendering that count as "2 visits" asserted visits this
 * period may not have had.
 */
function Payments({ fact }: { fact: Fact<number> }) {
  return <Counted fact={fact} one="payment" many="payments" />;
}

/**
 * Cents, as the studio's own currency. NEVER a bare number and never rounded to
 * the dollar: a money figure that has lost its cents is a different number, and
 * an owner reconciling against a bank statement is the person most likely to
 * notice.
 */
function money(cents: number): string {
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "CAD",
    currencyDisplay: "narrowSymbol",
  });
}

/** A money figure, or the sentence saying why there isn't one. */
function Money({ fact }: { fact: Fact<number> }) {
  if (!fact.known) return <Unknown cause={fact.cause} />;
  return <p className="tabular-nums text-sm font-medium">{money(fact.value)}</p>;
}

/** Basis points, rendered as a percentage with one decimal. */
function percent(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(1)}%`;
}

/** An hours figure, or the sentence saying why there isn't one. */
function Hours({ fact }: { fact: Fact<number> }) {
  if (!fact.known) return <Unknown cause={fact.cause} />;
  return <p className="tabular-nums text-sm font-medium">{hours(fact.value)}</p>;
}

/** Minutes as hours, to two decimals — the unit the per-hour figure divides by. */
function hours(minutes: number): string {
  return `${(minutes / 60).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} h`;
}

/**
 * One labelled line whose figure is rendered by the caller.
 *
 * Generalised from `Row` so a money figure, a count and a ratio can share the
 * exact same label/figure geometry. Order in the DOM is unchanged: the label
 * always precedes its figure, so stacking on a phone cannot invert them.
 */
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <span className="text-sm">{label}</span>
      <div className="min-w-0 sm:text-right">{children}</div>
    </div>
  );
}

function Row({ label, fact }: { label: string; fact: Fact<number> }) {
  // Column on a phone, row on a wider screen: the label always precedes its
  // figure in the DOM, so stacking cannot invert them.
  return (
    <div className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <span className="text-sm">{label}</span>
      <div className="sm:text-right">
        <Visits fact={fact} />
      </div>
    </div>
  );
}

export function FinancialSpine({ briefing }: { briefing: FinancialBriefing }) {
  const { calendar } = briefing;
  return (
    <div className="flex w-full max-w-[920px] flex-col gap-8">
      <header className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Financials</h1>

        <nav className="flex flex-wrap gap-2" aria-label="Reporting period">
          {PERIODS.map((p) => {
            const active = p.key === briefing.period;
            return (
              <Link
                key={p.key}
                href={`/financials?period=${p.key}`}
                aria-current={active ? "page" : undefined}
                className={`hone-transition-press inline-flex min-h-[44px] items-center rounded-md border px-4 text-sm ${
                  active
                    ? "border-accent bg-accent text-on-accent"
                    : "border-line-strong text-fg hover:bg-surface-sunken active:scale-[0.97]"
                }`}
              >
                {p.label}
              </Link>
            );
          })}
        </nav>

        <p className="text-sm text-fg">
          {briefing.startLocal} to {briefing.endLocalInclusive}
          <span className="text-fg-muted"> · studio time, {briefing.timezone}</span>
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">The calendar</SectionLabel>
        <div className="flex flex-col">
          <Row label="Appointments in this period" fact={calendar.booked} />
          <Row label="Still to happen" fact={calendar.stillToHappen} />
          <Row label="Past, still confirmed" fact={calendar.pastConfirmed} />
          <Row label="Cancelled" fact={calendar.cancelled} />
          <Row label="No-show" fact={calendar.noShow} />
        </div>
        <PartitionNote briefing={briefing} />
        {calendar.pastConfirmed.known && calendar.pastConfirmed.value > 0 ? (
          <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
            {PAST_STILL_CONFIRMED_IS_A_RECORD_STATE}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2 border-y border-line-strong py-6">
        <SectionLabel as="h2">Work actually completed</SectionLabel>
        {calendar.completed.known ? (
          <p className="text-4xl font-semibold tracking-tight">
            {calendar.completed.value.toLocaleString()}
            <span className="ml-2 text-base font-normal text-fg-muted">
              {calendar.completed.value === 1 ? "visit" : "visits"}
            </span>
          </p>
        ) : (
          <Unknown cause={calendar.completed.cause} />
        )}
        {/*
          CONDITIONED, NOT DELETED. Below the money floor there genuinely is no
          service value on this screen and saying so is useful; above it, the
          section renders immediately underneath and the old sentence denied it.
        */}
        <p className="text-sm text-fg">
          {briefing.money.covered
            ? COMPLETED_IS_NOT_THE_MONEY_POPULATION
            : "What this work was worth is not on this screen yet."}
        </p>
      </section>

      <DeliveredMoney briefing={briefing} />

      <footer className="flex flex-col gap-2 border-t border-line pt-5">
        {PERMANENT_LINES.map((line) => (
          <p key={line} className="max-w-[68ch] text-xs leading-relaxed text-fg">
            {line}
          </p>
        ))}
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg">{CAPACITY_NOT_YET}</p>
        {/*
          THE EVIDENCE INSTANT, ON SCREEN. Two reports run minutes apart
          legitimately disagree — production moved 63 to 64 delivered visits
          inside twenty-six minutes while this surface was being specified — and
          without the instant an owner comparing them concludes Hone is broken.
          `dateTime` carries the machine-readable form; the visible text is the
          same instant, not a prettier approximation of it.

          SCOPED, NOT WEAKENED. This said "Figures as at" over the whole page.
          Money can carry that claim and now does; visit counts, clinic time and
          service value cannot, because their sources are mutated in place with
          no version history. Both sentences are printed together so the
          guarantee is stated exactly where it holds — see MONEY_AS_AT_MEANING.
        */}
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg-muted">
          Money figures are as at{" "}
          <time dateTime={briefing.evidenceInstant} className="tabular-nums">
            {briefing.evidenceInstant}
          </time>
          . {MONEY_AS_AT_MEANING}
        </p>
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg-muted">
          {VISIT_FIGURES_ARE_CURRENT}
        </p>
      </footer>
    </div>
  );
}

/**
 * The partition claim, printed only when it is TRUE — and stating the claim the
 * model actually makes.
 *
 * `partition.closed` now means TWO things, because the census now decides two
 * things: every appointment fell into one of the four known statuses, AND every
 * confirmed row supplied a readable start. Only then is
 * `stillToHappen + pastConfirmed + completed + cancelled + noShow === booked`.
 * That is a fact about STATUS COVERAGE. An earlier version of this note printed
 * it as a fact about LAYOUT — "every appointment in this period is on exactly
 * one line above" — and that was false twice over: the first row is the TOTAL,
 * so every appointment is on that line AND on its status line; and `completed`
 * has no line in this section at all, because Direction B gives the work that
 * actually happened its own. Codex raised it on PR #646 and was right. The
 * owner was shown an exactness the screen does not have.
 *
 * The two claims are easy to confuse and were: one is about which statuses
 * exist, the other about which rows are drawn. The sentence names the five
 * categories it is actually about, and says where `completed` is shown.
 *
 * That total row was labelled "Booked in this period" when this comment was
 * written and is labelled "Appointments in this period" now, which is why the
 * text above names it by POSITION rather than by its wording: a comment that
 * quotes a label goes stale the moment the label is corrected, and this one
 * did.
 *
 * A status this build does not recognise leaves the five counts perfectly
 * correct while making them no longer a complete account of the period —
 * so the claim is withdrawn and the reason named, rather than the row being
 * dropped to keep a total looking tidy.
 */
function PartitionNote({ briefing }: { briefing: FinancialBriefing }) {
  const { partition, booked } = briefing.calendar;
  if (!booked.known) return null;
  if (partition.closed) {
    return (
      <p className="text-xs text-fg">
        Still to happen, past but still confirmed, completed, cancelled and no-show
        account for every appointment in this period. Completed is counted in the
        next section.
      </p>
    );
  }
  // TWO REASONS, REPORTED SEPARATELY AND BOTH IF BOTH HOLD. Naming only the
  // status reason would have printed "0 appointment statuses ... are ones this
  // version of Hone does not recognise" whenever the breach was an unreadable
  // start time instead — a sentence that is false and reads as a bug.
  const statuses = partition.unrecognisedStatuses.length;
  const undatable = partition.undatableConfirmed;
  const reasons: string[] = [];
  if (statuses > 0) {
    reasons.push(
      `${statuses} appointment status${statuses === 1 ? "" : "es"} in this period ${
        statuses === 1 ? "is one" : "are ones"
      } this version of Hone does not recognise`,
    );
  }
  if (undatable > 0) {
    reasons.push(
      `${undatable} confirmed appointment${undatable === 1 ? "" : "s"} did not supply a start time Hone could read, so ${
        undatable === 1 ? "it is" : "they are"
      } counted as neither still to happen nor past`,
    );
  }
  return (
    <p className="text-xs text-warning-fg">
      {reasons.join("; and ")}, so still to happen, past but still confirmed,
      completed, cancelled and no-show do not account for every appointment in this
      period.
    </p>
  );
}

/**
 * SLICE 2 — delivered work and the money against it.
 *
 * THE THREE EVIDENCE CLASSES GET THREE SECTIONS, and the order is deliberate:
 * verified card money, then attested external money, then service value. No
 * section sums another, there is no total line anywhere beneath them, and the
 * sentence naming why sits directly under the heading rather than in the
 * footer — a reader who stops after the first figure has still read it.
 *
 * WHAT IS DELIBERATELY ABSENT: schedule utilisation, clinic-hour yield, any
 * sustainable-client or spare-capacity count, and every forecast. Those need
 * blocked-out time, interval merging and an elapsed denominator, none of which
 * this release reads. The footer says so in a sentence rather than leaving the
 * owner to assume the screen has answered a question it has not.
 */
function DeliveredMoney({ briefing }: { briefing: FinancialBriefing }) {
  const { money: window } = briefing;

  // The whole requested period sits below the record-keeping floor. The
  // calendar above is still true and still shown; only money is withdrawn.
  if (!window.covered) {
    return (
      <>
        <section className="flex flex-col gap-3">
          <SectionLabel as="h2">Money in this period</SectionLabel>
          <Unknown cause="records_incomplete" />
          <p className="max-w-[68ch] text-sm text-fg">{PERIOD_IS_BEFORE_MONEY_WINDOW}</p>
        </section>
        <UnattributedAllTime briefing={briefing} />
      </>
    );
  }

  const c = window.census;
  return (
    <>
      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">Delivered in this window</SectionLabel>
        <div className="flex flex-col">
          <Line label="Treatment visits delivered">
            <Visits fact={c.deliveredTreatmentVisits} />
          </Line>
          <Line label="Consultations delivered">
            <Visits fact={c.consultationVisits} />
          </Line>
          {c.unclassifiedVisits.known && c.unclassifiedVisits.value > 0 ? (
            <Line label="Delivered, service no longer on record">
              <Visits fact={c.unclassifiedVisits} />
            </Line>
          ) : null}
        </div>
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg">{DELIVERED_MEANS}</p>
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
          {CONSULTATION_IS_A_SERVICE_KIND}
        </p>
        {c.unclassifiedVisits.known && c.unclassifiedVisits.value > 0 ? (
          <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
            {UNCLASSIFIED_VISITS_EXPLAINED}
          </p>
        ) : null}
        {window.narrowed ? (
          <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
            {MONEY_WINDOW_IS_NARROWER}
          </p>
        ) : null}
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
          {THREE_CLASSES_NEVER_ADD_UP}
        </p>
      </section>

      {/*
        CONTRACT 1 — CASH MOVEMENT, transaction period. Charges windowed on
        charged_at, refunds on refunded_at, INDEPENDENTLY. That independence is
        correct for movement and wrong for earnings, so the heading says
        "moved" and the caveat says why.
      */}
      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">Card money that moved this period</SectionLabel>
        <div className="flex flex-col">
          <Line label="Payments taken, before fees">
            <Money fact={c.movedInGrossCents} />
          </Line>
          <Line label="Refunds sent back">
            <Money fact={c.movedOutRefundedCents} />
          </Line>
          <Line label="Net movement">
            <Money fact={c.netMovementCents} />
          </Line>
          <Line label="Payments">
            <Payments fact={c.chargeCount} />
          </Line>
        </div>
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
          {CASH_MOVEMENT_IS_NOT_EARNINGS}
        </p>
        {/*
          The generic caveat above is true always; this line is the MEASURED
          instance of it, so the owner learns whether it actually bit this
          period rather than being told it might have.
        */}
        {c.refundsReversingOtherPeriods.known && c.refundsReversingOtherPeriods.value > 0 ? (
          <p className="max-w-[68ch] text-xs leading-relaxed text-warning-fg">
            {c.refundsReversingOtherPeriods.value.toLocaleString()} of these refund
            {c.refundsReversingOtherPeriods.value === 1 ? "" : "s"} reverse
            {c.refundsReversingOtherPeriods.value === 1 ? "s" : ""} a payment taken in
            another period, so net movement is lower here than this period&apos;s
            work would suggest.
          </p>
        ) : null}
        {/*
          A refund reversing a payment that carries NO date of its own. Not
          "another period" — that would state a chronology nothing establishes —
          so it is disclosed as the unplaceable reversal it is.
        */}
        {c.refundsReversingUnknownPeriod.known && c.refundsReversingUnknownPeriod.value > 0 ? (
          <p className="max-w-[68ch] text-xs leading-relaxed text-warning-fg">
            {c.refundsReversingUnknownPeriod.value.toLocaleString()} of these refund
            {c.refundsReversingUnknownPeriod.value === 1 ? "" : "s"} reverse
            {c.refundsReversingUnknownPeriod.value === 1 ? "s" : ""} a payment whose own
            date was never recorded, so which period it came from is unknown.
          </p>
        ) : null}
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg">{COLLECTED_IS_GROSS}</p>
        {window.precedesLedger ? (
          <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
            {WINDOW_PRECEDES_LEDGER}
          </p>
        ) : null}
      </section>

      {/*
        CONTRACT 2 — SERVICE PERIOD. One population on both sides. An earlier
        draft divided cash-movement net by delivered-visit hours; a charge in
        the window can pay for a visit outside it and vice versa, so that
        quotient had no population to be a rate OF. Replaced, not relabelled.
      */}
      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">Collected on treatment delivered in this window</SectionLabel>
        <div className="flex flex-col">
          <Line label="Collected by card, after refunds on those visits">
            <Money fact={c.collectedOnDeliveredCents} />
          </Line>
          <Line label="Treatment visits paid by card in this window">
            <Visits fact={c.collectedOnDeliveredVisits} />
          </Line>
          <Line label="Treatment hours with the client">
            <Hours fact={c.collectedOnDeliveredMinutes} />
          </Line>
          <Line label="Collected per treatment hour with the client">
            {c.perTreatmentHourCents.known ? (
              <p className="tabular-nums text-sm font-medium">
                {money(c.perTreatmentHourCents.value)}
              </p>
            ) : (
              <Unknown cause={c.perTreatmentHourCents.cause} />
            )}
          </Line>
        </div>
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
          {COLLECTED_ON_DELIVERED_IS_ONE_POPULATION}
        </p>
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg">{PER_HOUR_POPULATION}</p>
      </section>

      {/* CLASS 2 — studio-attested. Exists only if somebody wrote it down. */}
      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">Collected outside Hone</SectionLabel>
        <div className="flex flex-col">
          <Line label="Cash, e-transfer or other, as recorded">
            <Money fact={c.externallyAttestedCents} />
          </Line>
          <Line label="Waived">
            <Money fact={c.waivedCents} />
          </Line>
          <Line label="Recorded as still owed">
            <Money fact={c.stillOwedCents} />
          </Line>
        </div>
        {/*
          Migration 0187 permits "still owes" followed by a card payment on
          purpose — it is the ordinary progression of a debt — and says the
          authoritative disposition ranks Hone-verified money above the
          attestation. The money leaving the owed total is explained here rather
          than silently disappearing from it.
        */}
        {c.stillOwedSupersededByCard.known && c.stillOwedSupersededByCard.value > 0 ? (
          <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
            {c.stillOwedSupersededByCard.value.toLocaleString()} visit
            {c.stillOwedSupersededByCard.value === 1 ? " was" : "s were"} recorded as
            still owed and later paid by card. The card payment is what happened, so
            {c.stillOwedSupersededByCard.value === 1 ? " it is" : " they are"} not counted
            as owed here.
          </p>
        ) : null}
        {/*
          Shown beside the money it affects, not only in the basis note at the
          foot of the screen: a studio that settles a visit outside this window
          should see why that money is not in these three lines.
        */}
        {briefing.money.census.basis.settlementsOutsideWindow > 0 ? (
          <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
            {SETTLEMENTS_NOT_IN_THIS_WINDOW}
          </p>
        ) : null}
      </section>

      {/* CLASS 3 — service value. A price, and never money. */}
      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">Service value of delivered work</SectionLabel>
        <div className="flex flex-col">
          {/*
            NAMED BY POPULATION, NOT BY BASIS. These two labels used to say
            "at today's prices", which the paragraph directly below them
            contradicts: a visit settled from 0187 onward is valued at the
            price it carried then, and repricing the menu does not move it.
            Whether a given visit is valued that way or from today's price is
            exactly what varies inside the total, so no single label can state
            it truthfully — only the paragraph can, and it does.
          */}
          <Line label="Treatment service value">
            <Money fact={c.treatmentServiceValueCents} />
          </Line>
          <Line label="Consultation service value">
            <Money fact={c.consultationServiceValueCents} />
          </Line>
        </div>
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
          {SERVICE_VALUE_PRICE_BASIS}
        </p>
        {/*
          Shown only when the bases are actually mixed. The figures above then
          sum two kinds of evidence, and nothing in the total says so.
        */}
        {c.visitsValuedAtRecordedPrice.known && c.visitsValuedAtRecordedPrice.value > 0 ? (
          <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
            {SOME_VISITS_PRICED_AT_THE_TIME}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">Visits with a payment recorded</SectionLabel>
        <div className="flex flex-col">
          <Line label="Treatment visits with something to collect">
            <Visits fact={c.chargeableTreatmentVisits} />
          </Line>
          <Line label="Of those, paid by card through Hone">
            <Visits fact={c.cardPaidVisits} />
          </Line>
          <Line label="Of those visits">
            {c.collectionRateBasisPoints.known ? (
              <p className="tabular-nums text-sm font-medium">
                {percent(c.collectionRateBasisPoints.value)}
              </p>
            ) : (
              <Unknown cause={c.collectionRateBasisPoints.cause} />
            )}
          </Line>
          {c.refundedToZeroVisits.known && c.refundedToZeroVisits.value > 0 ? (
            <Line label="Paid by card, then refunded in full">
              <Visits fact={c.refundedToZeroVisits} />
            </Line>
          ) : null}
          {/*
            Shown only when it happens, like the reversal line above. These
            visits were paid — just not in this window — so they are neither
            collected here nor "No payment recorded", and leaving them out of
            both without a line would make the counts stop adding up.
          */}
          {c.paidInAnotherPeriodVisits.known && c.paidInAnotherPeriodVisits.value > 0 ? (
            <Line label="Paid by card in another period">
              <Visits fact={c.paidInAnotherPeriodVisits} />
            </Line>
          ) : null}
          {/*
            A succeeded payment can carry no date at all. That is a THIRD state:
            the payment exists, and which period it belongs to is unknown. It is
            not "another period" — that would assert a chronology nothing
            establishes, and would contradict the undated-payment count this
            screen already reports.
          */}
          {c.paidWithUnknownDateVisits.known && c.paidWithUnknownDateVisits.value > 0 ? (
            <Line label="Paid by card, date not recorded">
              <Visits fact={c.paidWithUnknownDateVisits} />
            </Line>
          ) : null}
          <Line label="No payment recorded">
            <Visits fact={c.unresolvedVisits} />
          </Line>
          <Line label="Service value of those visits">
            <Money fact={c.unresolvedServiceValueCents} />
          </Line>
        </div>
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
          {COLLECTION_RATE_IS_VISITS}
        </p>
        {/*
          The two paid-visit counts on this screen differ by exactly this, and
          only when it happens. Measured rather than described: a standing
          caveat about a case that almost never arises is noise, while an
          unexplained mismatch between two adjacent numbers is a bug report.
        */}
        {c.cardPaidWithoutAPrice.known && c.cardPaidWithoutAPrice.value > 0 ? (
          <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
            {PAID_BUT_NOTHING_TO_COLLECT}
          </p>
        ) : null}
        {/*
          A refunded visit used to be counted as collected here, which put a
          100% rate beside $0.00 collected. It now has its own line, and this
          says why it is in neither the rate nor "No payment recorded".
        */}
        {c.refundedToZeroVisits.known && c.refundedToZeroVisits.value > 0 ? (
          <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
            {REFUNDED_TO_ZERO_EXPLAINED}
          </p>
        ) : null}
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
          {NO_PAYMENT_RECORDED_IS_NOT_OWED}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">Where the clinic time went</SectionLabel>
        <div className="flex flex-col">
          <Line label="Treatment, with the client">
            <Hours fact={c.treatmentBookedMinutes} />
          </Line>
          <Line label="Treatment, including buffer">
            <Hours fact={c.treatmentBlockedMinutes} />
          </Line>
          <Line label="Consultations, including buffer">
            <Hours fact={c.consultationBlockedMinutes} />
          </Line>
          <Line label="Share of clinic time that was consultation">
            {c.consultationTimeShareBasisPoints.known ? (
              <p className="tabular-nums text-sm font-medium">
                {percent(c.consultationTimeShareBasisPoints.value)}
              </p>
            ) : (
              <Unknown cause={c.consultationTimeShareBasisPoints.cause} />
            )}
          </Line>
        </div>
        <p className="max-w-[68ch] text-xs leading-relaxed text-fg">
          {CONSULTATIONS_ARE_UNPAID_TIME}
        </p>
      </section>

      <UnattributedAllTime briefing={briefing} />
      <BasisNote briefing={briefing} />
    </>
  );
}

/**
 * FIN-C9, KEPT — AND MOVED OUT OF THE PERIOD.
 *
 * A succeeded card payment with no `charged_at` belongs to no period and can be
 * windowed by nothing: `created_at` records when the attempt ROW was written,
 * not when money moved, so windowing by it would file real money into a period
 * on a guess. The first draft printed this count beside the windowed figures,
 * where it read as a claim about the chosen period. It is still surfaced —
 * dropping it denies money that was actually made — but it now sits in its own
 * section and says "all time" in its own sentence.
 */
function UnattributedAllTime({ briefing }: { briefing: FinancialBriefing }) {
  const fact = briefing.unattributedChargesAllTime;
  // A KNOWN ZERO IS A NON-EVENT and says nothing worth a section: Hone looked,
  // and every payment it has is placeable in time.
  //
  // AN UNKNOWN IS NOT THAT, and must not look like it. Returning null for both
  // made "Hone could not look" indistinguishable from "there are none" — the
  // exact collapse this surface refuses everywhere else, and the reason
  // financial-copy.ts rejects a shared "Not available". So the section renders,
  // carrying its cause.
  if (fact.known && fact.value === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel as="h2">Card payments Hone cannot place in time (all time)</SectionLabel>
      {fact.known ? (
        <p className="tabular-nums text-sm font-medium">
          {fact.value.toLocaleString()}
          <span className="ml-1 font-normal text-fg-muted">
            {fact.value === 1 ? "payment" : "payments"}
          </span>
        </p>
      ) : (
        <Unknown cause={fact.cause} />
      )}
      <p className="max-w-[68ch] text-xs leading-relaxed text-fg">{UNATTRIBUTED_IS_ALL_TIME}</p>
    </section>
  );
}

/**
 * What the money census could NOT account for.
 *
 * Same discipline as PartitionNote: the figures above stay true and the
 * COMPLETENESS claim is withdrawn, naming each reason separately. A row that
 * could not be dated, priced or measured is not dropped to keep a total tidy —
 * it is counted here, where the owner can see the figures are narrower than the
 * window they were asked for.
 */
function BasisNote({ briefing }: { briefing: FinancialBriefing }) {
  if (!briefing.money.covered) return null;
  const b = briefing.money.census.basis;
  if (b.complete) return null;
  const reasons: string[] = [];
  if (b.undatable > 0) {
    reasons.push(
      `${b.undatable} appointment${b.undatable === 1 ? "" : "s"} did not supply an end time Hone could read, so whether ${b.undatable === 1 ? "it has" : "they have"} finished is unknown`,
    );
  }
  if (b.unclassifiable > 0) {
    reasons.push(
      `${b.unclassifiable} delivered appointment${b.unclassifiable === 1 ? "" : "s"} no longer carries a service Hone can read, so whether ${b.unclassifiable === 1 ? "it was" : "they were"} treatment or consultation is unknown`,
    );
  }
  if (b.unvalued > 0) {
    reasons.push(
      `${b.unvalued} delivered treatment visit${b.unvalued === 1 ? "" : "s"} had no price on record, so ${b.unvalued === 1 ? "it is" : "they are"} counted as delivered work with no service value`,
    );
  }
  if (b.ambiguouslyPriced > 0) {
    // A SUBSET of `unvalued`, given its own sentence because the remedy is
    // different and it is the only one the owner can act on directly: two of
    // their own price rows disagree, and Hone will not pick between them.
    reasons.push(
      `${b.ambiguouslyPriced} of those had two custom prices that start on the same day and disagree, so Hone will not choose one`,
    );
  }
  if (b.unmeasurable > 0) {
    reasons.push(
      `${b.unmeasurable} delivered appointment${b.unmeasurable === 1 ? "" : "s"} did not supply readable times for the chair, so ${b.unmeasurable === 1 ? "its" : "their"} clinic time is not in the hours above`,
    );
  }
  if (b.unreadableAmounts > 0) {
    reasons.push(
      `${b.unreadableAmounts} amount${b.unreadableAmounts === 1 ? "" : "s"} did not arrive as a number Hone could read, so ${b.unreadableAmounts === 1 ? "it is" : "they are"} left out of the totals rather than counted as nothing`,
    );
  }
  // `settlementsOutsideWindow` is NOT a reason. Settlements are read
  // studio-wide, so after a studio's first settlement every later window sees
  // the earlier ones, and listing them here warned that the current window was
  // incomplete whenever the studio had any history at all. Those rows keep
  // their own neutral disclosure beside the money they are not in
  // (SETTLEMENTS_NOT_IN_THIS_WINDOW), which is information rather than a
  // warning. What remains a reason is a row that names NOTHING.
  if (b.settlementsUnattributable > 0) {
    reasons.push(
      `${b.settlementsUnattributable} payment${b.settlementsUnattributable === 1 ? "" : "s"} recorded outside Hone name${b.settlementsUnattributable === 1 ? "s" : ""} no visit at all, so ${b.settlementsUnattributable === 1 ? "it cannot" : "they cannot"} be attributed to this window or any other`,
    );
  }
  return (
    <p className="max-w-[68ch] text-xs leading-relaxed text-warning-fg">
      {reasons.join("; and ")}. The figures above are true for what Hone could
      read, and are not a complete account of this window.
    </p>
  );
}
