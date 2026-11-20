import type { ReactNode } from "react";

import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import { ANALYTICS_ACCESS_NOTE, COLLECTED_DEFINITION, COLLECTED_LABEL, EVIDENCE_LABELS, EVIDENCE_NOT_READABLE_NOTE, FIRST_TIME_NOTE, INTERVAL_NOTE, MISSING_PRICE_EVIDENCE_LABEL, NEVER_SUMMED_NOTE, SERVICE_VALUE_DEFINITION, SERVICE_VALUE_LABEL, noNextBookingNote } from "@/lib/business-analytics/copy";
import { FIGURE_UNAVAILABLE_COPY, type Figure } from "@/lib/business-analytics/figure";
import { MONEY_BASIS_NOTE, type Change } from "@/lib/business-analytics/money-metrics";
import type { OverviewView } from "@/lib/business-analytics/overview-model";
import { overviewQuery, type OverviewParams } from "@/lib/business-analytics/overview-params";
import { FORMER_TEAM_MEMBER_LABEL, UNATTRIBUTED_LABEL } from "@/lib/business-analytics/copy";
import { PERIOD_KINDS } from "@/lib/business-analytics/period";
import type { Fact } from "@/lib/dashboard/owner-capacity-model";

import { BarChart } from "./charts";

// ===========================================================================
// The Overview screen. PRESENTATION ONLY: it renders the one OverviewView it is given and computes nothing about money or people.
// ===========================================================================
// Every figure goes through <Card>: an unavailable figure shows its fixed reason sentence in the same place, never a blank card, a 0 or a dropped
// section. The view holds aggregates only, so nothing here can show a client or an appointment id, and no text names a practitioner id. A SELECTED
// team member's id sits in the filter form's option value AND in the screen's own link hrefs (the chart toggle here; Download, Print and Back on
// the other pages): owner-only, the same URL as the request. It must stay OUT of print, CSV and any chart, table or link text.

export const OVERVIEW_PATH = "/financials/analytics";
const PERIOD_LABELS: Record<string, string> = { month_to_date: "Month to date", previous_month: "Previous month", year_to_date: "Year to date", custom: "Custom range" };

export type OverviewScreenProps = {
  view: OverviewView;
  params: OverviewParams;
  notices: readonly string[];
  practitionerOptions: ReadonlyArray<{ id: string; label: string }>;
  format: (cents: number) => string;
  /** The printable form: no controls or toggles, definitions open, the owner-only note as a footer. The figures are the same cards. */
  print?: boolean;
};

function changeText(c: Change, comparisonLabel: string): string {
  if (c.kind === "percent") return `${c.percent >= 0 ? "+" : "−"}${Math.abs(c.percent).toFixed(1)}% compared with ${comparisonLabel}`;
  if (c.kind === "none_recorded") return `Nothing was recorded in ${comparisonLabel}, so there is no percentage to show.`;
  return "The comparison is not available.";
}
const factText = (f: Fact<number>, fmt: (n: number) => string): string => (f.known ? fmt(f.value) : f.reason);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function bucketLabel(key: string): string {
  const [y, m, d] = key.split("-");
  const mi = Number(m) - 1;
  if (!(mi >= 0 && mi < 12)) return key;
  return d ? `${Number(d)} ${MONTHS[mi]}` : `${MONTHS[mi]} ${y}`;
}

/** One figure's card. `figure` unavailable renders the reason sentence; there is no other path to a blank card. */
function Card<T>({ id, title, figure, children, note }: { id: string; title: string; figure: Figure<T>; children: (v: T) => ReactNode; note?: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2 rounded-lg border border-line bg-surface p-4" data-figure={id}>
      <h3 id={id} className="text-sm font-medium text-fg-muted">{title}</h3>
      {figure.available ? children(figure.value) : <p className="text-sm text-fg" role="status">{FIGURE_UNAVAILABLE_COPY[figure.reason]}</p>}
      {note ? <p className="text-xs text-fg-muted">{note}</p> : null}
    </section>
  );
}

const BIG = "text-2xl font-semibold tabular-nums tracking-tight text-fg";
const INPUT = cx("rounded-lg border border-[#d6dbd3] bg-white px-2 text-fg", CONTROL_MIN_TOUCH, FOCUS_RING);

