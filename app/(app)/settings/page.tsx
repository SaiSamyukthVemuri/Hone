import { PendingLink } from "@/components/pending-link";
import { SettingIcon } from "@/components/settings/setting-icon";
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
const descriptions: Record<string, string> = {
  "Booking & availability": "Set studio hours and choose what clients can book.",
  "Messages": "Manage the messages your studio sends.",
  "Payments & fees": "Set up payments, saved cards and cancellation fees.",
  "Client forms & care": "Manage intake, consent and postcare.",
  "Studio & team": "Manage studio details and how your team works.",
  "Services & machines": "Manage your booking menu and treatment equipment.",
  "Connections & data": "Manage connected tools and studio data.",
  "My profile": "Update your personal details and calendar preferences.",
};
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
  const accessibleDays = new Set(openDays.map(({ day }) => day));
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
        {defaults && <ul aria-label="Open days" className="my-2 flex justify-between gap-1">
          {dayNames.map(day => <li key={day} title={day + (accessibleDays.has(day) ? " · Open" : " · Closed")} className="flex flex-col items-center gap-1 text-xs">
            <span aria-hidden>{day.slice(0, 3)}</span><span className="sr-only">{day} {accessibleDays.has(day) ? "open" : "closed"}</span>
            <span aria-hidden className={"size-1.5 rounded-full " + (accessibleDays.has(day) ? "bg-fg" : "bg-neutral-300")}/>
          </li>)}
        </ul>}
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
        <h1 data-settings-heading tabIndex={-1} className="text-3xl font-semibold tracking-tight text-fg outline-none sm:text-4xl">Studio settings</h1>
        <p className="mt-1 text-sm text-neutral-600">{studio.name}</p>
      </header>
      {role === "owner" && <BookingSummary studio={studio} />}
      <section aria-labelledby="settings-directory-title">
        <h2 id="settings-directory-title" className="mb-3 text-lg font-semibold tracking-tight">Settings directory</h2>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {sections.map(section => (
            <section key={section.name} className="min-w-0 rounded-xl border border-line bg-surface p-4">
              <h3 className="flex items-center gap-2.5 text-base font-semibold">
                <span className="grid size-8 shrink-0 place-items-center rounded-md border border-line bg-surface-sunken"><SettingIcon name={section.name}/></span>
                <PendingLink href={section.links[0].href} className="hover:underline">{section.name}</PendingLink>
              </h3>
              {descriptions[section.name] && <p className="mt-2 text-sm text-fg-muted">{descriptions[section.name]}</p>}
              <ul className="mt-2 flex flex-wrap gap-x-4">
                {section.links.slice(0, 2).map(link => <li key={link.href}><PendingLink href={link.href} className="inline-flex min-h-10 items-center text-sm underline decoration-line-strong underline-offset-4 hover:decoration-current">{link.label}</PendingLink></li>)}
              </ul>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
