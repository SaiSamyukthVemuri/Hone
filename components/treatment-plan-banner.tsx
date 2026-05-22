import type { TreatmentPlanWithCount } from "@/lib/treatment-plans/queries";

// Banner at the top of session detail when a plan is attached. Amber for
// active plans, neutral for closed plans (signals historical context
// without urgency).
export function TreatmentPlanBanner({
  plan,
}: {
  plan: TreatmentPlanWithCount;
}) {
  const isClosed = plan.status === "closed";
  const wrapper = isClosed
    ? "rounded-lg border-l-4 border-neutral-400 bg-neutral-100 px-5 py-4 dark:border-neutral-600 dark:bg-neutral-900"
    : "rounded-lg border-l-4 border-amber-400 bg-amber-50 px-5 py-4 dark:border-amber-500 dark:bg-amber-950/30";
  const eyebrow = isClosed
    ? "text-xs font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-400"
    : "text-xs font-semibold uppercase tracking-wider text-amber-900 dark:text-amber-200";
  const body = isClosed
    ? "text-sm text-neutral-800 dark:text-neutral-200"
    : "text-sm text-amber-950 dark:text-amber-100";

  return (
    <section className={wrapper}>
      <p className={eyebrow}>Treatment plan</p>
      <p className={`mt-1 ${body}`}>
        <span className="font-medium">{plan.name}</span>
        <span className="tabular-nums">
          {" "}
          · {plan.attached_count} of {plan.suggested_visit_count} visits
        </span>
        {isClosed && (
          <span className="ml-2 text-xs uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            Closed
          </span>
        )}
      </p>
    </section>
  );
}
