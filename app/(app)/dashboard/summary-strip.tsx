import type { ReactNode } from "react";

// The day's summary strip, under the date navigation. Three values, each with ONE definition:
//   * Appointments: the day's visible appointments (cancelled ones are already excluded), the same
//     number the roster below lists.
//   * Booked time: booked appointment minutes inside the studio day (lib/calendar/time-insights, the
//     calendar sidebar's definition: cancelled and voided never count, buffers are not booked time).
//   * Clients to review: the number of client cards in Needs attention, from the SAME model as that
//     panel. Not a per-practitioner count: the panel is studio-wide today.
// Display only: no write, no new read.

// Narrow phones (under 360px, e.g. 320): three cells share the row, so the padding and the value size
// step down and a long value such as "Unavailable" may break rather than push the card and the
// viewport wider. From 360px up the cells are exactly as before.
const CELL =
  "min-w-0 rounded-lg border border-neutral-200 px-2 py-3 min-[360px]:px-4 dark:border-neutral-800";
// The uppercase LABEL can be wider than its cell at 320 ("APPOINTMENTS" at 11px with wide tracking ran into the next card), so it may
// wrap or break and steps down in size and tracking under 360px; from 360px up it is exactly as before.
const LABEL =
  "min-w-0 text-[11px] font-medium uppercase tracking-wider text-neutral-500 [overflow-wrap:anywhere] max-[359px]:text-[10px] max-[359px]:tracking-normal";
const VALUE =
  "mt-1 min-w-0 text-xl font-semibold tracking-tight text-neutral-900 [overflow-wrap:anywhere] max-[359px]:text-sm dark:text-neutral-100";

export function SummaryStrip({
  appointmentCount,
  clientCount,
  bookedTime,
  clientsToReview,
}: {
  appointmentCount: number;
  /** Distinct clients across those appointments: the Appointments cell's sub-label. */
  clientCount: number;
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
        {appointmentCount > 0 && (
          <p className="mt-0.5 text-xs text-neutral-500" data-testid="summary-clients-sublabel">
            {clientCount} {clientCount === 1 ? "client" : "clients"}
          </p>
        )}
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
