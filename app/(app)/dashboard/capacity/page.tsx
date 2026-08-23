import Link from "next/link";

import { SectionLabel } from "@/components/ui/section-label";
import { StatusPill } from "@/components/ui/status-pill";
import {
  formatLocalDateLabel,
  formatTimeForStudio,
  localDateString,
  resolveTimeFormat,
  type TimeFormat,
} from "@/lib/booking/tz";
import {
  getOwnerCapacityBriefing,
  type NextOpening,
  type OwnerCapacityBriefing,
} from "@/lib/dashboard/owner-capacity";
import type { Fact } from "@/lib/dashboard/owner-capacity-model";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

// ===========================================================================
// PRACTICE CAPACITY — the owner's operational briefing
// ===========================================================================
//
// Owner-only. The role check runs BEFORE any capacity read is issued, so an
// ordinary practitioner never causes a studio-wide analytics query, let alone
// receives one — the refusal is the same panel /settings/studio and
// /settings/consent render. Studio scope is server-resolved from the
// practitioner row; nothing here reads a browser-supplied id, and every
// underlying table is RLS-scoped to studio membership, so a cross-studio read
// is not expressible.
//
// READ-ONLY. No form, no action, no mutation.

export const metadata = { title: "Practice capacity" };

export default async function PracticeCapacityPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg-muted">
        Only studio owners can see practice capacity.
      </section>
    );
  }

  const briefing = await getOwnerCapacityBriefing(studio);
  return (
    <CapacityBriefing briefing={briefing} timeFormat={resolveTimeFormat(studio)} />
  );
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const UNKNOWN_LABEL = "Not enough evidence yet";

/** A number the studio can act on, or the one sentence saying why there isn't one. */
function Figure({
  fact,
  format = (n: number) => n.toLocaleString(),
  suffix,
}: {
  fact: Fact<number>;
  format?: (value: number) => string;
  suffix?: string;
}) {
  if (!fact.known) return <NotKnown reason={fact.reason} />;
  return (
    <p className="text-3xl font-semibold tabular-nums">
      {format(fact.value)}
      {suffix ? <span className="ml-1 text-base font-normal text-fg-muted">{suffix}</span> : null}
    </p>
  );
}

