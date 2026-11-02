import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import {
  OwnerOnlyNotice,
  SettingsViewHeading,
  STUDIO_WIDE_SCOPE,
} from "@/components/settings/view-heading";
import { PendingLink } from "@/components/pending-link";
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
      {/* The approved artifact shows location and time zone on Studio details.
          They already exist as studio settings and are edited, with their own
          save and conflict handling, in Booking window. Shown here read-only with
          a link, not duplicated as a second editable source. */}
      <section aria-labelledby="studio-location-heading" className="flex flex-col gap-3">
        <h3 id="studio-location-heading" className="text-base font-medium">
          Location and time zone
        </h3>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
          <dt className="text-neutral-500">Public address</dt>
          <dd>{studio.address?.trim() ? studio.address : "Not set"}</dd>
          <dt className="text-neutral-500">Studio time zone</dt>
          <dd>{studio.timezone}</dd>
        </dl>
        <PendingLink
          href="/settings/booking/window"
          pendingLabel="Loading settings…"
          className="w-fit text-sm font-medium underline underline-offset-2"
        >
          Change location or time zone in Booking window
        </PendingLink>
      </section>
    </section>
  );
}
