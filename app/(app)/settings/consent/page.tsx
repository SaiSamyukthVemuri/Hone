import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { getConsentTemplatesForStudio } from "@/lib/consent/queries";
import { ConsentTemplatesEditor } from "./ConsentTemplatesEditor";
import { SettingsViewHeading, STUDIO_WIDE_SCOPE } from "@/components/settings/view-heading";
import {
  createConsentTemplateAction,
  setConsentTemplateLiveAction,
  setConsentTemplateStatusAction,
  updateConsentTemplateAction,
} from "./actions";

// Owner-only consent templates page. The settings layout already
// gates the tab visibility on role === 'owner'; the page render
// itself re-checks so a non-owner who navigates the route directly
// sees the same gate. Server-resolved studio scope.

export default async function ConsentSettingsPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <section className="text-sm text-neutral-600 dark:text-neutral-400">
        Only studio owners can manage consent forms.
      </section>
    );
  }
  const templates = await getConsentTemplatesForStudio(studio.id);

  return (
    <section className="flex flex-col gap-8">
      <SettingsViewHeading title="Consent forms" scope={STUDIO_WIDE_SCOPE}>
        Create consent forms clients can review and sign in their secure portal.
        Only forms marked <strong>Live in client portal</strong> are shown to
        clients. Keep new forms off until you have reviewed them.
      </SettingsViewHeading>

      <ConsentTemplatesEditor
        templates={templates}
        createAction={createConsentTemplateAction}
        updateAction={updateConsentTemplateAction}
        setStatusAction={setConsentTemplateStatusAction}
        setLiveAction={setConsentTemplateLiveAction}
      />
    </section>
  );
}
