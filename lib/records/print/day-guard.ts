// HON-46 M2 — which days the page will audit and read at all.
//
// parseSelectedDay (selected-day.ts) accepts any real date from year 0000 to
// 9999, and migration 0233 accepts any real date, so without this a typed
// 9999-12-31 would write a "previewed" audit row and then fail at the day-bounds
// step. Same 1900-2100 window as the records filter (#1381). A day after the
// studio's today cannot hold treatments and would only create audit rows, so it
// is refused too. Runs BEFORE the audit call (Privacy B-2).

import { localDateString } from "@/lib/booking/tz";

export const MIN_PRINT_YEAR = 1900;
export const MAX_PRINT_YEAR = 2100;

export type PrintableDay = { ok: true } | { ok: false; reason: "out_of_range" | "future" };

/** `day` must already be a real YYYY-MM-DD (parseSelectedDay). */
export function checkPrintableDay(day: string, timezone: string, now: Date = new Date()): PrintableDay {
  const year = Number(day.slice(0, 4));
  if (!Number.isInteger(year) || year < MIN_PRINT_YEAR || year > MAX_PRINT_YEAR) return { ok: false, reason: "out_of_range" };
  let today: string;
  try {
    today = localDateString(now, timezone);
  } catch {
    // An unresolvable timezone cannot say what "today" is: refuse rather than guess.
    return { ok: false, reason: "out_of_range" };
  }
  return day > today ? { ok: false, reason: "future" } : { ok: true };
}
