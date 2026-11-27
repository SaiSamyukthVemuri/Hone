import type { ReactNode } from "react";

import { PendingGetForm, PendingSubmit } from "@/components/pending-get-form";
import { PendingLink } from "@/components/pending-link";
import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import {
  ANALYTICS_ACCESS_NOTE,
  ANALYTICS_TABS,
  ANALYTICS_TITLE,
  COLLECTED_DEFINITION,
  COLLECTED_LABEL,
  EVIDENCE_LABELS,
  EVIDENCE_NOT_READABLE_NOTE,
  FIRST_TIME_NOTE,
  FORMER_TEAM_MEMBER_LABEL,
  INTERVAL_NOTE,
  MISSING_PRICE_EVIDENCE_LABEL,
  NEVER_SUMMED_NOTE,
  NOT_ENOUGH_HISTORY_NOTE,
  SERVICE_VALUE_DEFINITION,
  SERVICE_VALUE_LABEL,
  TABS_NOT_AVAILABLE_NOTE,
  UNATTRIBUTED_LABEL,
  UNFINISHED_CHARTS_UNAVAILABLE,
  BEYOND_USUAL_FILTER_NOTE,
  MOST_FREQUENT_RETURNS_NOTE,
  NAMED_CLIENTS_PRINT_NOTE,
  NAMED_CLIENTS_TITLE,
  SPEND_NOT_AVAILABLE,
  TOP_SPENDERS_NOTE,
  beyondUsualNote,
  fewerThanTwoDatesNote,
  namedClientsCap,
  namedClientsNotListed,
  noNextBookingNote,
} from "@/lib/business-analytics/copy";
import { NAMED_LIST_SIZE, type NamedRow } from "@/lib/business-analytics/named-clients";
import { FIGURE_UNAVAILABLE_COPY, type Figure } from "@/lib/business-analytics/figure";
import { formatWhole } from "@/lib/business-analytics/money-format";
import { MONEY_BASIS_NOTE, type Change } from "@/lib/business-analytics/money-metrics";
import type { CollectedDifference, OverviewView } from "@/lib/business-analytics/overview-model";
import { overviewQuery, type OverviewParams } from "@/lib/business-analytics/overview-params";
import { PERIOD_KINDS } from "@/lib/business-analytics/period";
import { DEFAULT_BEYOND_USUAL_FACTOR } from "@/lib/business-analytics/visit-metrics";
import type { Fact } from "@/lib/dashboard/owner-capacity-model";

import { Donut, HBars, LineChart } from "./charts";

// ===========================================================================
// The Overview screen. PRESENTATION ONLY: it renders the one OverviewView it is given and computes nothing about money or people.
// ===========================================================================
// Every figure goes through <Card>: an unavailable figure shows its fixed reason sentence in the same place, never a blank card, a 0 or a dropped
// section. The view holds aggregates only, so nothing here can show a client or an appointment id, and no text names a practitioner id. A SELECTED
// team member's id sits in the filter form's option value AND in the screen's own link hrefs (the chart toggle, Export data and Print / Save PDF here;
// Back on the print page): owner-only, the same URL as the request. It must stay OUT of print, CSV and any chart, table or link text.
// Colour: white, charcoal and neutral greys. A change is words and a sign, never green or red.
// The other four tabs are drawn as plain, disabled text: no link, no route.

export const OVERVIEW_PATH = "/financials/analytics";
export const CLIENTS_PATH = "/financials/analytics/clients";
const PERIOD_LABELS: Record<string, string> = { month_to_date: "Month to date", previous_month: "Previous month", year_to_date: "Year to date", custom: "Custom range" };

