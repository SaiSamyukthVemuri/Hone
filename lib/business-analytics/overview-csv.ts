import { csvCell } from "@/lib/csv";
import { CSV_BOM, decimalAmount } from "@/lib/finance/statement-csv";

import { ANALYTICS_ACCESS_NOTE, COLLECTED_LABEL, BEYOND_USUAL_FILTER_NOTE, NOT_ENOUGH_HISTORY_NOTE, beyondUsualNote, EVIDENCE_LABELS, EVIDENCE_NOT_READABLE_NOTE, FIRST_TIME_NOTE, INTERVAL_NOTE, MISSING_PRICE_EVIDENCE_LABEL, NEVER_SUMMED_NOTE, SERVICE_VALUE_LABEL, noNextBookingNote } from "./copy";
import { unavailableText, type Figure } from "./figure";
import { MONEY_BASIS_NOTE, type Change } from "./money-metrics";
import type { OverviewView } from "./overview-model";
import { DEFAULT_BEYOND_USUAL_FACTOR } from "./visit-metrics";

// ===========================================================================
// The Overview as a spreadsheet file. PURE: no I/O, no clock, no request.
// ===========================================================================
//
// AGGREGATES ONLY. The file is built from the OverviewView, which holds no appointment, client or practitioner id and no per-visit price, so none can
// leave. Team members appear by display name beside their total (or "Former team member"); the file name is the period only, never a person. "No next
// booking" is a COUNT; the clients themselves are never listed here.
//
// UNAVAILABLE. A figure that could not be shown is a row that says why, in the same fixed words as the screen. A cell is never empty and never 0 for it.
//
// MONEY. Decimal amounts ("60.00") with a separate currency column; written as text so the places survive. SAFETY: every cell goes through csvCell
// (a text cell beginning with = + - @ TAB or CR is neutralised; RFC 4180 quoting), and a UTF-8 byte order mark leads the file.

/** A plain number (a decimal amount or a count, possibly negative) is a real number in the spreadsheet, not text. Nothing else is exempt from the formula guard. */
const PLAIN_NUMBER = /^-?\d+(\.\d{2})?$/;
const cell = (v: string): string => (PLAIN_NUMBER.test(v) ? v : csvCell(v));

/** The by-team-member rows are the whole studio whatever team member is chosen, so the section says so, as the screen does. */
const WHOLE_STUDIO = "Whole studio (not filtered)";

export const OVERVIEW_CSV_COLUMNS = ["section", "figure", "value", "currency", "note"] as const;

type Row = readonly string[];

/** The file name: the period's dates only. Never a name, an id or anything typed by a person. */
export function overviewCsvFileName(range: { startLocal: string; lastLocal: string }): string {
  return `analytics-${range.startLocal}-to-${range.lastLocal}.csv`;
}

export const FILTER_TEXT: Record<OverviewView["filterKind"], string> = {
  all: "All team members",
  one: "One team member (filtered)",
  unattributed: "Bookings with no team member (filtered)",
};

/** In words, never a leading sign: a note that began with + or - would be neutralised as a formula and written as text. */
function changeText(c: Change, comparisonLabel: string): string {
  if (c.kind === "percent") {
    const p = Math.abs(c.percent).toFixed(1);
    return c.percent === 0 || p === "0.0" ? `No change compared with ${comparisonLabel}` : `${c.percent > 0 ? "Up" : "Down"} ${p}% compared with ${comparisonLabel}`;
  }
  if (c.kind === "none_recorded") return `Nothing was recorded in ${comparisonLabel}, so there is no percentage to show.`;
  return "The comparison is not available.";
}

