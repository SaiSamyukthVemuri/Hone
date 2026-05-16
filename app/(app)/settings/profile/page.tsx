import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { ProfileForm } from "./ProfileForm";

export default async function ProfileSettingsPage() {
  const { practitioner } = await getCurrentPractitionerWithStudio();

  return (
    <section className="flex flex-col gap-6">
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
    </section>
  );
}
