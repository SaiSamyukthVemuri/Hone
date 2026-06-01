import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { StudioSettingsForm } from "./StudioSettingsForm";
import { EmailSettingsForm } from "./EmailSettingsForm";
// PostcareSettingsForm intentionally NOT imported here. Postcare
// editing moved to /settings/intake (Intake & Postcare tab) after
// Chloe's retest; the form component itself is unchanged and is
// still owner-gated server-side via updateStudioPostcareAction.

export default async function StudioSettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

  if (practitioner.role !== "owner") {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        Only studio owners can change studio settings.
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-10">
      <div>
        <h2 className="text-xl font-medium">Studio</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Change your studio name and legal entity. Visible to your team.
        </p>
      </div>
      <StudioSettingsForm
        initialName={studio.name}
        initialLegalEntity={studio.legal_entity_name ?? ""}
        ownerEmail={studio.owner_email}
        initialBirthdayColor={studio.birthday_reminder_color}
      />
      <EmailSettingsForm
        initial={{
          send_confirmation_emails: studio.send_confirmation_emails,
          send_24h_reminders: studio.send_24h_reminders,
          send_2h_reminders: studio.send_2h_reminders,
          auto_mark_no_shows: studio.auto_mark_no_shows,
          send_no_show_followup: studio.send_no_show_followup,
          show_treatment_time_to_clients: studio.show_treatment_time_to_clients,
        }}
      />
    </section>
  );
}
