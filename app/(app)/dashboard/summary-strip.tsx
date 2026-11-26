// The day's summary strip, under the date navigation. Two values, each with ONE definition:
//   * Appointments: the day's visible appointments (cancelled ones are already excluded), the same
//     number the roster below lists.
//   * Booked time: booked appointment minutes inside the studio day (lib/calendar/time-insights, the
//     calendar sidebar's definition: cancelled and voided never count, buffers are not booked time).
// The "Clients to review" cell is gone (Sam, 4 Nov): Needs attention shows ONE count, in its own heading.
// Display only: no write, no new read.

// Each group can wrap independently when a translated label or unavailable value is long.
const CELL = "flex min-w-0 flex-wrap items-baseline gap-x-2";
const LABEL = "min-w-0 text-xs text-neutral-600 [overflow-wrap:anywhere] dark:text-neutral-400";
const VALUE = "min-w-0 text-base font-semibold tabular-nums [overflow-wrap:anywhere]";

export function SummaryStrip({
  appointmentCount,
  clientCount,
  bookedTime,
}: {
  appointmentCount: number;
  /** Distinct clients across those appointments: the Appointments cell's sub-label. */
  clientCount: number;
  bookedTime: string;
}) {
  return (
    <dl aria-label="Day summary" data-testid="dashboard-summary-strip" className="flex flex-wrap gap-x-6 gap-y-1 border-y border-neutral-200 bg-neutral-50 px-4 py-2 dark:border-neutral-800 dark:bg-neutral-900">
      <div className={CELL}>
        <dt className={LABEL}>Appointments</dt>
        <dd className={VALUE} data-testid="summary-appointments-value">
          {appointmentCount}
        </dd>
        {appointmentCount > 0 && (
          <dd className="text-xs text-neutral-500" data-testid="summary-clients-sublabel">
            {clientCount} {clientCount === 1 ? "client" : "clients"}
          </dd>
        )}
      </div>
      <div className={CELL}>
        <dt className={LABEL}>Booked time</dt>
        <dd className={VALUE} data-testid="summary-booked-time-value">
          {bookedTime}
        </dd>
      </div>
    </dl>
  );
}
