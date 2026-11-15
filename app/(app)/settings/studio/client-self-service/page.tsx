import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { clientSelfServicePolicyFromStudio } from "@/lib/booking/client-self-service-policy";
import {
  OwnerOnlyNotice,
  SettingsViewHeading,
  STUDIO_WIDE_SCOPE,
} from "@/components/settings/view-heading";
import { ClientSelfServiceForm } from "../ClientSelfServiceForm";

export default async function StudioClientSelfServicePage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <OwnerOnlyNotice>
        Only studio owners can change studio settings.
      </OwnerOnlyNotice>
    );
  }
  const policy = clientSelfServicePolicyFromStudio(studio);
  return (
    <section className="flex flex-col gap-8">
      <SettingsViewHeading
        title="Client self-service"
        scope={STUDIO_WIDE_SCOPE}
      />
      <ClientSelfServiceForm
        initial={{
          cancellation: policy.cancellation,
          reschedule: policy.reschedule,
        }}
        portalEnabled={policy.portal}
      />
    </section>
  );
}
