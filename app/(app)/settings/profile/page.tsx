import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { ProfileForm } from "./ProfileForm";
import { ColorPicker } from "./ColorPicker";
import { CalendarFeedCard } from "./CalendarFeedCard";
import { GoogleCalendarCard } from "./GoogleCalendarCard";
import { getOwnConnectionReadiness } from "@/lib/google-calendar/connection";
import { getRequiredAppOrigin } from "@/lib/app-origin";

export default async function ProfileSettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

  // Google Calendar — Phase A. The card renders ONLY when the studio flag is on;
  // when it's off the card is hidden and the server actions reject anyway.
  const googleEnabled = studio.google_calendar_connection_enabled === true;
  const google = googleEnabled
    ? await getOwnConnectionReadiness(studio.id, practitioner.id)
    : { metadata: null, readiness: "disconnected" as const };

  return (
    <section className="flex flex-col gap-8">
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
      <ColorPicker initialColor={practitioner.color} />
      <CalendarFeedCard
        appOrigin={getRequiredAppOrigin()}
        initialActive={!!practitioner.calendar_feed_token_hash}
      />
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
