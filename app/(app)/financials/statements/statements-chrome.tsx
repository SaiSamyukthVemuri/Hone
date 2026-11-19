import { PendingLink } from "@/components/pending-link";
import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import { shiftYearMonth, STATEMENT_MIN_MONTH, type YearMonth } from "@/lib/finance/statement-period";
import { STATEMENT_TABS, tabHref, type StatementsTab } from "@/lib/finance/statement-screen";

// The shared frame of the statements screens: the Studio | Clients tabs and the month controls. Both carry the SELECTED MONTH in their links.

export function StatementsTabs({ active, month }: { active: StatementsTab; month: YearMonth }) {
  return (
    <nav aria-label="Statements" className="flex gap-1 border-b border-line">
      {STATEMENT_TABS.map((t) => (
        <PendingLink
          key={t.key}
          href={tabHref(t.key, month)}
          aria-current={t.key === active ? "page" : undefined}
          className={cx("px-4 text-sm", CONTROL_MIN_TOUCH, FOCUS_RING, t.key === active ? "border-b-2 border-fg font-medium text-fg" : "text-fg-muted underline")}
        >
          {t.label}
        </PendingLink>
      ))}
    </nav>
  );
}

/** Previous / next month links and a month picker, all pointing at `base` (the page's own path, with any fixed query already in `extra`). */
export function MonthControls({ base, month, maxMonth, extra = "" }: { base: string; month: YearMonth; maxMonth: YearMonth; extra?: string }) {
  const prev = shiftYearMonth(month, -1);
  const next = shiftYearMonth(month, 1);
  const href = (m: YearMonth) => `${base}?month=${m}${extra}`;
  return (
    <div className="flex flex-wrap items-end gap-4 text-sm">
      <form method="get" action={base} className="flex items-end gap-2" aria-label="Choose a month">
        {extra ? <input type="hidden" name="view" value="month" /> : null}
        <label className="flex flex-col gap-1 text-fg">
          Month
          <input type="month" name="month" defaultValue={month} min={STATEMENT_MIN_MONTH} max={maxMonth} className={cx("rounded border border-line bg-surface px-2", CONTROL_MIN_TOUCH, FOCUS_RING)} />
        </label>
        <button type="submit" className={cx("rounded border border-line px-3", CONTROL_MIN_TOUCH, FOCUS_RING)}>Show month</button>
      </form>
      <nav className="flex gap-4" aria-label="Month">
        {prev >= STATEMENT_MIN_MONTH ? <PendingLink href={href(prev)} className={cx("underline", CONTROL_MIN_TOUCH, FOCUS_RING)}>Previous month</PendingLink> : null}
        {next <= maxMonth ? <PendingLink href={href(next)} className={cx("underline", CONTROL_MIN_TOUCH, FOCUS_RING)}>Next month</PendingLink> : null}
      </nav>
    </div>
  );
}
