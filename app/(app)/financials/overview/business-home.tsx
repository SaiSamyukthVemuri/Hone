import { PendingLink } from "@/components/pending-link";
import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import { cumulativePath, NOT_AVAILABLE, type HomeFigure, type HomeFigures } from "@/lib/business-analytics/home-figures";
import { CHOOSE_MONTH_LABEL, heroTitle, HOME_PERIOD_LABELS, homeQuery, type HomeSelection } from "@/lib/business-analytics/home-params";
import { monthRange, STATEMENT_MIN_MONTH, type YearMonth } from "@/lib/finance/statement-period";

import { MonthPickerInput } from "../statements/month-picker-input";

// Business → Overview, as the five-page preview draws it: heading, the reporting-period control, the hero (Collected by visit date, its comparison and the
// cumulative line), the three smaller figures, then the follow-up groups. A SERVER component: there is no client state, so the figures are in the first paint.
// A genuine zero is printed as a number. A figure that cannot be computed is printed as "Not available", never as zero and never blank.

export const OVERVIEW_PATH = "/financials/overview";
export const OVERVIEW_STATEMENT_PATH = "/financials/statement";
export const OVERVIEW_ANALYTICS_PATH = "/financials/analytics";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function asOfText(local: string): string {
  const [y, m, d] = local.split("-");
  const mi = Number(m) - 1;
  return mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${Number(d)}, ${y}` : local;
}

const NAMED = ["month_to_date", "previous_month", "year_to_date"] as const;
const CELL = cx("flex items-center justify-center rounded-lg px-3 text-sm", CONTROL_MIN_TOUCH, FOCUS_RING);
const cellClass = (active: boolean) => cx(CELL, active ? "bg-white font-semibold text-fg shadow-[0_1px_4px_#0002]" : "text-fg hover:bg-white/60");

function ReportingPeriod({ selection, currentMonth }: { selection: HomeSelection; currentMonth: YearMonth }) {
  const monthChosen = selection.period === "month" && selection.month !== null;
  return (
    <div className="space-y-2" data-testid="overview-period">
      <p className="text-sm font-semibold text-fg-muted" id="overview-period-label">Reporting period</p>
      <div role="group" aria-labelledby="overview-period-label" className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-surface-sunken p-1">
        {NAMED.map((p) => (
          <PendingLink key={p} href={`${OVERVIEW_PATH}${homeQuery({ period: p, month: null })}`} aria-current={selection.period === p ? "true" : undefined} data-period={p} className={cellClass(selection.period === p)}>
            {HOME_PERIOD_LABELS[p]}
          </PendingLink>
        ))}
        <form method="get" action={OVERVIEW_PATH} aria-label={CHOOSE_MONTH_LABEL} className={cx(CELL, "col-span-2 min-w-0 justify-between gap-3", monthChosen ? "bg-white font-semibold text-fg shadow-[0_1px_4px_#0002]" : "text-fg hover:bg-white/60")} data-period="month">
          <input type="hidden" name="period" value="month" />
          <label className="flex w-full min-w-0 items-center justify-between gap-3">
            <span className={monthChosen ? "sr-only" : undefined}>{CHOOSE_MONTH_LABEL}</span>
            <MonthPickerInput defaultValue={selection.month ?? currentMonth} min={STATEMENT_MIN_MONTH} max={currentMonth} className={cx("min-w-0 flex-1 rounded-md border border-line-strong bg-white px-2 text-fg", CONTROL_MIN_TOUCH, FOCUS_RING)} />
          </label>
          <button type="submit" className="sr-only focus:not-sr-only focus:rounded-lg focus:border focus:border-line-strong focus:bg-white focus:px-3 focus:py-2">Show month</button>
        </form>
      </div>
    </div>
  );
}

function Unavailable({ reason, dark = false }: { reason: string; dark?: boolean }) {
  return (
    <span data-figure-state="unavailable">
      <span className="font-semibold">{NOT_AVAILABLE}</span>
      <span className={cx("mt-0.5 block text-xs font-normal", dark ? "text-white/70" : "text-fg-muted")}>{reason}</span>
    </span>
  );
}

function Small({ label, figure, testId }: { label: string; figure: HomeFigure<string | number>; testId: string }) {
  return (
    <div data-testid={testId} className="min-w-0">
      <span className="block text-xs text-white/70">{label}</span>
      <strong className="mt-1 block text-xl leading-tight [&_[data-figure-state]>span:first-child]:text-base">{figure.state === "value" ? String(figure.value) : <Unavailable reason={figure.reason} dark />}</strong>
    </div>
  );
}

const W = 312;
const H = 100;

function Trend({ trend, label }: { trend: HomeFigures["trend"]; label: string }) {
  if (trend.state !== "value") return <p className="text-xs text-white/70" data-testid="overview-trend-unavailable">{NOT_AVAILABLE}. {trend.reason}</p>;
  const { current, previous } = trend.value;
  const slots = Math.max(current.length, previous?.length ?? 0);
  const max = Math.max(0, ...current, ...(previous ?? []));
  const last = current.length ? current[current.length - 1] : 0;
  const lastX = slots <= 1 ? W / 2 : 3 + ((current.length - 1) / (slots - 1)) * (W - 6);
  const lastY = max <= 0 ? H - 10 : H - 10 - (last / max) * (H - 20);
  return (
    <div data-testid="overview-trend">
      <p className="text-sm font-semibold">Cumulative collections</p>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Cumulative collections for ${label}`} className="mt-2 h-24 w-full">
        <path d={`M3 ${H - 10}H${W - 2}M3 ${H / 2}H${W - 2}M3 10H${W - 2}`} stroke="currentColor" strokeOpacity=".25" strokeDasharray="2 5" fill="none" />
        {previous && previous.length ? <path d={cumulativePath(previous, max, slots, W, H)} stroke="currentColor" strokeOpacity=".55" strokeWidth="1.5" strokeDasharray="4 4" fill="none" /> : null}
        <path d={cumulativePath(current, max, slots, W, H)} stroke="currentColor" strokeWidth="2.8" fill="none" strokeLinejoin="round" />
        {current.length ? <circle cx={lastX} cy={lastY} r="4" fill="currentColor" /> : null}
      </svg>
    </div>
  );
}

