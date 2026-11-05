import "server-only";

// Needs attention "Dismiss" is OFF until an explicit enabling input exists (Sam/OPS, 4 Nov). The three database commands it uses
// (dismiss, restore and list) belong to migration 0298, which is held and not applied
// anywhere. Shipping the app before the migration must neither call a function that does not exist nor print a standing
// "could not read your dismissed reminders" note to every owner.
//
// The ONLY enabling input is HONE_DASHBOARD_DISMISSALS_ENABLED === "true". Anything else (unset, empty, "TRUE", "1", "yes",
// whitespace) fails closed. With it OFF: no Dismiss, no Dismissed view, no note, and none of the three commands is called.
// The one count in the heading and the unpaid reminders do not depend on it.
//
// Order of release: the migration is applied first, THEN this is switched on, then verified. Switching it back OFF is the rollback.
export function dashboardDismissalsEnabled(): boolean {
  return process.env.HONE_DASHBOARD_DISMISSALS_ENABLED === "true";
}