export type OverviewScreenProps = {
  view: OverviewView;
  params: OverviewParams;
  notices: readonly string[];
  practitionerOptions: ReadonlyArray<{ id: string; label: string }>;
  format: (cents: number) => string;
  /** The printable form: no controls, tabs, toggle or buttons; every disclosure open; the owner-only note as a footer. The figures are the same cards. */
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
/** "day"/"days" or "month"/"months" for the series' own unit. */
const unitWord = (unit: "day" | "month", n: number): string => (unit === "day" ? (n === 1 ? "day" : "days") : n === 1 ? "month" : "months");
function asOfText(local: string): string {
  const [y, m, d] = local.split("-");
  const mi = Number(m) - 1;
  return mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${Number(d)}, ${y}` : local;
}

/** One figure's card. `figure` unavailable renders the reason sentence; there is no other path to a blank card. */
function Card<T>({ id, title, figure, children, note, tone = "plain", className }: { id: string; title: string; figure: Figure<T>; children: (v: T) => ReactNode; note?: ReactNode; tone?: "plain" | "soft"; className?: string }) {
  return (
    <section aria-labelledby={id} className={cx("space-y-2 rounded-xl border border-line p-4", tone === "soft" ? "bg-surface-sunken" : "bg-surface", className)} data-figure={id} data-print-hidden={className?.includes("print:hidden") ? "" : undefined}>
      <h3 id={id} className="text-sm font-medium text-fg-muted">{title}</h3>
      {figure.available ? children(figure.value) : <p className="text-sm text-fg" role="status">{FIGURE_UNAVAILABLE_COPY[figure.reason]}</p>}
      {note ? <p className="text-xs text-fg-muted">{note}</p> : null}
    </section>
  );
}

/** A figure inside a figure: unavailable when the outer one is, else the picked inner one. */
function flatten<T, U>(outer: Figure<T>, pick: (v: T) => Figure<U>): Figure<U> {
  return outer.available ? pick(outer.value) : outer;
}

/** One ranked list: a display name and one figure per row, in the order given. No link, no id; the row key is the rank, never a client. */
function NamedList({ rows, show, format }: { rows: readonly NamedRow[]; show: "spend" | "visits" | "gap"; format: (cents: number) => string }) {
  if (rows.length === 0) return <p className="text-sm text-fg-muted">No clients to list.</p>;
  const value = (r: NamedRow): string =>
    show === "spend" ? (r.periodPaidCents === null ? SPEND_NOT_AVAILABLE : format(r.periodPaidCents)) : show === "visits" ? plural(r.periodVisits, "visit", "visits") : `every ${Math.round(r.averageGapDays ?? 0)} days`;
  return (
    <ol className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.rowKey} className="flex items-baseline justify-between gap-3 text-sm">
          <span className="min-w-0 truncate text-fg">{r.name}</span>
          <span className="shrink-0 tabular-nums text-fg-muted">{value(r)}</span>
        </li>
      ))}
    </ol>
  );
}

const BIG = "text-3xl font-semibold tabular-nums tracking-tight text-fg";
const INPUT = cx("rounded-lg border border-line bg-surface px-2 text-fg", CONTROL_MIN_TOUCH, FOCUS_RING);
export const BUTTON = cx("inline-flex items-center rounded-lg border border-line bg-surface px-4 text-sm font-medium text-fg hover:bg-surface-sunken", CONTROL_MIN_TOUCH, FOCUS_RING);

/** A submitted date is put back in the form only when it is a plain YYYY-MM-DD; anything else (junk, a long string, a non-date) leaves the field empty rather than echoing the query. */
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;
const shownDate = (v: string | undefined): string => (v !== undefined && PLAIN_DATE.test(v) ? v : "");

export function Controls({ params, options, action = OVERVIEW_PATH, hidden = [] }: { params: OverviewParams; options: OverviewScreenProps["practitionerOptions"]; action?: string; hidden?: ReadonlyArray<readonly [string, string]> }) {
  const selected = params.practitioner.kind === "one" ? params.practitioner.practitionerId : params.practitioner.kind === "unattributed" ? "unattributed" : "all";
  // Compact controls: a period list and a team-member list. Choosing "Custom range" reveals the dates and the comparison, with no script: the form's own
  // :has() rule shows that group while the Custom option is selected. The submit button is always there, so every choice works without script, and the
  // submitted names and values are exactly the ones the loader's strict parser reads.
  // The form remounts from the applied values on every navigation (PendingGetForm keys itself on the full applied address), so no per-screen key is needed here.
  return (
    <PendingGetForm action={action} className="group flex flex-wrap items-end justify-end gap-2" aria-label="Period and team member">
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        <span className="sr-only">Period</span>
        <select name="period" defaultValue={params.periodKind} aria-label="Period" className={INPUT}>
          {PERIOD_KINDS.map((k) => (
            <option key={k} value={k}>{PERIOD_LABELS[k]}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        <span className="sr-only">Team member</span>
        <select name="practitioner" defaultValue={selected} aria-label="Team member" className={INPUT}>
          <option value="all">All practitioners</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
          <option value="unattributed">Unattributed</option>
        </select>
      </label>
      {params.series !== "money" ? <input type="hidden" name="series" value={params.series} /> : null}
      {hidden.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <PendingSubmit className={BUTTON}>Show</PendingSubmit>
      <div className="hidden basis-full flex-wrap items-end justify-end gap-2 group-has-[option[value=custom]:checked]:flex" data-custom-range="">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          From
          <input type="date" name="from" defaultValue={shownDate(params.from)} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          To
          <input type="date" name="to" defaultValue={shownDate(params.to)} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Compare with
          <select name="compare" defaultValue={params.compare} className={INPUT}>
            <option value="preceding">The period just before</option>
            <option value="last_year">The same dates last year</option>
          </select>
        </label>
      </div>
    </PendingGetForm>
  );
}

/** The current tab is plain text. Overview and Clients carry their period/team query; Waitlist starts with its own capacity controls. Unbuilt tabs stay disabled. */
export function Tabs({ current = "Overview", query = "" }: { current?: "Overview" | "Clients" | "Waitlist"; query?: string }) {
  const href = (t: string): string | null => (t === "Overview" ? `${OVERVIEW_PATH}${query}` : t === "Clients" ? `${CLIENTS_PATH}${query}` : t === "Waitlist" ? "/financials/analytics/waitlist" : null);
  return (
    <div className="space-y-1">
      <ul className="inline-flex flex-wrap gap-1 rounded-xl bg-surface-sunken p-1 text-sm" aria-label="Analytics sections">
        {ANALYTICS_TABS.map((t) => {
          const link = href(t);
          return (
            <li key={t}>
              {t === current ? (
                <span aria-current="page" className={cx("inline-flex items-center rounded-lg bg-surface px-4 py-2 font-semibold text-fg shadow-[0_1px_3px_#0002]", CONTROL_MIN_TOUCH)}>{t}</span>
              ) : link ? (
                <PendingLink href={link} className={cx("inline-flex items-center rounded-lg px-4 py-2 text-fg-muted hover:text-fg", CONTROL_MIN_TOUCH, FOCUS_RING)}>{t}</PendingLink>
              ) : (
                <span aria-disabled="true" className={cx("inline-flex items-center rounded-lg px-4 py-2 text-fg-muted", CONTROL_MIN_TOUCH)}>{t}<span className="sr-only"> (not available yet)</span></span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-fg-muted">{TABS_NOT_AVAILABLE_NOTE}</p>
    </div>
  );
}

export function PageTitle() {
  return (
    <h1 className="text-4xl font-semibold tracking-tight text-fg">{ANALYTICS_TITLE}</h1>
  );
}

/** The dates were not accepted: the header and controls stay (with what was submitted, parsed to safe values) so the owner can correct the range, and the reason sits beside them. */
export function OverviewInvalidPeriod({ params, notices, practitionerOptions }: { params: OverviewParams; notices: readonly string[]; practitionerOptions: OverviewScreenProps["practitionerOptions"] }) {
  return (
    <div className="space-y-8">
      <header className="space-y-5">
        <PageTitle />
        <Tabs />
        <Controls params={params} options={practitionerOptions} />
        <ul className="space-y-1 text-sm text-fg" role="alert">
          {notices.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <p className="text-xs text-fg-muted">{ANALYTICS_ACCESS_NOTE}</p>
      </header>
    </div>
  );
}

/** "+3.1% ..." under a headline number. A comparison that is not available says so; it is never a +0.0%. */
function ChangeLine({ change, cmp }: { change: Change; cmp: string }) {
  return <p className="text-sm text-fg-muted">{changeText(change, cmp)}</p>;
}

/** Words for the model's difference: "$248 more collected", "$40 less collected" or "No change in collected". The screen only formats; the subtraction is the model's. */
function differenceText(d: CollectedDifference, fmt: (c: number) => string): string {
  return d.direction === "same" ? "No change in collected" : `${fmt(d.cents)} ${d.direction} collected`;
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
  // The period line is already said once above; the model's own copy of it is not repeated.
  const periodLine = `${view.currentLabel} compared with ${cmp}.`;
  const pageNotes = view.notes.filter((n) => n !== periodLine);
  const currencyWord = view.currency ? view.currency.toUpperCase() : null;
  const prevCount = view.previousSeries.available ? view.previousSeries.value.points.length : null;
  const curCount = view.series.available ? view.series.value.points.length : null;
  const toggle = (series: "money" | "visits", label: string) => (
    <PendingLink
      href={`${OVERVIEW_PATH}${overviewQuery(params, { series })}`}
      aria-current={(series === "money") === chartIsMoney ? "true" : undefined}
      className={cx("inline-flex items-center rounded-lg px-3 text-sm", CONTROL_MIN_TOUCH, FOCUS_RING, (series === "money") === chartIsMoney ? "bg-surface font-semibold shadow-[0_1px_3px_#0002]" : "text-fg-muted")}
    >
      {label}
    </PendingLink>
  );
  return (
    <div className="space-y-8">
      <header className="space-y-5" data-statement-header={print ? "" : undefined}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <PageTitle />
          {print ? null : (
            <div className="flex flex-wrap gap-2">
              <a href={`${OVERVIEW_PATH}/export.csv${overviewQuery(params)}`} className={BUTTON}>Export data</a>
              <PendingLink href={`${OVERVIEW_PATH}/print${overviewQuery(params)}`} className={BUTTON}>Print / Save PDF</PendingLink>
            </div>
          )}
        </div>
        {print ? null : (
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
            <Tabs query={overviewQuery(params)} />
            <Controls params={params} options={practitionerOptions} />
          </div>
        )}
        <div className="space-y-1">
          <p className="text-sm text-fg-muted">{periodLine}</p>
          <p className="text-sm font-medium text-fg" data-showing="">Showing: {showing}</p>
        </div>
        {notices.length > 0 || pageNotes.length > 0 ? (
          <ul className="space-y-1 text-sm text-fg" role="status">
            {[...notices, ...pageNotes].map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        <details open={print} id="ov-defs" className="rounded-xl border border-line bg-surface p-4">
          <summary className={cx("cursor-pointer text-sm font-medium text-fg underline", FOCUS_RING)}>How these are calculated</summary>
          <dl className="mt-3 space-y-3 text-sm text-fg">
            <div><dt className="font-medium">{COLLECTED_LABEL}</dt><dd className="text-fg-muted">{COLLECTED_DEFINITION}</dd></div>
            <div><dt className="font-medium">{SERVICE_VALUE_LABEL}</dt><dd className="text-fg-muted">{SERVICE_VALUE_DEFINITION}</dd></div>
            <div><dt className="font-medium">Not added together</dt><dd className="text-fg-muted">{NEVER_SUMMED_NOTE}</dd></div>
            <div><dt className="font-medium">First-time</dt><dd className="text-fg-muted">{FIRST_TIME_NOTE}</dd></div>
            <div><dt className="font-medium">Visit interval</dt><dd className="text-fg-muted">{INTERVAL_NOTE}</dd></div>
            <div><dt className="font-medium">Beyond their usual visit interval</dt><dd className="text-fg-muted">{beyondUsualNote(DEFAULT_BEYOND_USUAL_FACTOR)} {BEYOND_USUAL_FILTER_NOTE}</dd></div>
            <div><dt className="font-medium">Who sees this page</dt><dd className="text-fg-muted">{ANALYTICS_ACCESS_NOTE}</dd></div>
          </dl>
        </details>
      </header>

      <section aria-label="Headline figures" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card id="ov-collected-total" title={COLLECTED_LABEL} figure={view.collected} tone="soft">
          {(c) => (
            <>
              <p className={BIG}>
                {formatWhole(c.headlineCents)}
                {currencyWord ? <span className="ml-1.5 text-sm font-medium tracking-normal text-fg-muted">{currencyWord}</span> : null}
              </p>
              <ChangeLine change={c.change} cmp={cmp} />
            </>
          )}
        </Card>
        <Card id="ov-visits" title="Completed visits" figure={view.completedVisits}>
          {(v) => (
            <>
              <p className={BIG}>{v.count}</p>
              <ChangeLine change={v.change} cmp={cmp} />
            </>
          )}
        </Card>
        <Card id="ov-avgpaid" title="Average paid per visit" figure={view.averagePaid}>
          {(a) => (
            <>
              <p className={a.averageCents.known ? BIG : "text-sm text-fg"}>{factText(a.averageCents, format)}</p>
              {a.averageCents.known ? <ChangeLine change={view.averagePaidChange} cmp={cmp} /> : null}
              {a.excludedUnknownVisits > 0 ? <p className="text-xs text-fg-muted">{plural(a.excludedUnknownVisits, "visit", "visits")} awaiting payment confirmation {a.excludedUnknownVisits === 1 ? "is" : "are"} left out of this average.</p> : null}
            </>
          )}
        </Card>
        <Card id="ov-clients" title="Active clients" figure={view.activeClients}>
          {(v) => (
            <>
              <p className={BIG}>{v.count}</p>
              <ChangeLine change={v.change} cmp={cmp} />
              {v.withoutClient > 0 ? <p className="text-xs text-fg-muted">{plural(v.withoutClient, "visit has", "visits have")} no client recorded and {v.withoutClient === 1 ? "is" : "are"} not counted here.</p> : null}
            </>
          )}
        </Card>
      </section>
      {/* The basis of the Collected figure, in full, beside the cards it belongs to (not inside one card, so the four cards stay level). */}
      <p className="-mt-4 text-xs text-fg-muted" data-collected-basis="">{COLLECTED_LABEL}: {MONEY_BASIS_NOTE} {claim}</p>

      <section aria-label="Over time and returning clients" className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {print ? null : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-semibold tracking-tight text-fg">{chartIsMoney ? "Collected over time" : "Completed visits over time"}</h2>
              <div className="inline-flex gap-1 rounded-xl bg-surface-sunken p-1" role="group" aria-label="Chart shows">
                {toggle("money", "Money")}
                {toggle("visits", "Visits")}
              </div>
            </div>
          )}
          {print ? <h2 className="text-xl font-semibold tracking-tight text-fg">{chartIsMoney ? "Collected over time" : "Completed visits over time"}</h2> : null}
          <Card id="ov-series" title={chartIsMoney ? "Collected by visit date" : "Completed visits by date"} figure={view.series}>
            {(s) => (
              <div className="space-y-2">
                <LineChart
                  idPrefix="ov-series-chart"
                  title={chartIsMoney ? "Collected by visit date" : "Completed visits by date"}
                  caption={`${chartIsMoney ? `Collected${currencyWord ? ` (amounts in ${currencyWord})` : ""}` : "Completed visits"} for each ${s.unit === "day" ? "day" : "month"} of ${view.currentLabel}${view.previousSeries.available ? `, with the same for ${cmp}` : ""}.`}
                  valueHeading={chartIsMoney ? "Collected" : "Completed visits"}
                  currentName={view.currentLabel}
                  previousName={cmp}
                  points={s.points.map((p) => ({ key: p.key, label: bucketLabel(p.key), value: chartIsMoney ? p.collectedCents : p.completedVisits }))}
                  previous={view.previousSeries.available ? view.previousSeries.value.points.map((p) => (chartIsMoney ? p.collectedCents : p.completedVisits)) : null}
                  formatValue={(v) => (chartIsMoney ? format(v) : String(v))}
                  formatTick={(v) => (chartIsMoney ? formatWhole(v) : String(v))}
                  openData={print}
                />
                {view.previousSeries.available ? (
                  <p className="text-xs text-fg-muted">
                    {`Each point on the dashed line is the same ${s.unit === "day" ? "day" : "month"} number of ${cmp}.`}
                    {prevCount !== null && curCount !== null && prevCount < curCount ? ` That period has ${prevCount} ${unitWord(s.unit, prevCount)}, so its line ends sooner.` : ""}
                    {prevCount !== null && curCount !== null && prevCount > curCount ? ` That period has ${prevCount} ${unitWord(s.unit, prevCount)}; only the first ${curCount} are drawn.` : ""}
                  </p>
                ) : (
                  <p className="text-xs text-fg-muted" role="status">{FIGURE_UNAVAILABLE_COPY[(view.previousSeries as { reason: keyof typeof FIGURE_UNAVAILABLE_COPY }).reason]} The previous period is not drawn.</p>
                )}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight text-fg">Returning clients</h2>
          <Card id="ov-returning" title="Returning and first-time clients" figure={view.returning} note={FIRST_TIME_NOTE}>
            {(r) =>
              r.returningPercent.known ? (
                <div className="space-y-2">
                  <Donut
                    idPrefix="ov-returning-donut"
                    title={`${Math.round(r.returningPercent.value)}% of the clients seen in this period had a completed visit before it`}
                    centre={`${Math.round(r.returningPercent.value)}%`}
                    parts={[
                      { key: "returning", label: "returning", value: r.returning, tone: "ink" },
                      { key: "first", label: "first-time", value: r.firstTime, tone: "soft" },
                    ]}
                  />
                  <p className="text-sm text-fg-muted">{`${plural(r.activeClients, "client", "clients")} seen in this period.`}</p>
                </div>
              ) : (
                <p className="text-sm text-fg">{r.returningPercent.reason}</p>
              )
            }
          </Card>
          <Card id="ov-interval" title="Average gap between visits" figure={view.interval} note={INTERVAL_NOTE}>
            {(i) => (
              <>
                <p className={i.pooledAverageDays.known ? BIG : "text-sm text-fg"}>{factText(i.pooledAverageDays, (n) => `${Math.round(n)} days`)}</p>
                <p className="text-sm text-fg-muted">Across returning clients&rsquo; histories. {plural(i.clientsWithInterval, "client has", "clients have")} two or more visits; {i.clientsWithoutInterval} {i.clientsWithoutInterval === 1 ? "has" : "have"} fewer and {i.clientsWithoutInterval === 1 ? "is" : "are"} left out.</p>
              </>
            )}
          </Card>
        </div>
      </section>

      <section aria-labelledby="ov-named" className="space-y-3" data-named-clients="">
        <h2 id="ov-named" className="text-xl font-semibold tracking-tight text-fg">{NAMED_CLIENTS_TITLE}</h2>
        {print ? (
          <p className="text-sm text-fg-muted" data-named-omitted="">{NAMED_CLIENTS_PRINT_NOTE}</p>
        ) : (
          <>
            {/* The browser's own Print on this page must not print names or spending either: the lists are hidden in print media and a print-only line says so. */}
            <p className="hidden text-sm text-fg-muted print:block" data-print-only-note="">{NAMED_CLIENTS_PRINT_NOTE}</p>
            <div className="grid gap-3 lg:grid-cols-3 print:hidden" data-print-hidden="">
              <Card id="ov-top-spenders" title="Top spenders" figure={flatten(view.namedClients, (n) => n.spenders)} note={TOP_SPENDERS_NOTE}>
                {(rows) => <NamedList rows={rows} show="spend" format={format} />}
              </Card>
              <Card id="ov-most-visits" title="Most visits" figure={flatten(view.namedClients, (n) => ({ available: true, value: n.mostVisits }))}>
                {(rows) => <NamedList rows={rows} show="visits" format={format} />}
              </Card>
              <Card id="ov-frequent-returns" title="Most frequent returns" figure={flatten(view.namedClients, (n) => n.frequentReturns)} note={MOST_FREQUENT_RETURNS_NOTE}>
                {(rows) => <NamedList rows={rows} show="gap" format={format} />}
              </Card>
            </div>
            {view.namedClients.available ? (
              <div className="space-y-1 text-xs text-fg-muted print:hidden" data-named-footnotes="" data-print-hidden="">
                <p>{namedClientsCap(view.namedClients.value.seen, NAMED_LIST_SIZE)}</p>
                {view.namedClients.value.notListed > 0 ? <p>{namedClientsNotListed(view.namedClients.value.notListed)}</p> : null}
                {view.namedClients.value.fewerThanTwoDates !== null && view.namedClients.value.fewerThanTwoDates > 0 ? <p>{fewerThanTwoDatesNote(view.namedClients.value.fewerThanTwoDates)}</p> : null}
              </div>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="ov-review" className="space-y-3">
        <h2 id="ov-review" className="text-xl font-semibold tracking-tight text-fg">Period in review</h2>
        <div className={cx("grid gap-3 sm:grid-cols-2", !print && view.namedClients.available && view.namedClients.value.highestSpend ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
          <Card id="ov-month-collected" title="Collections compared" figure={view.collected}>
            {(c) =>
              c.difference === null ? (
                <p className="text-sm text-fg">The comparison is not available.</p>
              ) : (
                <>
                  <p className="text-xl font-semibold text-fg">{differenceText(c.difference, format)}</p>
                  <p className="text-sm text-fg-muted">{view.currentLabel} against {cmp}. {changeText(c.change, cmp)}</p>
                </>
              )
            }
          </Card>
          <Card id="ov-month-new" title="First-time clients" figure={view.returning}>
            {(r) => (
              <>
                <p className="text-xl font-semibold text-fg">{plural(r.firstTime, "first-time client", "first-time clients")}</p>
                <p className="text-sm text-fg-muted">First completed visit recorded in Hone fell within this period.</p>
              </>
            )}
          </Card>
          <Card id="ov-vpc" title="Visits per client seen" figure={view.visitsPerClient}>
            {(v) => <p className={v.known ? BIG : "text-sm text-fg"}>{factText(v, (n) => n.toFixed(1))}</p>}
          </Card>
          {!print && view.namedClients.available && view.namedClients.value.highestSpend && view.namedClients.value.highestSpend.periodPaidCents !== null ? (
            <Card id="ov-highest-spend" className="print:hidden" title="Highest spend this period" figure={{ available: true, value: view.namedClients.value.highestSpend }}>
              {(r) => (
                <>
                  <p className="text-xl font-semibold text-fg">{r.name}</p>
                  <p className="text-sm text-fg-muted">{format(r.periodPaidCents as number)} kept on completed visits.</p>
                </>
              )}
            </Card>
          ) : null}
        </div>
      </section>

      <section aria-label="Visit frequency and collections by team member" className="grid gap-3 lg:grid-cols-2">
        <Card id="ov-frequency" title="How often clients visit" figure={view.visitFrequency} note="Completed visits per active client in this period.">
          {(f) => (
            <HBars
              rows={[
                { key: "one", label: "1 visit", value: f.one },
                { key: "two", label: "2 visits", value: f.two },
                { key: "three", label: "3+ visits", value: f.threePlus },
              ]}
              formatValue={(n) => String(n)}
            />
          )}
        </Card>
        <Card id="ov-bypractitioner" title="Collections by practitioner" figure={view.byPractitioner} note="This card always shows the whole studio, whatever team member is chosen above.">
          {(rows) => <HBars rows={rows.map((r) => ({ key: r.key, label: r.label, value: r.collectedCents }))} formatValue={format} />}
        </Card>
      </section>

      <section aria-labelledby="ov-follow" className="space-y-3">
        <div>
          <h2 id="ov-follow" className="text-xl font-semibold tracking-tight text-fg">Booking follow-up</h2>
          <p className="text-sm text-fg-muted">Current as of {asOfText(view.asOfLocal)}.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Card id="ov-nonext" title="No next booking" figure={view.noNextBooking} note={noNextBookingNote()}>
            {(n) => <p className={BIG}>{n.count}</p>}
          </Card>
          <Card id="ov-beyond" title="Beyond their usual visit interval" figure={view.beyondUsual} note={<>{beyondUsualNote(DEFAULT_BEYOND_USUAL_FACTOR)}{view.filterKind !== "all" ? ` ${BEYOND_USUAL_FILTER_NOTE}` : ""}</>}>
            {(b) => (
              <>
                <p className={BIG}>{b.count}</p>
                {b.notEnoughHistory > 0 ? <p className="text-xs text-fg-muted">{NOT_ENOUGH_HISTORY_NOTE(b.notEnoughHistory)}</p> : null}
              </>
            )}
          </Card>
          <section aria-labelledby="ov-unfinished" className="space-y-2 rounded-xl border border-line bg-surface p-4" data-unavailable-section="ov-unfinished">
            <h3 id="ov-unfinished" className="text-sm font-medium text-fg-muted">Charts with unfinished sections</h3>
            <p className="text-sm text-fg" role="status">{UNFINISHED_CHARTS_UNAVAILABLE}</p>
          </section>
        </div>
      </section>

      <section aria-labelledby="ov-value" className="space-y-2">
        <details open={print} className="rounded-xl border border-line bg-surface p-4" data-reconciliation="">
          <summary id="ov-value" className={cx("cursor-pointer text-sm font-medium text-fg", FOCUS_RING)}>Service value and collected</summary>
          <div className="mt-4 space-y-4">
            <p className="text-sm text-fg-muted">{NEVER_SUMMED_NOTE}</p>
            <Card id="ov-split" title="Collected breakdown" figure={view.collected}>
              {(c) => (
                <div className="space-y-2">
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
          </div>
        </details>
      </section>

      <footer className="flex flex-wrap items-start justify-between gap-2 border-t border-line pt-3 text-xs text-fg-muted" data-print-footer={print ? "" : undefined}>
        <span>{view.currency ? view.currency.toUpperCase() : "Currency not set"} &middot; {view.timezone}</span>
        <span>{ANALYTICS_ACCESS_NOTE}</span>
      </footer>
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

