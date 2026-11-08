import Link from "next/link";
import { SectionLabel } from "@/components/ui/section-label";
import { formatTimeForStudio, localLongDate, type TimeFormat } from "@/lib/booking/tz";
import type { LastVisit, NextAppointment } from "@/lib/clients/profile-visits";

// Three DISTINCT values at the top of the Overview, none replacing another:
//   * Last visit: the later of the newest non-void past session and the newest completed past
//     appointment (lib/clients/profile-visits);
//   * Last charted treatment: the newest charted treatment, the one the detailed card below
//     recaps (it can be older than the last visit, e.g. an appointment that was never charted);
//   * Next appointment: the nearest confirmed appointment still ahead.
// Dates are STUDIO time, never the viewer's browser clock. A value that does not exist reads
// "No visit recorded in Hone" / "Not recorded" / "None booked", never a blank. When the charted-treatment
// read FAILED the value reads "Unavailable", never "Not recorded" (that would be a clinical absence nobody read). Display only: opening this writes nothing.

type Props = {
  clientId: string;
  lastVisit: LastVisit | null;
  lastChartedAt: string | null;
  lastChartedSessionId: string | null;
  /** The read behind Last charted treatment FAILED. That is not "Not recorded": nobody read an absence. */
  lastChartedUnavailable?: boolean;
  next: NextAppointment | null;
  timezone: string;
  timeFormat: TimeFormat;
};

function when(iso: string, tz: string, format: TimeFormat): string {
  const d = new Date(iso);
  return `${localLongDate(d, tz)}, ${formatTimeForStudio(d, tz, format)}`;
}

const VALUE = "mt-0.5 text-sm font-medium text-neutral-900 dark:text-neutral-100";
const EMPTY = "mt-0.5 text-sm text-neutral-500";

export function VisitSummary({
  clientId,
  lastVisit,
  lastChartedAt,
  lastChartedSessionId,
  lastChartedUnavailable = false,
  next,
  timezone,
  timeFormat,
}: Props) {
  const lastVisitHref = lastVisit
    ? lastVisit.kind === "session"
      ? `/clients/${clientId}/sessions/${lastVisit.id}`
      : `/calendar/${lastVisit.id}`
    : null;
  return (
    <section
      aria-label="Visits"
      className="grid gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800 sm:grid-cols-3"
    >
      <div data-testid="profile-last-visit">
        <SectionLabel as="h2" size="caption">
          Last visit
        </SectionLabel>
        {lastVisit && lastVisitHref ? (
          <Link href={lastVisitHref} className={`${VALUE} block underline-offset-2 hover:underline`}>
            {when(lastVisit.at, timezone, timeFormat)}
          </Link>
        ) : (
          <p className={EMPTY}>No visit recorded in Hone</p>
        )}
      </div>
      <div data-testid="profile-last-charted-treatment">
        <SectionLabel as="h2" size="caption">
          Last charted treatment
        </SectionLabel>
        {lastChartedAt && lastChartedSessionId ? (
          <Link
            href={`/clients/${clientId}/sessions/${lastChartedSessionId}`}
            className={`${VALUE} block underline-offset-2 hover:underline`}
          >
            {when(lastChartedAt, timezone, timeFormat)}
          </Link>
        ) : lastChartedUnavailable ? (
          <p className={EMPTY} data-testid="profile-last-charted-unavailable">
            Unavailable
          </p>
        ) : (
          <p className={EMPTY}>Not recorded</p>
        )}
      </div>
      <div data-testid="profile-next-appointment">
        <SectionLabel as="h2" size="caption">
          Next appointment
        </SectionLabel>
        {next ? (
          <Link href={`/calendar/${next.id}`} className={`${VALUE} block underline-offset-2 hover:underline`}>
            {when(next.at, timezone, timeFormat)}
          </Link>
        ) : (
          <p className={EMPTY}>None booked</p>
        )}
      </div>
    </section>
  );
}
