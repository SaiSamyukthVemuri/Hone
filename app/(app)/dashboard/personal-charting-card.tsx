import type { ChartedWithin24hMetrics } from "@/lib/dashboard/practice-metrics";

// The signed-in practitioner's own charting timeliness. Server component: it
// renders for that person only (the page reads for them alone) and never shows
// a name, a comparison or a rank.
export function PersonalChartingCard({
  metrics,
}: {
  // `null` = the read failed. Stated, never shown as 0/0.
  metrics: ChartedWithin24hMetrics | null;
}) {
  return (
    <section aria-label="Your charting" data-testid="personal-charting" className="flex flex-col gap-1 rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
      <h2 className="text-sm font-medium">Your charting</h2>
      {metrics === null ? (
        <p role="status" className="text-sm text-neutral-600 dark:text-neutral-400">
          Could not load your charting figure just now.
        </p>
      ) : metrics.completedCount === 0 ? (
        <p className="text-sm text-neutral-500">No completed sessions of yours in the last 7 days.</p>
      ) : (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <span className="text-lg font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
            {metrics.chartedWithin24hCount}/{metrics.completedCount}
          </span>{" "}
          of your completed sessions were charted within 24 hours (last 7 days).
        </p>
      )}
    </section>
  );
}
