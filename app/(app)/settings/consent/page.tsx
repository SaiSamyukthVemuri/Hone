import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getConsentTemplatesForStudio } from "@/lib/consent/queries";
import { ConsentTemplatesEditor } from "./ConsentTemplatesEditor";
import {
  createConsentTemplateAction,
  setConsentTemplateStatusAction,
  updateConsentTemplateAction,
} from "./actions";

// Owner-only consent templates page. The settings layout already
// gates the tab visibility on role === 'owner'; the page render
// itself re-checks so a non-owner who navigates the route directly
// sees the same gate. Server-resolved studio scope.

export default async function ConsentSettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <section className="px-5 py-6 text-sm text-neutral-600 dark:text-neutral-400">
        Only studio owners can manage consent forms.
      </section>
    );
  }
  const templates = await getConsentTemplatesForStudio(studio.id);

  return (
    <section className="flex flex-col gap-4 px-5 py-6">
      <header>
        <h2 className="text-lg font-semibold tracking-tight">Consent forms</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Create consent forms clients can review and sign in their secure
          portal.
        </p>
      </header>

      <ConsentTemplatesEditor
        templates={templates}
        createAction={createConsentTemplateAction}
        updateAction={updateConsentTemplateAction}
        setStatusAction={setConsentTemplateStatusAction}
      />
    </section>
  );
}