function Hero({ figures, currency, title }: { figures: HomeFigures; currency: string | null; title: string }) {
  const c = figures.collected;
  return (
    <section aria-labelledby="overview-hero-title" className="rounded-2xl bg-accent p-5 text-white" data-testid="overview-hero">
      <h2 id="overview-hero-title" className="text-base font-semibold">{title}</h2>
      <p className="text-xs text-white/70">Grouped by visit date</p>
      {c.state === "value" ? (
        <>
          <p className="mt-2 flex items-baseline gap-2" data-testid="overview-collected" data-cents={c.value.cents}>
            <span className="text-5xl font-bold leading-none tracking-tight">{c.value.display}</span>
            {currency ? <small className="text-lg font-normal text-white/70">{currency.toUpperCase()}</small> : null}
          </p>
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="overview-comparison">
            {c.value.comparison.kind === "percent" ? (
              <>
                <b className="rounded-md bg-white/15 px-2 py-1">{c.value.comparison.direction === "up" ? "↗ " : c.value.comparison.direction === "down" ? "↘ " : ""}{c.value.comparison.text}</b>
                <span>vs {c.value.comparisonLabel}</span>
              </>
            ) : (
              <span>{c.value.comparison.text}</span>
            )}
          </p>
        </>
      ) : (
        <p className="mt-2 text-3xl leading-tight" data-testid="overview-collected-unavailable"><Unavailable reason={c.reason} dark /></p>
      )}
      <p className="mt-3 text-sm text-white/80" data-testid="overview-period-text">{figures.periodLabel}</p>
      <div className="mt-5"><Trend trend={figures.trend} label={figures.periodLabel} /></div>
      <div className="mt-5 grid grid-cols-3 gap-3 border-t border-white/20 pt-4">
        <Small label="Completed visits" figure={figures.completedVisits} testId="overview-visits" />
        <Small label="Clients seen" figure={figures.activeClients} testId="overview-clients" />
        <Small label="Average paid visit" figure={figures.averagePaid} testId="overview-average" />
      </div>
    </section>
  );
}

function Group({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2"><h2 className="text-base font-semibold text-fg">{title}</h2><small className="text-xs text-fg-muted">{note}</small></div>
      {children}
    </section>
  );
}

function Row({ label, hint, tag }: { label: string; hint: string; tag?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line pt-3 first:border-0 first:pt-0" data-figure-state="unavailable">
      <span className="min-w-0"><strong className="block text-sm font-semibold text-fg">{label}{tag ? <small className="ml-2 text-xs font-normal text-fg-muted">{tag}</small> : null}</strong><small className="block text-xs text-fg-muted">{hint}</small></span>
      <b className="shrink-0 text-sm text-fg">{NOT_AVAILABLE}</b>
    </div>
  );
}

