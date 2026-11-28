import { PendingGetForm, PendingSubmit } from "@/components/pending-get-form";
import { PendingLink } from "@/components/pending-link";
import { MonthPickerInput } from "./month-picker-input";
import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import { shiftYearMonth, STATEMENT_MIN_MONTH, type YearMonth } from "@/lib/finance/statement-period";
import type { PillTone } from "@/lib/finance/statement-methods";
import { STATEMENT_TABS, tabHref, type StatementsTab } from "@/lib/finance/statement-screen";

// The shared frame of the statements screens: the Studio | Clients tabs and the month controls. Both carry the SELECTED MONTH in their links.

// One segmented control for the screens' tabs and period switches (Studio | Clients, Month | Full history). Presentation only: the links, labels and
// aria-current are unchanged.
// The summary card: white with the app's static edge. No decorative tint; the figures and words carry the meaning.
// The pill colours are the app's own status tokens; the label is always shown beside the colour.
export const PILL_TONE: Record<PillTone, string> = {
  success: "bg-success-surface text-success-fg",
  warning: "bg-warning-surface text-warning-fg",
  neutral: "bg-status-neutral-surface text-status-neutral-fg",
};
export const SUMMARY_TONE = "border border-line bg-surface";
export const SEGMENT_GROUP = "inline-flex gap-0.5 rounded-[9px] border border-line bg-surface-sunken p-[3px]";
export const segmentClass = (active: boolean) =>
  cx("inline-flex items-center rounded-lg px-3 text-sm", CONTROL_MIN_TOUCH, FOCUS_RING, active ? "bg-white font-semibold text-fg shadow-[0_1px_4px_#0002]" : "text-fg hover:bg-white/60");

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

// The month controls as the reference draws them: a bordered arrow, the month picker, a bordered arrow. The links, labels and bounds are unchanged (the
// arrows keep their words for screen readers); at a bound the arrow is not rendered, as before.
const ARROW = cx("inline-flex w-9 items-center justify-center rounded-lg border border-line-strong bg-white text-fg hover:bg-surface-sunken", CONTROL_MIN_TOUCH, FOCUS_RING);
const PICKER = cx("w-[185px] max-w-full rounded-lg border border-line-strong bg-white px-2 text-fg", CONTROL_MIN_TOUCH, FOCUS_RING);

/** Previous / next month arrows and a month picker, all pointing at `base` (the page's own path, with any fixed query already in `extra`). */
export function MonthControls({ base, month, maxMonth, extra = "" }: { base: string; month: YearMonth; maxMonth: YearMonth; extra?: string }) {
  const prev = shiftYearMonth(month, -1);
  const next = shiftYearMonth(month, 1);
  const href = (m: YearMonth) => `${base}?month=${m}${extra}`;
  return (
    <div className="flex items-center gap-1 text-sm">
      {prev >= STATEMENT_MIN_MONTH ? (
        <PendingLink href={href(prev)} className={ARROW}>
          <span aria-hidden="true">‹</span>
          <span className="sr-only">Previous month</span>
        </PendingLink>
      ) : null}
      <PendingGetForm native action={base} className="flex items-center gap-1" aria-label="Choose a month">
        {extra ? <input type="hidden" name="view" value="month" /> : null}
        <label className="text-fg">
          <span className="sr-only">Month</span>
          <MonthPickerInput defaultValue={month} min={STATEMENT_MIN_MONTH} max={maxMonth} className={PICKER} />
        </label>
        <PendingSubmit className="sr-only focus:not-sr-only focus:rounded-lg focus:border focus:border-line-strong focus:bg-white focus:px-3 focus:py-2">Show month</PendingSubmit>
      </PendingGetForm>
      {next <= maxMonth ? (
        <PendingLink href={href(next)} className={ARROW}>
          <span aria-hidden="true">›</span>
          <span className="sr-only">Next month</span>
        </PendingLink>
      ) : (
        // At the latest month the arrow is drawn disabled, as the reference does: not a link, not focusable, and silent to screen readers.
        <span aria-hidden="true" className={cx("inline-flex w-9 items-center justify-center rounded-lg border border-line-strong bg-white text-fg opacity-35", CONTROL_MIN_TOUCH)}>›</span>
      )}
    </div>
  );
}
