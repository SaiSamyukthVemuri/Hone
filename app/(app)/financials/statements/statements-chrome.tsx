import { PendingLink } from "@/components/pending-link";
import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import { shiftYearMonth, STATEMENT_MIN_MONTH, type YearMonth } from "@/lib/finance/statement-period";
import { STATEMENT_TABS, tabHref, type StatementsTab } from "@/lib/finance/statement-screen";

// The shared frame of the statements screens: the Studio | Clients tabs and the month controls. Both carry the SELECTED MONTH in their links.

// One segmented control for the screens' tabs and period switches (Studio | Clients, Month | Full history). Presentation only: the links, labels and
// aria-current are unchanged.
export const SEGMENT_GROUP = "inline-flex gap-0.5 rounded-lg border border-line bg-surface-sunken p-0.5";
export const segmentClass = (active: boolean) =>
  cx("inline-flex items-center rounded-md px-3 text-sm", CONTROL_MIN_TOUCH, FOCUS_RING, active ? "bg-surface font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg");

export function StatementsTabs({ active, month }: { active: StatementsTab; month: YearMonth }) {
  return (
    <nav aria-label="Statements" className={SEGMENT_GROUP}>
      {STATEMENT_TABS.map((t) => (
        <PendingLink key={t.key} href={tabHref(t.key, month)} aria-current={t.key === active ? "page" : undefined} className={segmentClass(t.key === active)}>
          {t.label}
        </PendingLink>
      ))}
    </nav>
  );
}

const MONTH_STEP = cx("inline-flex items-center rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg hover:bg-surface-sunken", CONTROL_MIN_TOUCH, FOCUS_RING);

/** Previous / next month links and a month picker, all pointing at `base` (the page's own path, with any fixed query already in `extra`). */
export function MonthControls({ base, month, maxMonth, extra = "" }: { base: string; month: YearMonth; maxMonth: YearMonth; extra?: string }) {
  const prev = shiftYearMonth(month, -1);
  const next = shiftYearMonth(month, 1);
  const href = (m: YearMonth) => `${base}?month=${m}${extra}`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {prev >= STATEMENT_MIN_MONTH ? (
        <PendingLink href={href(prev)} className={MONTH_STEP}>
          <span aria-hidden="true">‹&nbsp;</span>Previous month
        </PendingLink>
      ) : null}
      <form method="get" action={base} className="flex items-center gap-2" aria-label="Choose a month">
        {extra ? <input type="hidden" name="view" value="month" /> : null}
        <label className="text-fg">
          <span className="sr-only">Month</span>
          <input type="month" name="month" defaultValue={month} min={STATEMENT_MIN_MONTH} max={maxMonth} className={cx("rounded-lg border border-line-strong bg-surface px-2 text-fg", CONTROL_MIN_TOUCH, FOCUS_RING)} />
        </label>
        <button type="submit" className={MONTH_STEP}>Show month</button>
      </form>
      {next <= maxMonth ? (
        <PendingLink href={href(next)} className={MONTH_STEP}>
          Next month<span aria-hidden="true">&nbsp;›</span>
        </PendingLink>
      ) : null}
    </div>
  );
}
