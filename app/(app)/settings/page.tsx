import { PendingLink } from "@/components/pending-link";
import { SettingsDirectory } from "@/components/settings/settings-directory";
import { SettingsViewHeading } from "@/components/settings/view-heading";
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
  const sectionTitle = "text-sm font-medium text-neutral-600 dark:text-neutral-400";
  const detailLink = "mt-3 inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4";

  return (
    <div className="grid min-w-0 gap-px overflow-hidden rounded-xl border border-neutral-200 bg-neutral-200 md:grid-cols-2 dark:border-neutral-800 dark:bg-neutral-800">
      <section className="min-w-0 bg-neutral-50 p-5 dark:bg-neutral-900">
        <h3 className={sectionTitle}>New-client admission</h3>
        <p className="mt-2 text-xl font-semibold tracking-tight">
          {admission.ok ? admissionLabels[admission.mode] : "Admission status unavailable"}
        </p>
        <PendingLink href="/settings/booking/link" className={detailLink}>Review booking page</PendingLink>
      </section>
      <section className="min-w-0 bg-neutral-50 p-5 dark:bg-neutral-900">
        <h3 className={sectionTitle}>Studio weekly hours</h3>
        {defaults ? (
          <ul aria-label="Default weekly opening hours" className="mt-3 grid grid-cols-7 gap-1">
            {dayNames.map((day, index) => {
              const row = defaults.find((record) => record.day_of_week === index);
              const open = row && isOpenDay(row);
              const hours = open
                ? `${formatClockLabel(row.open_time!.slice(0, 5), format)} – ${formatClockLabel(row.close_time!.slice(0, 5), format)}`
                : "Closed";
              return (
                <li key={day} title={`${day} · ${hours}`} className="min-w-0">
                  <span className="sr-only">{day} · {hours}</span>
                  <span aria-hidden="true" className={`block rounded px-0.5 py-1 text-center text-xs ${open ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-950" : "text-neutral-500"}`}>
                    {day.slice(0, 3)}
                    <span className="mt-0.5 block text-[10px]">{open ? "Open" : "Closed"}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : <p className="mt-2 text-sm">Weekly hours are unavailable.</p>}
        <PendingLink href="/settings/availability" className={detailLink}>Edit weekly hours</PendingLink>
      </section>
    </div>
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
    <div className="flex min-w-0 flex-col gap-8">
      <SettingsViewHeading title={role === "owner" ? "Studio settings" : "Your settings"}>
        {studio.name}
      </SettingsViewHeading>
      {role === "owner" && <BookingSummary studio={studio} />}
      <SettingsDirectory sections={sections} />
    </div>
  );
}
