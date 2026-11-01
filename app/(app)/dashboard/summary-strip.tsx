import type { ReactNode } from "react";

// The day's summary strip, under the date navigation. Three values, each with ONE definition:
//   * Appointments: the day's visible appointments (cancelled ones are already excluded), the same
//     number the roster below lists.
//   * Booked time: booked appointment minutes inside the studio day (lib/calendar/time-insights, the
//     calendar sidebar's definition: cancelled and voided never count, buffers are not booked time).
//   * Clients to review: the number of client cards in Needs attention, from the SAME model as that
//     panel. Not a per-practitioner count: the panel is studio-wide today.
// Display only: no write, no new read.

const CELL = "min-w-0 rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800";
const LABEL = "text-[11px] font-medium uppercase tracking-wider text-neutral-500";
const VALUE = "mt-1 text-xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100";

export function SummaryStrip({
  appointmentCount,
  bookedTime,
  clientsToReview,
}: {
  appointmentCount: number;
  bookedTime: string;
  /** Rendered by the caller inside its own Suspense: it reads the Needs attention model. */
  clientsToReview: ReactNode;
}) {
  return (
    <dl aria-label="Day summary" data-testid="dashboard-summary-strip" className="grid grid-cols-3 gap-3">
      <div className={CELL}>
        <dt className={LABEL}>Appointments</dt>
        <dd className={VALUE} data-testid="summary-appointments-value">
          {appointmentCount}
        </dd>
      </div>
      <div className={CELL}>
        <dt className={LABEL}>Booked time</dt>
        <dd className={VALUE} data-testid="summary-booked-time-value">
          {bookedTime}
        </dd>
      </div>
      <div className={CELL}>
        <dt className={LABEL}>Clients to review</dt>
        <dd className={VALUE}>{clientsToReview}</dd>
      </div>
    </dl>
  );
}
