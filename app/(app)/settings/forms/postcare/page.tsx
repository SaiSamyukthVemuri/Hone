import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import {
  OwnerOnlyNotice,
  SettingsViewHeading,
  STUDIO_WIDE_SCOPE,
} from "@/components/settings/view-heading";
import { PostcareSettingsForm } from "../../studio/PostcareSettingsForm";

// Forms & postcare > Postcare. Owner-only: updateStudioPostcareAction is gated
// server-side as well. Postcare data lives on the studio record.
export const metadata = { title: "Postcare" };

export default async function PostcarePage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <OwnerOnlyNotice>
        Only studio owners can edit postcare delivery settings.
      </OwnerOnlyNotice>
    );
  }
  return (
    <section className="flex flex-col gap-8">
      <SettingsViewHeading title="Postcare" scope={STUDIO_WIDE_SCOPE}>
        Configure the postcare instructions clients receive and choose whether
        postcare is sent manually or automatically after completed appointments.
        You write the clinical content; Hone never invents medical advice.
      </SettingsViewHeading>
      <PostcareSettingsForm
        initial={{
          postcare_aftercare_text: studio.postcare_aftercare_text ?? "",
          postcare_warning_signs_text: studio.postcare_warning_signs_text ?? "",
          postcare_product_recommendations_text:
            studio.postcare_product_recommendations_text ?? "",
          postcare_review_url: studio.postcare_review_url ?? "",
          postcare_review_prompt_text: studio.postcare_review_prompt_text ?? "",
          postcare_contact_email: studio.postcare_contact_email ?? "",
          postcare_delivery_mode:
            studio.postcare_delivery_mode === "auto_on_complete"
              ? "auto_on_complete"
              : "manual",
        }}
        studioOwnerEmail={studio.owner_email}
      />
    </section>
  );
}
