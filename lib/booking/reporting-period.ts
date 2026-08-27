import { addDays, startOfWeek } from "./tz";

// ===========================================================================
// THE REPORTING PERIOD CONTRACT
// ===========================================================================
//
// One vocabulary and ONE algorithm for "today / this week / this month" over
// studio-local dates, shared by every surface that reports over a window.
//
// WHY IT LIVES HERE AND NOT BESIDE A CONSUMER. It was previously defined in
// lib/dashboard/practice-metrics.ts, whose executable module also reads
// service prices and payment_charge_attempts. That made every importer of the
// period vocabulary — including the owner Financials surface, whose contract
// forbids a live-price or payment path — depend on a money module to ask what
// "this week" means. Codex raised it on PR #646 as a P2 and it was accepted.
//
// The evidence for that contract is scoped, and worth naming precisely rather
// than implying more: FIN's guard proves the compiler-resolved STATIC ESM
// closure of the financials surface contains no money module. It does not
// prove anything about runtime module acquisition in shared dependencies. This
// module is in that closure, which is why it must stay pure.
//
// So the contract moved DOWN to the pure layer rather than being copied
// sideways. It sits beside ./tz because that is the module owning the studio's
// date arithmetic and the Sunday anchor it delegates to, and it imports
// nothing else. A second copy of this algorithm is exactly the defect the week
// comment below records; there must never be one.
//
// PURE. No I/O, no clock, no timezone lookup, no database. `todayLocal` is
// supplied by the caller, which is what keeps this testable at a fixed date and
// keeps the studio's timezone the caller's business.

/**
 * The reporting window a surface is showing.
 *
 * Renamed from `DashboardPeriod` when it moved: the dashboard is no longer its
 * only consumer, and a type named for one caller reads as a mistake at the
 * others. The three member strings are UNCHANGED — they are URL values
 * (`?period=week`) and a rename of those would be a behaviour change.
 */
export type ReportingPeriod = "today" | "week" | "month";

export function isReportingPeriod(v: string | undefined): v is ReportingPeriod {
  return v === "today" || v === "week" || v === "month";
}

// Pure: resolve the studio-local date range for a period. `todayLocal`
// is the studio-local YYYY-MM-DD. Weeks start SUNDAY; ranges are
// [startLocal, endLocalExclusive).
export function resolvePeriodRange(
  todayLocal: string,
  period: ReportingPeriod,
): { startLocal: string; endLocalExclusive: string; label: string } {
  if (period === "today") {
    return {
      startLocal: todayLocal,
      endLocalExclusive: addDays(todayLocal, 1),
      label: "today",
    };
  }
  if (period === "week") {
    // SUNDAY -> SATURDAY, delegated to the SAME helper the practitioner
    // calendar uses (lib/booking/tz.startOfWeek: "the Sunday on or before").
    //
    // This used to roll its own Monday anchor,
    //   const dow = new Date(`${todayLocal}T12:00:00Z`).getUTCDay();
    //   const sinceMonday = (dow + 6) % 7;
    // which made the dashboard's "this week" and the calendar's week differ
    // by a FULL WEEK every Sunday: Sunday was day 7 of the metrics week and
    // day 1 of the calendar week. Chloe reported this. The two are now one
    // boundary, and deliberately ONE algorithm: a second copy is how they
    // drifted apart in the first place.
    //
    // startOfWeek() takes the same noon-UTC anchoring this code used, so the
    // studio-local date string semantics are unchanged, only the anchor day
    // moves. Ranges stay [startLocal, endLocalExclusive) over local date
    // STRINGS, never "start + 168 hours", so DST is handled by the existing
    // utcInstantFromLocal() conversion exactly as before.
    const startLocal = startOfWeek(todayLocal);
    return {
      startLocal,
      endLocalExclusive: addDays(startLocal, 7),
      label: "this week",
    };
  }
  const startLocal = `${todayLocal.slice(0, 8)}01`;
  const [y, m] = todayLocal.split("-").map((p) => parseInt(p, 10));
  const nextMonth =
    m === 12
      ? `${y + 1}-01-01`
      : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { startLocal, endLocalExclusive: nextMonth, label: "this month" };
}
