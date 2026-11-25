import { PendingLink } from "@/components/pending-link";
import { SettingsDirectory } from "@/components/settings/settings-directory";
import { getNewClientAdmissionMode } from "@/lib/booking/new-client-admission";
import { isOpenDay } from "@/lib/booking/new-client-readiness";
import { getStudioWideDefaultsSafe } from "@/lib/booking/studio-wide-availability";
import { formatClockLabel, resolveTimeFormat } from "@/lib/booking/tz";
import { getSettingsNavigation } from "@/lib/settings/nav-registry";
import { buildSettingsOverview } from "@/lib/settings/overview";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import type { Studio } from "@/lib/types/database";

const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const admissionLabels = {
  closed: "Not accepting new clients",
  waitlist: "Taking waitlist requests",
  open: "Accepting new bookings",
};

async function BookingSummary({ studio }: { studio: Studio }) {
  const [admission, defaults] = await Promise.all([
    getNewClientAdmissionMode(studio),
    createClient().then((client) => getStudioWideDefaultsSafe(client, studio.id)).catch(() => null),
  ]);
  const format = resolveTimeFormat(studio);
  const openDays = dayNames.flatMap((day, index) => {
    const row = defaults?.find((record) => record.day_of_week === index);
    if (!row || !isOpenDay(row)) return [];
    return [{ day, hours: `${formatClockLabel(row.open_time!.slice(0, 5), format)} – ${formatClockLabel(row.close_time!.slice(0, 5), format)}` }];
  });
  const hoursLabel = !defaults ? "Weekly hours unavailable"
    : !openDays.length ? "Closed all week"
    : openDays.length === 7 ? "Open every day"
    : openDays.map(({ day }) => day.slice(0, 3)).join(", ");
  const sameHours = openDays.length > 0 && openDays.every(({ hours }) => hours === openDays[0].hours);
  const editLink = "inline-flex min-h-11 items-center self-start text-sm font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2";

  return (
    <section aria-label="Current booking settings" className="grid divide-y divide-line rounded-xl border border-line bg-surface-sunken px-5 sm:grid-cols-2 sm:divide-x sm:divide-y-0 sm:px-0">
      <div className="py-3 sm:px-6 sm:py-4">
        <h2 className="text-sm text-neutral-600">New clients</h2>
        <p className="mt-1 text-lg font-semibold tracking-tight text-fg">
          {admission.ok ? admissionLabels[admission.mode] : "Admission status unavailable"}
        </p>
        <PendingLink href="/settings/booking/link#admission-options" className={editLink}>Edit new-client admission</PendingLink>
      </div>
      <div className="py-3 sm:px-6 sm:py-4">
        <h2 className="text-sm text-neutral-600">Studio weekly hours</h2>
        {(sameHours || !openDays.length) && <p className="mt-1 text-lg font-semibold tracking-tight text-fg">
          {hoursLabel}{sameHours && <span className="font-normal"> · {openDays[0].hours}</span>}
        </p>}
        {!sameHours && openDays.length > 0 && (
          <ul aria-label="Hours by day" className="mt-1 flex flex-wrap gap-x-3 text-sm font-medium text-fg">
            {openDays.map(({ day, hours }) => <li key={day}>{day.slice(0, 3)} · {hours}</li>)}
          </ul>
        )}
        <PendingLink href="/settings/availability#weekly-hours" className={editLink}>Edit weekly hours</PendingLink>
      </div>
    </section>
  );
}

export default async function SettingsIndexPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  const role = practitioner.role === "owner" ? "owner" : "practitioner";
  const { items } = await getSettingsNavigation(role, studio);
  const sections = buildSettingsOverview(items, {
    isOwner: role === "owner",
    googleCalendarEnabled: studio.google_calendar_connection_enabled === true,
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 data-settings-heading tabIndex={-1} className="text-3xl font-semibold tracking-tight text-fg outline-none sm:text-4xl">Settings</h1>
        <p className="mt-1 text-sm text-neutral-600">{studio.name}</p>
      </header>
      <SettingsDirectory sections={sections}>
        {role === "owner" && <BookingSummary studio={studio} />}
      </SettingsDirectory>
    </div>
  );
}
