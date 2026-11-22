import { CHARTING_VIEW_STUDIOS_ENV, chartingViewToggleVisible, parseChartingViewGate } from "@/lib/charting/view-preference";

/**
 * WHO MAY SEE OR REGISTER "Dectro xCell" (Sam's rollout decision). Only studios on the charting new-view allowlist
 * (HONE_CHARTING_NEW_VIEW_STUDIO_IDS) are offered the model in Settings > Machines, and the registration action refuses every other
 * studio, so a forged form cannot get around the listing. It reuses the SAME parser and visibility rule as the charting toggle
 * (unset = nobody, "all" = every studio, otherwise a list of studio ids); there is no second parser. This is a rollout gate on a
 * DISPLAY/offer decision, not an authorization decision: the owner check stays in the database command.
 */
export function xcellRegistrationAllowed(studioId: string | null | undefined, rawGate: string | undefined | null = process.env[CHARTING_VIEW_STUDIOS_ENV]): boolean {
  return chartingViewToggleVisible(parseChartingViewGate(rawGate), studioId);
}
