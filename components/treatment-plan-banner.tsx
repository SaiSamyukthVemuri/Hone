import type { TreatmentPlanWithCount } from "@/lib/treatment-plans/queries";

// Compact treatment-plan card shown directly under the session title.
// Green for active plans (positive, ongoing context — not an alert),
// neutral for closed plans (historical context without urgency).
// Amber/yellow is reserved for "needs attention"; red for allergies.
// The prominent line is the plan's structured primary_area when set
// ("Chin"), falling back to the plan name; then "N of M estimated visits".
export function TreatmentPlanBanner({
  plan,
}: {
  plan: TreatmentPlanWithCount;
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

  const title = plan.primary_area?.trim() || plan.name;

  return (
    <section className={wrapper}>
      <p className={eyebrow}>Treatment plan{isClosed ? " · Closed" : ""}</p>
      <p className={`mt-0.5 ${heading}`}>{title}</p>
      <p className={`mt-0.5 tabular-nums ${sub}`}>
        {plan.attached_count} of {plan.suggested_visit_count} estimated visits
      </p>
    </section>
  );
}
