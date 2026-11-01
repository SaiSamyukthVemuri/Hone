import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import {
  OwnerOnlyNotice,
  SettingsViewHeading,
  STUDIO_WIDE_SCOPE,
} from "@/components/settings/view-heading";
import { StudioSettingsForm } from "../StudioSettingsForm";

export default async function StudioDetailsPage() {
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
      <SettingsViewHeading title="Studio details" scope={STUDIO_WIDE_SCOPE}>
        Change your studio name and legal entity. Visible to your team.
      </SettingsViewHeading>
      <StudioSettingsForm
        initialName={studio.name}
        initialLegalEntity={studio.legal_entity_name ?? ""}
        ownerEmail={studio.owner_email}
      />
    </section>
  );
}
