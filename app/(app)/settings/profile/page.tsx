import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { ProfileForm } from "./ProfileForm";
import { ColorPicker } from "./ColorPicker";
import { CalendarFeedCard } from "./CalendarFeedCard";
import { getRequiredAppOrigin } from "@/lib/app-origin";

export default async function ProfileSettingsPage() {
  const { practitioner } = await getCurrentPractitionerWithStudio();

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
    </section>
  );
}
