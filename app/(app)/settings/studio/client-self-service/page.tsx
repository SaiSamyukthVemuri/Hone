import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { clientSelfServicePolicyFromStudio } from "@/lib/booking/client-self-service-policy";
import {
  OwnerOnlyNotice,
  SettingsViewHeading,
  STUDIO_WIDE_SCOPE,
} from "@/components/settings/view-heading";
import { StudioManagedAppointmentsControl } from "../StudioManagedAppointmentsControl";
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
  const mode = (studio as { studio_managed_appointments?: unknown }).studio_managed_appointments;
  const policy = clientSelfServicePolicyFromStudio({ ...studio, studio_managed_appointments: false });
  return (
    <section className="flex flex-col gap-8">
      <SettingsViewHeading
        title="Client self-service"
        scope={STUDIO_WIDE_SCOPE}
      />
      <StudioManagedAppointmentsControl initial={mode === true} available={typeof mode === "boolean"} />
      <ClientSelfServiceForm
        initial={{
          cancellation: policy.cancellation,
          reschedule: policy.reschedule,
        }}
        portalEnabled={policy.portal}
        studioManaged={mode === true}
      />
    </section>
  );
}
