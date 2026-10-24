// Pure, server-safe month blocked-time grouping. Lives in a plain (.ts)
// module (not MonthView.tsx) so it is unit-testable without a JSX transform
// and callable from the server-rendered calendar page. Mirrors the week view's
// block sources: full-day blockouts, one-off timed blocks, recurring breaks.

import { addDays, localDateString } from "@/lib/booking/tz";
import { displayRecurringBreakLabel, TIMED_BLOCK_LABEL } from "./calendar-format";
import { calendarBlockScopeLabel, type BlockScopeNames } from "@/lib/calendar/block-scope";

// Per-day blocked-time summary for the month grid. `fullDay` marks a full-day
// blockout (its reason shown, fallback "Blocked"); `labels` collects timed-
// block + recurring-break labels for that day (deduped, timed blocks first).
export type MonthDayBlocked = {
  fullDay: boolean;
  fullDayReason: string | null;
  labels: string[];
};

type ClosedDayLookup = (date: string) => boolean;

// Build the per-day summary from the same sources the week view uses.
// Recurring breaks are skipped on closed dates, matching the week view (a
// standing break would otherwise show on a day the studio is closed).
export function groupMonthBlockedByDate(
  blockouts: ReadonlyArray<{
    starts_on: string;
    ends_on: string;
    reason: string | null;
  }>,
  timedBlocks: ReadonlyArray<{ starts_at: string; category: string; practitioner_id?: string | null }>,
  recurringOccurrences: ReadonlyArray<{
    starts_at: string;
    rule: { label: string } | null;
    practitioner_id?: string | null;
  }>,
  tz: string,
  isClosedDate: ClosedDayLookup,
  // BLOCK-SCOPE F3: under practitioner capacity each label carries its scope
  // ("Lunch · All practitioners"); absent (one studio timeline): bare labels.
  scopeNames?: BlockScopeNames,
): Map<string, MonthDayBlocked> {
  const byDate = new Map<string, MonthDayBlocked>();
  const ensure = (date: string): MonthDayBlocked => {
    let row = byDate.get(date);
    if (!row) {
      row = { fullDay: false, fullDayReason: null, labels: [] };
      byDate.set(date, row);
    }
    return row;
  };
  const addLabel = (row: MonthDayBlocked, base: string, practitionerId: string | null | undefined) => {
    const label = scopeNames ? `${base} · ${calendarBlockScopeLabel(practitionerId, scopeNames)}` : base;
    if (!row.labels.includes(label)) row.labels.push(label);
  };

  for (const b of blockouts) {
    for (let d = b.starts_on; d <= b.ends_on; d = addDays(d, 1)) {
      const row = ensure(d);
      row.fullDay = true;
      if (row.fullDayReason == null) row.fullDayReason = b.reason;
    }
  }
  for (const tb of timedBlocks) {
    const date = localDateString(new Date(tb.starts_at), tz);
    addLabel(ensure(date), TIMED_BLOCK_LABEL[tb.category] ?? "Unavailable", tb.practitioner_id);
  }
  for (const occ of recurringOccurrences) {
    const date = localDateString(new Date(occ.starts_at), tz);
    if (isClosedDate(date)) continue;
    addLabel(ensure(date), displayRecurringBreakLabel(occ.rule?.label), occ.practitioner_id);
  }
  return byDate;
}
