import { SectionLabel } from "@/components/ui/section-label";
import {
  formatMinutes,
  summarizeTreatmentTime,
  type TreatmentTimeBlock,
} from "@/lib/sessions/treatment-time-summary";

// HON-59 first slice: the session's recorded treatment minutes, summed across
// its treatment areas, with the three things the number is NOT said out loud.
// Server-safe: no state, no directive. Renders nothing for a session with no
// areas yet, so an empty chart is unchanged.
export function SessionTreatmentTime({
  blocks,
}: {
  blocks: ReadonlyArray<TreatmentTimeBlock>;
}) {
  const s = summarizeTreatmentTime(blocks);
  if (s.areaCount === 0) return null;

  const coverage =
    s.areasWithMinutes === s.areaCount
      ? s.areaCount === 1
        ? "1 area"
        : `${s.areaCount} areas`
      : `${s.areasWithMinutes} of ${s.areaCount} areas`;

  return (
    <section
      data-testid="session-treatment-time"
      aria-label="Recorded treatment time"
      className="flex flex-col gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      <SectionLabel as="h3">Recorded treatment time</SectionLabel>
      {s.areasWithMinutes === 0 ? (
        <p className="text-neutral-600 dark:text-neutral-400">
          No minutes recorded on {s.areaCount === 1 ? "this area" : "these areas"} yet.
        </p>
      ) : (
        <p>
          <span className="font-medium tabular-nums">
            {formatMinutes(s.recordedMinutes)}
          </span>
          <span className="text-neutral-600 dark:text-neutral-400">
            {" "}
            across {coverage}
          </span>
        </p>
      )}
      <p className="text-xs text-neutral-500">
        The sum of minutes recorded on each area. It is not the visit&apos;s
        length, is not split by practitioner, and is not a billing total.
      </p>
      {s.overlapRecorded && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          Some areas were recorded at the same time, so this sum can be more
          than the time that passed.
        </p>
      )}
    </section>
  );
}