export function BusinessHome({ studioName, selection, notices, currentMonth, statementMonth, asOfLocal, figures }: {
  studioName: string;
  selection: HomeSelection;
  notices: readonly string[];
  currentMonth: YearMonth;
  statementMonth: YearMonth | null;
  asOfLocal: string;
  figures: HomeFigures | null;
}) {
  return (
    <div className="space-y-5 bg-surface-sunken" data-testid="business-overview">
      <header>
        <h1 className="text-4xl font-bold leading-tight tracking-tight text-fg">Business overview</h1>
        <p className="mt-1 text-base text-fg-muted">{studioName}</p>
      </header>
      {notices.map((n) => (<p key={n} role="status" className="rounded-lg border border-line bg-surface p-3 text-sm text-fg">{n}</p>))}
      <ReportingPeriod selection={selection} currentMonth={currentMonth} />
      <p className="-mt-2 text-sm text-fg-muted">As of {asOfText(asOfLocal)}</p>
      {figures ? (
        <Hero figures={figures} currency={figures.currency} title={heroTitle(selection, currentMonth)} />
      ) : (
        <section role="alert" className="rounded-2xl border border-line bg-surface p-5 text-sm text-fg" data-testid="overview-read-failed">
          <h2 className="text-base font-semibold">{heroTitle(selection, currentMonth)}</h2>
          <p className="mt-2"><span className="font-semibold">{NOT_AVAILABLE}</span> This figure could not be read right now. Nothing is shown rather than a partial figure. Try again in a moment.</p>
        </section>
      )}
      <div className="grid gap-5 md:grid-cols-2">
        <Group title="Payment follow-up" note="">
          <Row label="Needs review" tag="All dates" hint="Visits whose payment outcome is unclear" />
          <Row label="Money owed" tag="All dates" hint="Confirmed unpaid balances" />
          <Row label="Processing" hint="Payments awaiting confirmation" />
        </Group>
        <Group title="Treatment follow-up" note="As of today">
          <Row label="Clients with no treatment booked" hint="Open plans" />
          <PendingLink href="/dashboard/capacity" className={cx("inline-flex items-center text-sm font-semibold text-fg underline", CONTROL_MIN_TOUCH, FOCUS_RING)}>Review rebooking list →</PendingLink>
        </Group>
      </div>
      {statementMonth ? (
        <section className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4" data-testid="overview-statement-card">
          <div><h2 className="text-base font-semibold text-fg">{monthRange(statementMonth).label} statement</h2><p className="text-sm text-fg-muted">{figures?.periodLabel ?? ""}</p></div>
          <PendingLink href={`${OVERVIEW_STATEMENT_PATH}?month=${statementMonth}`} className={cx("inline-flex items-center rounded-lg border border-line-strong bg-white px-3 text-sm font-semibold text-fg", CONTROL_MIN_TOUCH, FOCUS_RING)} data-testid="overview-open-statement">Open statement →</PendingLink>
        </section>
      ) : (
        <section className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
          <div><h2 className="text-base font-semibold text-fg">Clients seen year to date</h2><p className="text-sm text-fg-muted">{figures?.periodLabel ?? ""}</p></div>
          <PendingLink href={`${OVERVIEW_ANALYTICS_PATH}/clients?period=year_to_date`} className={cx("inline-flex items-center rounded-lg border border-line-strong bg-white px-3 text-sm font-semibold text-fg", CONTROL_MIN_TOUCH, FOCUS_RING)}>Explore clients →</PendingLink>
        </section>
      )}
      <p className="text-sm"><PendingLink href={`${OVERVIEW_ANALYTICS_PATH}${analyticsQuery(selection)}`} className={cx("inline-flex items-center font-semibold text-fg underline", CONTROL_MIN_TOUCH, FOCUS_RING)}>Explore analytics →</PendingLink></p>
    </div>
  );
}

function analyticsQuery(sel: HomeSelection): string {
  if (sel.period === "month" && sel.month) {
    const [y, m] = sel.month.split("-");
    const last = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
    return `?period=custom&from=${sel.month}-01&to=${sel.month}-${String(last).padStart(2, "0")}`;
  }
  return sel.period === "month_to_date" ? "" : `?period=${sel.period}`;
}