export function overviewCsv(view: OverviewView, opts: { preparedOn: string }): string {
  const money = (cents: number) => decimalAmount(cents);
  const cur = view.currency ? view.currency.toUpperCase() : "";
  const rows: Row[] = [];
  const add = (section: string, figure: string, value: string, note = "", currency = "") => rows.push([section, figure, value, currency, note]);
  /** One figure: its rows when available, one row saying why when not. `title` names the row that carries the reason. */
  const fig = <T,>(section: string, title: string, f: Figure<T>, emit: (v: T) => void) => {
    if (f.available) emit(f.value);
    else add(section, title, unavailableText(f.reason));
  };

  rows.push(["Analytics overview"]);
  rows.push(["Period", view.currentLabel]);
  rows.push(["Compared with", view.comparisonLabel]);
  rows.push(["Team members", FILTER_TEXT[view.filterKind]]);
  rows.push(["Prepared on", opts.preparedOn]);
  rows.push(["Currency", cur || "Not set"]);
  rows.push(["Basis", MONEY_BASIS_NOTE]);
  rows.push(["Who sees this", ANALYTICS_ACCESS_NOTE]);
  for (const n of view.notes) rows.push(["Note", n]);
  rows.push([]);
  rows.push([...OVERVIEW_CSV_COLUMNS]);

  fig("Collected", COLLECTED_LABEL, view.collected, (c) => {
    add("Collected", COLLECTED_LABEL, money(c.headlineCents), changeText(c.change, view.comparisonLabel), cur);
    add("Collected", "On completed visits", money(c.split.completedVisitsCents), "", cur);
    add("Collected", "Cancellation, no-show and booking fees", money(c.split.feesCents), "", cur);
    add("Collected", "Payments on past bookings never completed", money(c.split.uncompletedPaymentsCents), "", cur);
    add("Collected", "On other bookings, not on a client statement", money(c.split.otherBookingsCents), "", cur);
    if (c.caveats.refundedInFullCents > 0) add("Collected", "Refunded in full, not in collected", money(c.caveats.refundedInFullCents), "", cur);
    if (c.caveats.refundedPartialCents > 0) add("Collected", "Refunded from payments still counted in full above", money(c.caveats.refundedPartialCents), "", cur);
    if (c.caveats.unresolvedCount > 0) add("Collected", "Payment records not settled either way, not counted", String(c.caveats.unresolvedCount));
    if (c.caveats.otherCurrencyCount > 0) add("Collected", "Payment records in another currency, not counted", String(c.caveats.otherCurrencyCount));
  });

  fig("By date", "Collected and completed visits by date", view.series, (s) => {
    for (const p of s.points) {
      add("By date", `${p.key} collected`, money(p.collectedCents), s.unit === "day" ? "day" : "month", cur);
      add("By date", `${p.key} completed visits`, String(p.completedVisits), s.unit === "day" ? "day" : "month");
    }
  });

  fig("Comparison by date", "Collected and completed visits by date, comparison period", view.previousSeries, (s) => {
    for (const p of s.points) {
      add("Comparison by date", `${p.key} collected`, money(p.collectedCents), s.unit === "day" ? "day" : "month", cur);
      add("Comparison by date", `${p.key} completed visits`, String(p.completedVisits), s.unit === "day" ? "day" : "month");
    }
  });

  fig("Visits", "Completed visits", view.completedVisits, (v) => add("Visits", "Completed visits", String(v.count), changeText(v.change, view.comparisonLabel)));
  fig("Visits", "Clients seen", view.activeClients, (v) =>
    add("Visits", "Clients seen", String(v.count), `${changeText(v.change, view.comparisonLabel)}${v.withoutClient > 0 ? ` ${v.withoutClient} visits have no client recorded and are not counted.` : ""}`),
  );
  fig("Visits", "Visits per client seen", view.visitsPerClient, (v) => (v.known ? add("Visits", "Visits per client seen", v.value.toFixed(1)) : add("Visits", "Visits per client seen", `Not available: ${v.reason}`)));
  fig("Visits", "Average paid per visit", view.averagePaid, (a) =>
    a.averageCents.known
      ? add("Visits", "Average paid per visit", money(a.averageCents.value), `${changeText(view.averagePaidChange, view.comparisonLabel)}. ${a.excludedUnknownVisits} visits awaiting payment confirmation are left out.`, cur)
      : add("Visits", "Average paid per visit", `Not available: ${a.averageCents.reason}`, `${a.excludedUnknownVisits} visits awaiting payment confirmation are left out.`),
  );

  fig("Visits", "How often clients visit", view.visitFrequency, (f) => {
    add("Visits", "Clients with 1 visit", String(f.one), "Completed visits per active client in this period.");
    add("Visits", "Clients with 2 visits", String(f.two), "Completed visits per active client in this period.");
    add("Visits", "Clients with 3 or more visits", String(f.threePlus), "Completed visits per active client in this period.");
  });

  fig(WHOLE_STUDIO, "Collected by team member (whole studio, not filtered)", view.byPractitioner, (list) => {
    for (const r of list) add(WHOLE_STUDIO, r.label, money(r.collectedCents), "", cur);
  });

  fig("Service value", SERVICE_VALUE_LABEL, view.serviceValue, (sv) => {
    add("Service value", SERVICE_VALUE_LABEL, money(sv.withEvidenceCents), `${sv.withEvidenceVisits} completed visits with price evidence. ${NEVER_SUMMED_NOTE}`, cur);
    for (const k of Object.keys(EVIDENCE_LABELS) as Array<keyof typeof EVIDENCE_LABELS>) {
      const c = sv.classes[k];
      if (c.read) add("Service value", EVIDENCE_LABELS[k], money(c.cents), `${c.visits} visits`, cur);
      else add("Service value", EVIDENCE_LABELS[k], "Not available", EVIDENCE_NOT_READABLE_NOTE);
    }
    add("Service value", MISSING_PRICE_EVIDENCE_LABEL, String(sv.missingVisits), `of ${sv.completedVisits} completed visits`);
  });
  fig("Service value", "From service value to collected", view.reconciliation, (l) => {
    add("Service value to collected", "Completed service value", money(l.serviceValueCents), "", cur);
    add("Service value to collected", "Add: collected above the price", money(l.collectedAbovePriceCents), "", cur);
    add("Service value to collected", "Subtract: collected below the price (unpaid, part paid, adjusted or waived)", money(l.collectedBelowPriceCents), "", cur);
    add("Service value to collected", "Add: collected on visits with no price evidence", money(l.collectedOnNoEvidenceCents), "", cur);
    add("Service value to collected", "Add: fees", money(l.feesCents), "", cur);
    add("Service value to collected", "Add: payments on past bookings never completed", money(l.uncompletedPaymentsCents), "", cur);
    add("Service value to collected", "Add: money on other bookings", money(l.otherBookingsCents), "", cur);
    add("Service value to collected", "Equals: collected", money(l.collectedCents), "", cur);
  });

  fig("Clients", "Returning and first-time clients", view.returning, (r) =>
    add("Clients", "Returning clients", r.returningPercent.known ? `${Math.round(r.returningPercent.value)}%` : `Not available: ${r.returningPercent.reason}`, `${r.returning} returning, ${r.firstTime} first-time, of ${r.activeClients} clients seen. ${FIRST_TIME_NOTE}`),
  );
  fig("Clients", "Average days between visits", view.interval, (i) =>
    add("Clients", "Average days between visits", i.pooledAverageDays.known ? String(Math.round(i.pooledAverageDays.value)) : `Not available: ${i.pooledAverageDays.reason}`, `${i.clientsWithInterval} clients with two or more visits; ${i.clientsWithoutInterval} left out. ${INTERVAL_NOTE}`),
  );
  fig("Clients", "Beyond their usual visit interval", view.beyondUsual, (b) =>
    add("Clients", "Beyond their usual visit interval", String(b.count), `${beyondUsualNote(DEFAULT_BEYOND_USUAL_FACTOR)}${view.filterKind !== "all" ? ` ${BEYOND_USUAL_FILTER_NOTE}` : ""}${b.notEnoughHistory > 0 ? ` ${NOT_ENOUGH_HISTORY_NOTE(b.notEnoughHistory)}` : ""}`),
  );
  fig("Clients", "Clients with no next booking", view.noNextBooking, (n) => add("Clients", "Clients with no next booking", String(n.count), noNextBookingNote()));

  return `${CSV_BOM}${rows.map((r) => r.map(cell).join(",")).join("\n")}\n`;
}
