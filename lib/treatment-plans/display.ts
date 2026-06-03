import type { TreatmentPlan } from "@/lib/types/database";

// Small pure helpers shared by the treatment-plan card on /clients/[id]
// and the treatment-plan banner on the session detail page. No DB
// access; safe to import from any client or server component.

// Resolve the area chips to display for a plan. Prefers the
// migration-0051 multi-area list when non-empty; falls back to the
// legacy single primary_area string so plans created before the
// multi-area reframing still render an area chip.
//
// Returns at most the supplied cap so banner-style surfaces can show
// a tight "first 2 + N more" layout. The card surface passes a
// generous cap and renders all chips.
export function resolveTreatmentAreas(
  plan: Pick<TreatmentPlan, "treatment_areas" | "primary_area">,
  opts: { max?: number } = {},
): string[] {
  const max = opts.max ?? 12;
  if (plan.treatment_areas && plan.treatment_areas.length > 0) {
    return plan.treatment_areas.slice(0, max);
  }
  const legacy = plan.primary_area?.trim();
  if (legacy) return [legacy].slice(0, max);
  return [];
}

// Pretty timeline string for the months estimate. Honours either side
// being null so one-sided estimates ("at least 18 months", "about
// 24 months") render naturally. Returns null when nothing to show.
export function formatTimelineMonths(
  minMonths: number | null,
  maxMonths: number | null,
): string | null {
  if (minMonths == null && maxMonths == null) return null;
  if (minMonths != null && maxMonths != null) {
    if (minMonths === maxMonths) {
      return `About ${minMonths} ${minMonths === 1 ? "month" : "months"}`;
    }
    return `${minMonths} to ${maxMonths} months`;
  }
  if (minMonths != null) {
    return `At least ${minMonths} ${minMonths === 1 ? "month" : "months"}`;
  }
  // maxMonths != null
  return `About ${maxMonths} ${maxMonths === 1 ? "month" : "months"}`;
}
