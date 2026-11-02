import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import {
  OwnerOnlyNotice,
  SettingsViewHeading,
  STUDIO_WIDE_SCOPE,
} from "@/components/settings/view-heading";
import { PolicySettingsForm } from "../../studio/PolicySettingsForm";

// Forms & postcare > Cancellation policy. Owner-only (the save action re-checks
// the role). Saving does not collect a card or charge anyone.
export const metadata = { title: "Cancellation policy" };

export default async function CancellationPolicyPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <OwnerOnlyNotice>
        Only studio owners can edit the cancellation and no-show policy.
      </OwnerOnlyNotice>
    );
  }
  return (
    <section className="flex flex-col gap-8">
      <SettingsViewHeading
        title="Cancellation and no-show policy"
        scope={STUDIO_WIDE_SCOPE}
      />
      <PolicySettingsForm
        initial={{
          cancellation_policy_text: studio.cancellation_policy_text ?? "",
          no_show_policy_text: studio.no_show_policy_text ?? "",
          policy_version: studio.policy_version,
          policy_updated_at: studio.policy_updated_at,
        }}
      />
    </section>
  );
}
