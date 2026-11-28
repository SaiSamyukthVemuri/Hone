import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { OwnerOnlyNotice, SettingsViewHeading, STUDIO_WIDE_SCOPE } from "@/components/settings/view-heading";
import { defaultPortalPresentation, parsePortalPresentation } from "@/lib/portal/presentation";
import { portalRedesignEnrolled } from "@/lib/portal/presentation-server";
import { PortalEditor } from "./PortalEditor";

export default async function StudioClientPortalPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <OwnerOnlyNotice>Only studio owners can change the client portal.</OwnerOnlyNotice>;
  }
  if (!portalRedesignEnrolled(studio.id)) notFound();

  const db = await createClient();
  const { data, error } = await db.from("studio_portal_presentations")
    .select("revision,draft,published").eq("studio_id", studio.id).maybeSingle();
  const draft = data ? parsePortalPresentation(data.draft) : defaultPortalPresentation();

  return <section className="flex flex-col gap-8">
    <SettingsViewHeading title="Client portal" scope={STUDIO_WIDE_SCOPE} />
    {error || !draft ? <p role="alert">Portal settings could not be loaded. Reload this page to try again.</p> :
      <PortalEditor key={studio.id} studioId={studio.id} studioName={studio.name} timezone={studio.timezone}
        initial={draft} initialRevision={data?.revision ?? 0} initiallyPublished={Boolean(data?.published)} />}
  </section>;
}