function Card({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex flex-col rounded-lg border border-line p-4 ${className ?? ""}`}>
      <SectionLabel size="caption" as="h3">
        {label}
      </SectionLabel>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/**
 * Minutes as a practitioner reads a working day: "8h", "6h 45m", "45m".
 * The data layer carries exact minutes precisely so this stays a display
 * choice — an hours figure rounded upstream reported 14h45m as 14.8.
 */
function formatHours(minutes: number): string {
  const rounded = Math.round(minutes);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs leading-snug text-fg-muted">{children}</p>;
}

/**
 * One unknown, stated once, for a whole group of figures that share a reason.
 * Repeating the same sentence under six cards is noise, not honesty.
 */
function UnknownPanel({ reason }: { reason: string }) {
  return (
    <div className="rounded-lg border border-line p-4">
      <p className="text-lg font-medium text-fg-muted">{UNKNOWN_LABEL}</p>
      <Note>{reason}</Note>
    </div>
  );
}

/** The unknown half of <Figure>, for facts that carry something other than a number. */
function NotKnown({ reason }: { reason: string }) {
  return (
    <>
      <p className="text-lg font-medium text-fg-muted">{UNKNOWN_LABEL}</p>
      <p className="mt-1 text-xs leading-snug text-fg-muted">{reason}</p>
    </>
  );
}

function openingLabel(opening: NextOpening, timezone: string, timeFormat: TimeFormat) {
  if (!opening.startsAt) return null;
  const at = new Date(opening.startsAt);
  const dateLabel = formatLocalDateLabel(localDateString(at, timezone));
  return `${dateLabel}, ${formatTimeForStudio(at, timezone, timeFormat)}`;
}

function CapacityBriefing({
  briefing,
  timeFormat,
}: {
  briefing: OwnerCapacityBriefing;
  timeFormat: TimeFormat;
}) {
  const { clients, newDemand, access, weeks, depth, futureTreatmentMinutes, admission } =
    briefing;
  const generated = new Date(briefing.generatedAt);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <Link href="/dashboard" className="text-sm text-fg-muted underline underline-offset-2">
          Back to Dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Practice capacity</h1>
        <p className="text-sm text-fg-muted">
          Current studio truth as of {formatTimeForStudio(generated, briefing.timezone, timeFormat)}{" "}
          on {formatLocalDateLabel(briefing.todayLocal)}. Looking {briefing.horizonWeeks} weeks
          ahead.
        </p>
      </header>

      {/* --- Admission first: it is the question the owner came to ask. ----- */}
      <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface-sunken p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionLabel as="h2">Admission capacity</SectionLabel>
          <StatusPill
            tone={
              admission.kind === "can_take_more"
                ? "success"
                : admission.kind === "hold"
                  ? "warning"
                  : "neutral"
            }
          >
            {admission.kind === "can_take_more"
              ? "Room to take more"
              : admission.kind === "hold"
                ? "Hold"
                : "Unknown"}
          </StatusPill>
        </div>

        {admission.kind === "can_take_more" ? (
          <p className="text-3xl font-semibold tabular-nums">
            {admission.count}
            <span className="ml-2 text-base font-normal text-fg-muted">
              new {admission.count === 1 ? "client" : "clients"} this week
            </span>
          </p>
        ) : (
          <p className="text-2xl font-medium text-fg-muted">
            {admission.kind === "hold" ? "Hold new clients" : UNKNOWN_LABEL}
          </p>
        )}

        {admission.kind === "hold" ? <p className="text-sm">{admission.reason}</p> : null}

        {admission.kind === "unknown" ? (
          <>
            <div>
              <SectionLabel size="caption" as="h3">
                What is still missing
              </SectionLabel>
              <ul className="mt-1.5 flex flex-col gap-1.5 text-sm text-fg-muted">
                {admission.missing.map((reason) => (
                  <li key={reason} className="flex gap-2">
                    <span aria-hidden="true">•</span>
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-sm">
              What is known is below. Review intake by hand until the studio records the
              missing facts.
            </p>
          </>
        ) : null}
      </section>

      {/* --- Clients ------------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">Clients</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-3">
          <Card label="Client records">
            <Figure fact={clients.totalRecords} />
            <Note>Everyone on file who is not archived. Not a measure of who is in treatment.</Note>
          </Card>
          <Card label="Active treatment clients">
            <Figure fact={clients.activeTreatment} />
            {clients.activeTreatment.known ? <Note>{clients.activeTreatmentBasis}</Note> : null}
          </Card>
          <Card label="No future treatment booked">
            <Figure fact={clients.activeTreatmentWithoutFutureBooking} />
            {clients.activeTreatmentWithoutFutureBooking.known ? (
              <Note>
                Active treatment clients with nothing on the calendar. They will need time that
                is not yet booked; how much and when is not recorded.
              </Note>
            ) : null}
          </Card>
        </div>
      </section>

      {/* --- New-client demand --------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">New-client demand</SectionLabel>
        {newDemand.consultationsByDays.known ? null : (
          <UnknownPanel reason={newDemand.consultationsByDays.reason} />
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {newDemand.consultationsByDays.known
            ? newDemand.horizonDays.map((days) => (
                <Card key={days} label={`New consultations · next ${days} days`}>
                  <Figure
                    fact={{
                      known: true,
                      value: newDemand.consultationsByDays.known
                        ? (newDemand.consultationsByDays.value[days] ?? 0)
                        : 0,
                    }}
                  />
                </Card>
              ))
            : null}
          <Card label={`${newDemand.maturityDays}-day conversion`}>
            {newDemand.conversion.known ? (
              <>
                <p className="text-3xl font-semibold tabular-nums">
                  {newDemand.conversion.value.percent === null
                    ? "—"
                    : `${newDemand.conversion.value.percent}%`}
                </p>
                <p className="mt-1 text-sm tabular-nums text-fg-muted">
                  {newDemand.conversion.value.converted} of{" "}
                  {newDemand.conversion.value.matured} matured
                </p>
              </>
            ) : (
              <NotKnown reason={newDemand.conversion.reason} />
            )}
            <Note>
              First-ever consultations that finished at least {newDemand.maturityDays} days ago,
              within the last {newDemand.lookbackDays} days, and whether a treatment followed
              inside {newDemand.maturityDays} days. A consultation too recent to have had that
              chance is on neither side of the ratio.
            </Note>
          </Card>
        </div>
        <p className="text-xs text-fg-muted">
          Counts a client&rsquo;s FIRST-EVER booking only. A returning client booking another
          consultation is not new-client demand.
        </p>
      </section>

      {/* --- Treatment access ---------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">Treatment access</SectionLabel>
        {access.known ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {access.value.map((opening) => (
              <Card key={opening.durationMinutes} label={`Next ${opening.durationMinutes}-min opening`}>
                {opening.startsAt ? (
                  <>
                    <p className="text-2xl font-semibold tabular-nums">
                      {opening.daysAway === null
                        ? "—"
                        : opening.daysAway < 1
                          ? "Today"
                          : `${opening.daysAway} days`}
                    </p>
                    <p className="mt-1 text-sm text-fg-muted">
                      {openingLabel(opening, briefing.timezone, timeFormat)}
                    </p>
                  </>
                ) : (
                  <p className="text-lg font-medium text-fg-muted">
                    None in the next {briefing.horizonWeeks} weeks
                  </p>
                )}
              </Card>
            ))}
          </div>
        ) : (
          <UnknownPanel reason={access.reason} />
        )}
        <p className="text-xs text-fg-muted">
          The first start the booking page itself would offer: real working hours, blocks,
          breaks, existing appointments and the studio buffer, in studio time.
        </p>
      </section>

      {/* --- Capacity by week ---------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">Capacity by week</SectionLabel>
        {weeks.known ? (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-fg-muted">
                  <th className="px-3 py-2 font-medium">Week</th>
                  <th className="px-3 py-2 text-right font-medium">Net bookable</th>
                  <th className="px-3 py-2 text-right font-medium">Booked</th>
                  <th className="px-3 py-2 text-right font-medium">Free</th>
                  <th className="px-3 py-2 text-right font-medium">Booked %</th>
                  <th className="px-3 py-2 text-right font-medium">60-min openings</th>
                </tr>
              </thead>
              <tbody>
                {weeks.value.map((week) => (
                  <tr key={week.startLocal} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2 whitespace-nowrap">
                      {formatLocalDateLabel(week.startLocal)}
                      {week.isCurrentWeek ? (
                        <span className="ml-2 text-xs text-fg-muted">rest of this week</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatHours(week.netBookableMinutes)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatHours(week.bookedMinutes)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatHours(week.freeMinutes)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {week.bookedPercent === null ? "—" : `${week.bookedPercent}%`}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{week.usableOpenings}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <UnknownPanel reason={weeks.reason} />
        )}
        <p className="text-xs text-fg-muted">
          Net bookable is open hours minus blocks, breaks and closures. Booked includes each
          appointment&rsquo;s protected buffer. The last column is whole 60-minute treatments that
          still fit — free hours scattered in short gaps are not appointments.
        </p>
      </section>

      {/* --- Booking depth -------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <SectionLabel as="h2">Recurring demand visibility</SectionLabel>
        {depth.known ? null : <UnknownPanel reason={depth.reason} />}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {depth.known
            ? (
                [
                  ["0 future treatments", "zero"],
                  ["1 or more", "oneOrMore"],
                  ["2 or more", "twoOrMore"],
                  ["3 or more", "threeOrMore"],
                ] as const
              ).map(([label, key]) => (
                <Card key={key} label={label}>
                  <Figure fact={{ known: true, value: depth.value[key] }} />
                </Card>
              ))
            : null}
          <Card label="Future treatment time booked">
            <Figure fact={futureTreatmentMinutes} format={formatHours} />
          </Card>
        </div>
        <p className="text-xs text-fg-muted">
          Booking depth across the active treatment clients. Clients with nothing booked are a
          demand signal, not projected hours: Hone does not record when they will return.
        </p>
      </section>
    </div>
  );
}
