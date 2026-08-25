import Link from "next/link";

import { SectionLabel } from "@/components/ui/section-label";
import type { FinancialBriefing } from "@/lib/finance/financial-briefing";
import {
  DISPOSITION_CHAIN_NOT_YET,
  MONEY_BRIDGES_NOT_YET,
  PERMANENT_LINES,
  UNKNOWN_EXPLANATION,
  UNKNOWN_LABEL,
} from "@/lib/finance/financial-copy";
import type { Fact, FinancialUnknownCause } from "@/lib/finance/financial-fact";
import type { DashboardPeriod } from "@/lib/dashboard/practice-metrics";

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

const PERIODS: ReadonlyArray<{ key: DashboardPeriod; label: string }> = [
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
function Visits({ fact }: { fact: Fact<number> }) {
  if (!fact.known) return <Unknown cause={fact.cause} />;
  return (
    <p className="tabular-nums text-sm font-medium">
      {fact.value.toLocaleString()}
      <span className="ml-1 font-normal text-fg-muted">
        {fact.value === 1 ? "visit" : "visits"}
      </span>
    </p>
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
          <Row label="Booked in this period" fact={calendar.booked} />
          <Row label="Still to happen" fact={calendar.stillToHappen} />
          <Row label="Cancelled" fact={calendar.cancelled} />
          <Row label="No-show" fact={calendar.noShow} />
        </div>
        <PartitionNote briefing={briefing} />
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
        <p className="text-sm text-fg">
          What this work was worth is not on this screen yet.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">Where the completed work went</SectionLabel>
        <Unknown cause="not_yet_supported" />
        <p className="text-sm text-fg">{DISPOSITION_CHAIN_NOT_YET}</p>
      </section>

      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">Money in this period</SectionLabel>
        <Unknown cause="not_yet_supported" />
        <p className="text-sm text-fg">{MONEY_BRIDGES_NOT_YET}</p>
      </section>

      <footer className="flex flex-col gap-2 border-t border-line pt-5">
        {PERMANENT_LINES.map((line) => (
          <p key={line} className="max-w-[68ch] text-xs leading-relaxed text-fg">
            {line}
          </p>
        ))}
      </footer>
    </div>
  );
}

/**
 * The partition claim, printed only when it is TRUE.
 *
 * A status this build does not recognise leaves the four counts above perfectly
 * correct while making them no longer a complete account of what was booked —
 * so the claim is withdrawn and the reason named, rather than the row being
 * dropped to keep a total looking tidy.
 */
function PartitionNote({ briefing }: { briefing: FinancialBriefing }) {
  const { partition, booked } = briefing.calendar;
  if (!booked.known) return null;
  if (partition.closed) {
    return (
      <p className="text-xs text-fg">
        Every appointment in this period is on exactly one line above.
      </p>
    );
  }
  return (
    <p className="text-xs text-warning-fg">
      {partition.unrecognisedStatuses.length} appointment status
      {partition.unrecognisedStatuses.length === 1 ? "" : "es"} on this period are ones
      this version of Hone does not recognise, so the lines above do not account for
      every booking.
    </p>
  );
}
