import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { StudioSettingsForm } from "./StudioSettingsForm";

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
    <section className="flex flex-col gap-6">
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
      />
    </section>
  );
}
