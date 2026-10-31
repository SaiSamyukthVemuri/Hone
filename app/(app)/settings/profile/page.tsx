import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { ProfileForm } from "./ProfileForm";
import Link from "next/link";
import { HashRedirect } from "@/components/settings/hash-redirect";
import { GoogleCalendarCard } from "./GoogleCalendarCard";
import { getOwnConnectionReadiness } from "@/lib/google-calendar/connection";

// Old bookmarks and links to the sections that moved to Calendar keep working.
const MOVED_SECTIONS = {
  "calendar-color": "/settings/calendar#calendar-color",
  "calendar-feed": "/settings/calendar#calendar-feed",
} as const;

export default async function ProfileSettingsPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();

  // Google Calendar: Phase A. The card renders ONLY when the studio flag is on;
  // when it's off the card is hidden and the server actions reject anyway.
  const googleEnabled = studio.google_calendar_connection_enabled === true;
  const google = googleEnabled
    ? await getOwnConnectionReadiness(studio.id, practitioner.id)
    : { metadata: null, readiness: "disconnected" as const };

  return (
    <section className="flex flex-col gap-8">
      <HashRedirect moved={MOVED_SECTIONS} />
      <div>
        <h2 className="text-xl font-medium">Profile</h2>
        <p className="mt-1 text-sm text-neutral-500">
          How you show up to your team and in session logs.
        </p>
      </div>
      <ProfileForm
        initialDisplayName={practitioner.display_name ?? ""}
        email={practitioner.email}
      />
      <p className="text-sm text-neutral-500">
        Your calendar colour and calendar feed now live under{" "}
        <Link href="/settings/calendar" className="underline">
          Calendar
        </Link>
        .
      </p>
      {googleEnabled && (
        <GoogleCalendarCard
          connection={google.metadata}
          readiness={google.readiness}
          isOwner={practitioner.role === "owner"}
        />
      )}
    </section>
  );
}
