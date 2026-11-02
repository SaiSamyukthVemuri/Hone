import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { PendingLink } from "@/components/pending-link";
import {
  OwnerOnlyNotice,
  SettingsViewHeading,
  STUDIO_WIDE_SCOPE,
} from "@/components/settings/view-heading";
import { SmsSettingsForm } from "../SmsSettingsForm";

export default async function StudioTextMessagesPage() {
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
        title="Text-message preferences"
        scope={STUDIO_WIDE_SCOPE}
      >
        Which messages your studio sends by text. Setting up the sending number
        is separate:{" "}
        <PendingLink
          href="/settings/integrations/text-messaging"
          pendingLabel="Loading settings…"
          className="underline"
        >
          Integrations &gt; Text-message setup
        </PendingLink>
        .
      </SettingsViewHeading>
      <SmsSettingsForm
        initial={{
          send_confirmation_sms: studio.send_confirmation_sms,
          send_24h_sms_reminders: studio.send_24h_sms_reminders,
          send_2h_sms_reminders: studio.send_2h_sms_reminders,
        }}
      />
    </section>
  );
}
