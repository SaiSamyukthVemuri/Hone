import type { ReactNode } from "react";
import type { TreatmentPlanWithCount } from "@/lib/treatment-plans/queries";
import {
  formatTimelineMonths,
  resolveTreatmentAreas,
} from "@/lib/treatment-plans/display";

// Compact treatment-plan card shown directly under the session title.
// Green for active plans (positive, ongoing context, not an alert),
// neutral for closed plans (historical context without urgency).
//
// Lead with the area chip(s) and (when set) the months-timeline
// estimate, matching the reframed treatment-plan model: timeline +
// areas first, the legacy "X of Y estimated visits" line second. Plans
// created before the multi-area + timeline reframing still render
// correctly: the area chip falls back to the legacy primary_area, and
// the legacy visits line still appears so historical context is not
// lost.
export function TreatmentPlanBanner({
  plan,
  detachSlot,
}: {
  plan: TreatmentPlanWithCount;
  // PR #199 (Chloe iPad retest): the plan card owns ALL plan context
  // and actions, so the session page passes its Detach affordance in
  // here instead of floating it below the card.
  detachSlot?: ReactNode;
}) {
  const isClosed = plan.status === "closed";
  const wrapper = isClosed
    ? "rounded-lg border-l-4 border-neutral-400 bg-neutral-100 px-4 py-3 dark:border-neutral-600 dark:bg-neutral-900"
    : "rounded-lg border-l-4 border-emerald-400 bg-emerald-50 px-4 py-3 dark:border-emerald-500 dark:bg-emerald-950/30";
  const eyebrow = isClosed
    ? "text-[11px] font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-400"
    : "text-[11px] font-semibold uppercase tracking-wider text-emerald-900 dark:text-emerald-200";
  const heading = isClosed
    ? "text-sm font-medium text-neutral-800 dark:text-neutral-100"
    : "text-sm font-medium text-emerald-950 dark:text-emerald-100";
  const sub = isClosed
    ? "text-xs text-neutral-500 dark:text-neutral-400"
    : "text-xs text-emerald-800/80 dark:text-emerald-200/70";
  const chipClass = isClosed
    ? "inline-flex rounded-full border border-neutral-300 bg-neutral-50 px-2 py-0.5 text-[11px] font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
    : "inline-flex rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200";

  // Show the first two area chips inline; collapse the rest into a
  // "+N more" pill so the banner stays one-line on common cases.
  const allAreas = resolveTreatmentAreas(plan);
  const visibleAreas = allAreas.slice(0, 2);
  const extraAreaCount = Math.max(allAreas.length - visibleAreas.length, 0);
  const timelineLabel = formatTimelineMonths(
    plan.estimated_timeline_months_min,
    plan.estimated_timeline_months_max,
  );

  // Heading: area chip(s) when present, otherwise the plan name. The
  // plan name itself sits in the sub-line so the structured area
  // remains the visual lead.
  const headingHasAreas = visibleAreas.length > 0;

  return (
    <section className={wrapper}>
      <p className={eyebrow}>Treatment plan{isClosed ? " · Closed" : ""}</p>
      {headingHasAreas ? (
        <div className={`mt-0.5 flex flex-wrap items-baseline gap-1.5 ${heading}`}>
          {visibleAreas.map((area) => (
            <span key={area} className={chipClass}>
              {area}
            </span>
          ))}
          {extraAreaCount > 0 && (
            <span className={chipClass}>+{extraAreaCount} more</span>
          )}
          <span className="ml-1 truncate text-[12px] font-normal opacity-80">
            {plan.name}
          </span>
        </div>
      ) : (
        <p className={`mt-0.5 ${heading}`}>{plan.name}</p>
      )}
      {timelineLabel && (
        <p className={`mt-0.5 ${sub}`}>{timelineLabel}</p>
      )}
      {/* Legacy visit-count line. Kept so banners on plans created
          before the reframing still surface their historical target,
          and so any plan without a timeline still reads as anchored to
          something. Demoted to the muted sub-line below the timeline
          when timeline is set. */}
      <p className={`mt-0.5 tabular-nums ${sub}`}>
        {plan.attached_count} of {plan.suggested_visit_count} estimated visits
      </p>
      {detachSlot && <div className="mt-2">{detachSlot}</div>}
    </section>
  );
}
