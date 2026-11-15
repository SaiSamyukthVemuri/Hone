import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import {
  OwnerOnlyNotice,
  SettingsViewHeading,
  STUDIO_WIDE_SCOPE,
} from "@/components/settings/view-heading";
import { EmailSettingsForm } from "../EmailSettingsForm";

export default async function StudioEmailPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <OwnerOnlyNotice>
        Only studio owners can change studio settings.
      </OwnerOnlyNotice>
    );
  }
  return (
    <section className="flex flex-col gap-8">
      <SettingsViewHeading
        title="Email notifications"
        scope={STUDIO_WIDE_SCOPE}
      />
      <EmailSettingsForm
        initial={{
          send_confirmation_emails: studio.send_confirmation_emails,
          notify_practitioner_on_new_booking:
            studio.notify_practitioner_on_new_booking,
          send_24h_reminders: studio.send_24h_reminders,
          send_2h_reminders: studio.send_2h_reminders,
          // Absent only on a row read before 0186 is applied; the column
          // defaults true, so absent must display as ON, never OFF.
          send_intake_reminders: studio.send_intake_reminders ?? true,
          auto_mark_no_shows: studio.auto_mark_no_shows,
          send_no_show_followup: studio.send_no_show_followup,
          show_treatment_time_to_clients: studio.show_treatment_time_to_clients,
        }}
      />
    </section>
  );
}