function Controls({ params, options }: { params: OverviewParams; options: OverviewScreenProps["practitionerOptions"] }) {
  const selected = params.practitioner.kind === "one" ? params.practitioner.practitionerId : params.practitioner.kind === "unattributed" ? "unattributed" : "all";
  return (
    <form method="get" action={OVERVIEW_PATH} className="flex flex-wrap items-end gap-3" aria-label="Period and team member">
      <label className="flex flex-col gap-1 text-sm text-fg-muted">
        Period
        <select name="period" defaultValue={params.periodKind} className={INPUT}>
          {PERIOD_KINDS.map((k) => (
            <option key={k} value={k}>{PERIOD_LABELS[k]}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm text-fg-muted">
        From (custom)
        <input type="date" name="from" defaultValue={params.from ?? ""} className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-sm text-fg-muted">
        To (custom)
        <input type="date" name="to" defaultValue={params.to ?? ""} className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-sm text-fg-muted">
        Compare with (custom)
        <select name="compare" defaultValue={params.compare} className={INPUT}>
          <option value="preceding">The period just before</option>
          <option value="last_year">The same dates last year</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm text-fg-muted">
        Team member
        <select name="practitioner" defaultValue={selected} className={INPUT}>
          <option value="all">Everyone</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
          <option value="unattributed">Unattributed</option>
        </select>
      </label>
      {params.series !== "money" ? <input type="hidden" name="series" value={params.series} /> : null}
      <button type="submit" className={cx("rounded-lg border border-[#d6dbd3] bg-white px-4 text-sm font-medium text-fg hover:bg-[#edf1eb]", CONTROL_MIN_TOUCH, FOCUS_RING)}>Show</button>
    </form>
  );
}

export function OverviewScreen({ view, params, notices, practitionerOptions, format, print = false }: OverviewScreenProps) {
  const cmp = view.comparisonLabel;
  const claim =
    view.statementsClaim.kind === "one_whole_month"
      ? "This is a whole calendar month, so its collected total can be compared with that month on Statements."
      : view.statementsClaim.kind === "several_whole_months"
        ? "These are whole calendar months. Each month's collected total can be compared with that month on Statements."
        : "This period is not whole months, so it is not compared with a Statements page. It follows the same rules applied to the same dates.";
  const chartIsMoney = params.series === "money";
  // The filter in force, in words, so the data is never filtered without saying so. An id not in the list is a former team member.
  const showing =
    params.practitioner.kind === "all"
      ? "Everyone"
      : params.practitioner.kind === "unattributed"
        ? UNATTRIBUTED_LABEL
        : (practitionerOptions.find((o) => o.id === (params.practitioner as { practitionerId: string }).practitionerId)?.label ?? FORMER_TEAM_MEMBER_LABEL);
  return (
    <div className="space-y-8">
      <header className="space-y-4" data-statement-header={print ? "" : undefined}>
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight text-fg">Analytics</h1>
          <p className="text-sm text-fg-muted">{view.currentLabel}, compared with {cmp}.</p>
          <p className="text-sm font-medium text-fg" data-showing="">Showing: {showing}</p>
        </div>
        {print ? null : (
          <>
            <Controls params={params} options={practitionerOptions} />
            <p className="flex flex-wrap gap-4 text-sm">
              <a href={`${OVERVIEW_PATH}/export.csv${overviewQuery(params)}`} className={cx("underline", FOCUS_RING)}>Download as a spreadsheet (CSV)</a>
              <a href={`${OVERVIEW_PATH}/print${overviewQuery(params)}`} className={cx("underline", FOCUS_RING)}>Print this page</a>
            </p>
          </>
        )}
        {notices.length > 0 || view.notes.length > 0 ? (
          <ul className="space-y-1 text-sm text-fg" role="status">
            {[...notices, ...view.notes].map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-fg-muted">{ANALYTICS_ACCESS_NOTE}</p>
      </header>

      <section aria-labelledby="ov-collected" className="space-y-3">
        <h2 id="ov-collected" className="text-xl font-semibold tracking-tight text-fg">Collected over time</h2>
        <Card id="ov-collected-total" title={COLLECTED_LABEL} figure={view.collected} note={`${MONEY_BASIS_NOTE} ${claim}`}>
          {(c) => (
            <div className="space-y-3">
              <p className={BIG}>{format(c.headlineCents)}</p>
              <p className="text-sm text-fg-muted">{changeText(c.change, cmp)}</p>
              <table className="w-full text-left text-sm">
                <caption className="sr-only">What the collected total is made of</caption>
                <tbody>
                  <SplitRow label="On completed visits" value={format(c.split.completedVisitsCents)} />
                  <SplitRow label="Cancellation, no-show and booking fees" value={format(c.split.feesCents)} />
                  <SplitRow label="Payments on past bookings never completed" value={format(c.split.uncompletedPaymentsCents)} />
                  <SplitRow label="On other bookings, not on a client statement" value={format(c.split.otherBookingsCents)} />
                  <SplitRow label="Collected" value={format(c.split.totalCents)} strong />
                </tbody>
              </table>
              {c.caveats.refundedInFullCents > 0 ? <p className="text-sm text-fg-muted">Refunded in full, not in collected: {format(c.caveats.refundedInFullCents)}.</p> : null}
              {c.caveats.unresolvedCount > 0 ? <p className="text-sm text-fg-muted">{plural(c.caveats.unresolvedCount, "payment record", "payment records")} could not be settled either way and {c.caveats.unresolvedCount === 1 ? "is" : "are"} not counted.</p> : null}
              {c.caveats.otherCurrencyCount > 0 ? <p className="text-sm text-fg-muted">{plural(c.caveats.otherCurrencyCount, "payment record", "payment records")} in another currency {c.caveats.otherCurrencyCount === 1 ? "is" : "are"} not counted.</p> : null}
            </div>
          )}
        </Card>

        <div className={cx("flex flex-wrap items-center gap-2 text-sm", print ? "hidden" : "")} role="group" aria-label="Chart shows">
          <a href={`${OVERVIEW_PATH}${overviewQuery(params, { series: "money" })}`} aria-current={chartIsMoney ? "true" : undefined} className={cx("rounded-lg px-3", CONTROL_MIN_TOUCH, "inline-flex items-center", FOCUS_RING, chartIsMoney ? "bg-white font-semibold shadow-[0_1px_4px_#0002]" : "text-fg-muted")}>Collected</a>
          <a href={`${OVERVIEW_PATH}${overviewQuery(params, { series: "visits" })}`} aria-current={!chartIsMoney ? "true" : undefined} className={cx("rounded-lg px-3", CONTROL_MIN_TOUCH, "inline-flex items-center", FOCUS_RING, !chartIsMoney ? "bg-white font-semibold shadow-[0_1px_4px_#0002]" : "text-fg-muted")}>Completed visits</a>
        </div>
        <Card id="ov-series" title={chartIsMoney ? "Collected by visit date" : "Completed visits by date"} figure={view.series}>
          {(s) => (
            <BarChart
              idPrefix="ov-series-chart"
              title={chartIsMoney ? "Collected by visit date" : "Completed visits by date"}
              caption={`${chartIsMoney ? "Collected" : "Completed visits"} for each ${s.unit === "day" ? "day" : "month"} of ${view.currentLabel}.`}
              valueHeading={chartIsMoney ? "Collected" : "Completed visits"}
              points={s.points.map((p) => ({ key: p.key, label: bucketLabel(p.key), value: chartIsMoney ? p.collectedCents : p.completedVisits }))}
              formatValue={(v) => (chartIsMoney ? format(v) : String(v))}
              formatTick={(v) => (chartIsMoney ? format(v) : String(v))}
              maxLabelChars={7}
            />
          )}
        </Card>
      </section>

      <section aria-labelledby="ov-review" className="space-y-3">
        <h2 id="ov-review" className="text-xl font-semibold tracking-tight text-fg">Period in review</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card id="ov-visits" title="Completed visits" figure={view.completedVisits}>
            {(v) => (
              <>
                <p className={BIG}>{v.count}</p>
                <p className="text-sm text-fg-muted">{changeText(v.change, cmp)}</p>
              </>
            )}
          </Card>
          <Card id="ov-clients" title="Clients seen" figure={view.activeClients}>
            {(v) => (
              <>
                <p className={BIG}>{v.count}</p>
                <p className="text-sm text-fg-muted">{changeText(v.change, cmp)}</p>
                {v.withoutClient > 0 ? <p className="text-xs text-fg-muted">{plural(v.withoutClient, "visit has", "visits have")} no client recorded and {v.withoutClient === 1 ? "is" : "are"} not counted here.</p> : null}
              </>
            )}
          </Card>
          <Card id="ov-vpc" title="Visits per client seen" figure={view.visitsPerClient}>
            {(v) => <p className={v.known ? BIG : "text-sm text-fg"}>{factText(v, (n) => n.toFixed(1))}</p>}
          </Card>
          <Card id="ov-avgpaid" title="Average paid per visit" figure={view.averagePaid}>
            {(a) => (
              <>
                <p className={a.averageCents.known ? BIG : "text-sm text-fg"}>{factText(a.averageCents, format)}</p>
                {a.excludedUnknownVisits > 0 ? <p className="text-xs text-fg-muted">{plural(a.excludedUnknownVisits, "visit", "visits")} awaiting payment confirmation {a.excludedUnknownVisits === 1 ? "is" : "are"} left out of this average.</p> : null}
              </>
            )}
          </Card>
        </div>
      </section>

      <section aria-labelledby="ov-team" className="space-y-3">
        <h2 id="ov-team" className="text-xl font-semibold tracking-tight text-fg">Collections by team member</h2>
        <Card id="ov-bypractitioner" title="Collected by team member (whole studio)" figure={view.byPractitioner} note="This card always shows the whole studio, whatever team member is chosen above.">
          {(rows) => (
            <BarChart
              idPrefix="ov-team-chart"
              title="Collected by team member"
              caption={`Collected for each team member over ${view.currentLabel}, for the whole studio.`}
              valueHeading="Collected"
              points={rows.map((r) => ({ key: r.key, label: r.label, value: r.collectedCents }))}
              formatValue={format}
              formatTick={format}
              maxLabelChars={12}
            />
          )}
        </Card>
      </section>

      <section aria-labelledby="ov-value" className="space-y-3">
        <h2 id="ov-value" className="text-xl font-semibold tracking-tight text-fg">Service value and collected</h2>
        <p className="text-sm text-fg-muted">{NEVER_SUMMED_NOTE}</p>
        <Card id="ov-servicevalue" title={SERVICE_VALUE_LABEL} figure={view.serviceValue}>
          {(sv) => (
            <div className="space-y-2">
              <p className={BIG}>{format(sv.withEvidenceCents)}</p>
              <p className="text-sm text-fg-muted">For {plural(sv.withEvidenceVisits, "completed visit", "completed visits")} with price evidence.</p>
              <ul className="space-y-1 text-sm text-fg">
                {(Object.keys(EVIDENCE_LABELS) as Array<keyof typeof EVIDENCE_LABELS>).map((k) => {
                  const c = sv.classes[k];
                  return (
                    <li key={k}>
                      <span className="font-medium">{EVIDENCE_LABELS[k]}:</span>{" "}
                      {c.read ? `${plural(c.visits, "visit", "visits")}, ${format(c.cents)}` : `Not available. ${EVIDENCE_NOT_READABLE_NOTE}`}
                    </li>
                  );
                })}
              </ul>
              <p className="text-sm text-fg">{MISSING_PRICE_EVIDENCE_LABEL}: {sv.missingVisits} of {sv.completedVisits}.</p>
              {sv.ambiguousVisits > 0 ? <p className="text-xs text-fg-muted">{plural(sv.ambiguousVisits, "visit has", "visits have")} more than one recorded price and {sv.ambiguousVisits === 1 ? "is" : "are"} counted as having none.</p> : null}
            </div>
          )}
        </Card>
        <Card id="ov-line" title="From service value to collected" figure={view.reconciliation}>
          {(l) => (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Each step from completed service value to collected, adding up exactly</caption>
              <tbody>
                <SplitRow label="Completed service value" value={format(l.serviceValueCents)} />
                <SplitRow label="+ Collected above the price" value={format(l.collectedAbovePriceCents)} />
                <SplitRow label="− Collected below the price (unpaid, part paid, adjusted or waived)" value={format(l.collectedBelowPriceCents)} />
                <SplitRow label="+ Collected on visits with no price evidence" value={format(l.collectedOnNoEvidenceCents)} />
                <SplitRow label="+ Fees" value={format(l.feesCents)} />
                <SplitRow label="+ Payments on past bookings never completed" value={format(l.uncompletedPaymentsCents)} />
                <SplitRow label="+ Money on other bookings" value={format(l.otherBookingsCents)} />
                <SplitRow label="= Collected" value={format(l.collectedCents)} strong />
              </tbody>
            </table>
          )}
        </Card>
      </section>

      <section aria-labelledby="ov-clients-back" className="space-y-3">
        <h2 id="ov-clients-back" className="text-xl font-semibold tracking-tight text-fg">Clients keep coming back</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Card id="ov-returning" title="Returning and first-time clients" figure={view.returning} note={FIRST_TIME_NOTE}>
            {(r) => (
              <>
                <p className={BIG}>{r.returningPercent.known ? `${Math.round(r.returningPercent.value)}% returning` : "Not available"}</p>
                <p className="text-sm text-fg-muted">{r.returningPercent.known ? `${r.returning} returning, ${r.firstTime} first-time, of ${plural(r.activeClients, "client", "clients")} seen.` : r.returningPercent.reason}</p>
              </>
            )}
          </Card>
          <Card id="ov-interval" title="Average days between visits" figure={view.interval} note={INTERVAL_NOTE}>
            {(i) => (
              <>
                <p className={i.pooledAverageDays.known ? BIG : "text-sm text-fg"}>{factText(i.pooledAverageDays, (n) => `${Math.round(n)} days`)}</p>
                <p className="text-sm text-fg-muted">{plural(i.clientsWithInterval, "client has", "clients have")} two or more visits; {i.clientsWithoutInterval} {i.clientsWithoutInterval === 1 ? "has" : "have"} fewer and {i.clientsWithoutInterval === 1 ? "is" : "are"} left out.</p>
              </>
            )}
          </Card>
          <Card id="ov-nonext" title="Clients with no next booking" figure={view.noNextBooking} note={null}>
            {(n) => (
              <>
                <p className={BIG}>{n.count}</p>
                <p className="text-sm text-fg-muted">{noNextBookingNote()}</p>
              </>
            )}
          </Card>
        </div>
      </section>

      <section aria-labelledby="ov-defs" className="space-y-2">
        <details open={print} className="rounded-lg border border-line bg-surface p-4">
          <summary id="ov-defs" className={cx("cursor-pointer text-sm font-medium text-fg", FOCUS_RING)}>What the numbers mean</summary>
          <dl className="mt-3 space-y-3 text-sm text-fg">
            <div><dt className="font-medium">{COLLECTED_LABEL}</dt><dd className="text-fg-muted">{COLLECTED_DEFINITION}</dd></div>
            <div><dt className="font-medium">{SERVICE_VALUE_LABEL}</dt><dd className="text-fg-muted">{SERVICE_VALUE_DEFINITION}</dd></div>
            <div><dt className="font-medium">Not added together</dt><dd className="text-fg-muted">{NEVER_SUMMED_NOTE}</dd></div>
            <div><dt className="font-medium">First-time</dt><dd className="text-fg-muted">{FIRST_TIME_NOTE}</dd></div>
            <div><dt className="font-medium">Visit interval</dt><dd className="text-fg-muted">{INTERVAL_NOTE}</dd></div>
            <div><dt className="font-medium">Who sees this page</dt><dd className="text-fg-muted">{ANALYTICS_ACCESS_NOTE}</dd></div>
          </dl>
        </details>
      </section>
      {print ? <p data-print-footer="" className="border-t border-line pt-3 text-xs text-fg-muted">{ANALYTICS_ACCESS_NOTE}</p> : null}
    </div>
  );
}

function SplitRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr className={cx("border-b border-line/60", strong ? "font-semibold" : "")}>
      <th scope="row" className="py-1 pr-3 text-left font-normal text-fg">{label}</th>
      <td className="py-1 text-right tabular-nums text-fg">{value}</td>
    </tr>
  );
}
