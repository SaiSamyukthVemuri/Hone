import type { LastSessionSummary } from "@/lib/sessions/clinical-summary";

// PR #191 (Chloe smoke feedback). Shared render for the last-session
// clinical memory, used by the appointment detail card and the
// new-session "Previous session context" panel.
//
//   * AreaSummaries: one compact mini-summary PER treatment area
//     (name, settings, probe, tolerance, response). Never collapses
//     multiple areas into a "first area" line.
//   * FromLastVisitForToday: ONE combined box carrying the per-area
//     watch lines (cautions) AND the plan (next-session note). Chloe
//     found the previous two competing boxes (amber "Watch today" +
//     blue "From last visit") redundant; this is the single
//     replacement, rendered only when there is something to say.
//
// Practitioner-facing language: "treatment area", never "block".

export function AreaSummaries({
  summary,
}: {
  summary: LastSessionSummary;
}) {
  if (summary.areas.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2.5">
      {summary.areas.map((area) => {
        const lines: Array<{ label: string; value: string }> = [];
        if (area.settingsLine) lines.push({ label: "Settings", value: area.settingsLine });
        if (area.probeLine) lines.push({ label: "Probe", value: area.probeLine });
        if (area.toleranceLine) lines.push({ label: "Tolerance", value: area.toleranceLine });
        if (area.reactionLine) lines.push({ label: "Response", value: area.reactionLine });
        return (
          <li key={area.name} className="text-sm">
            <p className="font-medium text-neutral-900 dark:text-neutral-100">
              {area.name}
            </p>
            {lines.length > 0 && (
              <dl className="mt-0.5 flex flex-col gap-0.5 text-neutral-700 dark:text-neutral-300">
                {lines.map((line) => (
                  <div key={line.label} className="flex gap-2">
                    <dt className="w-20 shrink-0 text-neutral-500">
                      {line.label}
                    </dt>
                    <dd>{line.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// PR #200: shared emptiness check so a host card can decide whether
// to reserve footer space for the box (the component itself still
// returns null when there is nothing to say).
export function hasFromLastVisitContent(summary: LastSessionSummary): boolean {
  return summary.watchLines.length > 0 || !!summary.nextSessionNote;
}

export function FromLastVisitForToday({
  summary,
  attached = false,
}: {
  summary: LastSessionSummary;
  // PR #200 (Chloe iPad retest): when true, render as a flush footer
  // band of the host card (top border only, square top corners) so
  // the Watch/Plan context reads as PART of the Last treatment card
  // instead of a floating island. Default keeps the standalone
  // bordered box used by the charting and appointment surfaces.
  attached?: boolean;
}) {
  if (!hasFromLastVisitContent(summary)) {
    return null;
  }
  // PR #204 (Chloe feedback): BLUE, not amber. This band is
  // treatment memory/context for today, not an error or caution
  // alert, so it uses the same blue visual language as the charting
  // page's "From last visit, for today" box. Both variants switch so
  // the memory surface is one color everywhere.
  return (
    <section
      className={
        attached
          ? "rounded-b-lg border-t border-blue-200 bg-blue-50 px-5 py-3 text-sm dark:border-blue-900 dark:bg-blue-950/40"
          : "rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-sm dark:border-blue-900 dark:bg-blue-950/40"
      }
    >
      <h3 className="text-xs font-medium uppercase tracking-wider text-blue-800 dark:text-blue-300">
        From last visit, for today
      </h3>
      <div className="mt-1 flex flex-col gap-1 text-blue-950 dark:text-blue-100">
        {summary.watchLines.map((line) => (
          <p key={line}>
            <span className="font-medium">Watch:</span> {line}
          </p>
        ))}
        {summary.nextSessionNote && (
          <p className="whitespace-pre-wrap">
            <span className="font-medium">Plan:</span> {summary.nextSessionNote}
          </p>
        )}
      </div>
    </section>
  );
}
