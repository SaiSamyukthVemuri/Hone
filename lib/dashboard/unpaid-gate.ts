import "server-only";

// Needs attention "unpaid" reminders are OFF until an explicit enabling input exists (OPS, HON-65, 4 Nov). The unpaid check shipped
// in #1356 showed a real appointment as outstanding / "Amount unavailable" while that appointment's own page showed it Paid. Until the
// two agree, the owner wants the unpaid section suppressed; every other #1356 improvement (one count, the other reminder kinds) stays.
//
// The ONLY enabling input is HONE_DASHBOARD_UNPAID_ENABLED === "true". Anything else (unset, empty, "TRUE", "1", "yes", whitespace)
// fails closed. With it OFF: the unpaid loader is never called, so there are no unpaid reminders, no window note, no "Show all
// outstanding" link, no "Could not check unpaid balances" entry, and the heading count excludes unpaid. `?unpaid=all` changes nothing.
// No payment record is read or written differently either way.
//
// Switching it ON (after the fix) is the re-release; switching it OFF again is the rollback.
export function dashboardUnpaidEnabled(): boolean {
  return process.env.HONE_DASHBOARD_UNPAID_ENABLED === "true";
}
