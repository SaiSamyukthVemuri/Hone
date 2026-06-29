// PR #280 (Chloe record-keeping feedback): read-time due/overdue status for a
// disinfectant batch's "discard / replace by" date. Pure + deterministic (the
// caller passes "today" as a studio-timezone YYYY-MM-DD string), so it is fully
// unit-testable and naturally idempotent — it is a computed display, never a
// stored or sent reminder. NO cron / notification / email here (deferred).

export type DisinfectantDueStatus =
  | "replaced" // an actual date_discarded exists — no alert, the batch is done
  | "overdue" // discard_due_date is before today and not yet discarded
  | "due_today" // discard_due_date is today
  | "due_soon" // discard_due_date is within DUE_SOON_DAYS
  | "scheduled" // a future discard_due_date beyond the due-soon window
  | "none"; // no discard_due_date recorded

export const DUE_SOON_DAYS = 7;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function ymdToUtc(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

// Whole days from `a` to `b` (positive when b is after a). Both YYYY-MM-DD.
export function daysBetween(a: string, b: string): number {
  return Math.round((ymdToUtc(b) - ymdToUtc(a)) / 86_400_000);
}

export function disinfectantDueStatus(
  record: { date_discarded: string | null; discard_due_date: string | null },
  todayYmd: string,
  dueSoonDays: number = DUE_SOON_DAYS,
): DisinfectantDueStatus {
  // An actually-discarded batch is finished — never alert on it, even if a due
  // date had been set.
  if (record.date_discarded) return "replaced";
  // Defensive: a Postgres `date` serializes as bare YYYY-MM-DD, but slice in
  // case a value ever arrives with a time component (matches how the rest of
  // the record-keeping UI handles dates).
  const due = record.discard_due_date?.slice(0, 10);
  const today = todayYmd.slice(0, 10);
  if (!due || !YMD.test(due) || !YMD.test(today)) return "none";
  // YYYY-MM-DD compares correctly as strings for equality/ordering.
  if (due < today) return "overdue";
  if (due === today) return "due_today";
  return daysBetween(today, due) <= dueSoonDays ? "due_soon" : "scheduled";
}

// True when the status warrants a visible due/overdue alert badge.
export function isDisinfectantAlert(status: DisinfectantDueStatus): boolean {
  return status === "overdue" || status === "due_today" || status === "due_soon";
}

export function disinfectantStatusLabel(status: DisinfectantDueStatus): string {
  switch (status) {
    case "overdue":
      return "Overdue — replace now";
    case "due_today":
      return "Due today";
    case "due_soon":
      return "Due soon";
    default:
      return "";
  }
}
